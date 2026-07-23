import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createLineageRouter } from '../src/lineageEndpoints';
import { createHallucinationRouter } from '../src/hallucinationEndpoints';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';

describe('derived observability endpoint tenant isolation', () => {
  const originalCwd = process.cwd();
  let tmpDir: string;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(originalCwd, '.tmp-observability-tenant-'));
    process.chdir(tmpDir);
    const tracesDir = path.join(tmpDir, '.commander_traces');
    const tenantDir = path.join(tracesDir, 'tenant_tenant-a');
    fs.mkdirSync(tenantDir, { recursive: true });
    const spawnEvent = {
      id: 'spawn-a',
      spanId: 'span-a',
      traceId: 'trace-a',
      runId: 'run-a',
      agentId: 'root-a',
      type: 'agent.spawn',
      timestamp: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      data: { instanceId: 'root-a', agentId: 'root-a' },
    };
    const hallucinationEvent = {
      id: 'hallucination-a',
      spanId: 'span-ha',
      traceId: 'trace-a',
      runId: 'run-a',
      agentId: 'root-a',
      type: 'verification',
      timestamp: '2026-01-01T00:00:01.000Z',
      durationMs: 0,
      data: { evaluationScore: 0.9, evaluationPassed: false },
    };
    const foreignEvent = {
      ...spawnEvent,
      id: 'spawn-b',
      spanId: 'span-b',
      traceId: 'trace-b',
      runId: 'run-b',
      agentId: 'root-b',
      data: { instanceId: 'root-b', agentId: 'root-b' },
    };
    fs.writeFileSync(
      path.join(tenantDir, 'run-a.ndjson'),
      `${JSON.stringify(spawnEvent)}\n${JSON.stringify(hallucinationEvent)}\n`,
    );
    fs.writeFileSync(path.join(tracesDir, 'run-b.ndjson'), `${JSON.stringify(foreignEvent)}\n`);

    const app = express();
    app.use(tenantContextMiddleware);
    const { createObservabilityRouter } = await import('../src/observabilityEndpoints');
    app.use('/api/v1/observability', createObservabilityRouter());
    app.use(createLineageRouter());
    app.use(createHallucinationRouter());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the current tenant lineage and hides a foreign run', async () => {
    const own = await fetch(`${baseUrl}/api/lineage/runs/run-a`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).totalNodes, 1);

    const foreign = await fetch(`${baseUrl}/api/lineage/runs/run-b`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(foreign.status, 200);
    assert.equal((await foreign.json()).totalNodes, 0);
  });

  it('returns current tenant hallucination reports and hides a foreign run', async () => {
    const own = await fetch(`${baseUrl}/api/hallucination/runs/run-a`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).total, 1);

    const foreign = await fetch(`${baseUrl}/api/hallucination/runs/run-b`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(foreign.status, 200);
    assert.equal((await foreign.json()).total, 0);
  });

  it('propagates middleware tenant identity through the observability adapter', async () => {
    const own = await fetch(`${baseUrl}/api/v1/observability/runs/run-a/timeline`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(own.status, 200);

    const foreign = await fetch(`${baseUrl}/api/v1/observability/runs/run-b/timeline`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(foreign.status, 404);
  });
});
