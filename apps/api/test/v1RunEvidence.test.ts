import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { verifyEvidenceBundle } from '@commander/effect-broker';
import type { KernelEffect, KernelEvent } from '@commander/kernel';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';
import type { V1KernelGateway } from '../src/v1GatewayKernel.js';

class EvidenceFakeGateway {
  private readonly runs = new Map<string, any>();
  private readonly effects = new Map<string, KernelEffect>();
  private readonly events: KernelEvent[] = [];

  seedRun(run: {
    id: string;
    tenantId: string;
    state?: string;
    intentHash?: string;
    workGraphHash?: string;
    workGraphVersion?: string;
    policySnapshotId?: string;
  }) {
    const timestamp = new Date().toISOString();
    this.runs.set(run.id, {
      id: run.id,
      tenantId: run.tenantId,
      state: run.state ?? 'SUCCEEDED',
      createdAt: timestamp,
      updatedAt: timestamp,
      intentHash: run.intentHash ?? 'intent-hash',
      workGraphHash: run.workGraphHash ?? 'graph-hash',
      workGraphVersion: run.workGraphVersion ?? 'v1',
      policySnapshotId: run.policySnapshotId ?? 'policy-42',
    });
  }

  seedEffect(effect: KernelEffect) {
    this.effects.set(effect.id, effect);
  }

  seedEvent(event: KernelEvent) {
    this.events.push(event);
  }

  async submit() {
    throw new Error('not implemented');
  }
  async getRun(runId: string, tenantId: string) {
    const value = this.runs.get(runId);
    return value?.tenantId === tenantId ? value : null;
  }
  async listEvents(runId: string, tenantId: string) {
    return this.events.filter((e) => e.runId === runId && e.tenantId === tenantId);
  }
  async listEffects(runId: string, tenantId: string) {
    return [...this.effects.values()].filter((e) => e.runId === runId && e.tenantId === tenantId);
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
  async listRuns() {
    return [];
  }
}

async function withGateway(
  kernel: EvidenceFakeGateway | null,
  tenantId: string,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).tenantId = tenantId;
    (req as any).apiKeyId = 'test-key';
    next();
  });
  app.use(
    '/v1',
    createV1GatewayRouter(() => (kernel ? (kernel as unknown as V1KernelGateway) : null)),
  );
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

describe('GET /v1/runs/:runId/evidence', () => {
  it('returns a bundle that passes verifyEvidenceBundle for the authenticated tenant', async () => {
    const gateway = new EvidenceFakeGateway();
    gateway.seedRun({ id: 'run-ev-1', tenantId: 'tenant-a' });
    gateway.seedEffect({
      id: 'eff-1',
      runId: 'run-ev-1',
      stepId: 'step-1',
      tenantId: 'tenant-a',
      type: 'llm.invoke',
      idempotencyKey: 'k-1',
      requestHash: 'req-hash-1',
      policyDecisionId: 'pd-1',
      state: 'COMPLETED',
      request: { contentHash: 'prompt-bound' },
      response: {
        contentHash: 'resp-bound',
        status: 'ok',
        messages: [{ role: 'user', content: 'secret prompt' }],
        Authorization: 'Bearer SECRET-TOKEN',
        'gen_ai.prompt': 'secret prompt',
        'gen_ai.completion': 'secret completion',
        'gen_ai.tool.call.arguments': { password: 'x' },
        chainOfThought: 'hidden reasoning',
      },
      createdAt: '2026-07-19T01:00:00.000Z',
      completedAt: '2026-07-19T01:00:01.000Z',
    });
    gateway.seedEvent({
      eventId: 'evt-1',
      aggregateType: 'effect',
      aggregateId: 'eff-1',
      sequence: 0,
      type: 'effect.completed',
      tenantId: 'tenant-a',
      runId: 'run-ev-1',
      stepId: 'step-1',
      actor: 'worker-1',
      schemaVersion: 'v1',
      payload: {
        effectId: 'eff-1',
        policyDecisionId: 'pd-1',
        Authorization: 'Bearer SECRET-TOKEN',
        'gen_ai.prompt': 'secret prompt',
        prompt: 'secret prompt',
      },
      occurredAt: '2026-07-19T01:00:01.000Z',
    });

    await withGateway(gateway, 'tenant-a', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs/run-ev-1/evidence`);
      assert.equal(res.status, 200);
      const raw = await res.text();
      assert.equal(findDlpLeak(raw), undefined);
      const body = JSON.parse(raw) as { bundle: unknown; verification: { ok: boolean } };
      const verification = verifyEvidenceBundle(body.bundle as any);
      assert.equal(verification.ok, true);
      assert.equal(body.verification.ok, true);
      assert.equal((body.bundle as any).scope.tenantId, 'tenant-a');
      assert.equal((body.bundle as any).scope.runId, 'run-ev-1');
      assert.equal((body.bundle as any).effects.length, 1);
      assert.equal((body.bundle as any).effects[0].responseSummary?.status, 'ok');
      assert.equal(findDlpLeak(body.bundle), undefined);
    });
  });

  it('sanitizes GET /v1/runs/:runId/events payloads before HTTP response', async () => {
    const gateway = new EvidenceFakeGateway();
    gateway.seedRun({ id: 'run-ev-2', tenantId: 'tenant-a' });
    gateway.seedEvent({
      eventId: 'evt-2',
      aggregateType: 'run',
      aggregateId: 'run-ev-2',
      sequence: 0,
      type: 'run.created',
      tenantId: 'tenant-a',
      runId: 'run-ev-2',
      stepId: null,
      actor: 'gateway',
      schemaVersion: 'v1',
      payload: {
        goal: 'ok-meta',
        Authorization: 'Bearer SECRET-TOKEN',
        'gen_ai.prompt': 'secret prompt',
        messages: [{ content: 'secret prompt' }],
      },
      occurredAt: '2026-07-19T01:00:00.000Z',
    });

    await withGateway(gateway, 'tenant-a', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs/run-ev-2/events`);
      assert.equal(res.status, 200);
      const raw = await res.text();
      assert.equal(findDlpLeak(raw), undefined);
      const body = JSON.parse(raw) as { events: Array<{ payload: Record<string, unknown> }> };
      assert.equal(body.events[0]?.payload?.goal, 'ok-meta');
      assert.equal(body.events[0]?.payload?.Authorization, undefined);
      assert.equal(body.events[0]?.payload?.['gen_ai.prompt'], undefined);
      assert.equal(body.events[0]?.payload?.messages, undefined);
    });
  });

  it('returns 404 when the run belongs to another tenant', async () => {
    const gateway = new EvidenceFakeGateway();
    gateway.seedRun({ id: 'run-other', tenantId: 'tenant-b' });

    await withGateway(gateway, 'tenant-a', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs/run-other/evidence`);
      assert.equal(res.status, 404);
      assert.equal((await res.json() as any).error.code, 'RUN_NOT_FOUND');
    });
  });

  it('returns 503 when the shared kernel is unavailable', async () => {
    await withGateway(null, 'tenant-a', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs/run-ev-1/evidence`);
      assert.equal(res.status, 503);
      assert.equal((await res.json() as any).error.code, 'KERNEL_UNAVAILABLE');
    });
  });
});

function findDlpLeak(value: unknown): string | undefined {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const forbidden = [
    'gen_ai.prompt',
    'gen_ai.completion',
    'gen_ai.tool.call.arguments',
    'Authorization',
    'chainOfThought',
    'secret prompt',
    'SECRET-TOKEN',
  ];
  for (const token of forbidden) {
    if (json.includes(token)) return token;
  }
  return undefined;
}
