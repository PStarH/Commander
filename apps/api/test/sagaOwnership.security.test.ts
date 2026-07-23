import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'commander-saga-owner-'));
const previousDataDir = process.env.COMMANDER_SAGA_DATA;
process.env.COMMANDER_SAGA_DATA = dataDir;
const { createSagaRouter } = await import('../src/sagaEndpoints.js');

type Role = 'developer' | 'operator' | 'admin' | 'super_admin';

function snapshot(runId: string, tenantId: string, ownerId: string) {
  const now = new Date().toISOString();
  return {
    runId,
    state: 'PAUSED',
    intentHash: 'intent',
    fencingEpoch: 1,
    nodeStates: {},
    childRunIds: [],
    createdAt: now,
    updatedAt: now,
    checkpointVersion: 1,
    tenantId,
    ownerId,
    sagaName: 'order-fulfillment',
    input: { orderId: runId, amount: 10 },
  };
}

async function waitForSnapshot(
  runId: string,
  expectedState?: string,
): Promise<Record<string, unknown>> {
  const snapshotPath = join(dataDir, runId, 'snapshot.json');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(snapshotPath)) {
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
      if (!expectedState || snapshot.state === expectedState) return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`snapshot ${runId} was not persisted`);
}

function writeRun(runId: string, tenantId: string, ownerId: string): void {
  const dir = join(dataDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snapshot(runId, tenantId, ownerId)));
  writeFileSync(join(dir, 'events.ndjson'), '');
}

function headers(
  principalId: string,
  tenantId: string,
  options: { role?: Role; scopes?: string[]; apiKey?: boolean } = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-test-principal': principalId,
    'x-test-tenant': tenantId,
    'x-test-role': options.role ?? 'developer',
    'x-test-scopes': (options.scopes ?? []).join(','),
    ...(options.apiKey ? { 'x-test-api-key': '1' } : {}),
  };
}

async function start() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const principalId = req.header('x-test-principal');
    const tenantId = req.header('x-test-tenant');
    const role = req.header('x-test-role') as Role | undefined;
    if (principalId && tenantId) {
      req.tenantId = tenantId;
      if (req.header('x-test-api-key') === '1') {
        req.apiKeyId = principalId;
        req.apiScopes = (req.header('x-test-scopes') ?? '').split(',').filter(Boolean);
      } else {
        req.user = {
          id: principalId,
          username: principalId,
          role: role ?? 'developer',
          tenantId: req.header('x-test-claim-tenant') ?? tenantId,
          scopes: (req.header('x-test-scopes') ?? '').split(',').filter(Boolean),
        };
      }
    }
    next();
  });
  app.use(createSagaRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('CMD-SAGA-CONTROL-001 owner authorization', () => {
  let server: Awaited<ReturnType<typeof start>>;

  before(async () => {
    writeRun('run-alice', 'tenant-a', 'alice');
    writeRun('run-bob', 'tenant-a', 'bob');
    writeRun('run-admin', 'tenant-a', 'alice');
    writeRun('run-operator', 'tenant-a', 'alice');
    writeRun('run-fork', 'tenant-a', 'alice');
    writeRun('run-foreign', 'tenant-b', 'mallory');
    server = await start();
  });

  after(async () => {
    await server.close();
    if (previousDataDir === undefined) delete process.env.COMMANDER_SAGA_DATA;
    else process.env.COMMANDER_SAGA_DATA = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('shows ordinary users only their owned runs and hides foreign tenants', async () => {
    const list = await fetch(`${server.baseUrl}/api/saga/runs`, {
      headers: headers('alice', 'tenant-a'),
    });
    assert.equal(list.status, 200);
    assert.deepEqual(
      ((await list.json()) as { runs: Array<{ runId: string }> }).runs.map((run) => run.runId),
      ['run-admin', 'run-alice', 'run-fork', 'run-operator'],
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/saga/runs/run-alice`, {
          headers: headers('bob', 'tenant-a'),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/saga/runs/run-foreign`, {
          headers: headers('admin-a', 'tenant-a', { role: 'admin' }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/saga/runs/run-foreign`, {
          headers: {
            ...headers('forged-admin', 'tenant-b', { role: 'admin' }),
            'x-test-claim-tenant': 'tenant-a',
          },
        })
      ).status,
      403,
    );
  });

  it('blocks same-tenant non-owners from resume and fork before mutation', async () => {
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/saga/runs/run-alice/resume`, {
          method: 'POST',
          headers: headers('bob', 'tenant-a'),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/saga/runs/run-foreign/resume`, {
          method: 'POST',
          headers: headers('admin-a', 'tenant-a', { role: 'admin' }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/saga/runs/run-alice/fork`, {
          method: 'POST',
          headers: headers('bob', 'tenant-a'),
          body: JSON.stringify({ nodeId: 'step-a', input: { forged: true } }),
        })
      ).status,
      403,
    );
  });

  it('allows the owner, tenant admin, and explicitly scoped operator to resume', async () => {
    const requests = [
      fetch(`${server.baseUrl}/api/saga/runs/run-admin/resume`, {
        method: 'POST',
        headers: headers('alice', 'tenant-a'),
      }),
      fetch(`${server.baseUrl}/api/saga/runs/run-operator/resume`, {
        method: 'POST',
        headers: headers('admin-a', 'tenant-a', { role: 'admin' }),
      }),
      fetch(`${server.baseUrl}/api/saga/runs/run-alice/resume`, {
        method: 'POST',
        headers: headers('operator-key', 'tenant-a', {
          apiKey: true,
          scopes: ['saga:operate'],
        }),
      }),
    ];
    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { status: string }).status, 'resuming');
    }
    for (const runId of ['run-alice', 'run-admin', 'run-operator']) {
      const resumed = await waitForSnapshot(runId, 'COMMITTED');
      assert.equal(resumed.tenantId, 'tenant-a');
      assert.equal(resumed.ownerId, 'alice');
    }
  });

  it('forks through the real coordinator sink and persists inherited ownership', async () => {
    const response = await fetch(`${server.baseUrl}/api/saga/runs/run-fork/fork`, {
      method: 'POST',
      headers: headers('alice', 'tenant-a'),
      body: JSON.stringify({
        nodeId: 'validate-cart',
        input: { orderId: 'forked-order', amount: 5 },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { newRunId: string; status: string };
    assert.equal(body.status, 'forked');
    const child = await waitForSnapshot(body.newRunId, 'COMMITTED');
    assert.equal(child.tenantId, 'tenant-a');
    assert.equal(child.ownerId, 'alice');
    assert.equal(child.parentRunId, 'run-fork');
    const parent = await waitForSnapshot('run-fork');
    assert.ok((parent.childRunIds as string[]).includes(body.newRunId));
  });
});
