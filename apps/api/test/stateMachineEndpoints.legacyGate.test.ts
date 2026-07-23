/**
 * Boundary honesty: apps/api task StateMachine is not V2 run authority.
 * Must share the legacy-execution choke point with pipelineEndpoints.
 * HTTP cases mount the real production router (not a copied middleware stub).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import stateMachineRouter from '../src/stateMachineEndpoints';
import { StateMachine } from '../src/stateMachine';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function createAppWithRealRouter(): Express {
  const app = express();
  app.use(express.json());
  // Same mount path as apps/api/src/index.ts (legacy product surface).
  app.use('/api/state-machine', stateMachineRouter);
  return app;
}

async function listen(app: Express): Promise<{ server: http.Server; base: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('stateMachineEndpoints legacy gate (boundary)', () => {
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

  it('source: router uses isLegacyExecutionAllowed choke point', () => {
    const src = fs.readFileSync(path.join(srcDir, 'stateMachineEndpoints.ts'), 'utf-8');
    assert.match(src, /isLegacyExecutionAllowed/);
    assert.match(src, /LEGACY_EXECUTION_DISABLED/);
    assert.match(src, /POST \/v1\/runs/);
    assert.match(src, /refuseIfLegacyDisabled/);
  });

  it('source: Gateway does not mount task SM under /api/v1/state-machine', () => {
    const src = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');
    assert.doesNotMatch(
      src,
      /name:\s*['"]v1-state-machine['"][\s\S]*mountPath:\s*['"]\/api\/v1\/state-machine['"]/,
    );
  });

  it('HTTP: real router create is 410 when legacy execution is disabled', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COMMANDER_V2_MODE;
    delete process.env.COMMANDER_LEGACY_EXECUTION;
    const { server, base } = await listen(createAppWithRealRouter());
    try {
      const res = await fetch(`${base}/api/state-machine/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 't1', projectId: 'p1', agentId: 'a1' }),
      });
      assert.equal(res.status, 410);
      const body = (await res.json()) as { error: { code: string; replacement: string } };
      assert.equal(body.error.code, 'LEGACY_EXECUTION_DISABLED');
      assert.equal(body.error.replacement, 'POST /v1/runs');
    } finally {
      server.close();
    }
  });

  it('HTTP: real router create reaches handler when legacy execution is allowed', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COMMANDER_V2_MODE;
    process.env.COMMANDER_LEGACY_EXECUTION = '1';
    const taskId = `legacy-handler-${process.pid}-${Date.now()}`;
    const stateFile = path.resolve(srcDir, '../data/state-machines', `${taskId}.json`);
    const { server, base } = await listen(createAppWithRealRouter());
    try {
      const res = await fetch(`${base}/api/state-machine/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, projectId: 'p1', agentId: 'a1' }),
      });
      assert.equal(res.status, 200);
    } finally {
      fs.rmSync(stateFile, { force: true });
      server.close();
    }
  });

  it('HTTP: create rejects task ids containing path traversal', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COMMANDER_V2_MODE;
    process.env.COMMANDER_LEGACY_EXECUTION = '1';
    const markerName = `state-machine-path-test-${process.pid}`;
    const escapedFile = path.resolve(srcDir, '..', `${markerName}.json`);
    const { server, base } = await listen(createAppWithRealRouter());
    try {
      const res = await fetch(`${base}/api/state-machine/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: `../../${markerName}`,
          projectId: 'p1',
          agentId: 'a1',
        }),
      });
      assert.equal(res.status, 400);
      assert.equal(fs.existsSync(escapedFile), false);
    } finally {
      server.close();
      fs.rmSync(escapedFile, { force: true });
    }
  });

  it('persistence sink rejects traversal when called without the HTTP schema', () => {
    const persistenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-machine-path-'));
    const escapedFile = path.join(
      path.dirname(persistenceRoot),
      `${path.basename(persistenceRoot)}-escaped.json`,
    );
    const machine = new StateMachine({
      id: 'path-test',
      name: 'Path test',
      initial: 'initialized',
      states: [{ name: 'initialized', type: 'start' }],
      transitions: [],
      persistence: { enabled: true, path: persistenceRoot, checkpointInterval: 60_000 },
    });

    try {
      assert.throws(
        () => machine.initialize(`../${path.basename(persistenceRoot)}-escaped`, 'p1', 'a1'),
        /Invalid taskId format/,
      );
      assert.equal(fs.existsSync(escapedFile), false);
    } finally {
      fs.rmSync(persistenceRoot, { recursive: true, force: true });
      fs.rmSync(escapedFile, { force: true });
    }
  });
});
