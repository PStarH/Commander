import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';
import type { V1KernelGateway } from '../src/v1GatewayKernel.js';

class ListRunsFakeGateway {
  private readonly runs: Array<{
    id: string;
    tenantId: string;
    state: string;
    createdAt: string;
    updatedAt: string;
    intentHash: string;
    workGraphHash: string;
    workGraphVersion: string;
    policySnapshotId: string;
  }> = [];

  seed(run: {
    id: string;
    tenantId: string;
    state?: string;
    updatedAt: string;
    createdAt?: string;
  }) {
    this.runs.push({
      id: run.id,
      tenantId: run.tenantId,
      state: run.state ?? 'PENDING',
      createdAt: run.createdAt ?? run.updatedAt,
      updatedAt: run.updatedAt,
      intentHash: 'intent',
      workGraphHash: 'graph',
      workGraphVersion: 'v1',
      policySnapshotId: 'policy-42',
    });
  }

  async submit() {
    throw new Error('not implemented');
  }
  async getRun(runId: string, tenantId: string) {
    return this.runs.find((run) => run.id === runId && run.tenantId === tenantId) ?? null;
  }
  async listRuns(tenantId: string, options?: { limit?: number }) {
    const limit = options?.limit ?? 50;
    return this.runs
      .filter((run) => run.tenantId === tenantId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }
  async listEvents() {
    return [];
  }
  async listEffects() {
    return [];
  }
  async pauseRun() {
    return null;
  }
  async resumeRun() {
    return null;
  }
  async cancelRun() {
    return null;
  }
}

async function withGateway(
  kernel: ListRunsFakeGateway,
  tenantId: string,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).tenantId = tenantId;
    next();
  });
  app.use('/v1', createV1GatewayRouter(() => kernel as unknown as V1KernelGateway));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('GET /v1/runs', () => {
  it('returns tenant-scoped runs ordered by updatedAt desc with contracts RunState field name', async () => {
    const gateway = new ListRunsFakeGateway();
    gateway.seed({ id: 'run-old', tenantId: 'tenant-a', state: 'SUCCEEDED', updatedAt: '2026-07-17T01:00:00.000Z' });
    gateway.seed({ id: 'run-new', tenantId: 'tenant-a', state: 'RUNNING', updatedAt: '2026-07-19T01:00:00.000Z' });
    gateway.seed({ id: 'run-other', tenantId: 'tenant-b', state: 'PENDING', updatedAt: '2026-07-20T01:00:00.000Z' });

    await withGateway(gateway, 'tenant-a', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { runs: Array<Record<string, unknown>> };
      assert.equal(body.runs.length, 2);
      assert.equal(body.runs[0]?.id, 'run-new');
      assert.equal(body.runs[0]?.state, 'RUNNING');
      assert.equal(body.runs[1]?.id, 'run-old');
      assert.deepEqual(Object.keys(body.runs[0] ?? {}).sort(), [
        'createdAt',
        'id',
        'state',
        'tenantId',
        'updatedAt',
      ]);
    });
  });

  it('clamps limit to 1..200 and defaults to 50', async () => {
    const gateway = new ListRunsFakeGateway();
    for (let i = 0; i < 55; i++) {
      const hour = String(Math.floor(i / 60)).padStart(2, '0');
      const minute = String(i % 60).padStart(2, '0');
      gateway.seed({
        id: `run-${String(i).padStart(3, '0')}`,
        tenantId: 'tenant-a',
        updatedAt: `2026-07-19T${hour}:${minute}:00.000Z`,
      });
    }

    await withGateway(gateway, 'tenant-a', async (baseUrl) => {
      const defaultLimit = await fetch(`${baseUrl}/v1/runs`);
      assert.equal(defaultLimit.status, 200);
      assert.equal((await defaultLimit.json() as any).runs.length, 50);

      const overMax = await fetch(`${baseUrl}/v1/runs?limit=999`);
      assert.equal(overMax.status, 200);
      assert.equal((await overMax.json() as any).runs.length, 55);

      const underMin = await fetch(`${baseUrl}/v1/runs?limit=0`);
      assert.equal(underMin.status, 200);
      assert.equal((await underMin.json() as any).runs.length, 1);

      const negative = await fetch(`${baseUrl}/v1/runs?limit=-1`);
      assert.equal(negative.status, 200);
      assert.equal((await negative.json() as any).runs.length, 1);

      const nonNumeric = await fetch(`${baseUrl}/v1/runs?limit=abc`);
      assert.equal(nonNumeric.status, 200);
      assert.equal((await nonNumeric.json() as any).runs.length, 50);

      const justOver = await fetch(`${baseUrl}/v1/runs?limit=201`);
      assert.equal(justOver.status, 200);
      assert.equal((await justOver.json() as any).runs.length, 55);

      const explicit = await fetch(`${baseUrl}/v1/runs?limit=10`);
      assert.equal(explicit.status, 200);
      assert.equal((await explicit.json() as any).runs.length, 10);
    });
  });

  it('returns 503 when the shared kernel is unavailable', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).tenantId = 'tenant-a';
      next();
    });
    app.use('/v1', createV1GatewayRouter(() => null));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/runs`);
      assert.equal(res.status, 503);
      assert.equal((await res.json() as any).error.code, 'KERNEL_UNAVAILABLE');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
