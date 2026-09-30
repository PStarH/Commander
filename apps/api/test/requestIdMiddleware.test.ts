import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { requestIdMiddleware } from '../src/securityMiddleware';

test('requestIdMiddleware echoes the caller request id in the response header', async () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/probe', (_req: Request, res: Response) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/probe`, {
      headers: { 'x-request-id': 'req-abc-123' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-request-id'), 'req-abc-123');

    const generated = await fetch(`http://127.0.0.1:${addr.port}/probe`);
    const id = generated.headers.get('x-request-id');
    assert.ok(id && id.length > 0, 'a generated request id must be returned');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
