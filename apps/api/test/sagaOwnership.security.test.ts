import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('keeps resume and fork removed for owners, admins, operators, and foreign callers', async () => {
    const requests = [
      ['run-alice/resume', headers('alice', 'tenant-a'), undefined],
      ['run-alice/resume', headers('bob', 'tenant-a'), undefined],
      ['run-admin/resume', headers('admin-a', 'tenant-a', { role: 'admin' }), undefined],
      [
        'run-operator/resume',
        headers('operator-key', 'tenant-a', { apiKey: true, scopes: ['saga:operate'] }),
        undefined,
      ],
      ['run-foreign/resume', headers('admin-a', 'tenant-a', { role: 'admin' }), undefined],
      [
        'run-fork/fork',
        headers('alice', 'tenant-a'),
        { nodeId: 'validate-cart', input: { orderId: 'forked-order', amount: 5 } },
      ],
    ] as const;
    for (const [path, requestHeaders, body] of requests) {
      const response = await fetch(`${server.baseUrl}/api/saga/runs/${path}`, {
        method: 'POST',
        headers: requestHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 410, path);
      const payload = (await response.json()) as {
        error?: { code?: string; replacement?: string };
      };
      assert.equal(payload.error?.code, 'LEGACY_EXECUTION_DISABLED');
      assert.equal(payload.error?.replacement, 'POST /v1/runs');
    }
  });
});
