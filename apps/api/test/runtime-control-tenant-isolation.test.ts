import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express, { type RequestHandler } from 'express';
import { createReplayRouter } from '../src/replayEndpoints';
import { createPauseRouter } from '../src/pauseEndpoints';
import { getSharedRuntime } from '../src/sharedRuntime';

interface RunningServer {
  baseUrl: string;
  close(): Promise<void>;
}

async function start(router: RequestHandler): Promise<RunningServer> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const tenant = req.header('x-test-tenant');
    if (tenant) req.tenantId = tenant;
    const principal = req.header('x-test-principal');
    if (tenant && principal) {
      req.user = {
        id: principal,
        username: principal,
        role: 'developer',
        tenantId: tenant,
      };
    }
    next();
  });
  app.use(router);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function checkpoint(runId: string, phase = 'completed') {
  return {
    runId,
    agentId: 'agent-1',
    phase,
    stepNumber: 1,
    timestamp: new Date().toISOString(),
    messages: [{ role: 'user', content: 'secret' }],
    context: {
      projectId: 'project-1',
      goal: 'legitimate goal',
      availableTools: [],
      tokenBudget: 100,
    },
    totalDurationMs: 1,
  };
}

function writeTenantCheckpoint(root: string, tenant: string, runId: string, phase?: string): void {
  const dir = join(root, '.commander_state', `tenant_${tenant}`, 'completed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(checkpoint(runId, phase)));
  const traces = join(root, '.commander_traces', `tenant_${tenant}`);
  mkdirSync(traces, { recursive: true });
  writeFileSync(
    join(traces, `${runId}.ndjson`),
    JSON.stringify({
      id: 'event-1',
      spanId: 'span-1',
      traceId: 'trace-1',
      runId,
      agentId: 'agent-1',
      type: 'llm',
      timestamp: new Date().toISOString(),
      durationMs: 1,
      data: { tokenUsage: { totalTokens: 3 } },
    }) + '\n',
  );
}

test('replay endpoints require tenant-scoped state and hide foreign runs', async () => {
  const previousCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'commander-replay-'));
  process.chdir(root);
  try {
    writeTenantCheckpoint(root, 'tenant-a', 'run-a');
    writeTenantCheckpoint(root, 'tenant-b', 'run-b');
    mkdirSync(join(root, '.commander_state', 'completed'), { recursive: true });
    writeFileSync(
      join(root, '.commander_state', 'completed', 'root-run.json'),
      JSON.stringify(checkpoint('root-run')),
    );

    const server = await start(createReplayRouter());
    try {
      const list = await fetch(`${server.baseUrl}/api/replay/runs`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(list.status, 200);
      const listed = (await list.json()) as { runs: Array<{ runId: string }> };
      assert.deepEqual(
        listed.runs.map((run) => run.runId),
        ['run-a'],
      );

      const own = await fetch(`${server.baseUrl}/api/replay/runs/run-a`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(own.status, 200);
      const foreign = await fetch(`${server.baseUrl}/api/replay/runs/run-b`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(foreign.status, 404);
      const events = await fetch(`${server.baseUrl}/api/replay/runs/run-b/events`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(events.status, 404);
      const missingTenant = await fetch(`${server.baseUrl}/api/replay/runs/run-a`);
      assert.equal(missingTenant.status, 401);
    } finally {
      await server.close();
    }
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('pause, resume, and rollback controls reject foreign tenants and preserve same-tenant execution', async () => {
  const previousCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'commander-runtime-'));
  process.chdir(root);
  try {
    writeTenantCheckpoint(root, 'tenant-a', 'pause-a', 'waiting_for_human');
    writeTenantCheckpoint(root, 'tenant-a', 'resume-a', 'waiting_for_human');
    writeTenantCheckpoint(root, 'tenant-a', 'rollback-a');
    writeTenantCheckpoint(root, 'tenant-b', 'pause-b');
    writeTenantCheckpoint(root, 'tenant-b', 'resume-b');
    writeTenantCheckpoint(root, 'tenant-b', 'rollback-b');

    const paused: string[] = [];
    const executed: Array<{ tenantId?: string }> = [];
    const fakeRuntime = {
      pauseRun: (runId: string) => {
        paused.push(runId);
        return runId === 'pause-a';
      },
      isPaused: (runId: string) => runId === 'resume-a',
      unpauseRun: () => undefined,
      execute: async (ctx: { tenantId?: string }) => {
        executed.push(ctx);
        return {};
      },
      getActiveRuns: () => [{ runId: 'pause-a', paused: true }],
    };
    const server = await start(
      createPauseRouter(() => fakeRuntime as unknown as ReturnType<typeof getSharedRuntime>),
    );
    try {
      const foreignPause = await fetch(`${server.baseUrl}/runtime/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'tenant-a' },
        body: JSON.stringify({ runId: 'pause-b' }),
      });
      assert.equal(foreignPause.status, 404);
      assert.deepEqual(paused, []);
      const ownPause = await fetch(`${server.baseUrl}/runtime/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'tenant-a' },
        body: JSON.stringify({ runId: 'pause-a' }),
      });
      assert.equal(ownPause.status, 200);

      const foreignResume = await fetch(`${server.baseUrl}/runtime/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'tenant-a' },
        body: JSON.stringify({ runId: 'resume-b' }),
      });
      assert.equal(foreignResume.status, 404);
      const ownResume = await fetch(`${server.baseUrl}/runtime/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'tenant-a' },
        body: JSON.stringify({ runId: 'resume-a' }),
      });
      assert.equal(ownResume.status, 200);
      assert.equal(executed.at(-1)?.tenantId, 'tenant-a');

      const foreignRollback = await fetch(`${server.baseUrl}/runtime/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'tenant-a' },
        body: JSON.stringify({ runId: 'rollback-b', stepNumber: 0 }),
      });
      assert.equal(foreignRollback.status, 404);
      const ownRollback = await fetch(`${server.baseUrl}/runtime/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'tenant-a' },
        body: JSON.stringify({ runId: 'rollback-a', stepNumber: 0 }),
      });
      assert.equal(ownRollback.status, 200);
      assert.equal(executed.length, 2);
    } finally {
      await server.close();
    }
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('saga controls filter and authorize by snapshot tenant', async () => {
  const previousDataDir = process.env.COMMANDER_SAGA_DATA;
  const dataDir = mkdtempSync(join(tmpdir(), 'commander-saga-'));
  process.env.COMMANDER_SAGA_DATA = dataDir;
  const { createSagaRouter } = await import('../src/sagaEndpoints');
  const snapshot = (runId: string, tenantId: string, ownerId: string) => ({
    runId,
    state: 'PAUSED',
    intentHash: 'intent',
    fencingEpoch: 1,
    nodeStates: {},
    childRunIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checkpointVersion: 1,
    tenantId,
    ownerId,
  });
  try {
    for (const [tenant, runId] of [
      ['tenant-a', 'saga-a'],
      ['tenant-b', 'saga-b'],
    ] as const) {
      mkdirSync(join(dataDir, runId), { recursive: true });
      writeFileSync(
        join(dataDir, runId, 'snapshot.json'),
        JSON.stringify(snapshot(runId, tenant, `owner-${tenant}`)),
      );
      writeFileSync(join(dataDir, runId, 'events.ndjson'), '');
    }
    const server = await start(createSagaRouter());
    try {
      const list = await fetch(`${server.baseUrl}/api/saga/runs`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'owner-tenant-a' },
      });
      assert.equal(list.status, 200);
      assert.deepEqual(
        (await list.json()).runs.map((run: { runId: string }) => run.runId),
        ['saga-a'],
      );
      const own = await fetch(`${server.baseUrl}/api/saga/runs/saga-a`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'owner-tenant-a' },
      });
      assert.equal(own.status, 200);
      const foreign = await fetch(`${server.baseUrl}/api/saga/runs/saga-b`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'owner-tenant-a' },
      });
      assert.equal(foreign.status, 404);
      const foreignResume = await fetch(`${server.baseUrl}/api/saga/runs/saga-b/resume`, {
        method: 'POST',
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'owner-tenant-a' },
      });
      assert.equal(foreignResume.status, 404);
    } finally {
      await server.close();
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.COMMANDER_SAGA_DATA;
    else process.env.COMMANDER_SAGA_DATA = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
