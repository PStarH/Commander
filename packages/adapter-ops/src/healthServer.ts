/**
 * Minimal HTTP health surface for adapter-operations Deployments.
 *
 * `/livez` is process-only liveness: it answers 200 as long as this HTTP server
 * is serving. Liveness must not depend on ops-loop or dependency state — a
 * stopped/failed loop or an unreachable DB would otherwise restart the Pod in a
 * loop and never converge. Helm `adapterOps.health.livenessPath` points here.
 *
 * `/health` reflects the state the daemons publish: a loop counts as healthy
 * only when it is running and its most recent tick succeeded. Without loop
 * telemetry the readiness predicate is used — an unknown state is never `ok`.
 *
 * `/ready` is the actual drain gate: it consults the caller-supplied readiness
 * predicate (durable claims, egress, DB ping, operations readiness).
 */
import { createServer, type Server } from 'node:http';
import type { OpsLoopHealth } from './reconciliationDaemon.js';

export interface AdapterOpsHealthHandle {
  port: number;
  close(): Promise<void>;
}

interface HealthVerdict {
  healthy: boolean;
  detail: Record<string, unknown>;
}

/**
 * A loop is healthy only when it is running and its latest tick succeeded.
 * A failure after the last success degrades the loop until a later success.
 * Exported so the drain gate (`isReady`) and `/health` share one definition.
 */
export function isAdapterOpsLoopHealthy(loop: OpsLoopHealth): boolean {
  if (!loop.running) return false;
  if (!loop.lastSucceededAt) return false;
  if (!loop.lastFailedAt) return true;
  return Date.parse(loop.lastFailedAt) <= Date.parse(loop.lastSucceededAt);
}

export async function startAdapterOpsHealthServer(options: {
  port: number;
  isReady: () => boolean | Promise<boolean>;
  getLoopHealth?: () => {
    reconciliation: OpsLoopHealth;
    compensation: OpsLoopHealth;
  };
}): Promise<AdapterOpsHealthHandle> {
  const verdict = async (): Promise<HealthVerdict> => {
    if (options.getLoopHealth) {
      const loops = options.getLoopHealth();
      const reconciliationHealthy = isAdapterOpsLoopHealthy(loops.reconciliation);
      const compensationHealthy = isAdapterOpsLoopHealthy(loops.compensation);
      return {
        healthy: reconciliationHealthy && compensationHealthy,
        detail: { loops },
      };
    }
    const ready = await options.isReady();
    return { healthy: ready, detail: {} };
  };

  const server: Server = createServer((req, res) => {
    const url = req.url?.split('?')[0] ?? '/';
    if (url === '/livez') {
      // Process-only: never consults loops, DB, or readiness. Keeps a degraded
      // dependency from turning into a restart storm.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'alive' }));
      return;
    }
    if (url === '/health') {
      void Promise.resolve()
        .then(() => verdict())
        .then(({ healthy, detail }) => {
          res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', ...detail }));
        })
        .catch(() => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'degraded', degraded: true }));
        });
      return;
    }
    if (url === '/ready') {
      void Promise.resolve()
        .then(() => options.isReady())
        .then((ready) => {
          res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
        })
        .catch(() => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'not_ready', degraded: true }));
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      server.close(() => reject(err));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port);
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : options.port;

  return {
    port: boundPort,
    close: () =>
      new Promise((resolve, reject) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
