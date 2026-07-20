/**
 * Minimal HTTP health surface for kernel-ops Deployments.
 * Does not touch the kernel state machine — only reports process liveness
 * and a cheap readiness check supplied by the caller.
 */
import { createServer, type Server } from 'node:http';

export interface OpsHealthHandle {
  port: number;
  close(): Promise<void>;
}

export async function startOpsHealthServer(options: {
  port: number;
  isReady: () => boolean | Promise<boolean>;
  /**
   * Optional details merged into /ready JSON (e.g. compensationMode).
   * Used so operators can tell probe-alive from true drain.
   */
  getReadyDetails?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}): Promise<OpsHealthHandle> {
  const server: Server = createServer((req, res) => {
    const url = req.url?.split('?')[0] ?? '/';
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url === '/ready') {
      void Promise.resolve()
        .then(async () => {
          const ready = await options.isReady();
          const details = options.getReadyDetails ? await options.getReadyDetails() : {};
          return { ready, details };
        })
        .then(({ ready, details }) => {
          res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: ready ? 'ready' : 'not_ready',
              ...details,
            }),
          );
        })
        .catch(() => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'not_ready' }));
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

  return {
    port: options.port,
    close: () =>
      new Promise((resolve, reject) => {
        // fetch/keep-alive can leave sockets open; force-close so tests and
        // shutdown do not hang on server.close().
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
