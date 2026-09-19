/**
 * EB-08 / contracts CC-01 — the effect idempotency key contract.
 *
 * `deriveEffectIdempotencyKey` is the single authority for the key: admit()
 * recomputes it from the grant identity + the exact request and rejects a
 * caller-chosen literal with IDEMPOTENCY_KEY_MISMATCH.
 *
 * D.1 pins that contract under an explicit `'derive'` policy.
 * D.4 pins the STAGED rollout: the default stays `'caller'` until every
 * production caller mints a derived key. Flipping it while
 * `toolStepExecutor`/`connectorStepExecutor` and the adapter-ops compensation
 * broker still pass caller-chosen keys would fail closed on working production
 * paths, so the staged boundary is asserted here and cannot move silently.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
  deriveEffectIdempotencyKey,
  type CapabilityGrant,
  type EffectKernelPort,
} from './index.js';

const TENANT_ID = 'tenant-a';
const RUN_ID = 'run-1';
const STEP_ID = 'step-1';
const WORKLOAD_ID = 'wl-1';
const WORKER_ID = 'w1';
/** The literal the LLM bridge used to pass as the key (raw effect id). */
const LLM_EFFECT_ID = 'llm:run-1:step-1:deadbeef';
const REQUEST: Record<string, unknown> = { destination: 'https://example.test/hook', value: 1 };

const PRODUCTION_SIGNALS = [
  'NODE_ENV',
  'COMMANDER_ENV',
  'COMMANDER_PROFILE',
  'COMMANDER_CELL_TIER',
  'COMMANDER_REQUIRE_WORKLOAD_BINDING',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of PRODUCTION_SIGNALS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearProductionSignals(): void {
  for (const key of PRODUCTION_SIGNALS) delete process.env[key];
}

function makeHarness(options: { idempotencyKeyPolicy?: 'derive' | 'caller' } = {}): {
  broker: EffectBroker;
  issuer: CapabilityTokenIssuer;
} {
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-issuer',
    audience: 'commander.effect-broker',
    keyId: 'k1',
  });
  const verifier = new CapabilityTokenVerifier({
    issuer: 'commander-issuer',
    audience: 'commander.effect-broker',
    publicKeys: { k1: issuer.publicKey },
  });
  const kernel: EffectKernelPort = {
    admitEffect: async (input) => ({
      admitted: true,
      effect: { id: input.id, state: 'ADMITTED' },
    }),
    completeEffect: async () => ({}),
  };
  const broker = new EffectBroker(
    verifier,
    {
      evaluate: async () => ({
        effect: 'allow',
        decisionId: 'd1',
        reason: 'ok',
        policySnapshotId: 'p1',
      }),
    },
    kernel,
    { execute: async () => ({ ok: true }) },
    { append: async () => {} },
    {
      audience: 'commander.effect-broker',
      requireRequestBinding: true,
      // Non-in-memory stores + affinity so the broker can also be constructed
      // while the production profile is active.
      localWorkerId: WORKER_ID,
      localWorkerGeneration: 1,
      replay: { consume: () => false },
      revocations: { revoke: () => undefined, isRevoked: () => false },
      ...(options.idempotencyKeyPolicy
        ? { idempotencyKeyPolicy: options.idempotencyKeyPolicy }
        : {}),
    },
  );
  return { broker, issuer };
}

function grant(issuer: CapabilityTokenIssuer): string {
  const token: CapabilityGrant = {
    jti: 'jti-1',
    tenantId: TENANT_ID,
    runId: RUN_ID,
    stepId: STEP_ID,
    workloadId: WORKLOAD_ID,
    workerId: WORKER_ID,
    workerGeneration: 1,
    effectTypes: ['llm.openai'],
    expiresAt: '2099-01-01T00:00:00.000Z',
    policySnapshotId: 'p1',
    requestHash: canonicalRequestHash(REQUEST),
  };
  return issuer.issue(token);
}

function admitInput(
  issuer: CapabilityTokenIssuer,
  idempotencyKey: string,
): Parameters<EffectBroker['admit']>[0] {
  return {
    effectId: LLM_EFFECT_ID,
    token: grant(issuer),
    type: 'llm.openai',
    request: REQUEST,
    idempotencyKey,
    lease: { workerId: WORKER_ID, workerGeneration: 1, token: 'lease-1', fencingEpoch: 1 },
    actor: WORKER_ID,
    workloadBinding: {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      stepId: STEP_ID,
      workloadId: WORKLOAD_ID,
    },
  };
}

describe('D.1 derive policy treats deriveEffectIdempotencyKey as the single authority', () => {
  it('rejects the raw llm: effect id as a caller-chosen key and admits the derived key', async () => {
    const { broker, issuer } = makeHarness({ idempotencyKeyPolicy: 'derive' });

    const rejected = await broker.admit(admitInput(issuer, LLM_EFFECT_ID));
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.reason, 'IDEMPOTENCY_KEY_MISMATCH');

    const derived = deriveEffectIdempotencyKey({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      stepId: STEP_ID,
      effectId: LLM_EFFECT_ID,
      request: REQUEST,
    });
    assert.notEqual(derived, LLM_EFFECT_ID);

    const admitted = await broker.admit(admitInput(issuer, derived));
    assert.equal(admitted.admitted, true);
  });

  it('rejects a key derived for a different request (no cross-effect collapse)', async () => {
    const { broker, issuer } = makeHarness({ idempotencyKeyPolicy: 'derive' });
    const otherRequestKey = deriveEffectIdempotencyKey({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      stepId: STEP_ID,
      effectId: LLM_EFFECT_ID,
      request: { ...REQUEST, value: 2 },
    });
    const rejected = await broker.admit(admitInput(issuer, otherRequestKey));
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.reason, 'IDEMPOTENCY_KEY_MISMATCH');
  });
});

describe('D.4 staged default — derive is opt-in until every caller migrates', () => {
  it('keeps the caller default even under the production profile', () => {
    const saved = snapshotEnv();
    try {
      clearProductionSignals();
      process.env.NODE_ENV = 'production';
      const { broker } = makeHarness();
      assert.equal(
        broker.idempotencyKeyPolicy,
        'caller',
        'flipping this default requires migrating toolStepExecutor, connectorStepExecutor and the adapter-ops compensation broker first',
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('keeps the caller default outside production', () => {
    const saved = snapshotEnv();
    try {
      clearProductionSignals();
      const { broker } = makeHarness();
      assert.equal(broker.idempotencyKeyPolicy, 'caller');
    } finally {
      restoreEnv(saved);
    }
  });

  it('honours an explicit derive opt-in in production', () => {
    const saved = snapshotEnv();
    try {
      clearProductionSignals();
      process.env.NODE_ENV = 'production';
      const { broker } = makeHarness({ idempotencyKeyPolicy: 'derive' });
      assert.equal(broker.idempotencyKeyPolicy, 'derive');
    } finally {
      restoreEnv(saved);
    }
  });

  it('rejects a caller-chosen literal at admit() once derive is opted into', async () => {
    const saved = snapshotEnv();
    try {
      clearProductionSignals();
      process.env.NODE_ENV = 'production';
      const { broker, issuer } = makeHarness({ idempotencyKeyPolicy: 'derive' });
      const rejected = await broker.admit(admitInput(issuer, LLM_EFFECT_ID));
      assert.equal(rejected.admitted, false);
      assert.equal(rejected.reason, 'IDEMPOTENCY_KEY_MISMATCH');
    } finally {
      restoreEnv(saved);
    }
  });
});
