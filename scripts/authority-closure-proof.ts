#!/usr/bin/env tsx
/**
 * Authority closure live proof against real PostgreSQL.
 *
 * Fail-closed: every nested boolean must be true or exit 1 with evidenceLevel FAILED.
 * Skipped / soft-pass is not allowed.
 *
 * Usage:
 *   export OWNER_DSN='postgres://commander:commander@127.0.0.1:5433/commander'
 *   export COMMANDER_KERNEL_DATABASE_URL="$OWNER_DSN"
 *   pnpm proof:authority
 */

import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
} from '@commander/effect-broker';
import {
  createCapabilityAuthority,
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  PostgresKernelRepository,
  runKernelMigrations,
  seedWorkerAllowedTenants,
  seedWorkerClaimSecret,
} from '@commander/kernel';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import type { SqlClient, SqlPool } from '../packages/kernel/src/postgres.js';
import { TENANT_TABLES } from '../packages/kernel/src/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_PATH = resolve(ROOT, '.superpowers/sdd/authority-closure-proof-latest.json');
const FALLBACK_DSN = 'postgres://commander:commander@127.0.0.1:5433/commander';

const appPassword = process.env.COMMANDER_APP_PASSWORD ?? 'commander_app';
const schedulerPassword = process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler';
const workerPassword = process.env.COMMANDER_WORKER_PASSWORD ?? 'commander_worker';

export interface AuthorityProofResult {
  gitSha: string;
  database: {
    rlsEnabled: boolean;
    rolesSeparated: boolean;
    workerDirectInsertRejected: boolean;
    workerDirectUpdateRejected: boolean;
    workerCrossTenantRegisterRejected: boolean;
    peerClaimWithoutSecretRejected: boolean;
    workerIdentityTakeoverRejected: boolean;
    workerRevocationDeleteRejected: boolean;
    claimExecuteRequiresSecret: boolean;
    workerOutsideAllowlistWriteRejected: boolean;
  };
  effect: { policyBound: boolean; actionDigestBound: boolean; actionDigestRequired: boolean; fenced: boolean };
  capability: {
    replayRejected: boolean;
    revocationObserved: boolean;
    rotationObserved: boolean;
    enterpriseRefusesGenerate: boolean;
  };
  passed: boolean;
  evidenceLevel: 'PROVEN' | 'FAILED';
  failures: string[];
  checkedAt: string;
}

export type AuthorityProofFlags = {
  database: AuthorityProofResult['database'];
  effect: AuthorityProofResult['effect'];
  capability: AuthorityProofResult['capability'];
};

/** Prefer OWNER_DSN, then kernel URL, then DATABASE_URL, then local fallback. */
export function resolveOwnerDsn(env: NodeJS.ProcessEnv = process.env): string {
  const owner = env.OWNER_DSN?.trim();
  if (owner) return owner;
  const kernel = env.COMMANDER_KERNEL_DATABASE_URL?.trim();
  if (kernel) return kernel;
  const database = env.DATABASE_URL?.trim();
  if (database) return database;
  return FALLBACK_DSN;
}

export function deriveRoleDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** Stable JSON for hashing (sorted object keys, arrays preserve order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Fail-closed finalize: any false flag or non-empty failures ⇒ FAILED. */
export function finalizeResult(input: {
  gitSha: string;
  flags: AuthorityProofFlags;
  failures: string[];
  checkedAt?: string;
}): AuthorityProofResult {
  const failures = [...input.failures];
  const { database, effect, capability } = input.flags;

  const boolChecks: Array<[string, boolean]> = [
    ['database.rlsEnabled', database.rlsEnabled],
    ['database.rolesSeparated', database.rolesSeparated],
    ['database.workerDirectInsertRejected', database.workerDirectInsertRejected],
    ['database.workerDirectUpdateRejected', database.workerDirectUpdateRejected],
    ['database.workerCrossTenantRegisterRejected', database.workerCrossTenantRegisterRejected],
    ['database.peerClaimWithoutSecretRejected', database.peerClaimWithoutSecretRejected],
    ['database.workerIdentityTakeoverRejected', database.workerIdentityTakeoverRejected],
    ['database.workerRevocationDeleteRejected', database.workerRevocationDeleteRejected],
    ['database.claimExecuteRequiresSecret', database.claimExecuteRequiresSecret],
    ['database.workerOutsideAllowlistWriteRejected', database.workerOutsideAllowlistWriteRejected],
    ['effect.policyBound', effect.policyBound],
    ['effect.actionDigestBound', effect.actionDigestBound],
    ['effect.actionDigestRequired', effect.actionDigestRequired],
    ['effect.fenced', effect.fenced],
    ['capability.replayRejected', capability.replayRejected],
    ['capability.revocationObserved', capability.revocationObserved],
    ['capability.rotationObserved', capability.rotationObserved],
    ['capability.enterpriseRefusesGenerate', capability.enterpriseRefusesGenerate],
  ];
  for (const [name, ok] of boolChecks) {
    if (!ok && !failures.some((f) => f.includes(name))) {
      failures.push(`${name}=false`);
    }
  }

  if (!input.gitSha || input.gitSha === 'unknown') {
    if (!failures.some((f) => /gitSha/i.test(f))) {
      failures.push('gitSha unknown');
    }
  }

  const allTrue = boolChecks.every(([, ok]) => ok);
  const passed = allTrue && failures.length === 0 && Boolean(input.gitSha) && input.gitSha !== 'unknown';

  return {
    gitSha: input.gitSha,
    database: { ...database },
    effect: { ...effect },
    capability: { ...capability },
    passed,
    evidenceLevel: passed ? 'PROVEN' : 'FAILED',
    failures,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

function resolveGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

async function ensureRoleLogin(ownerPool: Pool, role: string, password: string): Promise<void> {
  const escaped = password.replace(/'/g, "''");
  await ownerPool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${escaped}'`);
}

function createLoginPool(roleDatabaseUrl: string): SqlPool & { end: () => Promise<void> } {
  const pool = new Pool({ connectionString: roleDatabaseUrl, max: 2 });
  return {
    connect: async () => (await pool.connect()) as SqlClient,
    end: () => pool.end(),
  };
}

function createRunCommand(
  tenantId: string,
  steps: Array<{ kind: string; dependencies?: string[]; maxAttempts?: number; priority?: number }>,
) {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    dependencies: s.dependencies,
    maxAttempts: s.maxAttempts ?? 3,
    priority: s.priority ?? 0,
    // Schedule slightly in the past so claim_next_step's scheduled_at <= clock_timestamp()
    // still holds when the app host clock is ahead of Postgres (Docker clock skew).
    scheduledAt: new Date(Date.now() - 5_000).toISOString(),
  }));
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(JSON.stringify(stepDefs)).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'authority-proof-policy',
    steps: stepDefs,
  };
}

export type Ed25519JwksKey = {
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  x: string;
  alg: 'EdDSA';
  use: 'sig';
};

export function ed25519Material(kid: string): {
  privateKeyPem: string;
  jwksJson: string;
  keyId: string;
  publicJwk: Ed25519JwksKey;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error(`ed25519Material(${kid}): missing public x`);
  const publicJwk: Ed25519JwksKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    kid,
    x: jwk.x,
    alg: 'EdDSA',
    use: 'sig',
  };
  const jwksJson = JSON.stringify({ keys: [publicJwk] });
  return { privateKeyPem, jwksJson, keyId: kid, publicJwk };
}

/** Merge JWKS public keys (kid collision last-wins). Used for dual-key rotation proofs. */
export function mergeJwksJson(...materials: Array<{ publicJwk: Ed25519JwksKey }>): string {
  const byKid = new Map<string, Ed25519JwksKey>();
  for (const mat of materials) {
    byKid.set(mat.publicJwk.kid, mat.publicJwk);
  }
  return JSON.stringify({ keys: [...byKid.values()] });
}

function falseFlags(): AuthorityProofFlags {
  return {
    database: {
      rlsEnabled: false,
      rolesSeparated: false,
      workerDirectInsertRejected: false,
      workerDirectUpdateRejected: false,
      workerCrossTenantRegisterRejected: false,
      peerClaimWithoutSecretRejected: false,
      workerIdentityTakeoverRejected: false,
      workerRevocationDeleteRejected: false,
      claimExecuteRequiresSecret: false,
      workerOutsideAllowlistWriteRejected: false,
    },
    effect: { policyBound: false, actionDigestBound: false, actionDigestRequired: false, fenced: false },
    capability: {
      replayRejected: false,
      revocationObserved: false,
      rotationObserved: false,
      enterpriseRefusesGenerate: false,
    },
  };
}

async function checkRlsEnabled(ownerPool: Pool, failures: string[]): Promise<boolean> {
  const rows = await ownerPool.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity
     FROM pg_class
     WHERE relname = ANY($1::text[])`,
    [TENANT_TABLES as unknown as string[]],
  );
  if (rows.rows.length !== TENANT_TABLES.length) {
    failures.push(
      `rlsEnabled: expected ${TENANT_TABLES.length} tenant tables, got ${rows.rows.length}`,
    );
    return false;
  }
  let ok = true;
  for (const row of rows.rows) {
    if (!row.relrowsecurity || !row.relforcerowsecurity) {
      ok = false;
      failures.push(
        `rlsEnabled: ${row.relname} ENABLE=${row.relrowsecurity} FORCE=${row.relforcerowsecurity}`,
      );
    }
  }
  return ok;
}

async function checkRolesSeparated(input: {
  ownerPool: Pool;
  appPool: SqlPool;
  workerPool: SqlPool;
  appRepo: PostgresKernelRepository;
  workerRepo: PostgresKernelRepository;
  tenantA: string;
  tenantB: string;
  failures: string[];
}): Promise<boolean> {
  const { ownerPool, appPool, workerPool, appRepo, workerRepo, tenantA, tenantB, failures } = input;
  let ok = true;

  const roles = await ownerPool.query<{
    rolname: string;
    rolbypassrls: boolean;
    rolsuper: boolean;
  }>(
    `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
     WHERE rolname IN ('commander_app','commander_worker','commander_scheduler')`,
  );
  const byName = new Map(roles.rows.map((r) => [r.rolname, r]));
  if (byName.get('commander_app')?.rolbypassrls !== false) {
    ok = false;
    failures.push('rolesSeparated: commander_app must not BYPASSRLS');
  }
  if (byName.get('commander_worker')?.rolbypassrls !== false) {
    ok = false;
    failures.push('rolesSeparated: commander_worker must not BYPASSRLS');
  }
  if (byName.get('commander_scheduler')?.rolbypassrls !== true) {
    ok = false;
    failures.push('rolesSeparated: commander_scheduler must BYPASSRLS');
  }
  for (const name of ['commander_app', 'commander_worker', 'commander_scheduler']) {
    if (byName.get(name)?.rolsuper) {
      ok = false;
      failures.push(`rolesSeparated: ${name} must not be superuser`);
    }
  }

  // Raw-role cross-tenant: app scoped to A must not read B.
  const runA = createRunCommand(tenantA, [{ kind: 'agent' }]);
  const runB = createRunCommand(tenantB, [{ kind: 'agent' }]);
  await appRepo.createRun(runA, 'authority-proof');
  await appRepo.createRun(runB, 'authority-proof');

  const client = await appPool.connect();
  try {
    await client.query(`SELECT set_config('app.tenant_scope', $1, false)`, [tenantA]);
    const leaked = await client.query(`SELECT id FROM commander_runs WHERE tenant_id=$1`, [tenantB]);
    if (leaked.rows.length > 0) {
      ok = false;
      failures.push('rolesSeparated: app role leaked cross-tenant rows');
    }
  } finally {
    try {
      await client.query(`SELECT set_config('app.tenant_scope', '', false)`);
    } catch { /* best-effort pool hygiene */ }
    client.release();
  }

  // App cannot EXECUTE claim_next_step; worker can (after worker registration).
  const workerId = `proof-worker-${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
     VALUES ($1,'agent','v1','["agent"]',4,'ACTIVE',1,$1,$2::jsonb)
     ON CONFLICT (id) DO UPDATE SET generation=1, status='ACTIVE', tenant_ids=$2::jsonb`,
    [workerId, JSON.stringify([tenantA])],
  );
  const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);

  let appDenied = false;
  try {
    await appRepo.claimNextStep({
      workerId,
      workerGeneration: 1,
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
      claimSecret,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission denied/i.test(msg)) appDenied = true;
    else {
      ok = false;
      failures.push(`rolesSeparated: app claim unexpected error: ${msg}`);
    }
  }
  if (!appDenied) {
    ok = false;
    failures.push('rolesSeparated: commander_app must not EXECUTE claim_next_step');
  }

  // Drain then create a claimable step for worker.
  await ownerPool.query(
    `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
     WHERE tenant_id = ANY($1::text[]) AND state IN ('PENDING','RETRY_WAIT')`,
    [[tenantA]],
  );
  const claimRun = createRunCommand(tenantA, [{ kind: 'agent' }]);
  await appRepo.createRun(claimRun, 'authority-proof');

  const identityClient = await workerPool.connect();
  try {
    const identity = await identityClient.query<{ session_user: string }>(
      'SELECT session_user::text AS session_user',
    );
    if (identity.rows[0]?.session_user !== 'commander_worker') {
      ok = false;
      failures.push(
        `rolesSeparated: expected session_user=commander_worker, got ${identity.rows[0]?.session_user}`,
      );
    }
  } finally {
    identityClient.release();
  }

  const claimed = await workerRepo.claimNextStep({
    workerId,
    workerGeneration: 1,
    capabilities: ['agent'],
    leaseTtlMs: 30_000,
    claimSecret,
  });
  if (!claimed) {
    ok = false;
    failures.push('rolesSeparated: commander_worker must claim via claim_next_step');
  }

  return ok;
}

async function checkEffectBindings(input: {
  ownerPool: Pool;
  appRepo: PostgresKernelRepository;
  workerRepo: PostgresKernelRepository;
  tenantId: string;
  failures: string[];
}): Promise<{
  policyBound: boolean;
  actionDigestBound: boolean;
  actionDigestRequired: boolean;
  fenced: boolean;
}> {
  const { ownerPool, appRepo, workerRepo, tenantId, failures } = input;
  let policyBound = false;
  let actionDigestBound = false;
  let actionDigestRequired = false;
  let fenced = false;

  const workerId = `proof-fence-${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
     VALUES ($1,'agent','v1','["agent"]',4,'ACTIVE',1,$1,$2::jsonb)`,
    [workerId, JSON.stringify([tenantId])],
  );
  const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);

  try {
    await ownerPool.query(
      `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
       WHERE tenant_id=$1 AND state IN ('PENDING','RETRY_WAIT','RUNNING')`,
      [tenantId],
    );
    await ownerPool.query(
      `UPDATE commander_tenant_execution_usage SET running_steps=0, updated_at=now() WHERE tenant_id=$1`,
      [tenantId],
    );

    const bindRun = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await appRepo.createRun(bindRun, 'authority-proof');
    const claimed = await workerRepo.claimNextStep({
      workerId,
      workerGeneration: 1,
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
      claimSecret,
    });
    if (!claimed?.lease) {
      failures.push('effect: claim failed before policy/digest/fence checks');
      return { policyBound, actionDigestBound, actionDigestRequired, fenced };
    }
    const lease = claimed.lease;
    const digest = 'c'.repeat(64);
    const idemKey = `bind-${randomUUID().slice(0, 8)}`;

    const admitted = await appRepo.admitEffect({
      id: `effect-bind-${randomUUID().slice(0, 8)}`,
      runId: bindRun.id,
      stepId: claimed.id,
      tenantId,
      type: 'http.write',
      idempotencyKey: idemKey,
      policyDecisionId: 'decision-bind',
      policySnapshotId: 'policy-bind-v1',
      actionDigest: digest,
      request: { target: 'bind' },
      lease,
      actor: workerId,
    });
    if (!admitted.admitted) {
      failures.push(`effect: initial admit failed (${'reason' in admitted ? admitted.reason : 'unknown'})`);
      return { policyBound, actionDigestBound, actionDigestRequired, fenced };
    }

    const snapshotConflict = await appRepo.admitEffect({
      id: `effect-bind-snap-${randomUUID().slice(0, 8)}`,
      runId: bindRun.id,
      stepId: claimed.id,
      tenantId,
      type: 'http.write',
      idempotencyKey: idemKey,
      policyDecisionId: 'decision-bind',
      policySnapshotId: 'policy-bind-v2',
      actionDigest: digest,
      request: { target: 'bind' },
      lease,
      actor: workerId,
    });
    policyBound =
      snapshotConflict.admitted === false &&
      !snapshotConflict.admitted &&
      snapshotConflict.reason === 'IDEMPOTENCY_CONFLICT';
    if (!policyBound) {
      failures.push(
        `effect.policyBound: expected IDEMPOTENCY_CONFLICT, got ${JSON.stringify(snapshotConflict)}`,
      );
    }

    const digestConflict = await appRepo.admitEffect({
      id: `effect-bind-digest-${randomUUID().slice(0, 8)}`,
      runId: bindRun.id,
      stepId: claimed.id,
      tenantId,
      type: 'http.write',
      idempotencyKey: idemKey,
      policyDecisionId: 'decision-bind',
      policySnapshotId: 'policy-bind-v1',
      actionDigest: 'd'.repeat(64),
      request: { target: 'bind' },
      lease,
      actor: workerId,
    });
    actionDigestBound =
      digestConflict.admitted === false &&
      !digestConflict.admitted &&
      digestConflict.reason === 'IDEMPOTENCY_CONFLICT';
    if (!actionDigestBound) {
      failures.push(
        `effect.actionDigestBound: expected IDEMPOTENCY_CONFLICT, got ${JSON.stringify(digestConflict)}`,
      );
    }

    // Fence (kernel lease): rollover generation → stale lease admit must LEASE_LOST; stale claim null.
    await ownerPool.query('UPDATE commander_workers SET generation=2 WHERE id=$1', [workerId]);
    const staleAdmit = await appRepo.admitEffect({
      id: `effect-stale-${randomUUID().slice(0, 8)}`,
      runId: bindRun.id,
      stepId: claimed.id,
      tenantId,
      type: 'http.write',
      idempotencyKey: `stale-${randomUUID().slice(0, 8)}`,
      policyDecisionId: 'decision-stale',
      policySnapshotId: 'policy-bind-v1',
      actionDigest: 'e'.repeat(64),
      request: { target: 'stale' },
      lease,
      actor: workerId,
    });
    const staleClaim = await workerRepo.claimNextStep({
      workerId,
      workerGeneration: 1,
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
      claimSecret,
    });
    const kernelFenced =
      staleAdmit.admitted === false &&
      !staleAdmit.admitted &&
      staleAdmit.reason === 'LEASE_LOST' &&
      staleClaim === null;
    if (!kernelFenced) {
      failures.push(
        `effect.fenced(kernel): expected LEASE_LOST + null claim, got admit=${JSON.stringify(staleAdmit)} claim=${staleClaim ? 'claimed' : 'null'}`,
      );
    }

    // Fence (broker): grant workerId/generation ≠ lease → WORKER_FENCE_MISMATCH (fail-closed).
    const fenceIssuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-authority-proof',
      audience: 'commander.effect-broker',
      keyId: 'proof-fence',
    });
    const fenceVerifier = new CapabilityTokenVerifier({
      issuer: 'commander-authority-proof',
      audience: 'commander.effect-broker',
      publicKeys: { 'proof-fence': fenceIssuer.publicKey },
    });
    const fenceBroker = new EffectBroker(
      fenceVerifier,
      {
        evaluate: async () => ({
          effect: 'allow' as const,
          decisionId: 'authority-proof-fence',
          reason: 'ok',
          policySnapshotId: 'authority-proof-policy',
        }),
      },
      {
        admitEffect: async () => ({ admitted: true, effect: { id: 'e1', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => undefined },
      { audience: 'commander.effect-broker', requireRequestBinding: true },
    );
    const workloadId = `wl_${bindRun.id}_${claimed.id}_fence`;
    const brokerRequest = { target: 'broker-fence' };
    const mismatchedGrant = fenceIssuer.issue({
      jti: `jti-broker-fence-${randomUUID().slice(0, 8)}`,
      tenantId,
      runId: bindRun.id,
      stepId: claimed.id,
      workloadId,
      effectTypes: ['http.write'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(brokerRequest),
      actionDigest: 'f'.repeat(64),
      // Deliberately diverge from lease workerGeneration (lease stays gen 1).
      workerId,
      workerGeneration: 99,
      nonce: randomUUID(),
    });
    const brokerFenceAdmit = await fenceBroker.admit({
      effectId: `eff-broker-fence-${randomUUID().slice(0, 8)}`,
      token: mismatchedGrant,
      type: 'http.write',
      request: brokerRequest,
      idempotencyKey: `broker-fence-${randomUUID().slice(0, 8)}`,
      lease: {
        workerId: lease.workerId,
        workerGeneration: lease.workerGeneration,
        token: lease.token,
        fencingEpoch: lease.fencingEpoch,
      },
      actor: workerId,
      workloadBinding: {
        tenantId,
        runId: bindRun.id,
        stepId: claimed.id,
        workloadId,
      },
    });
    const brokerFenced =
      brokerFenceAdmit.admitted === false &&
      !brokerFenceAdmit.admitted &&
      brokerFenceAdmit.reason === 'WORKER_FENCE_MISMATCH';
    if (!brokerFenced) {
      failures.push(
        `effect.fenced(broker): expected WORKER_FENCE_MISMATCH, got ${JSON.stringify(brokerFenceAdmit)}`,
      );
    }

    fenced = kernelFenced && brokerFenced;

    // Class A admit without actionDigest → ACTION_DIGEST_REQUIRED.
    const digestGateIssuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-authority-proof',
      audience: 'commander.effect-broker',
      keyId: 'proof-digest-gate',
    });
    const digestGateVerifier = new CapabilityTokenVerifier({
      issuer: 'commander-authority-proof',
      audience: 'commander.effect-broker',
      publicKeys: { 'proof-digest-gate': digestGateIssuer.publicKey },
    });
    const digestGateBroker = new EffectBroker(
      digestGateVerifier,
      {
        evaluate: async () => ({
          effect: 'allow' as const,
          decisionId: 'authority-proof-digest',
          reason: 'ok',
          policySnapshotId: 'authority-proof-policy',
        }),
      },
      {
        admitEffect: async () => ({ admitted: true, effect: { id: 'e-digest', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => undefined },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: true,
        localWorkerId: workerId,
        localWorkerGeneration: 1,
      },
    );
    const digestGateRequest = { target: 'digest-gate' };
    const noDigestGrant = digestGateIssuer.issue({
      jti: `jti-digest-gate-${randomUUID().slice(0, 8)}`,
      tenantId,
      runId: bindRun.id,
      stepId: claimed.id,
      workloadId: `wl_${bindRun.id}_${claimed.id}_digest`,
      effectTypes: ['crm.write'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(digestGateRequest),
      workerId,
      workerGeneration: 1,
      nonce: randomUUID(),
    });
    const digestGateAdmit = await digestGateBroker.admit({
      effectId: `eff-digest-gate-${randomUUID().slice(0, 8)}`,
      token: noDigestGrant,
      type: 'crm.write',
      request: digestGateRequest,
      idempotencyKey: `digest-gate-${randomUUID().slice(0, 8)}`,
      lease: {
        workerId,
        workerGeneration: 1,
        token: lease.token,
        fencingEpoch: lease.fencingEpoch,
      },
      actor: workerId,
      workloadBinding: {
        tenantId,
        runId: bindRun.id,
        stepId: claimed.id,
        workloadId: `wl_${bindRun.id}_${claimed.id}_digest`,
      },
    });
    if (digestGateAdmit.admitted === false && digestGateAdmit.reason === 'ACTION_DIGEST_REQUIRED') {
      actionDigestRequired = true;
    } else {
      failures.push(
        `effect.actionDigestRequired: expected ACTION_DIGEST_REQUIRED, got ${JSON.stringify(digestGateAdmit)}`,
      );
    }
  } finally {
    await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [workerId]);
    await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
  }

  return { policyBound, actionDigestBound, actionDigestRequired, fenced };
}

async function checkCapability(input: {
  workerRepo: PostgresKernelRepository;
  tenantId: string;
  failures: string[];
}): Promise<AuthorityProofResult['capability']> {
  const { workerRepo, tenantId, failures } = input;
  const out: AuthorityProofResult['capability'] = {
    replayRejected: false,
    revocationObserved: false,
    rotationObserved: false,
    enterpriseRefusesGenerate: false,
  };

  const mat = ed25519Material(`proof-${randomUUID().slice(0, 8)}`);
  const env = {
    NODE_ENV: 'test',
    [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
    [CAPABILITY_KEY_ID_ENV]: mat.keyId,
    [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
  };

  // Worker LOGIN + schedulerMode: false — production verify/revoke observe path under RLS.
  const processA = createCapabilityAuthority(env, workerRepo, {
    issuer: 'commander-authority-proof',
    audience: 'commander.effect-broker',
  });
  const processB = createCapabilityAuthority(env, workerRepo, {
    issuer: 'commander-authority-proof',
    audience: 'commander.effect-broker',
  });

  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const replayToken = processA.issuer.issue({
    jti: `jti-replay-${randomUUID().slice(0, 8)}`,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-${randomUUID().slice(0, 8)}`,
  });

  await processA.verifier.verify(replayToken);
  try {
    await processB.verifier.verify(replayToken);
    failures.push('capability.replayRejected: second verify did not reject');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/replayed/i.test(msg)) out.replayRejected = true;
    else failures.push(`capability.replayRejected: unexpected error: ${msg}`);
  }

  const revJti = `jti-rev-${randomUUID().slice(0, 8)}`;
  const revToken = processA.issuer.issue({
    jti: revJti,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-rev-${randomUUID().slice(0, 8)}`,
  });
  // Revoke under worker tenant scope (not scheduler BYPASSRLS).
  await processA.revocations.revokeGrant({
    jti: revJti,
    tenantId,
    expiresAt,
    reason: 'authority-proof',
  });
  try {
    await processB.verifier.verify(revToken);
    failures.push('capability.revocationObserved: verify after revoke did not reject');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/revoked/i.test(msg)) out.revocationObserved = true;
    else failures.push(`capability.revocationObserved: unexpected error: ${msg}`);
  }

  // Real JWKS rotation (not merely foreign material):
  // 1–2 dual JWKS → 3 sign/verify with A → 4 retire A → 5 sign/verify with B → 6 reload.
  const keyA = ed25519Material('a');
  const keyB = ed25519Material('b');
  const dualJwks = mergeJwksJson(keyA, keyB);
  const issuerOpts = { issuer: 'commander-authority-proof', audience: 'commander.effect-broker' };

  const authADual = createCapabilityAuthority(
    {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: keyA.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: keyA.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: dualJwks,
    },
    workerRepo,
    issuerOpts,
  );
  const tokenSignedByA = authADual.issuer.issue({
    jti: `jti-rot-a-${randomUUID().slice(0, 8)}`,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-rot-a-${randomUUID().slice(0, 8)}`,
  });

  let dualVerifyOk = false;
  try {
    await authADual.verifier.verify(tokenSignedByA);
    dualVerifyOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`capability.rotationObserved: dual JWKS verify with A failed: ${msg}`);
  }

  const authBOnly = createCapabilityAuthority(
    {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: keyB.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: keyB.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: keyB.jwksJson,
    },
    workerRepo,
    issuerOpts,
  );

  let rotatedAwayRejected = false;
  try {
    await authBOnly.verifier.verify(tokenSignedByA);
    failures.push('capability.rotationObserved: rotated-away kid A still verified under B-only JWKS');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unknown capability token key id|unknown.*kid|key id/i.test(msg)) {
      rotatedAwayRejected = true;
    } else {
      failures.push(`capability.rotationObserved: expected unknown kid for retired A, got: ${msg}`);
    }
  }

  let bTokenOk = false;
  const tokenSignedByB = authBOnly.issuer.issue({
    jti: `jti-rot-b-${randomUUID().slice(0, 8)}`,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-rot-b-${randomUUID().slice(0, 8)}`,
  });
  try {
    await authBOnly.verifier.verify(tokenSignedByB);
    bTokenOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`capability.rotationObserved: B-only JWKS verify with B failed: ${msg}`);
  }

  // Optional reload: second createCapabilityAuthority with B-only JWKS still verifies the
  // same B token (fresh in-memory replay store — proves JWKS/PEM reload, not durable replay).
  let reloadOk = false;
  const authBReload = createCapabilityAuthority(
    {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: keyB.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: keyB.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: keyB.jwksJson,
    },
    new InMemoryKernelRepository(),
    issuerOpts,
  );
  try {
    await authBReload.verifier.verify(tokenSignedByB);
    reloadOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`capability.rotationObserved: post-reload B token verify failed: ${msg}`);
  }

  // Sub-check: unknown/foreign kid still rejected (not sufficient alone for rotationObserved).
  let unknownKidRejected = false;
  const foreign = ed25519Material(`foreign-${randomUUID().slice(0, 8)}`);
  const foreignAuth = createCapabilityAuthority(
    {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: foreign.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: foreign.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: foreign.jwksJson,
    },
    workerRepo,
    issuerOpts,
  );
  const foreignToken = foreignAuth.issuer.issue({
    jti: `jti-foreign-${randomUUID().slice(0, 8)}`,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-f-${randomUUID().slice(0, 8)}`,
  });
  try {
    await authBOnly.verifier.verify(foreignToken);
    failures.push('capability.rotationObserved: unknown kid did not reject');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unknown capability token key id|unknown.*kid|key id/i.test(msg)) {
      unknownKidRejected = true;
    } else {
      failures.push(`capability.rotationObserved: unknown-kid sub-check unexpected error: ${msg}`);
    }
  }

  out.rotationObserved =
    dualVerifyOk && rotatedAwayRejected && bTokenOk && reloadOk && unknownKidRejected;

  // Enterprise / CELL_TIER refuse ephemeral key generation.
  const mem = new InMemoryKernelRepository();
  for (const signal of [
    { COMMANDER_PROFILE: 'enterprise' },
    { COMMANDER_CELL_TIER: 'enterprise' },
    { NODE_ENV: 'production' },
  ] as const) {
    try {
      createCapabilityAuthority({ ...signal }, mem);
      failures.push(
        `capability.enterpriseRefusesGenerate: expected CAPABILITY_AUTHORITY_REQUIRED under ${JSON.stringify(signal)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith(CAPABILITY_AUTHORITY_REQUIRED)) {
        out.enterpriseRefusesGenerate = true;
      } else {
        failures.push(
          `capability.enterpriseRefusesGenerate: unexpected error under ${JSON.stringify(signal)}: ${msg}`,
        );
      }
    }
  }

  return out;
}

async function checkWorkerDsnThreat(input: {
  ownerPool: Pool;
  workerPool: SqlPool;
  workerRepo: PostgresKernelRepository;
  appRepo: PostgresKernelRepository;
  allowedTenant: string;
  failures: string[];
}): Promise<{
  workerDirectInsertRejected: boolean;
  workerDirectUpdateRejected: boolean;
  workerCrossTenantRegisterRejected: boolean;
  peerClaimWithoutSecretRejected: boolean;
  workerIdentityTakeoverRejected: boolean;
  workerRevocationDeleteRejected: boolean;
  claimExecuteRequiresSecret: boolean;
  workerOutsideAllowlistWriteRejected: boolean;
}> {
  const { ownerPool, workerPool, workerRepo, appRepo, allowedTenant, failures } = input;
  let workerDirectInsertRejected = false;
  let workerDirectUpdateRejected = false;
  let workerCrossTenantRegisterRejected = false;
  let peerClaimWithoutSecretRejected = false;
  let workerIdentityTakeoverRejected = false;
  let workerRevocationDeleteRejected = false;
  let claimExecuteRequiresSecret = false;
  let workerOutsideAllowlistWriteRejected = false;

  await seedWorkerAllowedTenants(ownerPool, [allowedTenant]);

  // 0) EXECUTE grants: worker must EXECUTE the p_claim_secret overloads for
  //    claim_next_step / claim_reconcile_effects / claim_outbox_by_topic;
  //    must not EXECUTE any stale overload that omits the secret argument.
  {
    const checkClaimExec = async (
      proname: string,
      hasSecretArg: (args: string) => boolean,
      label: string,
    ): Promise<boolean> => {
      const execRows = await ownerPool.query<{
        args: string;
        worker_exec: boolean;
      }>(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args,
                has_function_privilege('commander_worker', p.oid, 'EXECUTE') AS worker_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = $1`,
        [proname],
      );
      if (execRows.rows.length === 0) {
        failures.push(`database.claimExecuteRequiresSecret: missing function ${proname}`);
        return false;
      }
      const secretOverloads = execRows.rows.filter((r) => hasSecretArg(r.args));
      const staleOverloads = execRows.rows.filter((r) => !hasSecretArg(r.args));
      const workerHasSecretExec = secretOverloads.some((r) => r.worker_exec);
      const workerHasStaleExec = staleOverloads.some((r) => r.worker_exec);
      if (!workerHasSecretExec) {
        failures.push(
          `database.claimExecuteRequiresSecret: worker missing EXECUTE on ${label}`,
        );
        return false;
      }
      if (workerHasStaleExec) {
        failures.push(
          `database.claimExecuteRequiresSecret: worker still has EXECUTE on stale ${proname} without secret`,
        );
        return false;
      }
      return true;
    };

    const nextStepSecret = (args: string): boolean => {
      if (/p_claim_secret/i.test(args)) return true;
      const types = [...args.matchAll(/\b(text|bigint|integer|jsonb)\b/gi)].map((m) =>
        m[1]!.toLowerCase(),
      );
      return types.length === 5 && types[3] === 'text' && types[4] === 'jsonb';
    };
    const reconcileSecret = (args: string): boolean => {
      if (/p_claim_secret/i.test(args)) return true;
      const types = [...args.matchAll(/\b(text|bigint|integer|timestamptz)\b/gi)].map((m) =>
        m[1]!.toLowerCase(),
      );
      // text,bigint,integer,timestamptz,integer,text
      return (
        types.length === 6 &&
        types[0] === 'text' &&
        types[1] === 'bigint' &&
        types[5] === 'text'
      );
    };
    const outboxSecret = (args: string): boolean => {
      if (/p_claim_secret/i.test(args)) return true;
      const types = [...args.matchAll(/\b(text|bigint|integer|timestamptz)\b/gi)].map((m) =>
        m[1]!.toLowerCase(),
      );
      // text,bigint,text,integer,timestamptz,text
      return types.length === 6 && types[0] === 'text' && types[2] === 'text' && types[5] === 'text';
    };

    const okNext = await checkClaimExec('claim_next_step', nextStepSecret, 'claim_next_step with p_claim_secret');
    const okReconcile = await checkClaimExec(
      'claim_reconcile_effects',
      reconcileSecret,
      'claim_reconcile_effects with p_claim_secret',
    );
    const okOutbox = await checkClaimExec(
      'claim_outbox_by_topic',
      outboxSecret,
      'claim_outbox_by_topic with p_claim_secret',
    );
    if (okNext && okReconcile && okOutbox) {
      claimExecuteRequiresSecret = true;
    }
  }

  // 1) Worker LOGIN cannot INSERT into commander_workers (REVOKE INSERT).
  const directId = `proof-direct-${randomUUID().slice(0, 8)}`;
  const wClient = await workerPool.connect();
  try {
    await wClient.query(`SELECT set_config('app.tenant_scope', $1, false)`, [allowedTenant]);
    try {
      await wClient.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','v1','[]',1,'ACTIVE',1,$1,$2::jsonb)`,
        [directId, JSON.stringify([allowedTenant])],
      );
      failures.push('database.workerDirectInsertRejected: INSERT unexpectedly succeeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied/i.test(msg)) workerDirectInsertRejected = true;
      else failures.push(`database.workerDirectInsertRejected: unexpected error: ${msg}`);
    }
    try {
      await wClient.query('SELECT secret_hash FROM commander_worker_claim_secrets LIMIT 1');
      failures.push('database.peerClaimWithoutSecretRejected: worker SELECT claim_secrets unexpectedly succeeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/permission denied/i.test(msg)) {
        failures.push(`commander_worker_claim_secrets SELECT unexpected error: ${msg}`);
      }
    }
  } finally {
    try {
      await wClient.query(`SELECT set_config('app.tenant_scope', '', false)`);
    } catch { /* best-effort pool hygiene */ }
    wClient.release();
  }
  const updateId = `proof-upd-${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
     VALUES ($1,'agent','v1','["agent"]',1,'ACTIVE',1,$1,$2::jsonb)`,
    [updateId, JSON.stringify([allowedTenant])],
  );
  const updClient = await workerPool.connect();
  try {
    await updClient.query(`SELECT set_config('app.tenant_scope', $1, false)`, [allowedTenant]);
    try {
      await updClient.query(
        `UPDATE commander_workers SET tenant_ids = $1::jsonb WHERE id = $2`,
        [JSON.stringify([allowedTenant, 'victim-widen']), updateId],
      );
      failures.push('database.workerDirectUpdateRejected: UPDATE unexpectedly succeeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied/i.test(msg)) workerDirectUpdateRejected = true;
      else failures.push(`database.workerDirectUpdateRejected: unexpected error: ${msg}`);
    }
  } finally {
    try {
      await updClient.query(`SELECT set_config('app.tenant_scope', '', false)`);
    } catch { /* best-effort pool hygiene */ }
    updClient.release();
  }

  // 1c) Worker cannot DELETE revocations (resurrect revoked jti) or erase outbox.
  const revokeJti = `proof-jti-${randomUUID()}`;
  await ownerPool.query(
    `INSERT INTO commander_capability_revocations (tenant_id, jti, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')
     ON CONFLICT DO NOTHING`,
    [allowedTenant, revokeJti],
  );
  let revokeDeleteDenied = false;
  let outboxDeleteDenied = false;
  const delClient = await workerPool.connect();
  try {
    await delClient.query(`SELECT set_config('app.tenant_scope', $1, false)`, [allowedTenant]);
    try {
      await delClient.query(
        `DELETE FROM commander_capability_revocations WHERE tenant_id = $1 AND jti = $2`,
        [allowedTenant, revokeJti],
      );
      failures.push('database.workerRevocationDeleteRejected: DELETE revocations unexpectedly succeeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied/i.test(msg)) revokeDeleteDenied = true;
      else failures.push(`database.workerRevocationDeleteRejected: unexpected error: ${msg}`);
    }
    try {
      await delClient.query(`DELETE FROM commander_outbox WHERE tenant_id = $1`, [allowedTenant]);
      failures.push('database.workerRevocationDeleteRejected: DELETE outbox unexpectedly succeeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied/i.test(msg)) outboxDeleteDenied = true;
      else failures.push(`database.workerRevocationDeleteRejected: outbox unexpected error: ${msg}`);
    }
  } finally {
    try {
      await delClient.query(`SELECT set_config('app.tenant_scope', '', false)`);
    } catch { /* best-effort pool hygiene */ }
    delClient.release();
  }
  if (revokeDeleteDenied && outboxDeleteDenied) {
    workerRevocationDeleteRejected = true;
  }

  // 2) Peer claim + outbox/reconcile secret gates — run BEFORE register_worker
  //    on the shared worker pool (DEFINER register can leave session state that
  //    flakes subsequent claim_next_step under worker LOGIN).
  const peerId = `proof-peer-${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
     VALUES ($1,'agent','v1','["agent"]',4,'ACTIVE',1,$1,$2::jsonb)`,
    [peerId, JSON.stringify([allowedTenant])],
  );
  const peerSecret = await seedWorkerClaimSecret(ownerPool, peerId, 1);
  await ownerPool.query(
    `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
     WHERE tenant_id=$1 AND state IN ('PENDING','RETRY_WAIT','RUNNING')`,
    [allowedTenant],
  );
  await ownerPool.query(
    `UPDATE commander_tenant_execution_usage SET running_steps=0, updated_at=now() WHERE tenant_id=$1`,
    [allowedTenant],
  );
  const peerRun = createRunCommand(allowedTenant, [{ kind: 'agent' }]);
  await appRepo.createRun(peerRun, 'authority-proof');

  const noSecret = await workerRepo.claimNextStep({
    workerId: peerId,
    workerGeneration: 1,
    capabilities: ['agent'],
    leaseTtlMs: 30_000,
  });
  const wrongSecret = await workerRepo.claimNextStep({
    workerId: peerId,
    workerGeneration: 1,
    capabilities: ['agent'],
    leaseTtlMs: 30_000,
    claimSecret: 'peer-guess',
  });
  const withSecret = await workerRepo.claimNextStep({
    workerId: peerId,
    workerGeneration: 1,
    capabilities: ['agent'],
    leaseTtlMs: 30_000,
    claimSecret: peerSecret,
  });
  if (noSecret === null && wrongSecret === null && withSecret !== null) {
    const outboxId = `proof-obx-${randomUUID().slice(0, 8)}`;
    const eventId = `evt-${outboxId}`;
    await ownerPool.query(
      `INSERT INTO commander_events
         (id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, actor, schema_version, payload)
       VALUES ($1,'run',$2,1,'compensation.requested',$3,$2,'authority-proof','v2','{}'::jsonb)`,
      [eventId, `run-${outboxId}`, allowedTenant],
    );
    await ownerPool.query(
      `INSERT INTO commander_outbox (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, available_at)
       VALUES ($1, $2, $3, 'commander.compensation', $4, '{}'::jsonb, 0, 5, now())`,
      [outboxId, eventId, allowedTenant, `cmp/${outboxId}`],
    );
    let outboxNo: unknown[] = [];
    let outboxWrong: unknown[] = [];
    let outboxOk: unknown[] = [];
    try {
      outboxNo = await workerRepo.claimOutboxByTopic('commander.compensation', 10, new Date(), {
        workerId: peerId,
        workerGeneration: 1,
        claimSecret: '',
      });
    } catch {
      outboxNo = [];
    }
    outboxWrong = await workerRepo.claimOutboxByTopic('commander.compensation', 10, new Date(), {
      workerId: peerId,
      workerGeneration: 1,
      claimSecret: 'peer-guess',
    });
    outboxOk = await workerRepo.claimOutboxByTopic('commander.compensation', 10, new Date(), {
      workerId: peerId,
      workerGeneration: 1,
      claimSecret: peerSecret,
    });

    let reconcileNo: unknown[] = [];
    try {
      reconcileNo = await workerRepo.claimReconcileEffects({
        workerId: peerId,
        workerGeneration: 1,
        limit: 5,
        claimSecret: '',
      });
    } catch {
      reconcileNo = [];
    }
    const reconcileWrong = await workerRepo.claimReconcileEffects({
      workerId: peerId,
      workerGeneration: 1,
      limit: 5,
      claimSecret: 'peer-guess',
    });
    const reconcileOk = await workerRepo.claimReconcileEffects({
      workerId: peerId,
      workerGeneration: 1,
      limit: 5,
      claimSecret: peerSecret,
    });

    const outboxSecretOk =
      outboxNo.length === 0 &&
      outboxWrong.length === 0 &&
      outboxOk.some((m) => (m as { id?: string }).id === outboxId);
    const reconcileSecretOk =
      Array.isArray(reconcileNo) &&
      reconcileNo.length === 0 &&
      Array.isArray(reconcileWrong) &&
      reconcileWrong.length === 0 &&
      Array.isArray(reconcileOk);

    if (outboxSecretOk && reconcileSecretOk) {
      peerClaimWithoutSecretRejected = true;
    } else {
      failures.push(
        `database.peerClaimWithoutSecretRejected: outboxOk=${outboxSecretOk} reconcileOk=${reconcileSecretOk} claimed=${outboxOk.length}`,
      );
    }
    await ownerPool.query('DELETE FROM commander_outbox WHERE id = $1', [outboxId]);
    await ownerPool.query('DELETE FROM commander_events WHERE id = $1', [eventId]);
  } else {
    failures.push(
      `database.peerClaimWithoutSecretRejected: noSecret=${noSecret ? 'claimed' : 'null'} wrongSecret=${wrongSecret ? 'claimed' : 'null'} withSecret=${withSecret ? 'ok' : 'null'}`,
    );
  }

  // 3) Outside-allowlist write + register_worker gates (after claim proofs).
  const outsideTenant = `outside-${randomUUID().slice(0, 8)}`;
  const outsideClient = await workerPool.connect();
  try {
    await outsideClient.query('BEGIN');
    await outsideClient.query(`SELECT set_config('app.tenant_scope', $1, true)`, [outsideTenant]);
    try {
      await outsideClient.query(
        `INSERT INTO commander_runs (
           id, tenant_id, intent_hash, work_graph_hash, work_graph_version, policy_snapshot_id, state
         ) VALUES ($1, $2, 'h', 'h', 'v1', 'proof', 'PENDING')`,
        [`proof-outside-${randomUUID().slice(0, 8)}`, outsideTenant],
      );
      failures.push(
        'database.workerOutsideAllowlistWriteRejected: INSERT outside allowlist unexpectedly succeeded',
      );
      await outsideClient.query('COMMIT');
    } catch (err) {
      try { await outsideClient.query('ROLLBACK'); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      if (/row-level security|permission denied/i.test(msg)) {
        workerOutsideAllowlistWriteRejected = true;
      } else {
        failures.push(`database.workerOutsideAllowlistWriteRejected: unexpected error: ${msg}`);
      }
    }
  } finally {
    outsideClient.release();
  }

  const victimId = `proof-victim-${randomUUID().slice(0, 8)}`;
  const regClient = await workerPool.connect();
  try {
    try {
      await regClient.query(
        `SELECT register_worker(
           $1::text, 'agent', 'v1', '["agent"]'::jsonb, '{}'::jsonb, 1, $1::text, $2::jsonb, NULL
         )`,
        [victimId, JSON.stringify(['victim-not-allowed'])],
      );
      failures.push('database.workerCrossTenantRegisterRejected: register_worker unexpectedly succeeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/WORKER_TENANT_NOT_ALLOWED/i.test(msg)) workerCrossTenantRegisterRejected = true;
      else failures.push(`database.workerCrossTenantRegisterRejected: unexpected error: ${msg}`);
    }
  } finally {
    regClient.release();
  }

  // Identity takeover: dedicated short-lived pool so register_worker cannot poison
  // the shared workerRepo pool used by later effect proofs.
  const hijackId = `proof-hijack-${randomUUID().slice(0, 8)}`;
  const workerUrl = deriveRoleDatabaseUrl(
    resolveOwnerDsn(),
    'commander_worker',
    process.env.COMMANDER_WORKER_PASSWORD ?? 'commander_worker',
  );
  const hijackPool = new Pool({ connectionString: workerUrl, max: 1 });
  try {
    const first = await hijackPool.query<{ register_worker: { claim_secret?: string; generation?: number } }>(
      `SELECT register_worker(
         $1::text, 'agent', 'v1', '["agent"]'::jsonb, '{}'::jsonb, 1, $1::text, $2::jsonb, NULL
       ) AS register_worker`,
      [hijackId, JSON.stringify([allowedTenant])],
    );
    const firstSecret = first.rows[0]?.register_worker?.claim_secret;
    if (!firstSecret) {
      failures.push('database.workerIdentityTakeoverRejected: initial register_worker returned no secret');
    } else {
      try {
        await hijackPool.query(
          `SELECT register_worker(
             $1::text, 'agent', 'v9', '["agent"]'::jsonb, '{}'::jsonb, 1,
             'spiffe://evil/attacker', $2::jsonb, NULL
           )`,
          [hijackId, JSON.stringify([allowedTenant])],
        );
        failures.push(
          'database.workerIdentityTakeoverRejected: re-register without previous secret unexpectedly succeeded',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/WORKER_REREGISTER_REQUIRES_SECRET/i.test(msg)) {
          const drained = await hijackPool.query<{ drain_worker: boolean }>(
            `SELECT drain_worker($1::text, 1::bigint, 'guess') AS drain_worker`,
            [hijackId],
          );
          if (drained.rows[0]?.drain_worker === true) {
            failures.push('database.workerIdentityTakeoverRejected: drain_worker without secret succeeded');
          } else {
            workerIdentityTakeoverRejected = true;
          }
        } else {
          failures.push(`database.workerIdentityTakeoverRejected: unexpected error: ${msg}`);
        }
      }
    }
  } finally {
    await hijackPool.end();
  }

  await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])', [
    [directId, victimId, peerId, updateId, hijackId],
  ]);
  await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [
    [directId, victimId, peerId, updateId, hijackId],
  ]);
  await ownerPool.query(
    `DELETE FROM commander_capability_revocations WHERE tenant_id = $1 AND jti = $2`,
    [allowedTenant, revokeJti],
  );

  return {
    workerDirectInsertRejected,
    workerDirectUpdateRejected,
    workerCrossTenantRegisterRejected,
    peerClaimWithoutSecretRejected,
    workerIdentityTakeoverRejected,
    workerRevocationDeleteRejected,
    claimExecuteRequiresSecret,
    workerOutsideAllowlistWriteRejected,
  };
}

export async function runAuthorityProof(): Promise<AuthorityProofResult> {
  const failures: string[] = [];
  const flags = falseFlags();
  const gitSha = resolveGitSha();
  if (gitSha === 'unknown') {
    failures.push('gitSha unknown');
  }

  const ownerDsn = resolveOwnerDsn();
  let ownerPool: Pool | undefined;
  let appPool: (SqlPool & { end: () => Promise<void> }) | undefined;
  let workerPool: (SqlPool & { end: () => Promise<void> }) | undefined;
  const suffix = `${Date.now()}`;
  const tenantA = `proof-a-${suffix}`;
  const tenantB = `proof-b-${suffix}`;
  const tenantCap = `proof-cap-${suffix}`;

  try {
    ownerPool = new Pool({ connectionString: ownerDsn, max: 4 });
    await ownerPool.query('SELECT 1');
    await runKernelMigrations(ownerPool);

    await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
    await ensureRoleLogin(ownerPool, 'commander_scheduler', schedulerPassword);
    await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);

    const appUrl = deriveRoleDatabaseUrl(ownerDsn, 'commander_app', appPassword);
    const workerUrl = deriveRoleDatabaseUrl(ownerDsn, 'commander_worker', workerPassword);

    appPool = createLoginPool(appUrl);
    workerPool = createLoginPool(workerUrl);

    const appRepo = new PostgresKernelRepository(appPool);
    const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });

    // Worker RLS now requires allowlist membership for any tenant-scoped write.
    await seedWorkerAllowedTenants(ownerPool, [tenantA, tenantB, tenantCap]);

    flags.database.rlsEnabled = await checkRlsEnabled(ownerPool, failures);
    flags.database.rolesSeparated = await checkRolesSeparated({
      ownerPool,
      appPool,
      workerPool,
      appRepo,
      workerRepo,
      tenantA,
      tenantB,
      failures,
    });

    const workerThreat = await checkWorkerDsnThreat({
      ownerPool,
      workerPool,
      workerRepo,
      appRepo,
      allowedTenant: tenantA,
      failures,
    });
    flags.database.workerDirectInsertRejected = workerThreat.workerDirectInsertRejected;
    flags.database.workerDirectUpdateRejected = workerThreat.workerDirectUpdateRejected;
    flags.database.workerCrossTenantRegisterRejected =
      workerThreat.workerCrossTenantRegisterRejected;
    flags.database.peerClaimWithoutSecretRejected = workerThreat.peerClaimWithoutSecretRejected;
    flags.database.workerIdentityTakeoverRejected = workerThreat.workerIdentityTakeoverRejected;
    flags.database.workerRevocationDeleteRejected = workerThreat.workerRevocationDeleteRejected;
    flags.database.claimExecuteRequiresSecret = workerThreat.claimExecuteRequiresSecret;
    flags.database.workerOutsideAllowlistWriteRejected =
      workerThreat.workerOutsideAllowlistWriteRejected;

    const effect = await checkEffectBindings({
      ownerPool,
      appRepo,
      workerRepo,
      tenantId: tenantA,
      failures,
    });
    flags.effect = effect;

    flags.capability = await checkCapability({
      workerRepo,
      tenantId: tenantCap,
      failures,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`connect/migrate/proof error: ${msg}`);
  } finally {
    try {
      if (ownerPool) {
        await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
          [tenantA, tenantB, tenantCap],
        ]);
        await ownerPool.query(
          `DELETE FROM commander_capability_replays WHERE tenant_id = ANY($1::text[])`,
          [[tenantCap]],
        );
        await ownerPool.query(
          `DELETE FROM commander_capability_revocations WHERE tenant_id = ANY($1::text[])`,
          [[tenantCap]],
        );
        await ownerPool.query(
          `DELETE FROM commander_workers WHERE id LIKE $1 OR id LIKE $2 OR id LIKE $3 OR id LIKE $4 OR id LIKE $5`,
          ['proof-worker-%', 'proof-fence-%', 'proof-direct-%', 'proof-victim-%', 'proof-peer-%'],
        );
        await ownerPool.query(
          `DELETE FROM commander_worker_claim_secrets WHERE worker_id LIKE $1 OR worker_id LIKE $2 OR worker_id LIKE $3 OR worker_id LIKE $4 OR worker_id LIKE $5`,
          ['proof-worker-%', 'proof-fence-%', 'proof-direct-%', 'proof-victim-%', 'proof-peer-%'],
        );
        await ownerPool.query(
          `DELETE FROM commander_worker_allowed_tenants WHERE tenant_id = ANY($1::text[])`,
          [[tenantA, tenantB, tenantCap]],
        );
      }
    } catch {
      /* cleanup best-effort */
    }
    await appPool?.end().catch(() => undefined);
    await workerPool?.end().catch(() => undefined);
    await ownerPool?.end().catch(() => undefined);
  }

  return finalizeResult({ gitSha, flags, failures });
}

async function main(): Promise<void> {
  const result = await runAuthorityProof();
  // Exact artifact bytes (canonical JSON + trailing newline) — sha256 matches file on disk.
  const artifactBody = `${canonicalJson(result)}\n`;
  const hash = sha256Hex(artifactBody);

  await mkdir(dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, artifactBody, 'utf8');

  // Human-readable summary on stderr; machine JSON on stdout.
  console.error(`authority-closure-proof: ${result.evidenceLevel} passed=${result.passed}`);
  console.error(`artifact: ${ARTIFACT_PATH}`);
  console.error(`sha256: ${hash}`);
  if (result.failures.length > 0) {
    for (const f of result.failures) console.error(`  - ${f}`);
  }
  process.stdout.write(artifactBody);

  if (!result.passed || result.evidenceLevel !== 'PROVEN') {
    process.exit(1);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
