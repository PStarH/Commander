/**
 * Production worker-process entrypoint.
 *
 * The deployment supplies a bootstrap module through COMMANDER_WORKER_BOOTSTRAP.
 * That module is responsible for constructing the shared Postgres kernel and
 * registry, a real workload-identity authenticator, and an approved executor.
 * There is intentionally no built-in permissive/dev fallback.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { WorkerService } from './workerService.js';
import { startWorkerHealthServer } from './healthServer.js';

interface WorkerBootstrap {
  createWorkerService(): Promise<WorkerService> | WorkerService;
}

export async function runWorkerServiceWithHealth(
  service: WorkerService,
  healthPort = Number(process.env.COMMANDER_WORKER_HEALTH_PORT ?? 8083),
): Promise<void> {
  let workerReady = false;
  const health = await startWorkerHealthServer({
    port: healthPort,
    isReady: async () => workerReady,
  });
  const controller = new AbortController();
  const shutdown = async () => {
    workerReady = false;
    controller.abort();
  };
  const onSignal = () => {
    void shutdown().catch((error) => {
      console.error(`[commander-worker] shutdown error: ${(error as Error).message}`);
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  workerReady = true;
  await service.run(controller.signal);
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  await health.close();
}

async function main(): Promise<void> {
  const source = process.env.COMMANDER_WORKER_BOOTSTRAP;
  if (!source) {
    throw new Error('COMMANDER_WORKER_BOOTSTRAP is required; refusing to start an unconfigured worker');
  }
  const url = source.startsWith('file:') || source.startsWith('data:')
    ? source
    : pathToFileURL(resolve(process.cwd(), source)).href;
  const loaded = await import(url) as Partial<WorkerBootstrap>;
  if (typeof loaded.createWorkerService !== 'function') {
    throw new Error('Worker bootstrap must export createWorkerService()');
  }
  const service = await loaded.createWorkerService();
  await runWorkerServiceWithHealth(service);
}

void main().catch((error) => {
  console.error(`[commander-worker] fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
