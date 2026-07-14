/**
 * Timer Wakeup Worker — production entry point.
 *
 * Connects to the shared Postgres kernel and starts a TimerWakeupWorker
 * that scans for expired durable timers and transitions associated steps.
 */
import { PostgresKernelRepository } from '@commander/kernel';
import { TimerWakeupWorker } from './timerWakeupWorker.js';

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is required for the timer wakeup worker');
  }

  const { Pool } = require('pg') as { Pool: new (config: { connectionString: string }) => import('@commander/kernel').SqlPool & { end(): Promise<void> } };
  const pool = new Pool({ connectionString: dbUrl });
  // The timer wakeup worker is a scheduler/recovery process: it scans expired
  // timers across tenants. It must connect as the commander_scheduler role and
  // opt into scheduler mode. Migrations are applied by the dedicated migration job.
  const repo = new PostgresKernelRepository(pool, { schedulerMode: true });

  const pollIntervalMs = parseInt(process.env.COMMANDER_TIMER_POLL_MS ?? '5000', 10);
  const batchSize = parseInt(process.env.COMMANDER_TIMER_BATCH_SIZE ?? '100', 10);

  const worker = new TimerWakeupWorker(repo, { pollIntervalMs, batchSize, enabled: true });

  const shutdown = () => {
    worker.stop();
    void pool.end().then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  worker.start();
  console.log(`[timer-wakeup] Started (pollIntervalMs=${pollIntervalMs}, batchSize=${batchSize})`);
}

void main().catch((error) => {
  console.error(`[timer-wakeup] fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
