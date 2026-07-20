/**
 * GOV-3 — state-machine approve/reject must bind to authenticated principal,
 * never a client-supplied userId.
 *
 * Auth fail-closed (401/403) must run before the legacy Gone (410) gate so
 * unauthenticated probes are not masked as LEGACY_EXECUTION_DISABLED.
 */
import { describe, it, afterEach } from 'node:test';
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

  it('approve/reject call resolveApprover before refuseIfLegacyDisabled', () => {
    const src = fs.readFileSync(srcPath, 'utf-8');
    const approveIdx = src.indexOf("router.post('/:taskId/approve'");
    const rejectIdx = src.indexOf("router.post('/:taskId/reject'");
    assert.ok(approveIdx >= 0 && rejectIdx >= 0);
    for (const start of [approveIdx, rejectIdx]) {
      const slice = src.slice(start, start + 600);
      const authIdx = slice.indexOf('resolveApprover(req, res)');
      const legacyIdx = slice.indexOf('refuseIfLegacyDisabled(res)');
      assert.ok(authIdx >= 0, 'resolveApprover must appear in handler');
      assert.ok(legacyIdx >= 0, 'refuseIfLegacyDisabled must appear in handler');
      assert.ok(authIdx < legacyIdx, 'auth must precede legacy Gone gate');
    }
  });
});

describe('stateMachine approve behavior (GOV-3)', () => {
  const envSnapshot = {
    node: process.env.NODE_ENV,
    v2: process.env.COMMANDER_V2_MODE,
    legacy: process.env.COMMANDER_LEGACY_EXECUTION,
  };

  afterEach(() => {
    if (envSnapshot.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = envSnapshot.node;
    if (envSnapshot.v2 === undefined) delete process.env.COMMANDER_V2_MODE;
    else process.env.COMMANDER_V2_MODE = envSnapshot.v2;
    if (envSnapshot.legacy === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION;
    else process.env.COMMANDER_LEGACY_EXECUTION = envSnapshot.legacy;
  });

  it('returns 401 without authentication (even when legacy is disabled)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COMMANDER_V2_MODE;
    delete process.env.COMMANDER_LEGACY_EXECUTION;

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

  it('returns 403 for authenticated non-admin without approve scope (even when legacy is disabled)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COMMANDER_V2_MODE;
    delete process.env.COMMANDER_LEGACY_EXECUTION;

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

  it('returns 410 for authenticated approver when legacy execution is disabled', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COMMANDER_V2_MODE;
    delete process.env.COMMANDER_LEGACY_EXECUTION;

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      req.user = { id: 'admin-1', username: 'admin', role: 'admin' };
      next();
    });
    app.use('/api/state-machine', stateMachineRouter);

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state-machine/task-1/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkpointId: 'ckpt-1' }),
      });
      assert.equal(res.status, 410);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'LEGACY_EXECUTION_DISABLED');
    } finally {
      await close();
    }
  });
});
