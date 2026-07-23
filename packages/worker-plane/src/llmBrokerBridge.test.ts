import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  __testLlmInvokeRegistrySize,
  __testPlantLlmInvokeEntry,
  createLlmEffectAuth,
  dispatchLlmEffect,
  hashLlmCallContent,
  resetLlmInvokeRegistryForTests,
  runWithLlmEffectAuth,
  wrapProviderWithEffectBroker,
} from './llmBrokerBridge.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '@commander/core';
import { resetControlPlane } from '@commander/core';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
  type EffectExecutor,
  type EffectKernelPort,
  type PolicyEvaluator,
  type AuditSink,
} from '@commander/effect-broker';
import type { ClaimedStep } from './types.js';
import { runWithStepWorkloadIdentity } from './stepWorkloadIdentity.js';

const DEFAULT_WORKER_ID = 'w1';

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

function dispatchFromExecutionContext(input: Parameters<EffectExecutor['execute']>[0]) {
  const ctx = input.executionContext;
  if (
    !ctx?.tenantId ||
    !ctx.workerId ||
    typeof ctx.fencingEpoch !== 'number' ||
    typeof ctx.leaseToken !== 'string'
  ) {
    throw new Error('test executor: missing executionContext lease fields');
  }
  return dispatchLlmEffect({
    type: input.type,
    request: input.request,
    signal: input.signal,
    tenantId: ctx.tenantId,
    workerId: ctx.workerId,
    fencingEpoch: ctx.fencingEpoch,
    leaseToken: ctx.leaseToken,
  });
}

function makeBroker(options?: {
  localWorkerId?: string;
  executor?: EffectExecutor;
}): { broker: EffectBroker; issuer: CapabilityTokenIssuer } {
  const localWorkerId = options?.localWorkerId ?? DEFAULT_WORKER_ID;
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
  const executor: EffectExecutor =
    options?.executor ?? { execute: async (input) => dispatchFromExecutionContext(input) };
  const audit: AuditSink = { append: async () => undefined };
  const broker = new EffectBroker(tokens, policy, kernel, executor, audit, {
    audience: 'commander.effect-broker',
    requireRequestBinding: true,
    localWorkerId,
  });
  return { broker, issuer };
}

describe('llmBrokerBridge (WS2 §1)', () => {
  afterEach(() => {
    resetLlmInvokeRegistryForTests();
  });

  it('mints call-time request-bound tokens and routes through broker', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    const response = await runWithLlmEffectAuth(auth, () =>
      wrapped.call({
        model: 'gpt',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    assert.match(String(response.content), /hi/);
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('fail-closes when LLM auth context is missing', async () => {
    const { broker } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider(), broker);
    await assert.rejects(
      () => wrapped.call({ model: 'gpt', messages: [] }),
      /EFFECT_AUTHORIZATION_REQUIRED/,
    );
  });

  it('does not confuse colon-bearing tenantIds in registry keys', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const authColon = createLlmEffectAuth({
      tenantId: 'acme:prod',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    const authPlain = createLlmEffectAuth({
      tenantId: 'acme',
      runId: 'r2',
      stepId: 's2',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    const [r1, r2] = await Promise.all([
      runWithLlmEffectAuth(authColon, () =>
        wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'colon-tenant' }] }),
      ),
      runWithLlmEffectAuth(authPlain, () =>
        wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'plain-tenant' }] }),
      ),
    ]);
    assert.match(String(r1.content), /colon-tenant/);
    assert.match(String(r2.content), /plain-tenant/);
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('rejects tenant B dispatch for tenant A registry entry (LLM_TENANT_MISMATCH)', async () => {
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) =>
          dispatchLlmEffect({
            type: input.type,
            request: input.request,
            signal: input.signal,
            tenantId: 'tenant-b',
            workerId: input.executionContext!.workerId,
            fencingEpoch: input.executionContext!.fencingEpoch,
            leaseToken: input.executionContext!.leaseToken,
          }),
      },
    });
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 'tenant-a',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    await assert.rejects(
      () =>
        runWithLlmEffectAuth(auth, () =>
          wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
        ),
      /LLM_TENANT_MISMATCH/,
    );
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('rejects dispatch when workerId does not match registry entry', async () => {
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) =>
          dispatchLlmEffect({
            type: input.type,
            request: input.request,
            signal: input.signal,
            tenantId: input.executionContext!.tenantId,
            workerId: 'wrong-worker',
            fencingEpoch: input.executionContext!.fencingEpoch,
            leaseToken: input.executionContext!.leaseToken,
          }),
      },
    });
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    await assert.rejects(
      () =>
        runWithLlmEffectAuth(auth, () =>
          wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
        ),
      /LLM_WORKER_MISMATCH/,
    );
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('one-shot second dispatch yields LLM_INVOKE_MISS', async () => {
    let capturedEffectId: string | undefined;
    let capturedHash: string | undefined;
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) => {
          capturedEffectId = input.request.effectId as string;
          capturedHash = input.request.contentHash as string;
          return dispatchFromExecutionContext(input);
        },
      },
    });
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    await runWithLlmEffectAuth(auth, () =>
      wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'once' }] }),
    );
    assert.ok(capturedEffectId);
    assert.ok(capturedHash);
    await assert.rejects(
      () =>
        dispatchLlmEffect({
          type: 'llm.openai',
          request: { effectId: capturedEffectId!, contentHash: capturedHash! },
          tenantId: 't1',
          workerId: DEFAULT_WORKER_ID,
          fencingEpoch: 1,
          leaseToken: 'lease',
        }),
      /LLM_INVOKE_MISS/,
    );
  });

  it('fail-closes wrap construction when COMMANDER_LLM_INVOKE_MODE=disabled', () => {
    const prev = process.env.COMMANDER_LLM_INVOKE_MODE;
    process.env.COMMANDER_LLM_INVOKE_MODE = 'disabled';
    try {
      const { broker } = makeBroker();
      assert.throws(
        () => wrapProviderWithEffectBroker(mockProvider(), broker),
        /LLM_INVOKE_MODE_DISABLED/,
      );
    } finally {
      if (prev === undefined) delete process.env.COMMANDER_LLM_INVOKE_MODE;
      else process.env.COMMANDER_LLM_INVOKE_MODE = prev;
    }
  });

  it('fail-closes wrap for sealed or unknown COMMANDER_LLM_INVOKE_MODE (C-γ not shipped)', () => {
    const prev = process.env.COMMANDER_LLM_INVOKE_MODE;
    try {
      const { broker } = makeBroker();
      for (const mode of ['sealed', 'bogus']) {
        process.env.COMMANDER_LLM_INVOKE_MODE = mode;
        assert.throws(
          () => wrapProviderWithEffectBroker(mockProvider(), broker),
          /LLM_INVOKE_MODE_DISABLED/,
        );
      }
    } finally {
      if (prev === undefined) delete process.env.COMMANDER_LLM_INVOKE_MODE;
      else process.env.COMMANDER_LLM_INVOKE_MODE = prev;
    }
  });

  it('rejects dispatch when registry entry expiresAt has passed', async () => {
    __testPlantLlmInvokeEntry({
      tenantId: 't1',
      effectId: 'e-expired',
      runId: 'r1',
      stepId: 's1',
      workerId: DEFAULT_WORKER_ID,
      fencingEpoch: 1,
      leaseToken: 'lease',
      contentHash: 'abc',
      expiresAt: Date.now() - 1,
      invoke: async () => {
        throw new Error('should not invoke');
      },
    });
    await assert.rejects(
      () =>
        dispatchLlmEffect({
          type: 'llm.openai',
          request: { effectId: 'e-expired', contentHash: 'abc' },
          tenantId: 't1',
          workerId: DEFAULT_WORKER_ID,
          fencingEpoch: 1,
          leaseToken: 'lease',
        }),
      /LLM_INVOKE_EXPIRED/,
    );
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('isolates concurrent multi-tenant broker.execute calls', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const results = await Promise.all(
      (['t-a', 't-b', 't-c'] as const).map((tenantId) => {
        const auth = createLlmEffectAuth({
          tenantId,
          runId: `run-${tenantId}`,
          stepId: 's1',
          actor: 'worker-1',
          lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
          issuer,
        });
        return runWithLlmEffectAuth(auth, () =>
          wrapped.call({
            model: 'gpt',
            messages: [{ role: 'user', content: tenantId }],
          }),
        );
      }),
    );
    assert.equal(results.length, 3);
    for (const [i, tenantId] of (['t-a', 't-b', 't-c'] as const).entries()) {
      assert.match(String(results[i]!.content), new RegExp(tenantId));
    }
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('fail-closes LLM mint/admit in production without step workload ALS', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createLlmEffectAuth({
            tenantId: 't1',
            runId: 'r1',
            stepId: 's1',
            actor: 'worker-1',
            lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
            issuer,
          }),
        /WORKLOAD_IDENTITY_REQUIRED/,
      );
      // Auth minted outside ALS must not synthesize binding in production.
      const auth = {
        tenantId: 't1',
        runId: 'r1',
        stepId: 's1',
        actor: 'worker-1',
        lease: { workerId: 'w1' as const, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
        mintCapabilityToken: () =>
          issuer.issue({
            jti: 'x',
            tenantId: 't1',
            runId: 'r1',
            stepId: 's1',
            workloadId: 'wl_x',
            effectTypes: ['llm.openai'],
            expiresAt: '2099-01-01T00:00:00.000Z',
            requestHash: canonicalRequestHash({}),
          }),
      };
      await assert.rejects(
        () => runWithLlmEffectAuth(auth, () => wrapped.call({ model: 'gpt', messages: [] })),
        /WORKLOAD_IDENTITY_REQUIRED/,
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('rejects when mint binds a different request hash (request binding)', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    // Sabotage: mint against a different body than the broker receives.
    // Fence fields must still match lease so admit reaches REQUEST_HASH_MISMATCH.
    auth.mintCapabilityToken = () =>
      issuer.issue({
        jti: 'bad',
        tenantId: 't1',
        runId: 'r1',
        stepId: 's1',
        workloadId: auth.workloadId,
        workerId: DEFAULT_WORKER_ID,
        workerGeneration: 1,
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
      { execute: async (input) => dispatchFromExecutionContext(input) },
      { append: async () => undefined },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: true,
        localWorkerId: DEFAULT_WORKER_ID,
      },
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
            // Grant↔lease fence matches; kernel claimed generation differs → LEASE_LOST
            lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
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
          workerId: DEFAULT_WORKER_ID,
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
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
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

  it('uses content-stable idempotency keys so identical retries dedupe', async () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'idem-llm',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { 'idem-llm': issuer.publicKey },
    });
    const seenKeys: string[] = [];
    let callCount = 0;
    const kernel: EffectKernelPort = {
      admitEffect: async (input) => {
        seenKeys.push(input.idempotencyKey);
        const prior = seenKeys.filter((k) => k === input.idempotencyKey).length > 1;
        if (prior) {
          return {
            admitted: true,
            replayed: true,
            effect: {
              id: input.id,
              state: 'COMPLETED',
              response: {
                content: 'cached',
                model: 'm',
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                finishReason: 'stop',
              },
            },
          };
        }
        return { admitted: true, effect: { id: input.id, state: 'ADMITTED' } };
      },
      completeEffect: async (_id, _tenant, _lease, response) => response,
    };
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'd',
          reason: 'ok',
          policySnapshotId: 'p1',
        }),
      },
      kernel,
      {
        execute: async (input) => {
          callCount += 1;
          return dispatchFromExecutionContext(input);
        },
      },
      { append: async () => undefined },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: true,
        localWorkerId: DEFAULT_WORKER_ID,
      },
    );
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    const req = { model: 'gpt', messages: [{ role: 'user' as const, content: 'same' }] };
    const contentHash = hashLlmCallContent(req);
    const expectedKey = `llm:r1:s1:${contentHash}`;

    const first = await runWithLlmEffectAuth(auth, () => wrapped.call(req));
    const second = await runWithLlmEffectAuth(auth, () => wrapped.call(req));

    assert.equal(seenKeys[0], expectedKey);
    assert.equal(seenKeys[1], expectedKey);
    assert.equal(callCount, 1, 'second call must be COMPLETED cache hit, not re-invoke provider');
    assert.match(String(first.content), /same/);
    assert.equal(second.content, 'cached');
  });

  it('rejects dispatch when fencingEpoch or leaseToken mismatches registry', async () => {
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) =>
          dispatchLlmEffect({
            type: input.type,
            request: input.request,
            signal: input.signal,
            tenantId: input.executionContext!.tenantId,
            workerId: input.executionContext!.workerId,
            fencingEpoch: 99,
            leaseToken: input.executionContext!.leaseToken,
          }),
      },
    });
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    await assert.rejects(
      () =>
        runWithLlmEffectAuth(auth, () =>
          wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
        ),
      /LLM_LEASE_MISMATCH/,
    );
  });

  it('aborts in-flight dispatch when broker signal aborts', async () => {
    const neverResolve = new Promise<LLMResponse>(() => undefined);
    const provider: LLMProvider = {
      name: 'slow',
      call: () => neverResolve,
    };
    const controller = new AbortController();
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) => {
          queueMicrotask(() => controller.abort(new Error('Effect timeout')));
          return dispatchLlmEffect({
            type: input.type,
            request: input.request,
            signal: controller.signal,
            tenantId: input.executionContext!.tenantId,
            workerId: input.executionContext!.workerId,
            fencingEpoch: input.executionContext!.fencingEpoch,
            leaseToken: input.executionContext!.leaseToken,
          });
        },
      },
    });
    const wrapped = wrapProviderWithEffectBroker(provider, broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });
    await assert.rejects(
      () =>
        runWithLlmEffectAuth(auth, () =>
          wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'hang' }] }),
        ),
      /Effect timeout/,
    );
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('COMPLETION_UNCONFIRMED: no same-effectId replay; new effectId retries', async () => {
    let completeCalls = 0;
    let providerCalls = 0;
    let unknownMarked = 0;
    let firstEffectId: string | undefined;
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'unknown-retry',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { 'unknown-retry': issuer.publicKey },
    });
    const kernel: EffectKernelPort = {
      admitEffect: async (input) => ({
        admitted: true,
        effect: { id: input.id, state: 'admitted' },
      }),
      completeEffect: async (_id, _tenant, _lease, response) => {
        completeCalls += 1;
        if (completeCalls === 1) return null;
        return { ok: true, response };
      },
      markEffectCompletionUnknown: async () => {
        unknownMarked += 1;
        return {};
      },
    };
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'llm-unknown-allow',
          reason: 'test',
          policySnapshotId: 'p1',
        }),
      },
      kernel,
      {
        execute: async (input) => {
          if (!firstEffectId) firstEffectId = String(input.request.effectId);
          return dispatchFromExecutionContext(input);
        },
      },
      { append: async () => undefined },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: true,
        localWorkerId: DEFAULT_WORKER_ID,
      },
    );
    const provider: LLMProvider = {
      name: 'openai',
      async call(req) {
        providerCalls += 1;
        return {
          content: String(req.messages?.[0]?.content ?? ''),
          model: req.model ?? 'm',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: 'stop',
        };
      },
    };
    const wrapped = wrapProviderWithEffectBroker(provider, broker);
    const auth = createLlmEffectAuth({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      actor: 'worker-1',
      lease: { workerId: DEFAULT_WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      issuer,
    });

    await assert.rejects(
      () =>
        runWithLlmEffectAuth(auth, () =>
          wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'first' }] }),
        ),
      (err: unknown) => err instanceof EffectBrokerError && err.code === 'COMPLETION_UNCONFIRMED',
    );
    assert.equal(providerCalls, 1);
    assert.equal(unknownMarked, 1);
    assert.ok(firstEffectId);

    // Same effectId cannot re-invoke provider (one-shot + wrap finally cleared registry).
    await assert.rejects(
      () =>
        dispatchLlmEffect({
          type: 'llm.openai',
          request: {
            effectId: firstEffectId!,
            contentHash: hashLlmCallContent({
              model: 'gpt',
              messages: [{ role: 'user', content: 'first' }],
            }),
          },
          tenantId: 't1',
          workerId: DEFAULT_WORKER_ID,
          fencingEpoch: 1,
          leaseToken: 'lease',
        }),
      /LLM_INVOKE_MISS/,
    );
    assert.equal(providerCalls, 1);

    // Client retries with different content → new content-stable effectId — allowed.
    const retry = await runWithLlmEffectAuth(auth, () =>
      wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'retry' }] }),
    );
    assert.match(String(retry.content), /retry/);
    assert.equal(providerCalls, 2);
    assert.equal(completeCalls, 2);
  });

  it('fail-closes createLlmEffectAuth in production without step identity', () => {
    resetControlPlane();
    const { issuer } = makeBroker();
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createLlmEffectAuth({
            tenantId: 'attacker-tenant',
            runId: 'r1',
            stepId: 's1',
            actor: 'worker-1',
            lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
            issuer,
          }),
        /WORKLOAD_IDENTITY_REQUIRED/,
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('mints from verified step identity, not caller tenant override', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const step: ClaimedStep = {
      id: 'step-1',
      runId: 'run-1',
      tenantId: 'tenant-from-identity',
      kind: 'agent',
      version: 1,
      attempt: 1,
      input: {},
      lease: {
        workerId: 'w1',
        workerGeneration: 1,
        token: 'lease',
        fencingEpoch: 1,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    };
    const worker = {
      id: 'w1',
      kind: 'agent' as const,
      version: 'v1',
      capabilities: ['agent'],
      maxConcurrency: 2,
      status: 'ACTIVE' as const,
      generation: 1,
      activeSteps: 0,
      identitySubject: 'spiffe://commander/worker/w1',
      tenantIds: ['tenant-from-identity'],
      registeredAt: '2099-01-01T00:00:00.000Z',
      lastHeartbeatAt: '2099-01-01T00:00:00.000Z',
    };
    await runWithStepWorkloadIdentity(step, worker, async () => {
      const auth = createLlmEffectAuth({
        tenantId: 'attacker-override',
        runId: 'run-1',
        stepId: 'step-1',
        actor: 'worker-1',
        lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
        issuer,
      });
      assert.equal(auth.tenantId, 'tenant-from-identity');
      const response = await runWithLlmEffectAuth(auth, () =>
        wrapped.call({
          model: 'gpt',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      );
      assert.match(String(response.content), /hi/);
    });
  });
});
