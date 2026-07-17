/**
 * GOV-3 — state-machine approve/reject must bind to authenticated principal,
 * never a client-supplied userId.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import stateMachineRouter from '../src/stateMachineEndpoints';

const srcPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/stateMachineEndpoints.ts',
);

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('stateMachine approve source contract (GOV-3)', () => {
  it('does not read userId from request body', () => {
    const src = fs.readFileSync(srcPath, 'utf-8');
    assert.doesNotMatch(src, /const \{ checkpointId,\s*userId/);
    assert.match(src, /const approver = resolveApprover\(req, res\)/);
  });
});

describe('stateMachine approve behavior (GOV-3)', () => {
  it('returns 401 without authentication', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/state-machine', stateMachineRouter);

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state-machine/task-1/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkpointId: 'ckpt-1', userId: 'forged-admin' }),
      });
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });

  it('returns 403 for authenticated non-admin without approve scope', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      req.user = { id: 'viewer-1', username: 'viewer', role: 'viewer' };
      next();
    });
    app.use('/api/state-machine', stateMachineRouter);

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state-machine/task-1/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkpointId: 'ckpt-1', userId: 'forged-admin' }),
      });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });
});
