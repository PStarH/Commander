// packages/core/src/shadow/runner.ts
import * as http from 'node:http';
import { getGlobalLogger } from '../logging';
import { scrubRequest, DEFAULT_IGNORE_FIELDS } from './scrubber';

export interface RunnerOptions {
  port: number;
  shadowMode: boolean;
}

const MAX_BODY_BYTES = 1_048_576; // 1MB
const STRIP_HEADERS = new Set(['authorization', 'x-api-key', 'x-auth-token', 'cookie']);

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
      const bodyResult = await readBodyLimited(req, MAX_BODY_BYTES);
      if (bodyResult.tooLarge) {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'payload too large' }), () => {
          req.destroy();
        });
        logger.warn('ShadowRunner', 'body exceeds limit — skip forward', {
          endpoint: req.url,
          limit: MAX_BODY_BYTES,
        });
        return;
      }
      const body = bodyResult.body;

      const rawHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') rawHeaders[key] = value;
        else if (Array.isArray(value)) rawHeaders[key] = value.join(', ');
      }

      let parsedBody: unknown = body;
      if (body.length > 0) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          parsedBody = body;
        }
      } else {
        parsedBody = undefined;
      }

      const scrubbed = scrubRequest(
        { headers: rawHeaders, body: parsedBody },
        DEFAULT_IGNORE_FIELDS,
      );

      // Force-strip sensitive headers (do not forward even as [REDACTED]).
      const fwdHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(scrubbed.headers)) {
        if (STRIP_HEADERS.has(key.toLowerCase())) continue;
        fwdHeaders[key] = value;
      }

      let fwdBody: string | undefined;
      if (scrubbed.body !== undefined) {
        fwdBody = typeof scrubbed.body === 'string' ? scrubbed.body : JSON.stringify(scrubbed.body);
      }

      const fwdRes = await fetch(forwardUrl, {
        method: req.method,
        headers: fwdHeaders,
        body: fwdBody,
      });
      const fwdBodyText = await fwdRes.text();
      res.statusCode = fwdRes.status;
      res.end(fwdBodyText);
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

async function readBodyLimited(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (result: { body: string; tooLarge: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (c: Buffer) => {
      if (tooLarge || settled) return;
      size += c.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        // Resolve early so the handler can send 413 before tearing down the socket.
        finish({ body: '', tooLarge: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) {
        finish({ body: '', tooLarge: true });
        return;
      }
      finish({ body: Buffer.concat(chunks).toString('utf-8'), tooLarge: false });
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}
