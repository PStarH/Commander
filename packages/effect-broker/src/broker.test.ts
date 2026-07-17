import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
  type CapabilityGrant,
} from './index.js';

const grant: CapabilityGrant = {
  jti: 'jti',
  tenantId: 'tenant',
  runId: 'run',
  stepId: 'step',
  effectTypes: ['crm.write'],
  expiresAt: '2099-01-01T00:00:00.000Z',
  policySnapshotId: 'p1',
  requestHash: canonicalRequestHash({}),
} as unknown as CapabilityGrant;

/**
 * Test-only token port: pairs a freshly generated Ed25519 issuer with a
 * matching verifier. Replaces the deleted CapabilityTokenService facade —
 * production must wire separate issuer/verifier instances (spec §9).
 */
function makeTokens() {
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
  return {
    issue: (g: CapabilityGrant) =>
      issuer.issue({
        ...g,
        policySnapshotId: g.policySnapshotId ?? 'p1',
        requestHash: g.requestHash ?? canonicalRequestHash({}),
      }),
    verify: (token: string) => verifier.verify(token),
  };
}

describe('EffectBroker', () => {
  it('supports separate Ed25519 issuer and verifier keys', async () => {
    const issuer = CapabilityTokenIssuer.generate({ issuer: 'commander-issuer', audience: 'commander.effect-broker', keyId: 'k1' });
    const verifier = new CapabilityTokenVerifier({ issuer: 'commander-issuer', audience: 'commander.effect-broker', publicKeys: { k1: issuer.publicKey } });
    const token = issuer.issue({ jti: 'ed-jti', tenantId: 'tenant', runId: 'run', stepId: 'step', effectTypes: ['crm.write'], expiresAt: '2099-01-01T00:00:00.000Z', policySnapshotId: 'p1', requestHash: canonicalRequestHash({}) });
    assert.equal((await verifier.verify(token)).issuer, 'commander-issuer');
    // Flip a signature byte — trailing-char swaps are flaky under base64url (can be a no-op).
    const [header, payload, signature] = token.split('.');
    assert.ok(header && payload && signature);
    const sigBytes = Buffer.from(signature, 'base64url');
    sigBytes[0] = (sigBytes[0]! ^ 0xff) & 0xff;
    const forged = `${header}.${payload}.${sigBytes.toString('base64url')}`;
    await assert.rejects(verifier.verify(forged), /signature/i);
  });

  it('CapabilityTokenIssuer.publicKey derives via pkcs8 PEM export path', async () => {
    const issuer = CapabilityTokenIssuer.generate({ issuer: 'commander-issuer', audience: 'commander.effect-broker', keyId: 'pkcs8-test' });
    const publicKey = issuer.publicKey;

    assert.ok(publicKey, 'publicKey should be defined');
    assert.equal(publicKey.type, 'public');

    const verifier = new CapabilityTokenVerifier({ issuer: 'commander-issuer', audience: 'commander.effect-broker', publicKeys: { 'pkcs8-test': publicKey } });
    const token = issuer.issue({ jti: 'pkcs8-jti', tenantId: 'tenant', runId: 'run', stepId: 'step', effectTypes: ['crm.write'], expiresAt: '2099-01-01T00:00:00.000Z', policySnapshotId: 'p1', requestHash: canonicalRequestHash({}) });

    const verified = await verifier.verify(token);
    assert.equal(verified.tenantId, 'tenant');
    assert.equal(verified.effectTypes[0], 'crm.write');
  });

  it('requires matching capability, allow policy, kernel admission, and records completion', async () => {
    const tokens = makeTokens();
    let completed = false;
    const broker = new EffectBroker(tokens, { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) }, { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => { completed = true; return {}; } }, { execute: async () => ({ ok: true }) }, { append: async () => {} });
    const result = await broker.execute({ effectId: 'effect', token: tokens.issue(grant), type: 'crm.write', request: {}, idempotencyKey: 'idem', lease: { workerId: 'w', token: 'l', fencingEpoch: 1 }, actor: 'w' });
    assert.equal(result.response?.ok, true);
    assert.equal(completed, true);
  });

  it('fails closed before executor invocation when policy denies', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const broker = new EffectBroker(tokens, { evaluate: async () => ({ effect: 'deny', decisionId: 'd1', reason: 'no', policySnapshotId: 'p1' }) }, { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => null }, { execute: async () => { invoked = true; return {}; } }, { append: async () => {} });
    await assert.rejects(broker.execute({ effectId: 'effect', token: tokens.issue(grant), type: 'crm.write', request: {}, idempotencyKey: 'idem', lease: { workerId: 'w', token: 'l', fencingEpoch: 1 }, actor: 'w' }), (error: unknown) => error instanceof EffectBrokerError && error.code === 'POLICY_DENIED');
    assert.equal(invoked, false);
  });

  it('rejects a request whose canonical hash is not bound to the capability grant', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const broker = new EffectBroker(tokens, { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) }, { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) }, { execute: async () => { invoked = true; return {}; } }, { append: async () => {} });
    await assert.rejects(broker.execute({ effectId: 'effect', token: tokens.issue(grant), type: 'crm.write', request: { changed: true }, idempotencyKey: 'idem', lease: { workerId: 'w', token: 'l', fencingEpoch: 1 }, actor: 'w' }), (error: unknown) => error instanceof EffectBrokerError && error.code === 'REQUEST_HASH_MISMATCH');
    assert.equal(invoked, false);
  });

  it('creates a durable approval interaction instead of executing a required approval effect', async () => {
    const tokens = makeTokens();
    let interactionId = '';
    let invoked = false;
    const broker = new EffectBroker(tokens, { evaluate: async () => ({ effect: 'require_approval', decisionId: 'd-approval', reason: 'high risk', policySnapshotId: 'p1' }) }, { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) }, { execute: async () => { invoked = true; return {}; } }, { append: async () => {} }, { approval: { createApprovalInteraction: async () => { interactionId = 'interaction-1'; return { interactionId, status: 'pending' }; } } });
    await assert.rejects(broker.execute({ effectId: 'effect', token: tokens.issue(grant), type: 'crm.write', request: {}, idempotencyKey: 'idem', lease: { workerId: 'w', token: 'l', fencingEpoch: 1 }, actor: 'w' }), (error: unknown) => error instanceof EffectBrokerError && error.code === 'APPROVAL_REQUIRED' && error.details.interactionId === 'interaction-1');
    assert.equal(interactionId, 'interaction-1');
    assert.equal(invoked, false);
  });

  it('fail-closes incomplete idempotent replays (ADMITTED must not return as success)', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      {
        admitEffect: async () => ({
          admitted: true,
          replayed: true,
          effect: { id: 'effect', state: 'ADMITTED' },
        }),
        completeEffect: async () => ({}),
      },
      { execute: async () => { invoked = true; return { ok: true }; } },
      { append: async () => {} },
    );
    await assert.rejects(
      broker.execute({
        effectId: 'effect',
        token: tokens.issue(grant),
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'EFFECT_IN_FLIGHT',
    );
    assert.equal(invoked, false);
  });

  it('returns cached response only for COMPLETED idempotent replays', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      {
        admitEffect: async () => ({
          admitted: true,
          replayed: true,
          effect: { id: 'effect', state: 'COMPLETED', response: { ok: true, from: 'cache' } },
        }),
        completeEffect: async () => ({}),
      },
      { execute: async () => { invoked = true; return { ok: false }; } },
      { append: async () => {} },
    );
    const result = await broker.execute({
      effectId: 'effect',
      token: tokens.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(result.replayed, true);
    assert.equal(result.response?.from, 'cache');
    assert.equal(invoked, false);
  });

  it('fail-closes COMPLETION_UNKNOWN idempotent replays', async () => {
    const tokens = makeTokens();
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      {
        admitEffect: async () => ({
          admitted: true,
          replayed: true,
          effect: { id: 'effect', state: 'COMPLETION_UNKNOWN' },
        }),
        completeEffect: async () => ({}),
      },
      { execute: async () => ({}) },
      { append: async () => {} },
    );
    await assert.rejects(
      broker.execute({
        effectId: 'effect',
        token: tokens.issue(grant),
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'COMPLETION_UNKNOWN',
    );
  });
});


describe('ENFORCED approval binding (args / policy / audience)', () => {
  it('rejects mutated args after a grant was bound to the original request hash', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const approvedRequest = { amount: 10, target: 'acct-a' };
    const boundGrant: CapabilityGrant = {
      ...grant,
      requestHash: canonicalRequestHash(approvedRequest),
    };
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
      { execute: async () => { invoked = true; return {}; } },
      { append: async () => {} },
    );
    await assert.rejects(
      broker.execute({
        effectId: 'effect',
        token: tokens.issue(boundGrant),
        type: 'crm.write',
        request: { ...approvedRequest, amount: 999 },
        idempotencyKey: 'idem',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'REQUEST_HASH_MISMATCH',
    );
    assert.equal(invoked, false);
  });

  it('rejects a policy snapshot change after the grant was issued', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p2-rotated' }) },
      { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
      { execute: async () => { invoked = true; return {}; } },
      { append: async () => {} },
    );
    await assert.rejects(
      broker.execute({
        effectId: 'effect',
        token: tokens.issue({ ...grant, policySnapshotId: 'p1' }),
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'POLICY_SNAPSHOT_MISMATCH',
    );
    assert.equal(invoked, false);
  });

  it('rejects audience mismatch between grant and broker verifier', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
      { execute: async () => { invoked = true; return {}; } },
      { append: async () => {} },
      { audience: 'other.audience' },
    );
    await assert.rejects(
      broker.execute({
        effectId: 'effect',
        token: tokens.issue(grant),
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'AUDIENCE_MISMATCH',
    );
    assert.equal(invoked, false);
  });
});

describe('executeAdmitted worker affinity (C-α)', () => {
  const leaseW1 = { workerId: 'w1', token: 'l', fencingEpoch: 1 };

  function makeAffinityBroker(
    executor: (input: Parameters<import('./index.js').EffectExecutor['execute']>[0]) => Promise<Record<string, unknown>>,
    options: { localWorkerId?: string; localWorkerGeneration?: number } = { localWorkerId: 'w1' },
  ) {
    const tokens = makeTokens();
    return {
      tokens,
      broker: new EffectBroker(
        tokens,
        { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
        { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
        { execute: executor },
        { append: async () => {} },
        options,
      ),
    };
  }

  it('succeeds when localWorkerId matches admission lease workerId', async () => {
    let invoked = false;
    let receivedContext: unknown;
    const { tokens, broker } = makeAffinityBroker(async (input) => {
      invoked = true;
      receivedContext = input.executionContext;
      return { ok: true };
    });
    const admission = await broker.admit({
      effectId: 'eff-aff-ok',
      token: tokens.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: leaseW1,
      actor: 'w1',
    });
    assert.equal(admission.admitted, true);
    const result = await broker.executeAdmitted({ effectId: 'eff-aff-ok' });
    assert.equal(invoked, true);
    assert.equal(result.response?.ok, true);
    assert.deepEqual(receivedContext, {
      tenantId: 'tenant',
      workerId: 'w1',
      fencingEpoch: 1,
      leaseToken: 'l',
      effectId: 'eff-aff-ok',
    });
  });

  it('throws WORKER_AFFINITY_VIOLATION when lease workerId differs from localWorkerId', async () => {
    let invoked = false;
    const { tokens, broker } = makeAffinityBroker(async () => {
      invoked = true;
      return {};
    });
    const admission = await broker.admit({
      effectId: 'eff-aff-bad',
      token: tokens.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w2', token: 'l', fencingEpoch: 1 },
      actor: 'w2',
    });
    assert.equal(admission.admitted, true);
    await assert.rejects(
      broker.executeAdmitted({ effectId: 'eff-aff-bad' }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'WORKER_AFFINITY_VIOLATION',
    );
    assert.equal(invoked, false);
    // Affinity fail-closed must consume admission so grant/request do not leak.
    await assert.rejects(
      broker.executeAdmitted({ effectId: 'eff-aff-bad' }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'ADMISSION_NOT_FOUND',
    );
  });

  it('throws WORKER_AFFINITY_VIOLATION when workerGeneration mismatches', async () => {
    let invoked = false;
    const { tokens, broker } = makeAffinityBroker(
      async () => {
        invoked = true;
        return {};
      },
      { localWorkerId: 'w1', localWorkerGeneration: 2 },
    );
    const admission = await broker.admit({
      effectId: 'eff-gen-bad',
      token: tokens.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w1',
    });
    assert.equal(admission.admitted, true);
    await assert.rejects(
      broker.executeAdmitted({ effectId: 'eff-gen-bad' }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'WORKER_AFFINITY_VIOLATION',
    );
    assert.equal(invoked, false);
  });

  it('throws WORKER_AFFINITY_VIOLATION when localWorkerGeneration set but lease omits generation', async () => {
    const { tokens, broker } = makeAffinityBroker(async () => ({}), {
      localWorkerId: 'w1',
      localWorkerGeneration: 1,
    });
    await broker.admit({
      effectId: 'eff-gen-missing',
      token: tokens.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', token: 'l', fencingEpoch: 1 },
      actor: 'w1',
    });
    await assert.rejects(
      broker.executeAdmitted({ effectId: 'eff-gen-missing' }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'WORKER_AFFINITY_VIOLATION',
    );
  });

  it('throws WORKER_AFFINITY_VIOLATION when lease token or fencingEpoch is invalid', async () => {
    const { tokens, broker } = makeAffinityBroker(async () => ({}));
    await broker.admit({
      effectId: 'eff-no-token',
      token: tokens.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', token: '', fencingEpoch: 1 },
      actor: 'w1',
    });
    await assert.rejects(
      broker.executeAdmitted({ effectId: 'eff-no-token' }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'WORKER_AFFINITY_VIOLATION',
    );

    const { tokens: tokens2, broker: broker2 } = makeAffinityBroker(async () => ({}));
    await broker2.admit({
      effectId: 'eff-bad-epoch',
      token: tokens2.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem2',
      lease: { workerId: 'w1', token: 'l', fencingEpoch: Number.NaN },
      actor: 'w1',
    });
    await assert.rejects(
      broker2.executeAdmitted({ effectId: 'eff-bad-epoch' }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'WORKER_AFFINITY_VIOLATION',
    );
  });

  it('bindLocalWorkerGeneration enables generation affinity after construction', async () => {
    let invoked = false;
    const { tokens, broker } = makeAffinityBroker(async () => {
      invoked = true;
      return { ok: true };
    });
    broker.bindLocalWorkerGeneration(3);
    await broker.admit({
      effectId: 'eff-bind-gen',
      token: tokens.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', workerGeneration: 3, token: 'l', fencingEpoch: 1 },
      actor: 'w1',
    });
    await broker.executeAdmitted({ effectId: 'eff-bind-gen' });
    assert.equal(invoked, true);
  });

  it('skips affinity check when localWorkerId is unset (backward compatible)', async () => {
    let invoked = false;
    const { tokens, broker } = makeAffinityBroker(async () => {
      invoked = true;
      return { ok: true };
    }, {});
    const admission = await broker.admit({
      effectId: 'eff-no-local',
      token: tokens.issue(grant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w2', token: 'l', fencingEpoch: 1 },
      actor: 'w2',
    });
    assert.equal(admission.admitted, true);
    await broker.executeAdmitted({ effectId: 'eff-no-local' });
    assert.equal(invoked, true);
  });
});
