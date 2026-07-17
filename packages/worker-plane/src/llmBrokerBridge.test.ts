import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LLM_INVOKE_REGISTRY,
  createLlmEffectAuth,
  dispatchLlmEffect,
  hashLlmCallContent,
  runWithLlmEffectAuth,
  wrapProviderWithEffectBroker,
} from './llmBrokerBridge.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '@commander/core';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
  type EffectExecutor,
  type EffectKernelPort,
  type PolicyEvaluator,
  type AuditSink,
} from '@commander/effect-broker';

function mockProvider(name = 'mock'): LLMProvider {
  return {
    name,
    async call(req: LLMRequest): Promise<LLMResponse> {
      return {
        content: `echo:${JSON.stringify(req.messages?.[0] ?? '')}`,
        model: req.model ?? 'm',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  };
}

function makeBroker(): { broker: EffectBroker; issuer: CapabilityTokenIssuer } {
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'test-llm',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { 'test-llm': issuer.publicKey },
  });
  const policy: PolicyEvaluator = {
    evaluate: async () => ({
      effect: 'allow',
      decisionId: 'llm-test-allow',
      reason: 'test',
      policySnapshotId: 'p1',
    }),
  };
  const kernel: EffectKernelPort = {
    admitEffect: async (input) => ({
      admitted: true,
      effect: { id: input.id, state: 'admitted' },
    }),
    completeEffect: async (_id, _tenant, _lease, response) => ({ ok: true, response }),
  };
  const executor: EffectExecutor = {
    execute: async (input) => dispatchLlmEffect(input),
  };
  const audit: AuditSink = { append: async () => undefined };
  const broker = new EffectBroker(tokens, policy, kernel, executor, audit, {
    audience: 'commander.effect-broker',
    requireRequestBinding: true,
  });
  return { broker, issuer };
}

describe('llmBrokerBridge (WS2 §1)', () => {
  it('mints call-time request-bound tokens and routes through broker', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: 'w1', token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    const response = await runWithLlmEffectAuth(auth, () =>
      wrapped.call({
        model: 'gpt',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    assert.match(String(response.content), /hi/);
    assert.equal(LLM_INVOKE_REGISTRY.size, 0);
  });

  it('fail-closes when LLM auth context is missing', async () => {
    const { broker } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider(), broker);
    await assert.rejects(
      () => wrapped.call({ model: 'gpt', messages: [] }),
      /EFFECT_AUTHORIZATION_REQUIRED/,
    );
  });

  it('rejects when mint binds a different request hash (request binding)', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: 'w1', token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    // Sabotage: mint against a different body than the broker receives.
    auth.mintCapabilityToken = () =>
      issuer.issue({
        jti: 'bad',
        tenantId: 't1',
        runId: 'r1',
        stepId: 's1',
        effectTypes: ['llm.openai'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestHash: canonicalRequestHash({ wrong: true }),
      });
    await assert.rejects(
      () =>
        runWithLlmEffectAuth(auth, () =>
          wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
        ),
      /REQUEST_HASH_MISMATCH/,
    );
  });

  it('contentHash covers prompt text (different messages → different hash)', () => {
    const a = hashLlmCallContent({
      model: 'gpt',
      messages: [{ role: 'user', content: 'alpha' }],
    });
    const b = hashLlmCallContent({
      model: 'gpt',
      messages: [{ role: 'user', content: 'beta' }],
    });
    assert.notEqual(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  it('fail-closes admit when lease.workerGeneration mismatches (kernel fencing)', async () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'fence-test',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { 'fence-test': issuer.publicKey },
    });
    // Mirror kernel live(): missing generation coerces to -1 and loses against claimed ≥0.
    const claimedGeneration = 2;
    const kernel: EffectKernelPort = {
      admitEffect: async (input) => {
        const supplied = input.lease.workerGeneration ?? -1;
        if (supplied !== claimedGeneration) {
          return { admitted: false, reason: 'LEASE_LOST' };
        }
        return { admitted: true, effect: { id: input.id, state: 'admitted' } };
      },
      completeEffect: async (_id, _tenant, _lease, response) => ({ ok: true, response }),
    };
    const policy: PolicyEvaluator = {
      evaluate: async () => ({
        effect: 'allow',
        decisionId: 'llm-fence-allow',
        reason: 'test',
        policySnapshotId: 'p1',
      }),
    };
    const broker = new EffectBroker(
      tokens,
      policy,
      kernel,
      { execute: async (input) => dispatchLlmEffect(input) },
      { append: async () => undefined },
      { audience: 'commander.effect-broker', requireRequestBinding: true },
    );
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);

    await assert.rejects(
      () =>
        runWithLlmEffectAuth(
          createLlmEffectAuth({
            tenantId: 't1',
            runId: 'r1',
            stepId: 's1',
            actor: 'worker-1',
            // Bug shape: omit workerGeneration → ?? -1 → kernel LEASE_LOST
            lease: { workerId: 'w1', token: 'lease', fencingEpoch: 1 },
            issuer,
          }),
          () => wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Broker surfaces kernel LEASE_LOST as EFFECT_ADMISSION_REJECTED + details.reason
        assert.match(err.message, /EFFECT_ADMISSION_REJECTED/);
        assert.equal(
          (err as { details?: { reason?: string } }).details?.reason,
          'LEASE_LOST',
        );
        return true;
      },
    );

    const ok = await runWithLlmEffectAuth(
      createLlmEffectAuth({
        tenantId: 't1',
        runId: 'r1',
        stepId: 's1',
        actor: 'worker-1',
        lease: {
          workerId: 'w1',
          workerGeneration: claimedGeneration,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      }),
      () => wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'ok' }] }),
    );
    assert.match(String(ok.content), /ok/);
  });

  it('freezes call payload so contentHash and provider invoke stay atomic', async () => {
    const { broker, issuer } = makeBroker();
    let seen: LLMRequest | undefined;
    const provider: LLMProvider = {
      name: 'mock',
      async call(req) {
        seen = req;
        return {
          content: 'ok',
          model: req.model ?? 'm',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: 'stop',
        };
      },
    };
    const wrapped = wrapProviderWithEffectBroker(provider, broker);
    const mutable: LLMRequest = {
      model: 'gpt',
      messages: [{ role: 'user', content: 'original' }],
    };
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    const response = await runWithLlmEffectAuth(auth, async () => {
      const pending = wrapped.call(mutable);
      // Mutate after call starts — wrap must not observe the mutated messages.
      mutable.messages = [{ role: 'user', content: 'TAMPERED' }];
      return pending;
    });
    assert.equal(response.content, 'ok');
    assert.equal(seen?.messages?.[0]?.content, 'original');
  });
});
