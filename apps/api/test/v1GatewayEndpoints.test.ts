import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import express from 'express';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';
import type { V1KernelGateway } from '../src/v1GatewayKernel.js';

class FakeGateway implements V1KernelGateway {
  private readonly runs = new Map<string, any>();
  async submit(input: any) {
    const id = `run-${input.idempotencyKey}`;
    const old = this.runs.get(id);
    if (old) return { run: old, created: false };
    const timestamp = new Date().toISOString();
    const run = { id, tenantId: input.tenantId, state: 'PENDING', createdAt: timestamp, updatedAt: timestamp, intentHash: 'intent', workGraphHash: 'graph', workGraphVersion: input.workGraphVersion, policySnapshotId: input.policySnapshotId };
    this.runs.set(id, run);
    return { run, created: true };
  }
  async getRun(runId: string, tenantId: string) { const value = this.runs.get(runId); return value?.tenantId === tenantId ? value : null; }
  async listEvents(runId: string, tenantId: string) { return (await this.getRun(runId, tenantId)) ? [{ id: 'event-1', runId, tenantId, type: 'run.created' }] as any[] : []; }
  async pauseRun(runId: string, tenantId: string, _actor: string) {
    const run = await this.getRun(runId, tenantId);
    if (!run || !['PENDING', 'RUNNING'].includes(run.state)) return null;
    run.state = 'PAUSED'; run.updatedAt = new Date().toISOString();
    return run;
  }
  async resumeRun(runId: string, tenantId: string, _actor: string) {
    const run = await this.getRun(runId, tenantId);
    if (!run || run.state !== 'PAUSED') return null;
    run.state = 'RUNNING'; run.updatedAt = new Date().toISOString();
    return run;
  }
  async cancelRun(runId: string, tenantId: string, _actor: string) {
    const run = await this.getRun(runId, tenantId);
    if (!run || !['PENDING', 'RUNNING', 'PAUSED'].includes(run.state)) return null;
    run.state = 'CANCELLED'; run.updatedAt = new Date().toISOString();
    return run;
  }
}

async function withGateway(kernel: V1KernelGateway | null, action: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).tenantId = 'tenant-a'; (req as any).apiKeyId = 'test-key'; next(); });
  app.use('/v1', createV1GatewayRouter(() => kernel));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await action(`http://127.0.0.1:${address.port}`);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe('V1 Gateway runs resource', () => {
  it('submits durable work asynchronously and replays an idempotent submission', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      const body = {
        goal: 'classify incoming invoices',
        policySnapshotId: 'policy-42',
        steps: [{
          kind: 'agent',
          input: {
            goal: 'classify incoming invoices',
            agentId: 'agent-default',
            definitionVersion: 'v1',
            providerSnapshot: { provider: 'openai', model: 'gpt-4o' },
          },
        }],
      };
      const first = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-00000001' }, body: JSON.stringify(body) });
      assert.equal(first.status, 202);
      const firstPayload = await first.json() as any;
      assert.equal(firstPayload.run.state, 'PENDING');
      assert.equal(first.headers.get('location'), '/v1/runs/run-key-00000001');

      const replay = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-00000001' }, body: JSON.stringify(body) });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as any).idempotentReplay, true);

      const result = await fetch(`${baseUrl}/v1/runs/run-key-00000001`);
      assert.equal(result.status, 200);
      assert.equal((await result.json() as any).run.tenantId, 'tenant-a');
    });
  });

  it('rejects agent steps missing definitionVersion or providerSnapshot', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      const body = { goal: 'x', policySnapshotId: 'policy-42', steps: [{ kind: 'agent', input: { agentId: 'a' } }] };
      const res = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-schema-01' }, body: JSON.stringify(body) });
      assert.equal(res.status, 400);
      const payload = await res.json() as any;
      assert.equal(payload.error.code, 'INVALID_REQUEST');
    });
  });

  it('fails closed when no shared kernel is configured', async () => {
    await withGateway(null, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-00000002' }, body: JSON.stringify({ goal: 'do work', policySnapshotId: 'policy-42' }) });
      assert.equal(response.status, 503);
      assert.equal((await response.json() as any).error.code, 'KERNEL_UNAVAILABLE');
    });
  });

  it('pauses, resumes, and cancels a durable run via the lifecycle endpoints', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      // Submit a run to obtain a runId.
      const submit = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-lifecycle-01' }, body: JSON.stringify({ goal: 'lifecycle work', policySnapshotId: 'policy-42' }) });
      assert.equal(submit.status, 202);
      const runId = (await submit.json() as any).run.id;

      // Pause the PENDING run.
      const paused = await fetch(`${baseUrl}/v1/runs/${runId}/pause`, { method: 'POST' });
      assert.equal(paused.status, 200);
      assert.equal((await paused.json() as any).run.state, 'PAUSED');

      // Resuming requires PAUSED state — succeeds now.
      const resumed = await fetch(`${baseUrl}/v1/runs/${runId}/resume`, { method: 'POST' });
      assert.equal(resumed.status, 200);
      assert.equal((await resumed.json() as any).run.state, 'RUNNING');

      // Cancel the (now RUNNING) run.
      const cancelled = await fetch(`${baseUrl}/v1/runs/${runId}/cancel`, { method: 'POST' });
      assert.equal(cancelled.status, 200);
      assert.equal((await cancelled.json() as any).run.state, 'CANCELLED');
    });
  });

  it('returns 404 for lifecycle transitions on an unknown run', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs/run-does-not-exist/pause`, { method: 'POST' });
      assert.equal(res.status, 404);
      assert.equal((await res.json() as any).error.code, 'RUN_NOT_FOUND');
    });
  });

  it('returns 409 when a lifecycle transition is invalid for the current state', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      // Submit, then cancel to reach a terminal state.
      const submit = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-lifecycle-02' }, body: JSON.stringify({ goal: 'will cancel', policySnapshotId: 'policy-42' }) });
      const runId = (await submit.json() as any).run.id;
      const cancelled = await fetch(`${baseUrl}/v1/runs/${runId}/cancel`, { method: 'POST' });
      assert.equal(cancelled.status, 200);

      // Pausing a CANCELLED run is an invalid transition → 409.
      const pauseAgain = await fetch(`${baseUrl}/v1/runs/${runId}/pause`, { method: 'POST' });
      assert.equal(pauseAgain.status, 409);
      assert.equal((await pauseAgain.json() as any).error.code, 'INVALID_STATE_TRANSITION');

      // Resuming a PENDING run (never paused) is also invalid → 409.
      const submit2 = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-lifecycle-03' }, body: JSON.stringify({ goal: 'never paused', policySnapshotId: 'policy-42' }) });
      const runId2 = (await submit2.json() as any).run.id;
      const resumePending = await fetch(`${baseUrl}/v1/runs/${runId2}/resume`, { method: 'POST' });
      assert.equal(resumePending.status, 409);
    });
  });

  it('keeps V1 gateway code free of direct runtime execution', () => {
    const source = readFileSync(new URL('../src/v1GatewayEndpoints.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /new\s+AgentRuntime|from\s+['"][^'"]*agentRuntime/);
  });
});
