import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { getMetricsCollector } from '@commander/core';
import {
  runWithTenant,
  getTokenGovernor,
  getTenantFairnessMonitor,
  getTenantManager,
  resetTokenGovernor,
  resetTenantFairnessMonitor,
  resetTenantManager,
} from '@commander/core/runtime';
import {
  recordRuntimeUsage,
  resetRuntimeRegistry,
} from '../src/agentRuntimeRegistry';
import { exportTenantMetrics } from '../src/tenantMetricsExporter';

describe('/metrics tenant label control', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;

  before(async () => {
    app = express();
    app.get('/metrics', (_req, res) => {
      const tenantMetrics = exportTenantMetrics(process.env.METRICS_TENANT_LABELS === 'true');
      res.type('text/plain; version=0.0.4').send(getMetricsCollector().exportOpenMetrics() + tenantMetrics);
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    // Force-close any lingering keep-alive connections so server.close() can resolve.
    if ('closeAllConnections' in server && typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    process.env.COMMANDER_LEGACY_EXECUTION = '1';
    delete process.env.METRICS_TENANT_LABELS;
    getMetricsCollector().reset();
    resetRuntimeRegistry();
    resetTokenGovernor();
    resetTenantFairnessMonitor();
    resetTenantManager();
  });

  function seedTenant(tenantId: string, runs: number, tokens: number, durationMs: number) {
    recordRuntimeUsage(tenantId, { totalRuns: runs, durationMs });
    runWithTenant(tenantId, () => {
      getTokenGovernor().reportUsage(tokens);
    });
    for (let i = 0; i < runs; i++) {
      getTenantFairnessMonitor().recordCompletion(tenantId);
    }
  }

  it('includes tenant labels when METRICS_TENANT_LABELS=true', async () => {
    process.env.METRICS_TENANT_LABELS = 'true';
    seedTenant('tenant-a', 2, 400, 1500);
    seedTenant('tenant-b', 1, 200, 800);

    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.match(body, /commander_tenant_runs_total\{tenant="tenant-a"\} 2/);
    assert.match(body, /commander_tenant_runs_total\{tenant="tenant-b"\} 1/);
    assert.match(body, /commander_tenant_tokens_total\{tenant="tenant-a"\} 400/);
    assert.match(body, /commander_tenant_tokens_total\{tenant="tenant-b"\} 200/);
    assert.match(body, /commander_tenant_latency_seconds_bucket\{tenant="tenant-a"/);
    assert.match(body, /commander_tenant_storage_bytes\{tenant="tenant-a"\} 0/);
    assert.match(body, /commander_tenant_jain_fairness_index [\d.]+/);
  });

  it('omits tenant labels by default', async () => {
    seedTenant('tenant-a', 2, 400, 1500);
    seedTenant('tenant-b', 1, 200, 800);

    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.match(body, /commander_tenant_runs_total [\d.]+/);
    assert.match(body, /commander_tenant_tokens_total [\d.]+/);
    assert.doesNotMatch(body, /tenant="tenant-a"/);
    assert.doesNotMatch(body, /tenant="tenant-b"/);
  });

  it('aggregates values when tenant labels are disabled', async () => {
    seedTenant('tenant-a', 2, 400, 1500);
    seedTenant('tenant-b', 1, 200, 800);

    const res = await fetch(`${baseUrl}/metrics`);
    const body = await res.text();

    assert.match(body, /commander_tenant_runs_total 3/);
    assert.match(body, /commander_tenant_tokens_total 600/);
    assert.match(body, /commander_tenant_latency_seconds_count 2/);
  });
});
