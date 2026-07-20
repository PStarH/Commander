/**
 * Minimal HTTP health surface for adapter-operations Deployments.
 */
import { createServer, type Server } from 'node:http';

export interface AdapterOpsHealthHandle {
  port: number;
  close(): Promise<void>;
}

export async function startAdapterOpsHealthServer(options: {
  port: number;
  isReady: () => boolean | Promise<boolean>;
}): Promise<AdapterOpsHealthHandle> {
  const server: Server = createServer((req, res) => {
    const url = req.url?.split('?')[0] ?? '/';
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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
