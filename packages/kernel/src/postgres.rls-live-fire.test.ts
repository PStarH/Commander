/**
 * PostgreSQL RLS live-fire tests — WP90-3.
 *
 * These tests exercise the real PostgreSQL kernel with role-separated
 * connections:
 *   - commander_owner: runs migrations and test setup
 *   - commander_app: API-replica role, subject to FORCE RLS
 *   - commander_scheduler: scheduler/recovery role, BYPASSRLS
 *
 * Acceptance gates:
 *   - non-owner RLS live-fire: 0 leaks
 *   - generation rollover stale writes: 0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import { Pool } from 'pg';
import { PostgresKernelRepository } from './postgres.js';
import type { SqlClient, SqlPool } from './postgres.js';
import { runKernelMigrations } from './migrations.js';
import { TENANT_TABLES } from './schema.js';
import { seedWorkerClaimSecret, seedWorkerAllowedTenants } from './seedWorkerClaimSecret.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;
/** Bench/init convention: password matches role name unless overridden. */
const appPassword = process.env.COMMANDER_APP_PASSWORD ?? 'commander_app';
const schedulerPassword = process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler';
const workerPassword = process.env.COMMANDER_WORKER_PASSWORD ?? 'commander_worker';

function deriveRoleDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

const workerDatabaseUrl =
  process.env.COMMANDER_WORKER_DATABASE_URL ??
  (databaseUrl ? deriveRoleDatabaseUrl(databaseUrl, 'commander_worker', workerPassword) : undefined);
const appDatabaseUrl = databaseUrl
  ? deriveRoleDatabaseUrl(databaseUrl, 'commander_app', appPassword)
  : undefined;
const schedulerDatabaseUrl = databaseUrl
  ? deriveRoleDatabaseUrl(databaseUrl, 'commander_scheduler', schedulerPassword)
  : undefined;

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
  }));
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(JSON.stringify(stepDefs)).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'rls-live-fire-policy',
    steps: stepDefs,
  };
}

/** True LOGIN pool — session_user is the role (unlike SET SESSION ROLE from owner). */
function createLoginPool(roleDatabaseUrl: string): SqlPool & { end: () => Promise<void> } {
  const pool = new Pool({ connectionString: roleDatabaseUrl, max: 2 });
  return {
    connect: async () => (await pool.connect()) as SqlClient,
    end: () => pool.end(),
  };
}

/**
 * KERNEL_ROLES_SQL may create NOLOGIN-if-missing; deploy init / Helm ConfigMap use LOGIN.
 * Bench DSN fidelity: enable LOGIN+password for app/scheduler/worker before true-LOGIN pools.
 */
async function ensureRoleLogin(ownerPool: Pool, role: string, password: string): Promise<void> {
  const escaped = password.replace(/'/g, "''");
  await ownerPool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${escaped}'`);
}

describe('Postgres RLS live-fire', { skip: !databaseUrl || !workerDatabaseUrl }, () => {
  let ownerPool: Pool;
  let appPoolA: SqlPool & { end: () => Promise<void> };
  let appPoolB: SqlPool & { end: () => Promise<void> };
  let schedulerPool: SqlPool & { end: () => Promise<void> };
  let workerPool: SqlPool & { end: () => Promise<void> };
  let repoA: PostgresKernelRepository;
  let repoB: PostgresKernelRepository;
  let schedulerRepo: PostgresKernelRepository;
  let workerRepo: PostgresKernelRepository;
  const tenantA = `tenant-a-${Date.now()}`;
  const tenantB = `tenant-b-${Date.now()}`;
  const workerA = `worker-a-${Date.now()}`;
  const workerB = `worker-b-${Date.now()}`;
  const schedulerA = `scheduler-a-${Date.now()}`;
  const schedulerB = `scheduler-b-${Date.now()}`;
  /** Plaintext claim secrets for suite workers (worker LOGIN path requires claimSecret). */
  const claimSecrets = new Map<string, string>();

  before(async () => {
    if (!databaseUrl || !workerDatabaseUrl) return;
    ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });

    // Apply migrations as owner, then verify roles exist.
    await runKernelMigrations(ownerPool);
    const roles = await ownerPool.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('commander_owner','commander_app','commander_scheduler','commander_worker')");
    const names = roles.rows.map((r) => r.rolname);
    assert.ok(names.includes('commander_app'), 'commander_app role must exist');
    assert.ok(names.includes('commander_scheduler'), 'commander_scheduler role must exist');
    assert.ok(names.includes('commander_worker'), 'commander_worker role must exist');

    // True LOGIN DSNs (session_user=role). Deploy init already LOGIN; bench may be NOLOGIN.
    // Do NOT use owner+SET SESSION ROLE for worker/scheduler identity checks.
    await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
    await ensureRoleLogin(ownerPool, 'commander_scheduler', schedulerPassword);
    await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);

    appPoolA = createLoginPool(appDatabaseUrl!);
    appPoolB = createLoginPool(appDatabaseUrl!);
    schedulerPool = createLoginPool(schedulerDatabaseUrl!);
    workerPool = createLoginPool(workerDatabaseUrl);

    repoA = new PostgresKernelRepository(appPoolA);
    repoB = new PostgresKernelRepository(appPoolB);
    schedulerRepo = new PostgresKernelRepository(schedulerPool, { schedulerMode: true });
    // Worker runtime role: schedulerMode MUST be false (RLS-enforced, no BYPASSRLS).
    workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });

    // Worker LOGIN RLS requires cell allowlist membership for tenant-scoped I/O.
    await seedWorkerAllowedTenants(ownerPool, [tenantA, tenantB]);

    // Register workers as owner (workers are cross-tenant entities).
    // We need workers for the generation rollover test (workerA), the isolation
    // test (workerB), and the SKIP LOCKED contention test (2 schedulers + 8 racers).
    const raceWorkers = Array.from({ length: 8 }, (_, i) => `${workerA}-race-${i}`);
    const workerIds = [workerA, workerB, schedulerA, schedulerB, ...raceWorkers];
    const values = workerIds
      .map((id) => `('${id}','agent','v1','["agent"]',4,'ACTIVE',1,'${id}','[${JSON.stringify(tenantA)},${JSON.stringify(tenantB)}]'::jsonb)`)
      .join(',');
    await ownerPool.query(
      `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids) VALUES ${values}`
    );
    for (const id of workerIds) {
      claimSecrets.set(id, await seedWorkerClaimSecret(ownerPool, id, 1));
    }
  });

  after(async () => {
    if (!databaseUrl) return;
    const raceWorkers = Array.from({ length: 8 }, (_, i) => `${workerA}-race-${i}`);
    const suiteWorkerIds = [workerA, workerB, schedulerA, schedulerB, ...raceWorkers];
    await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB]]);
    await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])', [suiteWorkerIds]);
    await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [suiteWorkerIds]);
    await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id = ANY($1::text[])', [
      [tenantA, tenantB],
    ]);
    await appPoolA?.end();
    await appPoolB?.end();
    await schedulerPool?.end();
    await workerPool?.end();
    await ownerPool?.end();
  });

  it('every tenant table has RLS ENABLED and FORCED (catalog assertion)', async () => {
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
    assert.equal(rows.rows.length, TENANT_TABLES.length, 'all tenant tables must exist');
    for (const row of rows.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} must ENABLE RLS`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} must FORCE RLS`);
    }
  });

  it('raw app role cannot read or write across tenants under RLS', async () => {
    const runA = createRunCommand(tenantA, [{ kind: 'agent' }]);
    await repoA.createRun(runA, 'live-fire');

    const client = await appPoolA.connect();
    try {
      await client.query(`SELECT set_config('app.tenant_scope', $1, false)`, [tenantA]);
      const leaked = await client.query(
        `SELECT id FROM commander_runs WHERE tenant_id=$1`,
        [tenantB],
      );
      assert.deepEqual(leaked.rows, [], 'app role scoped to A must not read B rows');
      await assert.rejects(
        client.query(
          `INSERT INTO commander_runs (id, tenant_id, intent_hash, work_graph_hash,
            work_graph_version, policy_snapshot_id, state)
            VALUES ('cross-${Date.now()}', $1, 'i', 'g', 'v1', 'p1', 'PENDING')`,
          [tenantB],
        ),
        'app role scoped to A must not INSERT a B row (WITH CHECK)',
      );
    } finally {
      client.release();
    }
  });

  it('runtime roles have no BYPASSRLS/superuser except commander_scheduler', async () => {
    const rows = await ownerPool.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
       WHERE rolname IN ('commander_app','commander_worker','commander_scheduler')`,
    );
    const byName = new Map(rows.rows.map((r) => [r.rolname, r]));
    assert.equal(byName.get('commander_app')?.rolbypassrls, false, 'commander_app must NOT bypass RLS');
    assert.equal(byName.get('commander_worker')?.rolbypassrls, false, 'commander_worker must NOT bypass RLS');
    // Every runtime role must be a non-superuser.
    for (const name of ['commander_app', 'commander_worker', 'commander_scheduler']) {
      assert.equal(byName.get(name)?.rolsuper, false, `${name} must not be a superuser`);
    }
  });

  it('worker LOGIN cannot INSERT commander_workers (P0 DSN threat)', async () => {
    const client = await workerPool.connect();
    try {
      await client.query(`SELECT set_config('app.tenant_scope', $1, false)`, [tenantA]);
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
             VALUES ($1,'agent','v1','[]',1,'ACTIVE',1,$1,$2::jsonb)`,
            [`worker-direct-${Date.now()}`, JSON.stringify([tenantA])],
          ),
        /permission denied/i,
        'commander_worker must not INSERT commander_workers',
      );
    } finally {
      client.release();
    }
  });

  it('worker LOGIN DSN (schedulerMode false) claims allowed tenant but not an outside tenant', async () => {
    const workerId = `worker-role-${Date.now()}`;
    // Worker is authorized only for tenantA in its durable registration.
    // Claim no longer accepts caller tenantIds — durable authz only.
    await ownerPool.query(
      `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
       VALUES ($1,'agent','v1','["agent"]',4,'ACTIVE',1,$1,$2::jsonb)`,
      [workerId, JSON.stringify([tenantA])],
    );
    const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);
    try {
      // Drain suite leftovers so this case has exactly one allowed + one outside candidate.
      await ownerPool.query(
        `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
         WHERE tenant_id = ANY($1::text[]) AND state IN ('PENDING','RETRY_WAIT')`,
        [[tenantA, tenantB]],
      );

      // Prove true LOGIN identity (not owner + SET SESSION ROLE).
      const identityClient = await workerPool.connect();
      try {
        const identity = await identityClient.query<{ session_user: string; current_user: string }>(
          'SELECT session_user::text AS session_user, current_user::text AS current_user',
        );
        assert.equal(identity.rows[0]?.session_user, 'commander_worker', 'session_user must be commander_worker LOGIN');
        assert.equal(identity.rows[0]?.current_user, 'commander_worker', 'current_user must be commander_worker before repo wrap');
        // No membership: worker must not be able to SET ROLE commander_app.
        await assert.rejects(
          identityClient.query('SET ROLE commander_app'),
          /permission denied/i,
          'commander_worker must not be granted commander_app membership',
        );
        // Worker LOGIN must not SELECT claim-secret hashes.
        await assert.rejects(
          identityClient.query('SELECT secret_hash FROM commander_worker_claim_secrets WHERE worker_id=$1', [workerId]),
          /permission denied/i,
          'commander_worker must not SELECT commander_worker_claim_secrets',
        );
      } finally {
        identityClient.release();
      }

      const runAllowed = createRunCommand(tenantA, [{ kind: 'agent' }]);
      const runOutside = createRunCommand(tenantB, [{ kind: 'agent' }]);
      await repoA.createRun(runAllowed, 'live-fire');
      await repoB.createRun(runOutside, 'live-fire');

      // Read isolation under the worker's explicit allowed tenant list.
      assert.ok(await workerRepo.getRun(runAllowed.id, tenantA), 'worker must read an allowed-tenant run');
      assert.equal(
        await workerRepo.getRun(runOutside.id, tenantA),
        null,
        'worker scoped to allowed tenants must not read an outside-tenant run',
      );

      // App role must not EXECUTE claim_next_step (worker-only privilege).
      await assert.rejects(
        () => repoA.claimNextStep({
          workerId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret,
        }),
        /permission denied/i,
        'commander_app must not EXECUTE claim_next_step',
      );

      const claimAllowed = await workerRepo.claimNextStep({
        workerId,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret,
      });
      assert.ok(claimAllowed, 'worker LOGIN must claim via claim_next_step without caller tenantIds');
      assert.equal(claimAllowed!.tenantId, tenantA);

      // Passing tenantIds must not widen durable authz (ignored on worker path).
      const claimOutside = await workerRepo.claimNextStep({
        workerId,
        workerGeneration: 1,
        tenantIds: [tenantB],
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret,
      });
      assert.equal(claimOutside, null, 'worker must not claim outside durable tenant_ids even if tenantIds passed');

      // Outside step remains claimable only for a worker authorized to tenantB.
      const outsideStep = await schedulerRepo.getStep(runOutside.steps[0]!.id, tenantB);
      assert.equal(outsideStep?.state, 'PENDING', 'outside tenant step must remain unclaimed');
    } finally {
      await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [workerId]);
      await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
    }
  });

  it('worker LOGIN reads app-managed allowlist + claims reconcile effects; app cannot claim', async () => {
    const suffix = `${Date.now()}`;
    const allowTenant = `allow-${suffix}`;
    const reconWorker = `recon-w-${suffix}`;
    const run = createRunCommand(allowTenant, [{ kind: 'agent' }]);
    const effectId = `effect-recon-${suffix}`;

    await seedWorkerAllowedTenants(ownerPool, [allowTenant]);
    await ownerPool.query(
      `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
       VALUES ($1,'agent','v1','["agent"]',2,'ACTIVE',1,$1,$2::jsonb)`,
      [reconWorker, JSON.stringify([allowTenant])],
    );
    const claimSecret = await seedWorkerClaimSecret(ownerPool, reconWorker, 1);

    try {
      assert.equal(await workerRepo.isActionAllowed(allowTenant, 'http.post'), false);
      await repoA.setAllowlistEntry(allowTenant, 'http.post', true);
      assert.equal(await workerRepo.isActionAllowed(allowTenant, 'http.post'), true);
      await repoA.ensureAllowlistDefault(allowTenant, 'llm.*', true);
      assert.equal(await workerRepo.isActionAllowed(allowTenant, 'llm.openai'), true);
      await workerRepo.incrementQuota({ tenantId: allowTenant, actionClass: 'http' });
      assert.equal((await workerRepo.getQuota(allowTenant, 'http')).countUsed, 1);

      await repoA.createRun(run, 'live-fire');
      // Use worker scoped to allowTenant — claim via durable authz.
      const claimed = await workerRepo.claimNextStep({
        workerId: reconWorker,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret,
      });
      assert.ok(claimed?.lease);
      const admitted = await repoA.admitEffect({
        id: effectId,
        runId: run.id,
        stepId: claimed!.id,
        tenantId: allowTenant,
        type: 'http.post',
        idempotencyKey: `recon-${suffix}`,
        policyDecisionId: 'allow',
        policySnapshotId: 'rls-live-fire-policy',
        actionDigest: 'c'.repeat(64),
        request: {},
        lease: claimed!.lease!,
        actor: reconWorker,
      });
      assert.ok(admitted.admitted);
      await repoA.markEffectCompletionUnknown({
        effectId,
        tenantId: allowTenant,
        reason: 'timeout',
        actor: reconWorker,
      });
      await repoA.requestReconcile({
        effectId,
        tenantId: allowTenant,
        actor: 'live-fire',
        reconcileAfter: new Date(Date.now() - 1_000).toISOString(),
      });

      await assert.rejects(
        () => repoA.claimReconcileEffects({
          limit: 5,
          now: new Date(),
          workerId: reconWorker,
          workerGeneration: 1,
          claimSecret,
        }),
        /permission denied/i,
        'commander_app must not EXECUTE claim_reconcile_effects',
      );

      assert.deepEqual(
        await workerRepo.claimReconcileEffects({
          limit: 5,
          now: new Date(),
          workerId: reconWorker,
          workerGeneration: 1,
          claimSecret: 'wrong-secret',
        }),
        [],
        'wrong claimSecret must claim no reconcile effects',
      );

      const effects = await workerRepo.claimReconcileEffects({
        limit: 5,
        now: new Date(),
        workerId: reconWorker,
        workerGeneration: 1,
        claimSecret,
      });
      assert.equal(effects.length, 1);
      assert.equal(effects[0]!.effect.id, effectId);
      assert.equal(effects[0]!.effect.tenantId, allowTenant);
    } finally {
      await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id=$1', [allowTenant]);
      await ownerPool.query('DELETE FROM commander_effect_allowlist WHERE tenant_id=$1', [allowTenant]);
      await ownerPool.query('DELETE FROM commander_effect_quota WHERE tenant_id=$1', [allowTenant]);
      await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [reconWorker]);
      await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [reconWorker]);
      await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [allowTenant]);
    }
  });

  it('claim_next_step fails closed for empty authz, stale generation, inactive worker, and wrong claimSecret', async () => {
    const suffix = `${Date.now()}`;
    const tenantX = `claim-authz-x-${suffix}`;
    const tenantY = `claim-authz-y-${suffix}`;
    const emptyId = `worker-empty-${suffix}`;
    const staleId = `worker-stale-${suffix}`;
    const inactiveId = `worker-inactive-${suffix}`;
    const multiId = `worker-multi-${suffix}`;
    const starId = `worker-star-${suffix}`;
    const peerId = `worker-peer-${suffix}`;
    await ownerPool.query(
      `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids) VALUES
       ($1,'agent','v1','["agent"]',2,'ACTIVE',1,$1,'[]'::jsonb),
       ($2,'agent','v1','["agent"]',2,'ACTIVE',2,$2,$5::jsonb),
       ($3,'agent','v1','["agent"]',2,'DRAINING',1,$3,$5::jsonb),
       ($4,'agent','v1','["agent"]',2,'ACTIVE',1,$4,$6::jsonb),
       ($7,'agent','v1','["agent"]',2,'ACTIVE',1,$7,'["*"]'::jsonb),
       ($8,'agent','v1','["agent"]',2,'ACTIVE',1,$8,$5::jsonb)`,
      [emptyId, staleId, inactiveId, multiId, JSON.stringify([tenantX]), JSON.stringify([tenantX, tenantY]), starId, peerId],
    );
    const emptySecret = await seedWorkerClaimSecret(ownerPool, emptyId, 1);
    const staleSecret = await seedWorkerClaimSecret(ownerPool, staleId, 2);
    const inactiveSecret = await seedWorkerClaimSecret(ownerPool, inactiveId, 1);
    const multiSecret = await seedWorkerClaimSecret(ownerPool, multiId, 1);
    const starSecret = await seedWorkerClaimSecret(ownerPool, starId, 1);
    const peerSecret = await seedWorkerClaimSecret(ownerPool, peerId, 1);
    try {
      const runX = createRunCommand(tenantX, [{ kind: 'agent' }]);
      const runY = createRunCommand(tenantY, [{ kind: 'agent' }]);
      await repoA.createRun(runX, 'live-fire');
      await repoB.createRun(runY, 'live-fire');

      assert.equal(
        await workerRepo.claimNextStep({ workerId: emptyId, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: emptySecret }),
        null,
        'empty durable tenant_ids must claim nothing',
      );
      assert.equal(
        await workerRepo.claimNextStep({ workerId: staleId, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: staleSecret }),
        null,
        'stale workerGeneration must claim nothing',
      );
      assert.equal(
        await workerRepo.claimNextStep({ workerId: inactiveId, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: inactiveSecret }),
        null,
        'inactive worker must claim nothing',
      );
      assert.equal(
        await workerRepo.claimNextStep({ workerId: starId, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: starSecret }),
        null,
        "durable tenant_ids=['*'] must fail closed (not expand)",
      );

      const peerRun = createRunCommand(tenantX, [{ kind: 'agent' }]);
      await repoA.createRun(peerRun, 'live-fire');
      assert.equal(
        await workerRepo.claimNextStep({
          workerId: peerId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret: 'wrong-secret',
        }),
        null,
        'wrong claimSecret must claim nothing',
      );
      assert.equal(
        await workerRepo.claimNextStep({
          workerId: peerId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
        }),
        null,
        'peer/missing claimSecret must claim nothing',
      );
      const peerHappy = await workerRepo.claimNextStep({
        workerId: peerId,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret: peerSecret,
      });
      assert.ok(peerHappy, 'correct claimSecret must allow claim');
      assert.equal(peerHappy!.tenantId, tenantX);

      const first = await workerRepo.claimNextStep({
        workerId: multiId,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret: multiSecret,
      });
      assert.ok(first, 'multi-tenant durable authz must claim within stored tenant_ids');
      assert.ok([tenantX, tenantY].includes(first!.tenantId));

      const second = await workerRepo.claimNextStep({
        workerId: multiId,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret: multiSecret,
      });
      assert.ok(second, 'multi-tenant worker must claim the other authorized tenant');
      assert.ok([tenantX, tenantY].includes(second!.tenantId));
      assert.notEqual(first!.tenantId, second!.tenantId);
    } finally {
      await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantX, tenantY]]);
      const ids = [emptyId, staleId, inactiveId, multiId, starId, peerId];
      await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])', [ids]);
      await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [ids]);
    }
  });

  it('tenant A/B read/write/cancel/effect/timer/outbox isolation: 0 leaks', async () => {
    const runA = createRunCommand(tenantA, [{ kind: 'agent' }]);
    const runB = createRunCommand(tenantB, [{ kind: 'agent' }]);

    await repoA.createRun(runA, 'live-fire');
    await repoB.createRun(runB, 'live-fire');

    // Tenant A must not read tenant B's data when scoped to tenant A.
    assert.equal(await repoA.getRun(runB.id, tenantA), null, 'A must not read B run');
    assert.equal(await repoA.getStep(runB.steps[0]!.id, tenantA), null, 'A must not read B step');
    assert.deepEqual(await repoA.listEvents(runB.id, tenantA), [], 'A must not read B events');

    // Tenant A must read its own run; B must read B's run.
    assert.ok(await repoA.getRun(runA.id, tenantA), 'A must read A run');
    assert.ok(await repoB.getRun(runB.id, tenantB), 'B must read B run');

    // Cancellation scoped to tenant: A can cancel A, but not B (even if A knows B's id).
    assert.ok(await repoA.cancelRun(runA.id, tenantA, 'live-fire'));
    assert.equal(await repoA.cancelRun(runB.id, tenantA, 'live-fire'), null, 'A cannot cancel B run');

    // Timer creation and read scoped to tenant.
    const timerA = await repoA.createTimer({ runId: runA.id, stepId: runA.steps[0]!.id, tenantId: tenantA, firesAt: new Date(Date.now() + 60_000), timerType: 'RETRY_DELAY', payload: {} }, 'live-fire');
    assert.ok(timerA);
    assert.ok(await repoA.cancelTimer(timerA.id, tenantA), 'A can cancel A timer');
    const timerB = await repoB.createTimer({ runId: runB.id, stepId: runB.steps[0]!.id, tenantId: tenantB, firesAt: new Date(Date.now() + 60_000), timerType: 'RETRY_DELAY', payload: {} }, 'live-fire');
    assert.ok(timerB);
    assert.equal(await repoA.cancelTimer(timerB.id, tenantA), false, 'A cannot cancel B timer scoped as A');

    // Outbox: scheduler can see both; app only sees its own tenant when scoped.
    // Dirty shared DBs may have a large claimable backlog ahead of this suite's
    // tenants (ORDER BY created_at LIMIT N) — drain until suite tenants appear.
    const seenA = new Set<string>();
    const seenB = new Set<string>();
    for (let i = 0; i < 50 && (seenA.size === 0 || seenB.size === 0); i++) {
      const batch = await schedulerRepo.claimOutbox(200);
      if (batch.length === 0) break;
      for (const m of batch) {
        if (m.tenantId === tenantA) seenA.add(m.id);
        if (m.tenantId === tenantB) seenB.add(m.id);
      }
    }
    assert.ok(seenA.size > 0, 'scheduler must see A outbox');
    assert.ok(seenB.size > 0, 'scheduler must see B outbox');
  });

  it('2 schedulers + 10 workers contend on single PostgreSQL with SKIP LOCKED: exactly one claim', async () => {
    // Race workers are durable-authorized for tenantA+tenantB; drain both so this
    // race has exactly one claimable candidate (the run created below).
    await ownerPool.query(
      `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
       WHERE tenant_id = ANY($1::text[]) AND state IN ('PENDING','RETRY_WAIT')`,
      [[tenantA, tenantB]],
    );

    const run = createRunCommand(tenantA, [{ kind: 'agent' }]);
    await repoA.createRun(run, 'live-fire');

    const claims = await Promise.all([
      // Two scheduler-mode repos race for the same step.
      schedulerRepo.claimNextStep({ workerId: schedulerA, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 }),
      schedulerRepo.claimNextStep({ workerId: schedulerB, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 }),
      // Eight worker-mode racers (RPC claim; durable authz + claimSecret, no caller tenantIds).
      ...Array.from({ length: 8 }, (_, i) => {
        const id = `${workerA}-race-${i}`;
        return workerRepo.claimNextStep({
          workerId: id,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret: claimSecrets.get(id),
        });
      }),
    ]);

    const winners = claims.filter((c) => c !== null);
    assert.equal(winners.length, 1, 'exactly one worker may claim the step');
  });

  it('rejects stale worker generation on claim/heartbeat/complete/fail/effect', async () => {
    const run = createRunCommand(tenantA, [{ kind: 'agent' }]);
    await repoA.createRun(run, 'live-fire');

    const secretGen1 = claimSecrets.get(workerA)!;
    const claimed = await workerRepo.claimNextStep({
      workerId: workerA,
      workerGeneration: 1,
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
      claimSecret: secretGen1,
    });
    assert.ok(claimed);
    assert.equal(claimed!.lease!.workerGeneration, 1);

    // Rollover worker generation + re-seed claim secret for the new generation.
    await ownerPool.query('UPDATE commander_workers SET generation=2 WHERE id=$1', [workerA]);
    const secretGen2 = await seedWorkerClaimSecret(ownerPool, workerA, 2);
    claimSecrets.set(workerA, secretGen2);

    // Old generation claim rejected.
    assert.equal(
      await workerRepo.claimNextStep({
        workerId: workerA,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret: secretGen1,
      }),
      null,
      'stale generation claim must fail',
    );

    // Old generation heartbeat/complete/fail rejected.
    assert.equal(await repoA.heartbeatStep(claimed!.id, claimed!.tenantId, claimed!.lease!, 30_000), null, 'stale generation heartbeat must fail');
    assert.equal(await repoA.completeStep({ stepId: claimed!.id, tenantId: claimed!.tenantId, lease: claimed!.lease!, expectedVersion: claimed!.version, output: {}, actor: workerA }), null, 'stale generation complete must fail');
    assert.equal(
      await repoA.failStep({ stepId: claimed!.id, tenantId: claimed!.tenantId, lease: claimed!.lease!, expectedVersion: claimed!.version, error: { code: 'TEST', message: 'test', retryable: false }, actor: workerA }),
      null,
      'stale generation fail must fail',
    );

    // Effect admission/completion with stale generation rejected on a fresh run.
    const effectRun = createRunCommand(tenantA, [{ kind: 'agent' }]);
    await repoA.createRun(effectRun, 'live-fire');
    const effectClaim = await workerRepo.claimNextStep({
      workerId: workerA,
      workerGeneration: 2,
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
      claimSecret: secretGen2,
    });
    assert.ok(effectClaim);
    assert.equal(effectClaim!.lease!.workerGeneration, 2);

    const effect = await repoA.admitEffect({
      id: `effect-${Date.now()}`,
      runId: effectRun.id, stepId: effectClaim!.id, tenantId: tenantA,
      type: 'http', idempotencyKey: 'rls-test-1', policyDecisionId: 'allow',
      policySnapshotId: 'rls-live-fire-policy',
      actionDigest: 'a'.repeat(64),
      request: { url: 'https://example.com' },
      lease: effectClaim!.lease!, actor: workerA,
    });
    assert.ok(effect.admitted);

    // Roll over again.
    await ownerPool.query('UPDATE commander_workers SET generation=3 WHERE id=$1', [workerA]);
    claimSecrets.set(workerA, await seedWorkerClaimSecret(ownerPool, workerA, 3));
    const staleEffectLease = effectClaim!.lease!;
    assert.equal(
      await repoA.completeEffect(effect.effect!.id, tenantA, staleEffectLease, { status: 'ok' }, workerA),
      null,
      'stale generation effect completion must fail',
    );
  });

  it('app role cannot ALTER TABLE DISABLE RLS, read pg_authid, or alter policy', async () => {
    const client = await appPoolA.connect();
    try {
      // app role must not disable RLS.
      await assert.rejects(
        client.query('ALTER TABLE commander_runs DISABLE ROW LEVEL SECURITY'),
        /must be owner|permission denied/i,
        'app role must not disable RLS',
      );

      // app role must not read system catalogs containing secrets.
      await assert.rejects(
        client.query('SELECT * FROM pg_authid'),
        /permission denied/i,
        'app role must not read pg_authid',
      );

      // app role must not drop policies.
      await assert.rejects(
        client.query('DROP POLICY commander_tenant_isolation ON commander_runs'),
        /must be owner|permission denied/i,
        'app role must not drop policy',
      );
    } finally {
      client.release();
    }
  });

  it('migration rejected when run as app role', async () => {
    await assert.rejects(
      runKernelMigrations(appPoolA as unknown as SqlPool),
      /app role is not the migration owner/i,
      'migrations must reject app role',
    );
  });
});
