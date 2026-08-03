#!/usr/bin/env tsx
/**
 * L4-B dual-process compensation race — kernel-ops publisher ∥ adapter-ops consumer.
 *
 *   pnpm cell:compensation-dual-race [--compose-up] [--seed=24] [--help]
 *
 * Requires COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL (or --compose-up with POSTGRES_PASSWORD).
 * Spec: 2026-07-20-to100-w2-compensation-spec.md §5.1 — deadlineMs default 120000.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { runKernelMigrations } from '../packages/kernel/src/migrations.js';
import { KERNEL_COMPENSATION_TOPIC } from '../packages/kernel/src/ops/compensationConsumer.js';
import { canonicalCompensationHash } from '../packages/kernel/src/ops/compensationAuthority.js';
import {
  PostgresKernelRepository,
  PostgresTenantContextAuthority,
} from '../packages/kernel/src/postgres.js';
import { seedWorkerAllowedTenants } from '../packages/kernel/src/seedWorkerClaimSecret.js';
import { CELL_COMPOSE_ENV, COMPOSE_CMD, tryComposeCellUp } from './l4-b-cell-compose.js';
import { Pool } from 'pg';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const DEFAULT_DEADLINE_MS = 120_000;

const HELP = `L4-B compensation dual-process race (C6)

Usage:
  pnpm cell:compensation-dual-race [--compose-up] [--seed=N] [--help]

Options:
  --compose-up   docker compose cell profile up (shared PG)
  --seed=N       compensation outbox rows to seed (default 24)
  --help         Show this message

Env:
  DATABASE_URL / COMMANDER_KERNEL_DATABASE_URL — Postgres (required without --compose-up)
  L4B_DUAL_RACE_DEADLINE_MS — override deadline (default 120000)
`;

export interface DualProcessRaceArtifact {
  verdict: 'PASS' | 'BLOCKED';
  reason?: string;
  deadlineMs: number;
  seeded: number;
  publishedCount: number;
  compensationPublishedCount: number;
  consumerClaims: number;
  ws2CompensationDeliveries: number;
  publisherSteals: number;
  elapsedMs: number;
  databaseUrlSource: 'env' | 'compose-env';
}

function deriveRoleDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

function parseArgs(argv: string[]): { composeUp: boolean; seed: number; help: boolean } {
  let composeUp = false;
  let seed = 24;
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--compose-up') composeUp = true;
    else if (arg.startsWith('--seed='))
      seed = Math.max(1, Number.parseInt(arg.slice('--seed='.length), 10) || 24);
  }
  return { composeUp, seed, help };
}

function resolveDatabaseUrl(): string | null {
  return process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
}

function resolveDeadlineMs(): number {
  const raw = process.env.L4B_DUAL_RACE_DEADLINE_MS;
  if (!raw) return DEFAULT_DEADLINE_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEADLINE_MS;
}

async function seedOutboxRow(
  pool: Pool,
  tenantId: string,
  topic: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const messageId = randomUUID();
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO commander_events
       (id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, actor, schema_version, payload)
     VALUES ($1,'run',$2,1,'kernel.test.dual',$3,$2,'dual-race','v2','{}'::jsonb)`,
    [eventId, `run-${messageId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO commander_outbox
       (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, available_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,0,10,$7::timestamptz)`,
    [
      messageId,
      eventId,
      tenantId,
      topic,
      key,
      JSON.stringify(payload),
      new Date(Date.now() - 60_000).toISOString(),
    ],
  );
}

async function seedGovernedCompensationRows(
  ownerPool: Pool,
  appRepository: PostgresKernelRepository,
  tenantId: string,
  count: number,
): Promise<void> {
  const runId = `run-dual-${tenantId}`;
  const effects = Array.from({ length: count }, (_, index) => ({
    id: `effect-dual-${tenantId}-${index}`,
    stepId: `step-dual-${tenantId}-${index}`,
    response: { prNumber: index },
  }));
  await appRepository.createRun(
    {
      id: runId,
      tenantId,
      intentHash: `intent-${tenantId}`,
      workGraphHash: `graph-${tenantId}`,
      workGraphVersion: 'v1',
      policySnapshotId: 'policy-dual-v1',
      steps: effects.map((effect) => ({ id: effect.stepId, kind: 'agent' })),
    },
    'dual-race',
  );
  await ownerPool.query(
    `UPDATE commander_steps SET state='SUCCEEDED', output='{}'::jsonb
     WHERE run_id=$1 AND tenant_id=$2`,
    [runId, tenantId],
  );
  for (const effect of effects) {
    await ownerPool.query(
      `INSERT INTO commander_effects
       (id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,policy_decision_id,
        policy_snapshot_id,lease_worker_id,lease_worker_generation,lease_fencing_epoch,
        action_digest,state,request,response,completed_at)
       VALUES ($1,$2,$3,$4,'read.github.pull-request',$5,'seed','policy-forward',
               'policy-dual-v1','seed-worker',1,0,$6,'COMPLETED','{}'::jsonb,$7::jsonb,now())`,
      [
        effect.id,
        runId,
        effect.stepId,
        tenantId,
        `forward-${effect.id}`,
        'a'.repeat(64),
        JSON.stringify(effect.response),
      ],
    );
  }
  await ownerPool.query(
    `UPDATE commander_runs SET state='SUCCEEDED', terminal_at=now()
     WHERE id=$1 AND tenant_id=$2`,
    [runId, tenantId],
  );
  for (const [index, effect] of effects.entries()) {
    const compensationPatch = { action: 'close', reason: 'dual-process-race' };
    const adapterVersion = 'github-dual-race/v1';
    const authorizationId = `authorization-dual-${tenantId}-${index}`;
    await appRepository.createCompensationAuthorization({
      id: authorizationId,
      tenantId,
      originalRunId: runId,
      originalEffectId: effect.id,
      compensationEffectType: 'compensate.github.pull-request.create',
      adapterVersion,
      compensationPatch,
      forwardReceiptHash: canonicalCompensationHash(effect.response),
      policyDecisionId: 'policy-compensation',
      policySnapshotId: 'policy-dual-v1',
      decision: 'allow',
      actionDigest: canonicalCompensationHash({
        type: 'compensate.github.pull-request.create',
        originalEffectId: effect.id,
        adapterVersion,
        forwardResponse: effect.response,
        compensationPatch,
      }),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    const requested = await appRepository.requestCompensation({
      tenantId,
      authorizationId,
      actor: 'dual-race',
    });
    if (!requested.accepted) throw new Error('DUAL_RACE_COMPENSATION_REQUEST_REJECTED');
  }
}

function spawnWorker(
  role: 'publisher' | 'consumer',
  databaseUrl: string,
  stopFile: string,
  auth?: { workerId: string; workerGeneration: number; claimSecret: string },
): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      TSX_CLI,
      SCRIPT_PATH,
      '--worker',
      role,
      '--database-url',
      databaseUrl,
      '--stop-file',
      stopFile,
      ...(auth
        ? [
            '--worker-id',
            auth.workerId,
            '--worker-generation',
            String(auth.workerGeneration),
            '--claim-secret',
            auth.claimSecret,
          ]
        : []),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      cwd: process.cwd(),
    },
  );
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(`[${role}:${child.pid}] ${chunk}`);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[${role}:${child.pid}] ${chunk}`);
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[${role}:${child.pid}] exited code=${code} signal=${signal ?? ''}\n`);
    }
  });
  return child;
}

async function runWorkerLoop(
  role: 'publisher' | 'consumer',
  databaseUrl: string,
  stopFile: string,
  auth?: { workerId: string; workerGeneration: number; claimSecret: string },
): Promise<void> {
  const { PostgresKernelRepository } = await import('../packages/kernel/src/postgres.js');
  const { KernelOutboxPublisher } =
    await import('../packages/kernel/src/ops/outbox/kernelOutboxPublisher.js');
  const { PostgresOutboxDeliveryPort } =
    await import('../packages/kernel/src/ops/outbox/postgresOutboxDeliveryPort.js');
  const { consumeCompensationBatch } =
    await import('../packages/kernel/src/ops/compensationConsumer.js');

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const repo =
    role === 'publisher'
      ? new PostgresKernelRepository(pool, { schedulerMode: true })
      : new PostgresKernelRepository(pool, { adapterOpsMode: true });
  const delivery = new PostgresOutboxDeliveryPort(pool, { baseBackoffMs: 1 });
  const publisher = new KernelOutboxPublisher(repo, delivery);

  try {
    while (true) {
      try {
        await access(stopFile);
        break;
      } catch {
        /* keep racing */
      }
      try {
        if (role === 'publisher') {
          await publisher.publish(10);
        } else {
          if (!auth) throw new Error('dual-race consumer auth is required');
          await consumeCompensationBatch(
            repo,
            {
              admit: async () => ({ admitted: true, effectId: randomUUID(), replayed: false }),
              executeAdmitted: async (input) => ({
                effectId: input.effectId,
                replayed: false,
                response: { ok: true },
              }),
            },
            async () => 'dual-race-token',
            {
              ...auth,
              limit: 10,
              topic: KERNEL_COMPENSATION_TOPIC,
              registry: { resolve: () => null },
            },
          );
        }
      } catch (err) {
        console.error(`[worker ${role}] tick error:`, err);
      }
      await sleep(5);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
  process.exit(0);
}

export async function runDualProcessRace(options: {
  databaseUrl: string;
  seed: number;
  deadlineMs?: number;
}): Promise<DualProcessRaceArtifact> {
  const start = Date.now();
  const deadlineMs = options.deadlineMs ?? resolveDeadlineMs();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `dual-race-${suffix}`;
  const pool = new Pool({ connectionString: options.databaseUrl, max: 6 });
  const appPool = new Pool({
    connectionString:
      process.env.COMMANDER_APP_DATABASE_URL ??
      deriveRoleDatabaseUrl(
        options.databaseUrl,
        'commander_app',
        process.env.COMMANDER_APP_PASSWORD ?? 'commander_app',
      ),
    max: 2,
  });
  const tenantAuthorityPool = new Pool({
    connectionString:
      process.env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL ??
      deriveRoleDatabaseUrl(
        options.databaseUrl,
        'commander_tenant_authority',
        process.env.COMMANDER_TENANT_AUTHORITY_PASSWORD ?? 'commander_tenant_authority',
      ),
    max: 2,
  });
  const adapterPool = new Pool({
    connectionString:
      process.env.COMMANDER_ADAPTER_OPS_DATABASE_URL ??
      deriveRoleDatabaseUrl(
        options.databaseUrl,
        'commander_adapter_ops',
        process.env.COMMANDER_ADAPTER_OPS_PASSWORD ?? 'commander_adapter_ops',
      ),
    max: 2,
  });
  const appRepository = new PostgresKernelRepository(appPool, {
    tenantContextAuthority: new PostgresTenantContextAuthority(tenantAuthorityPool),
    tenantContextPhase: 'enforce',
  });
  const stopFile = join(process.cwd(), `.l4b-dual-race-stop-${suffix}`);

  let publisherProc: ChildProcess | undefined;
  let consumerProc: ChildProcess | undefined;
  let timedOut = false;
  let consumerAuth: { workerId: string; workerGeneration: number; claimSecret: string } | undefined;
  const adapterId = `compensation:dual-race-${suffix}`;
  try {
    await runKernelMigrations(pool);
    await seedWorkerAllowedTenants(pool, [tenantId]);
    await pool.query(
      `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
       VALUES ($1) ON CONFLICT (tenant_id) DO UPDATE SET enabled=true`,
      [tenantId],
    );
    const registration = await adapterPool.query<{
      registration: { generation: number; claim_secret: string };
    }>(`SELECT register_adapter_ops_worker('compensation',$1,$2::jsonb,NULL) AS registration`, [
      suffix,
      JSON.stringify([tenantId]),
    ]);
    consumerAuth = {
      workerId: adapterId,
      workerGeneration: Number(registration.rows[0]?.registration.generation),
      claimSecret: registration.rows[0]?.registration.claim_secret ?? '',
    };
    if (!consumerAuth.workerGeneration || !consumerAuth.claimSecret) {
      throw new Error('DUAL_RACE_ADAPTER_WORKER_REGISTRATION_FAILED');
    }
    await seedGovernedCompensationRows(pool, appRepository, tenantId, options.seed);
    for (let i = 0; i < options.seed; i++) {
      await seedOutboxRow(pool, tenantId, 'kernel.effect.completed', `${tenantId}/noise-${i}`, {
        type: 'kernel.effect.completed',
        effectId: `noise-${tenantId}-${i}`,
      });
    }

    publisherProc = spawnWorker('publisher', options.databaseUrl, stopFile);
    consumerProc = spawnWorker(
      'consumer',
      process.env.COMMANDER_ADAPTER_OPS_DATABASE_URL ??
        deriveRoleDatabaseUrl(
          options.databaseUrl,
          'commander_adapter_ops',
          process.env.COMMANDER_ADAPTER_OPS_PASSWORD ?? 'commander_adapter_ops',
        ),
      stopFile,
      consumerAuth,
    );

    // Fail fast if either worker dies before stop
    const earlyExit = new Promise<'publisher' | 'consumer'>((resolve) => {
      publisherProc!.once('exit', (code) => {
        if (code !== 0 && code !== null) resolve('publisher');
      });
      consumerProc!.once('exit', (code) => {
        if (code !== 0 && code !== null) resolve('consumer');
      });
    });

    const deadlineAt = Date.now() + deadlineMs;
    let publishedCount = 0;
    let compensationPublishedCount = 0;
    while (Date.now() < deadlineAt) {
      const raced = await Promise.race([
        sleep(200).then(() => 'tick' as const),
        earlyExit.then((role) => `dead:${role}` as const),
      ]);
      if (typeof raced === 'string' && raced.startsWith('dead:')) {
        throw new Error(`worker exited early: ${raced.slice('dead:'.length)}`);
      }
      const row = await pool.query<{ noise: string; compensation: string }>(
        `SELECT
           count(*) FILTER (WHERE topic='kernel.effect.completed' AND published_at IS NOT NULL)::text AS noise,
           count(*) FILTER (WHERE topic=$2 AND published_at IS NOT NULL)::text AS compensation
         FROM commander_outbox WHERE tenant_id=$1`,
        [tenantId, KERNEL_COMPENSATION_TOPIC],
      );
      publishedCount = Number(row.rows[0]?.noise ?? 0);
      compensationPublishedCount = Number(row.rows[0]?.compensation ?? 0);
      if (publishedCount >= options.seed && compensationPublishedCount >= options.seed) break;
    }
    if (publishedCount < options.seed || compensationPublishedCount < options.seed) timedOut = true;

    await writeFile(stopFile, 'stop');
    await sleep(300);

    const waitChild = (child: ChildProcess | undefined) =>
      new Promise<void>((resolve) => {
        if (!child || child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    await Promise.all([waitChild(publisherProc), waitChild(consumerProc)]);

    const published = await pool.query<{ noise: string; compensation: string }>(
      `SELECT
         count(*) FILTER (WHERE topic='kernel.effect.completed' AND published_at IS NOT NULL)::text AS noise,
         count(*) FILTER (WHERE topic=$2 AND published_at IS NOT NULL)::text AS compensation
       FROM commander_outbox WHERE tenant_id=$1`,
      [tenantId, KERNEL_COMPENSATION_TOPIC],
    );
    publishedCount = Number(published.rows[0]?.noise ?? 0);
    compensationPublishedCount = Number(published.rows[0]?.compensation ?? 0);

    const { PostgresOutboxDeliveryPort } =
      await import('../packages/kernel/src/ops/outbox/postgresOutboxDeliveryPort.js');
    const delivery = new PostgresOutboxDeliveryPort(pool, { baseBackoffMs: 1 });
    const ws2 = await delivery.claim(`dual-ws2-${suffix}`, 500);
    const ws2CompensationDeliveries = ws2.filter(
      (m) => m.topic === KERNEL_COMPENSATION_TOPIC,
    ).length;

    const pass =
      !timedOut &&
      publishedCount === options.seed &&
      compensationPublishedCount === options.seed &&
      ws2CompensationDeliveries === 0;
    const artifact: DualProcessRaceArtifact = {
      verdict: pass ? 'PASS' : 'BLOCKED',
      reason: pass ? undefined : timedOut ? 'deadline' : 'assertion',
      deadlineMs,
      seeded: options.seed,
      publishedCount,
      compensationPublishedCount,
      consumerClaims: compensationPublishedCount,
      ws2CompensationDeliveries,
      publisherSteals: ws2CompensationDeliveries,
      elapsedMs: Date.now() - start,
      databaseUrlSource: 'env',
    };
    return artifact;
  } finally {
    try {
      await unlink(stopFile);
    } catch {
      /* ignore */
    }
    await pool
      .query(
        `DELETE FROM commander_compensation_finalization_receipts
         WHERE request_id IN (SELECT id FROM commander_compensation_requests WHERE tenant_id=$1)`,
        [tenantId],
      )
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_outbox_deliveries WHERE tenant_id=$1', [tenantId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_compensation_requests WHERE tenant_id=$1', [tenantId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_compensation_authorizations WHERE tenant_id=$1', [tenantId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_runs WHERE tenant_id=$1', [tenantId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_workers WHERE id=$1', [adapterId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_app_tenant_contexts WHERE tenant_id=$1', [tenantId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_tenant_authority_allowed_tenants WHERE tenant_id=$1', [
        tenantId,
      ])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [tenantId])
      .catch(() => undefined);
    await Promise.all([
      adapterPool.end().catch(() => undefined),
      tenantAuthorityPool.end().catch(() => undefined),
      appPool.end().catch(() => undefined),
      pool.end().catch(() => undefined),
    ]);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const workerIdx = argv.indexOf('--worker');
  if (workerIdx >= 0) {
    const role = argv[workerIdx + 1] as 'publisher' | 'consumer';
    const dbIdx = argv.indexOf('--database-url');
    const stopIdx = argv.indexOf('--stop-file');
    const workerIdIdx = argv.indexOf('--worker-id');
    const workerGenerationIdx = argv.indexOf('--worker-generation');
    const claimSecretIdx = argv.indexOf('--claim-secret');
    const databaseUrl = argv[dbIdx + 1];
    const stopFile = argv[stopIdx + 1];
    const workerId = argv[workerIdIdx + 1];
    const workerGeneration = Number.parseInt(argv[workerGenerationIdx + 1] ?? '', 10);
    const claimSecret = argv[claimSecretIdx + 1];
    if (
      !databaseUrl ||
      !stopFile ||
      (role !== 'publisher' && role !== 'consumer') ||
      (role === 'consumer' &&
        (!workerId || !Number.isSafeInteger(workerGeneration) || !claimSecret))
    ) {
      process.exit(2);
    }
    await runWorkerLoop(
      role,
      databaseUrl,
      stopFile,
      role === 'consumer' ? { workerId, workerGeneration, claimSecret } : undefined,
    );
    return;
  }

  const { composeUp, seed, help } = parseArgs(argv);
  if (help) {
    console.log(HELP);
    process.exit(0);
  }

  let databaseUrl = resolveDatabaseUrl();
  let databaseUrlSource: 'env' | 'compose-env' = 'env';
  let composeDown = false;

  if (composeUp) {
    const up = tryComposeCellUp();
    if (!up.ok) {
      console.error(up.error ?? 'compose up failed');
      process.exit(1);
    }
    composeDown = true;
    const password = CELL_COMPOSE_ENV.POSTGRES_PASSWORD;
    databaseUrl = databaseUrl ?? `postgres://commander:${password}@127.0.0.1:5432/commander`;
    databaseUrlSource = 'compose-env';
  }

  if (!databaseUrl) {
    console.error('BLOCKED: set DATABASE_URL or use --compose-up with reachable Postgres');
    process.exit(1);
  }

  let artifact: DualProcessRaceArtifact;
  try {
    artifact = await runDualProcessRace({ databaseUrl, seed });
    artifact.databaseUrlSource = databaseUrlSource;
  } finally {
    if (composeDown) {
      try {
        execSync(`${COMPOSE_CMD} down -v`, {
          cwd: process.cwd(),
          env: { ...process.env, ...CELL_COMPOSE_ENV },
          stdio: 'pipe',
        });
      } catch {
        /* best-effort */
      }
    }
  }

  await mkdir(join(process.cwd(), 'artifacts'), { recursive: true });
  const outPath = join(process.cwd(), `artifacts/l4-b-compensation-dual-race-${Date.now()}.json`);
  await writeFile(outPath, `${JSON.stringify({ ...artifact, artifactPath: outPath }, null, 2)}\n`);

  if (artifact.verdict !== 'PASS') {
    console.error(`BLOCKED ${outPath} reason=${artifact.reason ?? 'unknown'}`);
    process.exit(1);
  }
  console.log(`PASS ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
