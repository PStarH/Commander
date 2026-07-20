import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
} from '@commander/effect-broker';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import {
  ActionAdapterRegistry,
  createGitHubPullRequestCreateAdapter,
  type ActionAdapter,
} from '@commander/action-adapters';
import type { EffectExecutor } from '@commander/effect-broker';
import { ReconciliationDaemon } from '../reconciliationDaemon.js';

const tenantId = 'tenant-ops-chaos';

function adapterExecutor(adapter: ActionAdapter): EffectExecutor {
  return {
    execute: async (input) => {
      const ctx = input.executionContext;
      if (!ctx?.tenantId || !ctx.effectId || typeof input.request.idempotencyKey !== 'string') {
        throw new Error('EFFECT_AUTHORIZATION_REQUIRED');
      }
      const destination = String(input.request.destination ?? '');
      if (input.type.startsWith('compensate.')) {
        return adapter.compensate({
          tenantId: ctx.tenantId,
          effectId: ctx.effectId,
          originalEffectId: String(
            (input.request as Record<string, unknown>).originalEffectId ?? '',
          ),
          idempotencyKey: input.request.idempotencyKey,
          destination,
          forwardResponse:
            ((input.request as Record<string, unknown>).forwardResponse as Record<string, unknown>) ??
            {},
          compensationPatch:
            ((input.request as Record<string, unknown>).compensationPatch as Record<string, unknown>) ??
            {},
          signal: input.signal,
        });
      }
      return adapter.execute({
        tenantId: ctx.tenantId,
        effectId: ctx.effectId,
        idempotencyKey: input.request.idempotencyKey,
        destination,
        args: (input.request.args as Record<string, unknown>) ?? {},
        signal: input.signal,
      });
    },
  };
}

describe('L4-02 operations chaos — timeout after commit', () => {
  it('reconciliation daemon completes UNKNOWN without second remote create', async () => {
    const counters = { createCount: 0, writeCount: 0 };
    const pulls: Array<{
      number: number;
      html_url: string;
      state: string;
      body: string;
      head: { ref: string };
      base: { ref: string };
    }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/pulls?')) {
        return new Response(JSON.stringify(pulls), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/pulls')) {
        counters.createCount += 1;
        counters.writeCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          title: string;
          body: string;
          head: string;
          base: string;
        };
        const created = {
          number: pulls.length + 1,
          html_url: `https://github.com/octo/repo/pull/${pulls.length + 1}`,
          state: 'open',
          body: body.body,
          head: { ref: body.head },
          base: { ref: body.base },
        };
        pulls.push(created);
        return new Response(JSON.stringify(created), { status: 201 });
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
    const executor = adapterExecutor(adapter);
    const kernel = new InMemoryKernelRepository();
    const destination = 'github://octo/repo/pulls';

    await kernel.createRun(
      {
        id: 'run-ops-chaos',
        tenantId,
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [{ id: 'step-ops-chaos', kind: 'tool' }],
      },
      'ops-chaos',
    );
    const step = await kernel.claimNextStep({ workerId: 'worker-ops', leaseTtlMs: 60_000 });
    assert.ok(step?.lease);
    await kernel.setAllowlistEntry(tenantId, 'connector.github.pull-request.create', true);

    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'ops-chaos',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { 'ops-chaos': issuer.publicKey },
    });
    const request = {
      destination,
      idempotencyKey: 'ops-chaos-idem',
      args: { title: 'Ops chaos', body: 'marker', head: 'feature', base: 'main' },
    };
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'allow',
          policySnapshotId: 'policy',
          reason: 'ok',
        }),
      },
      kernel,
      executor,
      { append: async () => {} },
      { localWorkerId: 'worker-ops', requireRequestBinding: false },
    );
    const effectId = 'eff-ops-chaos';
    const token = issuer.issue({
      jti: 'jti-ops-chaos',
      tenantId,
      runId: 'run-ops-chaos',
      stepId: step.id,
      effectTypes: ['connector.github.pull-request.create'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(request),
    });

    const originalComplete = kernel.completeEffect.bind(kernel);
    kernel.completeEffect = async () => null;
    try {
      await assert.rejects(
        () =>
          broker.execute({
            effectId,
            token,
            type: 'connector.github.pull-request.create',
            request,
            idempotencyKey: request.idempotencyKey,
            lease: step.lease!,
            actor: 'worker-ops',
          }),
        (error: unknown) =>
          error instanceof EffectBrokerError && error.code === 'COMPLETION_UNCONFIRMED',
      );
    } finally {
      kernel.completeEffect = originalComplete;
    }

    assert.equal(counters.createCount, 1);
    await kernel.requestReconcile({
      effectId,
      tenantId,
      actor: 'ops-chaos',
      reconcileAfter: new Date().toISOString(),
    });

    const daemon = new ReconciliationDaemon({
      repository: kernel,
      registry,
      actor: 'reconciliation-daemon',
      pollIntervalMs: 60_000,
      batchSize: 10,
      brokerFactory: () =>
        new EffectBroker(
          tokens,
          {
            evaluate: async () => ({
              effect: 'allow',
              decisionId: 'recon',
              policySnapshotId: 'policy',
              reason: 'ok',
            }),
          },
          kernel,
          { execute: async () => { throw new Error('no write'); } },
          { append: async () => {} },
          { requireRequestBinding: false },
        ),
    });

    const stats = await daemon.tick();
    assert.equal(stats.completed, 1);
    assert.equal(counters.createCount, 1);
    const effect = await kernel.getEffect(effectId, tenantId);
    assert.equal(effect?.state, 'COMPLETED');
  });
});
