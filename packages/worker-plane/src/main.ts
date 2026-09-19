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
  createWorkerService(options?: {
    onClaimLoopHealth?: (healthy: boolean) => void;
  }): Promise<WorkerService> | WorkerService;
}

async function main(): Promise<void> {
  let ready = false;
  let service: WorkerService | null = null;
  const healthPortRaw = process.env.COMMANDER_WORKER_HEALTH_PORT?.trim();
  const healthPort = healthPortRaw ? Number(healthPortRaw) : null;
  if (
    healthPort !== null &&
    (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535)
  ) {
    throw new Error('COMMANDER_WORKER_HEALTH_PORT must be an integer between 1 and 65535');
  }
  // F-P1-18: the listener default stays loopback (WP-15: /health and /ready carry no
  // authentication), but a deployment whose probes do not originate on loopback must
  // be able to move it. The Helm chart's kubelet httpGet probes hit the pod IP, so the
  // chart sets COMMANDER_WORKER_HEALTH_HOST=0.0.0.0; unset keeps the safe default.
  const healthHost = process.env.COMMANDER_WORKER_HEALTH_HOST?.trim();
  const health =
    healthPort === null
      ? null
      : await startWorkerHealthServer({
          port: healthPort,
          host: healthHost || undefined,
          isReady: () => ready,
        });

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
    service = await loaded.createWorkerService({
      // WP-05: readiness is not a one-shot latch. The claim loop clears it when the
      // claim path fails and refreshes it once claims succeed again, so a worker that
      // can no longer claim work stops advertising itself as ready.
      onClaimLoopHealth: (healthy) => {
        ready = healthy;
      },
    });
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    await service.start();
    // Readiness means "able to claim work", not "start() returned". start() only
    // authenticates and registers the worker; the claim path against the kernel
    // authority (claim secret, generation, capability lease) has not been exercised
    // yet. Probe it once before advertising readiness, so a worker whose claim path
    // is broken fails loudly instead of sitting in the load balancer claiming nothing.
    await service.pollOnce();
    ready = true;
    await service.run(controller.signal);
  } finally {
    ready = false;
    await health?.close();
    // WP-11: start()/run() can fail after the bootstrap created the verified pool.
    // stop() is idempotent and owns pool release, so shutdown always closes database
    // connections instead of leaking them for the life of the process.
    if (service) await service.stop();
  }
}

void main().catch((error) => {
  console.error(`[commander-worker] fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
