import { Pool } from 'pg';
import { PostgresKernelRepository } from '../postgres.js';
import { KernelOutboxPublisher } from './outbox/kernelOutboxPublisher.js';
import { PostgresOutboxDeliveryPort } from './outbox/postgresOutboxDeliveryPort.js';
import { KernelOpsRuntime } from './opsRuntime.js';
import { ReclaimDaemon } from './reclaimDaemon.js';
import { TimerWakeupWorker } from './timerWakeupWorker.js';
import { CompensationConsumerDaemon } from './compensationConsumerDaemon.js';
import { startOpsHealthServer } from './healthServer.js';

const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(name + ' must be a positive integer');
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

  // Probe-only compensation loop: proves claim path + DLQ sweep are healthy
  // without pulling EffectBroker into the kernel package. Full drain ticks can
  // replace probe when a broker-backed worker is co-located.
  //
  // Residual (intentional): NODE_ENV=production + probe-only still serves /ready 200
  // when the loop is healthy. A hard 503 gate would brick default kernel-ops because
  // drain ownership lives outside this package. /ready exposes compensationMode /
  // compensationDraining so operators do not mistake probe for drain. Opt into a
  // hard gate with COMMANDER_READY_REQUIRE_COMPENSATION_DRAIN=1 (K8s httpGet can
  // then fail closed until a drain tick is wired).
  const compensation = new CompensationConsumerDaemon({
    intervalMs: positiveInteger('COMMANDER_COMPENSATION_INTERVAL_MS', 5_000),
    probe: async () => {
      await repository.claimOutboxByTopic('commander.kernel.compensation.requested', 0);
      await repository.sweepOutboxDlq(new Date(), 50);
    },
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
    compensation,
  });

  const requireCompensationDrain = process.env.COMMANDER_READY_REQUIRE_COMPENSATION_DRAIN === '1';
  const healthPort = positiveInteger('COMMANDER_OPS_HEALTH_PORT', 8081);
  const health = await startOpsHealthServer({
    port: healthPort,
    isReady: async () => {
      if (!runtime.isReady()) return false;
      // Opt-in fail-closed: probe-only must not pass readiness when drain is required.
      if (requireCompensationDrain && !compensation.isDraining()) return false;
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    getReadyDetails: () => ({
      // Explicit honesty: default kernel-ops wiring is probe-only (limit 0).
      // Ready (without REQUIRE_DRAIN) means the compensation loop ticks; NOT outbox drain.
      compensationMode: compensation.mode(),
      compensationDraining: compensation.isDraining(),
    }),
  });

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
    await health.close();
    await pool.end();
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  // Bind health first so EADDRINUSE fails closed before starting daemons.
  runtime.start();
}

void main().catch((error: unknown) => {
  console.error('[kernel-ops] fatal:', error);
  process.exitCode = 1;
});
