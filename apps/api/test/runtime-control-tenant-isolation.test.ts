import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express, { type RequestHandler } from 'express';
import { createReplayRouter } from '../src/replayEndpoints';
import { createPauseRouter, type RunControlGateway } from '../src/pauseEndpoints';

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

test('pause and resume preserve tenant identity through the canonical gateway', async () => {
  const calls: Array<{ operation: string; runId: string; tenantId: string; actor: string }> = [];
  const gateway: RunControlGateway = {
    pauseRun: async (runId, tenantId, actor) => {
      calls.push({ operation: 'pause', runId, tenantId, actor });
      return runId === 'pause-a' ? { id: runId, state: 'PAUSED' } : null;
    },
    resumeRun: async (runId, tenantId, actor) => {
      calls.push({ operation: 'resume', runId, tenantId, actor });
      return runId === 'resume-a' ? { id: runId, state: 'RUNNING' } : null;
    },
  };
  const server = await start(createPauseRouter(() => gateway));
  try {
    for (const [operation, runId, expected] of [
      ['pause', 'pause-b', 409],
      ['pause', 'pause-a', 200],
      ['resume', 'resume-b', 409],
      ['resume', 'resume-a', 200],
    ] as const) {
      const response = await fetch(`${server.baseUrl}/runtime/${operation}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-tenant': 'tenant-a',
          'x-test-principal': 'owner-a',
        },
        body: JSON.stringify({ runId }),
      });
      assert.equal(response.status, expected);
    }
    for (const runId of ['rollback-a', 'rollback-b']) {
      const response = await fetch(`${server.baseUrl}/runtime/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'tenant-a' },
        body: JSON.stringify({ runId, stepNumber: 0 }),
      });
      assert.equal(response.status, 410);
    }
    assert.deepEqual(calls, [
      { operation: 'pause', runId: 'pause-b', tenantId: 'tenant-a', actor: 'owner-a' },
      { operation: 'pause', runId: 'pause-a', tenantId: 'tenant-a', actor: 'owner-a' },
      { operation: 'resume', runId: 'resume-b', tenantId: 'tenant-a', actor: 'owner-a' },
      { operation: 'resume', runId: 'resume-a', tenantId: 'tenant-a', actor: 'owner-a' },
    ]);
  } finally {
    await server.close();
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
      assert.equal(foreignResume.status, 410);
      assert.equal(
        ((await foreignResume.json()) as { error?: { code?: string } }).error?.code,
        'LEGACY_EXECUTION_DISABLED',
      );
    } finally {
      await server.close();
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.COMMANDER_SAGA_DATA;
    else process.env.COMMANDER_SAGA_DATA = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
