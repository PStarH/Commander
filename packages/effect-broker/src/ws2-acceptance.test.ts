/**
 * WS2 §3/§4/§6 acceptance tests.
 *
 * §3 — admit/execute separation: admit() does not invoke the executor.
 * §4 — production runtime gates: requireRequestBinding=false throws;
 *       permit-default PolicyEvaluator is rejected.
 * §6 — capability token lifecycle: forged/expired/cross-tenant/requestHash
 *       tampering rejected; revocation enforced.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  PERMIT_DEFAULT_DECISION_ID,
  canonicalRequestHash,
  type CapabilityGrant,
} from './index.js';

function makeTokens(issuer = 'commander-issuer', keyId = 'k1') {
  const iss = CapabilityTokenIssuer.generate({ issuer, audience: 'commander.effect-broker', keyId });
  const ver = new CapabilityTokenVerifier({ issuer, audience: 'commander.effect-broker', publicKeys: { [keyId]: iss.publicKey } });
  return { iss, ver };
}

const baseGrant: CapabilityGrant = {
  jti: 'jti-1',
  tenantId: 'tenant-a',
  runId: 'run-1',
  stepId: 'step-1',
  effectTypes: ['crm.write'],
  expiresAt: '2099-01-01T00:00:00.000Z',
  policySnapshotId: 'p1',
  requestHash: canonicalRequestHash({}),
  actionDigest: 'a'.repeat(64),
  workerId: 'w',
  workerGeneration: 1,
} as unknown as CapabilityGrant;

function makeBroker({
  tokens,
  policy = async () => ({ effect: 'allow' as const, decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }),
  executor = async () => ({ ok: true }),
  kernel,
  audit = { append: async () => {} },
  options = {},
}: {
  tokens: { verify: (t: string) => Promise<CapabilityGrant> };
  policy?: any;
  executor?: any;
  kernel?: any;
  audit?: any;
  options?: any;
}) {
  const k = kernel ?? {
    admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }),
    completeEffect: async () => ({}),
  };
  // Wrap the policy function in a PolicyEvaluator-shaped object so the broker
  // can call policy.evaluate(...). Same for executor → EffectExecutor.
  const policyEvaluator = typeof policy === 'function' ? { evaluate: policy } : policy;
  const effectExecutor = typeof executor === 'function' ? { execute: executor } : executor;
  return new EffectBroker(tokens as any, policyEvaluator, k, effectExecutor, audit, { audience: 'commander.effect-broker', requireRequestBinding: true, ...options });
}

describe('WS2 §3 admit/execute separation', () => {
  it('admit() does not invoke the executor', async () => {
    const { iss, ver } = makeTokens();
    let executorInvoked = false;
    const broker = makeBroker({
      tokens: ver,
      executor: async () => { executorInvoked = true; return {}; },
    });
    const admission = await broker.admit({
      effectId: 'eff-1',
      token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-1',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, true);
    assert.equal(executorInvoked, false, 'admit() must not call the executor');
  });

  it('executeAdmitted() invokes the executor after admit()', async () => {
    const { iss, ver } = makeTokens();
    let executorInvoked = false;
    const broker = makeBroker({
      tokens: ver,
      executor: async () => { executorInvoked = true; return { dispatched: true }; },
    });
    const admission = await broker.admit({
      effectId: 'eff-2',
      token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-2',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, true);
    const result = await broker.executeAdmitted({ effectId: 'eff-2' });
    assert.equal(executorInvoked, true);
    assert.deepEqual(result.response, { dispatched: true });
  });
});

describe('WS2 §4 production runtime gates', () => {
  it('constructor throws REQUEST_BINDING_DISABLED_IN_PROD when production + requireRequestBinding=false', () => {
    const { ver } = makeTokens();
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () => makeBroker({ tokens: ver, options: { requireRequestBinding: false } }),
        (err: unknown) => err instanceof EffectBrokerError && err.code === 'REQUEST_BINDING_DISABLED_IN_PROD',
      );
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  it('permit-default PolicyEvaluator is rejected by admit()', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker({
      tokens: ver,
      policy: async () => ({ effect: 'allow' as const, decisionId: PERMIT_DEFAULT_DECISION_ID, reason: 'permit-all', policySnapshotId: 'p1' }),
    });
    const admission = await broker.admit({
      effectId: 'eff-pd',
      token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-pd',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'PERMIT_ALL_FORBIDDEN');
  });
});

describe('WS2 §6 capability token lifecycle', () => {
  it('rejects a forged token (wrong signature)', async () => {
    // True forgery: same keyId 'k1' but signed by a different private key.
    // The verifier only has the real public key for k1, so signature
    // verification throws "Invalid capability token signature".
    const { ver } = makeTokens('commander-issuer', 'k1');
    const forge = makeTokens('commander-issuer', 'k1');
    const forgedToken = forge.iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) });
    const broker = makeBroker({ tokens: ver });
    await assert.rejects(
      broker.admit({
        effectId: 'eff-forge',
        token: forgedToken,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-forge',
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      /signature/i,
    );
  });

  it('rejects an expired token', async () => {
    const { iss, ver } = makeTokens();
    const expiredGrant = { ...baseGrant, expiresAt: '2020-01-01T00:00:00.000Z' };
    const token = iss.issue({ ...expiredGrant, requestHash: canonicalRequestHash({}) });
    const broker = makeBroker({ tokens: ver });
    await assert.rejects(
      broker.admit({
        effectId: 'eff-exp',
        token,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-exp',
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
    );
  });

  it('rejects a token whose requestHash does not match the request', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker({ tokens: ver });
    const token = iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({ original: true }) });
    const admission = await broker.admit({
      effectId: 'eff-rh',
      token,
      type: 'crm.write',
      request: { tampered: true },
      idempotencyKey: 'idem-rh',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'REQUEST_HASH_MISMATCH');
  });

  it('rejects a token with mismatched effect type (CAPABILITY_DENIED)', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker({ tokens: ver });
    const token = iss.issue({ ...baseGrant, effectTypes: ['crm.read'], requestHash: canonicalRequestHash({}) });
    const admission = await broker.admit({
      effectId: 'eff-cap',
      token,
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-cap',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'CAPABILITY_DENIED');
  });

  it('rejects a revoked capability token', async () => {
    const { iss } = makeTokens('commander-issuer', 'k1');
    const revokedJtis = new Set<string>();
    const ver = new CapabilityTokenVerifier({
      issuer: 'commander-issuer',
      audience: 'commander.effect-broker',
      publicKeys: { k1: iss.publicKey },
      revocations: { isRevoked: async (jti: string, _tenantId: string) => revokedJtis.has(jti) },
    });
    const token = iss.issue({ ...baseGrant, jti: 'revoked-jti', requestHash: canonicalRequestHash({}) });
    revokedJtis.add('revoked-jti');
    const broker = makeBroker({ tokens: ver });
    await assert.rejects(
      broker.admit({
        effectId: 'eff-rev',
        token,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-rev',
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      /revoked/i,
    );
  });
});

describe('WS2 §5 three-layer policy engine called by admit()', () => {
  const admitInput = (iss: ReturnType<typeof makeTokens>['iss'], effectId: string) => ({
    effectId,
    token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
    type: 'crm.write',
    request: {},
    idempotencyKey: `idem-${effectId}`,
    lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
    actor: 'w',
  });

  it('rejects ACTION_NOT_ALLOWLISTED when the tenant allowlist denies (fail-closed)', async () => {
    const { iss, ver } = makeTokens();
    let admitEffectCalled = false;
    const broker = makeBroker({
      tokens: ver,
      kernel: {
        admitEffect: async () => { admitEffectCalled = true; return { admitted: true, effect: { id: 'e', state: 'ADMITTED' } }; },
        completeEffect: async () => ({}),
        isActionAllowed: async () => false, // no matching allowlist row ⇒ deny
      },
    });
    const admission = await broker.admit(admitInput(iss, 'eff-allow-deny'));
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'ACTION_NOT_ALLOWLISTED');
    assert.equal(admitEffectCalled, false, 'denied action must not reach kernel admission');
  });

  it('admits when allowlisted and increments the tenant quota', async () => {
    const { iss, ver } = makeTokens();
    const quotaCalls: Array<{ tenantId: string; actionClass: string }> = [];
    const broker = makeBroker({
      tokens: ver,
      kernel: {
        admitEffect: async () => ({ admitted: true, effect: { id: 'e', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
        isActionAllowed: async (tenantId: string, action: string) => tenantId === 'tenant-a' && action === 'crm.write',
        incrementQuota: async (input: { tenantId: string; actionClass: string }) => { quotaCalls.push(input); return { countUsed: 1, tokensUsed: 0 }; },
      },
    });
    const admission = await broker.admit(admitInput(iss, 'eff-allow-ok'));
    assert.equal(admission.admitted, true);
    assert.equal(quotaCalls.length, 1, 'admit() must record quota usage');
    assert.deepEqual(quotaCalls[0], { tenantId: 'tenant-a', actionClass: 'crm' });
  });

  it('rejects QUOTA_EXCEEDED when daily count passes the configured ceiling', async () => {
    const { iss, ver } = makeTokens();
    let count = 0;
    const broker = makeBroker({
      tokens: ver,
      kernel: {
        admitEffect: async () => ({ admitted: true, effect: { id: 'e', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
        isActionAllowed: async () => true,
        getQuota: async () => ({ countUsed: count, tokensUsed: 0 }),
        incrementQuota: async () => ({ countUsed: ++count, tokensUsed: 0 }),
      },
      options: { quotaLimits: { maxCountPerDay: 2 } },
    });
    assert.equal((await broker.admit(admitInput(iss, 'q1'))).admitted, true);
    assert.equal((await broker.admit(admitInput(iss, 'q2'))).admitted, true);
    const third = await broker.admit(admitInput(iss, 'q3'));
    assert.equal(third.admitted, false);
    assert.equal(third.reason, 'QUOTA_EXCEEDED');
    assert.equal(count, 2, 'rejected admit must not charge quota');
  });

  it('does not charge quota when kernel admission fails (e.g. LEASE_LOST)', async () => {
    const { iss, ver } = makeTokens();
    let increments = 0;
    const broker = makeBroker({
      tokens: ver,
      kernel: {
        admitEffect: async () => ({ admitted: false, reason: 'LEASE_LOST' }),
        completeEffect: async () => ({}),
        isActionAllowed: async () => true,
        getQuota: async () => ({ countUsed: increments, tokensUsed: 0 }),
        incrementQuota: async () => ({ countUsed: ++increments, tokensUsed: 0 }),
      },
      options: { quotaLimits: { maxCountPerDay: 10 } },
    });
    const admission = await broker.admit(admitInput(iss, 'lease-lost'));
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'EFFECT_ADMISSION_REJECTED');
    assert.equal(increments, 0, 'LEASE_LOST must not burn quota');
  });

  it('does not re-charge quota on idempotent COMPLETED replay', async () => {
    const { iss, ver } = makeTokens();
    let increments = 0;
    const broker = makeBroker({
      tokens: ver,
      kernel: {
        admitEffect: async () => ({
          admitted: true,
          replayed: true,
          effect: { id: 'e', state: 'COMPLETED', response: { ok: true } },
        }),
        completeEffect: async () => ({}),
        isActionAllowed: async () => true,
        incrementQuota: async () => ({ countUsed: ++increments, tokensUsed: 0 }),
      },
    });
    const admission = await broker.admit(admitInput(iss, 'replay-quota'));
    assert.equal(admission.admitted, true);
    assert.equal(admission.replayed, true);
    assert.equal(increments, 0, 'COMPLETED replay must not increment quota');
  });

  it('parks already-admitted effect when concurrent quota race exceeds ceiling', async () => {
    const { iss, ver } = makeTokens();
    let parked: string | undefined;
    const broker = makeBroker({
      tokens: ver,
      kernel: {
        admitEffect: async () => ({ admitted: true, effect: { id: 'e-race', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
        isActionAllowed: async () => true,
        getQuota: async () => ({ countUsed: 1, tokensUsed: 0 }),
        incrementQuota: async () => ({ countUsed: 3, tokensUsed: 0 }),
        markEffectCompletionUnknown: async (input) => {
          parked = input.effectId;
          return { id: input.effectId, state: 'COMPLETION_UNKNOWN' };
        },
      },
      options: { quotaLimits: { maxCountPerDay: 2 } },
    });
    const admission = await broker.admit(admitInput(iss, 'race-quota'));
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'QUOTA_EXCEEDED');
    assert.equal(parked, 'e-race', 'over-quota race must park the orphan ADMITTED effect');
  });
});
