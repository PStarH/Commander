import { Pool } from 'pg';
import { PostgresKernelRepository } from '../postgres.js';
import { KernelOutboxPublisher } from './outbox/kernelOutboxPublisher.js';
import { PostgresOutboxDeliveryPort } from './outbox/postgresOutboxDeliveryPort.js';
import { KernelOpsRuntime } from './opsRuntime.js';
import { ReclaimDaemon } from './reclaimDaemon.js';
import { TimerWakeupWorker } from './timerWakeupWorker.js';

const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for kernel ops');
  const pool = new Pool({ connectionString });
  const repository = new PostgresKernelRepository(pool, { schedulerMode: true });
  const delivery = new PostgresOutboxDeliveryPort(pool, {
    maxAttempts: positiveInteger('COMMANDER_OUTBOX_MAX_ATTEMPTS', 10),
  });
  const runtime = new KernelOpsRuntime({
    reclaim: new ReclaimDaemon(repository, {
      pollIntervalMs: positiveInteger('COMMANDER_RECLAIM_INTERVAL_MS', 5_000),
      batchSize: positiveInteger('COMMANDER_RECLAIM_BATCH_SIZE', 100),
    }),
    timer: new TimerWakeupWorker(repository, {
      pollIntervalMs: positiveInteger('COMMANDER_TIMER_POLL_MS', 5_000),
      batchSize: positiveInteger('COMMANDER_TIMER_BATCH_SIZE', 100),
      enabled: true,
    }),
    outbox: new KernelOutboxPublisher(repository, delivery),
    outboxIntervalMs: positiveInteger('COMMANDER_OUTBOX_INTERVAL_MS', 1_000),
    outboxBatchSize: positiveInteger('COMMANDER_OUTBOX_BATCH_SIZE', 100),
  });

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
    await pool.end();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  runtime.start();
}

void main().catch((error: unknown) => {
  console.error('[kernel-ops] fatal:', error);
  process.exitCode = 1;
});
