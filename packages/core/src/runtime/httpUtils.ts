import { reportSilentFailure } from '../silentFailureReporter';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getGlobalLogger } from '../logging';

/** HTTP-layer request errors mapped to status codes in handleRequest. */
export class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejected = false;
    let bodyError: HttpRequestError | null = null;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (rejected) return;
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        rejected = true;
        body = '';
        bodyError = new HttpRequestError(
          413,
          `Request body too large. Limit is ${maxBytes} bytes.`,
        );
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (bodyError) {
        reject(bodyError);
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reportSilentFailure(err, 'httpUtils:parseBody');
        getGlobalLogger().warn('HttpServer', 'Invalid JSON');
        reject(new HttpRequestError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data !== undefined ? JSON.stringify(data) : undefined);
}
