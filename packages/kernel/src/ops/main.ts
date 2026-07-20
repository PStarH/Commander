import {
  createKernelRepository,
  KernelBackendMissingError,
  KernelBackendRefusedError,
} from '../repositoryFactory.js';
import { KernelOutboxPublisher } from './outbox/kernelOutboxPublisher.js';
import { InProcessOutboxDeliveryPort } from './outbox/inProcessOutboxDeliveryPort.js';
import { PostgresOutboxDeliveryPort } from './outbox/postgresOutboxDeliveryPort.js';
import { KernelOpsRuntime } from './opsRuntime.js';
import { ReclaimDaemon } from './reclaimDaemon.js';
import { TimerWakeupWorker } from './timerWakeupWorker.js';
import { startOpsHealthServer } from './healthServer.js';

const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export async function main(): Promise<void> {
  let handle;
  try {
    handle = await createKernelRepository({ env: process.env });
  } catch (error) {
    if (error instanceof KernelBackendRefusedError || error instanceof KernelBackendMissingError) {
      console.error(`[kernel-ops] ${error.code}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const repository = handle.repository;
  const delivery =
    handle.backend === 'postgres' && handle.postgresPool
      ? new PostgresOutboxDeliveryPort(handle.postgresPool, {
          maxAttempts: positiveInteger('COMMANDER_OUTBOX_MAX_ATTEMPTS', 10),
        })
      : new InProcessOutboxDeliveryPort();

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

  const healthPort = positiveInteger('COMMANDER_OPS_HEALTH_PORT', 8081);
  const health = await startOpsHealthServer({
    port: healthPort,
    isReady: async () => {
      if (!runtime.isReady()) return false;
      if (handle.backend === 'postgres' && handle.postgresPool) {
        try {
          await handle.postgresPool.query('SELECT 1');
          return true;
        } catch {
          return false;
        }
      }
      return true;
    },
  });

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
    await health.close();
    await handle.close();
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  runtime.start();
}

void main().catch((error: unknown) => {
  console.error('[kernel-ops] fatal:', error);
  process.exitCode = 1;
});
