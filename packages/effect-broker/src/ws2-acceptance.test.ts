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
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
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
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
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
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
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
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
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
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
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
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
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
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
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
      revocations: { isRevoked: async (jti: string) => revokedJtis.has(jti) },
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
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      /revoked/i,
    );
  });
});
