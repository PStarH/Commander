#!/usr/bin/env tsx
/**
 * L4-B dual-process compensation race — kernel-ops publisher ∥ adapter-ops consumer.
 *
 *   pnpm cell:compensation-dual-race [--compose-up] [--seed=24] [--help]
 *
 * Requires COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL (or --compose-up with POSTGRES_PASSWORD).
 * Spec: 2026-07-20-to100-w2-compensation-spec.md §5.1 — deadlineMs default 120000.
 */

import assert from 'node:assert/strict';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { runKernelMigrations } from '../packages/kernel/src/migrations.js';
import { KERNEL_COMPENSATION_TOPIC } from '../packages/kernel/src/ops/compensationConsumer.js';
import {
  CELL_COMPOSE_ENV,
  COMPOSE_CMD,
  tryComposeCellUp,
} from './l4-b-cell-compose.js';
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
  ws2CompensationDeliveries: number;
  publisherSteals: number;
  elapsedMs: number;
  databaseUrlSource: 'env' | 'compose-env';
}

function parseArgs(argv: string[]): { composeUp: boolean; seed: number; help: boolean } {
  let composeUp = false;
  let seed = 24;
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--compose-up') composeUp = true;
    else if (arg.startsWith('--seed=')) seed = Math.max(1, Number.parseInt(arg.slice('--seed='.length), 10) || 24);
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

async function seedCompensationRows(pool: Pool, tenantId: string, count: number): Promise<void> {
  const availableAt = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < count; i++) {
    const messageId = randomUUID();
    const eventId = randomUUID();
    const runId = `run-dual-${tenantId}-${i}`;
    await pool.query(
      `INSERT INTO commander_events
         (id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, actor, schema_version, payload)
       VALUES ($1,'run',$2,1,'kernel.test.dual',$3,$2,'dual-race','v2','{}'::jsonb)`,
      [eventId, runId, tenantId],
    );
    await pool.query(
      `INSERT INTO commander_outbox
         (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, available_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,0,10,$7::timestamptz)`,
      [
        messageId,
        eventId,
        tenantId,
        KERNEL_COMPENSATION_TOPIC,
        `${tenantId}/${runId}/cmp-${i}`,
        JSON.stringify({
          type: 'kernel.compensation.requested',
          tenantId,
          runId,
          stepId: 'step-dual',
          compensationAction: 'compensate.github.pull-request.create',
          compensationPayload: {
            originalEffectId: `effect-${i}`,
            forwardResponse: { prNumber: i },
          },
          idempotencyKey: `cmp:dual-${i}:1.0.0`,
        }),
        availableAt,
      ],
    );
  }
}

function spawnWorker(role: 'publisher' | 'consumer', databaseUrl: string, stopFile: string): ChildProcess {
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

async function runWorkerLoop(role: 'publisher' | 'consumer', databaseUrl: string, stopFile: string): Promise<void> {
  const { PostgresKernelRepository } = await import('../packages/kernel/src/postgres.js');
  const { KernelOutboxPublisher } = await import('../packages/kernel/src/ops/outbox/kernelOutboxPublisher.js');
  const { PostgresOutboxDeliveryPort } = await import('../packages/kernel/src/ops/outbox/postgresOutboxDeliveryPort.js');
  const { consumeCompensationBatch } = await import('../packages/kernel/src/ops/compensationConsumer.js');

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const repo = new PostgresKernelRepository(pool, { schedulerMode: true });
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
            { workerId: 'dual-race-consumer', limit: 10, topic: KERNEL_COMPENSATION_TOPIC },
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

async function cleanupTenant(pool: Pool, tenantId: string): Promise<void> {
  await pool.query('DELETE FROM commander_outbox_deliveries WHERE tenant_id=$1', [tenantId]);
  await pool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId]);
  await pool.query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId]);
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
  const stopFile = join(process.cwd(), `.l4b-dual-race-stop-${suffix}`);

  let publisherProc: ChildProcess | undefined;
  let consumerProc: ChildProcess | undefined;
  let timedOut = false;
  try {
    await runKernelMigrations(pool);
    await pool.query('DELETE FROM commander_outbox WHERE topic = $1', [KERNEL_COMPENSATION_TOPIC]);
    await seedCompensationRows(pool, tenantId, options.seed);

    publisherProc = spawnWorker('publisher', options.databaseUrl, stopFile);
    consumerProc = spawnWorker('consumer', options.databaseUrl, stopFile);

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
    while (Date.now() < deadlineAt) {
      const raced = await Promise.race([
        sleep(200).then(() => 'tick' as const),
        earlyExit.then((role) => `dead:${role}` as const),
      ]);
      if (typeof raced === 'string' && raced.startsWith('dead:')) {
        throw new Error(`worker exited early: ${raced.slice('dead:'.length)}`);
      }
      const row = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM commander_outbox
         WHERE tenant_id=$1 AND topic=$2 AND published_at IS NOT NULL`,
        [tenantId, KERNEL_COMPENSATION_TOPIC],
      );
      publishedCount = Number(row.rows[0]?.count ?? 0);
      if (publishedCount >= options.seed) break;
    }
    if (publishedCount < options.seed) timedOut = true;

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

    const published = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM commander_outbox
       WHERE tenant_id=$1 AND topic=$2 AND published_at IS NOT NULL`,
      [tenantId, KERNEL_COMPENSATION_TOPIC],
    );
    publishedCount = Number(published.rows[0]?.count ?? 0);

    const { PostgresOutboxDeliveryPort } = await import('../packages/kernel/src/ops/outbox/postgresOutboxDeliveryPort.js');
    const delivery = new PostgresOutboxDeliveryPort(pool, { baseBackoffMs: 1 });
    const ws2 = await delivery.claim(`dual-ws2-${suffix}`, 500);
    const ws2CompensationDeliveries = ws2.filter((m) => m.topic === KERNEL_COMPENSATION_TOPIC).length;

    const pass = !timedOut && publishedCount === options.seed && ws2CompensationDeliveries === 0;
    const artifact: DualProcessRaceArtifact = {
      verdict: pass ? 'PASS' : 'BLOCKED',
      reason: pass ? undefined : timedOut ? 'deadline' : 'assertion',
      deadlineMs,
      seeded: options.seed,
      publishedCount,
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
    await cleanupTenant(pool, tenantId).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const workerIdx = argv.indexOf('--worker');
  if (workerIdx >= 0) {
    const role = argv[workerIdx + 1] as 'publisher' | 'consumer';
    const dbIdx = argv.indexOf('--database-url');
    const stopIdx = argv.indexOf('--stop-file');
    const databaseUrl = argv[dbIdx + 1];
    const stopFile = argv[stopIdx + 1];
    if (!databaseUrl || !stopFile || (role !== 'publisher' && role !== 'consumer')) {
      process.exit(2);
    }
    await runWorkerLoop(role, databaseUrl, stopFile);
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
      console.error(up.dockerError ?? 'compose up failed');
      process.exit(1);
    }
    composeDown = true;
    const password = CELL_COMPOSE_ENV.POSTGRES_PASSWORD;
    databaseUrl =
      databaseUrl ??
      `postgres://commander:${password}@127.0.0.1:5432/commander`;
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
