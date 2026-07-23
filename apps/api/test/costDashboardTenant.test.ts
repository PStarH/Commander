import { before, after, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import { createCostDashboardRouter } from '../src/costDashboardEndpoints';

interface TraceEvent {
  id: string;
  spanId: string;
  traceId: string;
  runId: string;
  tenantId?: string;
  agentId: string;
  type: string;
  timestamp: string;
  durationMs: number;
  data: Record<string, unknown>;
}

describe('cost dashboard tenant filtering', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;
  let originalCwd: string;
  let tmpDir: string;

  before(async () => {
    app = express();
    app.use(tenantContextMiddleware);
    app.use(createCostDashboardRouter());
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdr-costdash-'));
    fs.mkdirSync(path.join(tmpDir, '.commander_traces'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  function makeLLMCallEvent(
    tenantId: string | undefined,
    promptTokens: number,
    completionTokens: number,
  ): TraceEvent {
    return {
      id: 'evt-1',
      spanId: 'span-1',
      traceId: 'trace-1',
      runId: 'run-1',
      tenantId,
      agentId: 'agent-1',
      type: 'llm_call',
      timestamp: new Date().toISOString(),
      durationMs: 100,
      data: {
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        output: { toolCalls: [] },
      },
    };
  }

  function writeEvents(events: TraceEvent[]) {
    const file = path.join(tmpDir, '.commander_traces', 'test.ndjson');
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  it('returns only the requested tenant cost data', async () => {
    writeEvents([
      makeLLMCallEvent('tenant-a', 1000, 200),
      makeLLMCallEvent('tenant-b', 500, 100),
      makeLLMCallEvent(undefined, 900, 100),
    ]);

    const resA = await fetch(`${baseUrl}/api/cost/dashboard`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(resA.status, 200);
    const bodyA = (await resA.json()) as { summary: { totalCalls: number; totalTokens: number } };
    assert.equal(bodyA.summary.totalCalls, 1);
    assert.equal(bodyA.summary.totalTokens, 1200);

    const resB = await fetch(`${baseUrl}/api/cost/dashboard`, {
      headers: { 'X-Tenant-ID': 'tenant-b' },
    });
    assert.equal(resB.status, 200);
    const bodyB = (await resB.json()) as { summary: { totalCalls: number; totalTokens: number } };
    assert.equal(bodyB.summary.totalCalls, 1);
    assert.equal(bodyB.summary.totalTokens, 600);
  });

  it('falls back to single-tenant mode without a tenant header', async () => {
    writeEvents([makeLLMCallEvent(undefined, 300, 50), makeLLMCallEvent(undefined, 700, 150)]);

    const res = await fetch(`${baseUrl}/api/cost/dashboard`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { summary: { totalCalls: number; totalTokens: number } };
    assert.equal(body.summary.totalCalls, 2);
    assert.equal(body.summary.totalTokens, 1200);
  });
});
