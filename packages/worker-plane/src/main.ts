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
import { startWorkerHealthServer } from './healthServer.js';
import type { WorkerService } from './workerService.js';

interface WorkerBootstrap {
  createWorkerService(): Promise<WorkerService> | WorkerService;
}

async function main(): Promise<void> {
  let ready = false;
  const healthPortRaw = process.env.COMMANDER_WORKER_HEALTH_PORT?.trim();
  const healthPort = healthPortRaw ? Number(healthPortRaw) : null;
  if (
    healthPort !== null &&
    (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535)
  ) {
    throw new Error('COMMANDER_WORKER_HEALTH_PORT must be an integer between 1 and 65535');
  }
  const health =
    healthPort === null
      ? null
      : await startWorkerHealthServer({ port: healthPort, isReady: () => ready });

  try {
    const source = process.env.COMMANDER_WORKER_BOOTSTRAP;
    if (!source) {
      throw new Error(
        'COMMANDER_WORKER_BOOTSTRAP is required; refusing to start an unconfigured worker',
      );
    }
    const url =
      source.startsWith('file:') || source.startsWith('data:')
        ? source
        : pathToFileURL(resolve(process.cwd(), source)).href;
    const loaded = (await import(url)) as Partial<WorkerBootstrap>;
    if (typeof loaded.createWorkerService !== 'function') {
      throw new Error('Worker bootstrap must export createWorkerService()');
    }
    const service = await loaded.createWorkerService();
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    await service.start();
    ready = true;
    await service.run(controller.signal);
  } finally {
    ready = false;
    await health?.close();
  }
}

void main().catch((error) => {
  console.error(`[commander-worker] fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
