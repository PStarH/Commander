import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { createCostRouter } from '../src/costEndpoints';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import { getUnifiedCostAuthority, resetUnifiedCostAuthority } from '@commander/core';
import { runWithTenant } from '@commander/core/runtime/tenantContext';

describe('cost endpoints tenant isolation', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;

  before(async () => {
    app = express();
    app.use(tenantContextMiddleware);
    app.use(createCostRouter());
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    resetUnifiedCostAuthority();
  });

  afterEach(() => {
    resetUnifiedCostAuthority();
  });

  function recordForTenant(tenantId: string, costUsd: number) {
    runWithTenant(tenantId, () => {
      getUnifiedCostAuthority().postCall(
        { runId: 'run-shared', tenantId, model: 'gpt-4o' },
        { costUsd },
      );
    });
  }

  it('returns only the current tenant summary', async () => {
    recordForTenant('tenant-a', 10.5);
    recordForTenant('tenant-b', 20.25);

    const resA = await fetch(`${baseUrl}/api/cost/summary`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(resA.status, 200);
    const bodyA = (await resA.json()) as { totalCostUsd: number; totalCalls: number };
    assert.equal(bodyA.totalCostUsd, 10.5);
    assert.equal(bodyA.totalCalls, 1);

    const resB = await fetch(`${baseUrl}/api/cost/summary`, {
      headers: { 'X-Tenant-ID': 'tenant-b' },
    });
    assert.equal(resB.status, 200);
    const bodyB = (await resB.json()) as { totalCostUsd: number; totalCalls: number };
    assert.equal(bodyB.totalCostUsd, 20.25);
    assert.equal(bodyB.totalCalls, 1);
  });

  it('returns only the current tenant records', async () => {
    recordForTenant('tenant-a', 5.0);
    recordForTenant('tenant-b', 7.0);

    const resA = await fetch(`${baseUrl}/api/cost/records`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(resA.status, 200);
    const bodyA = (await resA.json()) as { records: Array<{ costUsd: number }>; total: number };
    assert.equal(bodyA.total, 1);
    assert.equal(bodyA.records[0].costUsd, 5.0);

    const resB = await fetch(`${baseUrl}/api/cost/records`, {
      headers: { 'X-Tenant-ID': 'tenant-b' },
    });
    assert.equal(resB.status, 200);
    const bodyB = (await resB.json()) as { records: Array<{ costUsd: number }>; total: number };
    assert.equal(bodyB.total, 1);
    assert.equal(bodyB.records[0].costUsd, 7.0);
  });

  it('returns per-tenant budget snapshot', async () => {
    recordForTenant('tenant-a', 12.34);
    recordForTenant('tenant-b', 56.78);

    const resA = await fetch(`${baseUrl}/api/cost/budget`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(resA.status, 200);
    const bodyA = (await resA.json()) as { monthlyUsed: number };
    assert.equal(bodyA.monthlyUsed, 12.34);

    const resB = await fetch(`${baseUrl}/api/cost/budget`, {
      headers: { 'X-Tenant-ID': 'tenant-b' },
    });
    assert.equal(resB.status, 200);
    const bodyB = (await resB.json()) as { monthlyUsed: number };
    assert.equal(bodyB.monthlyUsed, 56.78);
  });

  it('falls back to default tenant without a tenant header', async () => {
    // Single-tenant callers do not wrap requests in a tenant context.
    getUnifiedCostAuthority().postCall(
      { runId: 'run-default', model: 'gpt-4o' },
      { costUsd: 3.0 },
    );

    const res = await fetch(`${baseUrl}/api/cost/summary`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { totalCostUsd: number; totalCalls: number };
    assert.equal(body.totalCostUsd, 3.0);
    assert.equal(body.totalCalls, 1);
  });
});
