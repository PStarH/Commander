import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
} from '@commander/kernel';
import {
  ActionAdapterRegistry,
  createGitHubPullRequestCreateAdapter,
} from '@commander/action-adapters';

describe('L4-02 operations chaos — worker kill / double compensate', () => {
  it('duplicate compensation outbox messages produce one remote state change', async () => {
    let compensateCount = 0;
    const pulls = [
      {
        number: 42,
        html_url: 'https://github.com/octo/repo/pull/42',
        state: 'open',
        body: '<!-- commander-action:abc -->',
        head: { ref: 'feature' },
        base: { ref: 'main' },
      },
    ];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' && url.endsWith('/pulls/42')) {
        const pull = pulls[0]!;
        if (pull.state !== 'closed') {
          compensateCount += 1;
          pull.state = 'closed';
        }
        return new Response(JSON.stringify(pull), { status: 200 });
      }
      if (method === 'GET' && url.endsWith('/pulls/42')) {
        return new Response(JSON.stringify(pulls[0]), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: {
        async getGitHubToken() {
          return 'token';
        },
        async getServiceNowCredentials() {
          throw new Error('not used');
        },
      },
      fetch: fetchImpl,
    });
    const registry = new ActionAdapterRegistry([adapter]);
    const kernel = new InMemoryKernelRepository();
    const payload = {
      type: 'kernel.compensation.requested',
      tenantId: 'tenant-a',
      runId: 'run-cmp-chaos',
      stepId: 'step-cmp-chaos',
      compensationAction: 'compensate.github.pull-request.create',
      compensationPayload: {
        originalEffectId: 'effect-forward',
        forwardResponse: { prNumber: 42 },
        compensationPatch: {},
        destination: 'github://octo/repo/pulls',
      },
      idempotencyKey: 'cmp:effect-forward:1.0.0',
    };
    kernel.seedOutboxMessage({
      topic: KERNEL_COMPENSATION_TOPIC,
      tenantId: 'tenant-a',
      key: 'tenant-a/run-cmp-chaos/effect-forward-1',
      payload,
    });
    kernel.seedOutboxMessage({
      topic: KERNEL_COMPENSATION_TOPIC,
      tenantId: 'tenant-a',
      key: 'tenant-a/run-cmp-chaos/effect-forward-2',
      payload,
    });

    const admitKeys = new Set<string>();
    const broker = {
      admit: async (input: {
        effectId: string;
        idempotencyKey: string;
        type: string;
      }) => {
        if (admitKeys.has(input.idempotencyKey)) {
          return { admitted: true, effectId: input.effectId, replayed: true };
        }
        admitKeys.add(input.idempotencyKey);
        return { admitted: true, effectId: input.effectId, replayed: false };
      },
      executeAdmitted: async (input: { effectId: string }) => {
        const resolved = registry.resolve('compensate.github.pull-request.create');
        assert.ok(resolved);
        const response = await resolved.compensate({
          tenantId: 'tenant-a',
          effectId: input.effectId,
          originalEffectId: 'effect-forward',
          idempotencyKey: 'cmp:effect-forward:1.0.0',
          destination: 'github://octo/repo/pulls',
          forwardResponse: { prNumber: 42 },
          compensationPatch: {},
          signal: AbortSignal.timeout(5_000),
        });
        return { effectId: input.effectId, replayed: false, response };
      },
    };

    await consumeCompensationBatch(kernel, broker, async () => 'token', {
      workerId: 'compensation-chaos',
      topic: KERNEL_COMPENSATION_TOPIC,
      limit: 10,
    });
    await consumeCompensationBatch(kernel, broker, async () => 'token', {
      workerId: 'compensation-chaos',
      topic: KERNEL_COMPENSATION_TOPIC,
      limit: 10,
    });

    assert.equal(compensateCount, 1);
    assert.equal(pulls[0]!.state, 'closed');
  });
});
