// packages/core/src/shadow/runner.ts
import * as http from 'node:http';
import { getGlobalLogger } from '../logging';

export interface RunnerOptions {
  port: number;
  shadowMode: boolean;
}

export function startShadowRunner(opts: RunnerOptions): http.Server {
  const logger = getGlobalLogger();
  if (!opts.shadowMode) {
    throw new Error(
      'ShadowRunner must be started with shadowMode=true to prevent production writes',
    );
  }

  process.env.SHADOW_MODE = '1';

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    try {
      const forwardUrl = `http://localhost:${process.env.COMMANDER_PORT ?? 8080}${req.url}`;
      const body = await readBody(req);
      const fwdRes = await fetch(forwardUrl, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: body.length > 0 ? body : undefined,
      });
      const fwdBody = await fwdRes.text();
      res.statusCode = fwdRes.status;
      res.end(fwdBody);
      logger.info('ShadowRunner', 'shadow request', {
        endpoint: req.url,
        latencyMs: Date.now() - start,
        shadow: true,
      });
    } catch (err) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'shadow failure' }));
      logger.warn('ShadowRunner', 'shadow request failed', { err, endpoint: req.url });
    }
  });

  server.listen(opts.port, () => {
    logger.info('ShadowRunner', 'started', { port: opts.port });
  });

  return server;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
