/**
 * Smoke: errorHandler after routers keeps /api/v1/* error JSON shape.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../src/securityMiddleware';

let server: ReturnType<ReturnType<typeof express>['listen']>;
let port: number;

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as Request & { requestId?: string }).requestId = 'test-req';
    next();
  });
  app.get('/api/v1/boom', (_req, _res, next: NextFunction) => {
    next(new Error('boom'));
  });
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path, requestId: (req as Request & { requestId?: string }).requestId });
  });
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test('route errors return errorHandler JSON shape', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/boom`);
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string; requestId?: string };
  assert.equal(body.error, 'Internal server error');
  assert.equal(body.requestId, 'test-req');
});

test('unmatched /api/v1/* returns stable 404 JSON', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/does-not-exist`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; path: string };
  assert.equal(body.error, 'Not found');
  assert.equal(body.path, '/api/v1/does-not-exist');
});
