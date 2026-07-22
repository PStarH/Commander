import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  DURABLE_CAPABILITY_STORES_REQUIRED,
  InMemoryCapabilityReplayStore,
  InMemoryCapabilityRevocationStore,
  assertEffectBrokerDurableStores,
  canonicalRequestHash,
  isClassAEffectType,
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
  actionDigest: 'a'.repeat(64),
  workerId: 'w',
  workerGeneration: 1,
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
    const result = await broker.execute({ effectId: 'effect', token: tokens.issue(grant), type: 'crm.write', request: {}, idempotencyKey: 'idem', lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 }, actor: 'w' });
    assert.equal(result.response?.ok, true);
    assert.equal(completed, true);
  });

  it('fails closed before executor invocation when policy denies', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const broker = new EffectBroker(tokens, { evaluate: async () => ({ effect: 'deny', decisionId: 'd1', reason: 'no', policySnapshotId: 'p1' }) }, { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => null }, { execute: async () => { invoked = true; return {}; } }, { append: async () => {} });
    await assert.rejects(broker.execute({ effectId: 'effect', token: tokens.issue(grant), type: 'crm.write', request: {}, idempotencyKey: 'idem', lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 }, actor: 'w' }), (error: unknown) => error instanceof EffectBrokerError && error.code === 'POLICY_DENIED');
    assert.equal(invoked, false);
  });

  it('rejects a request whose canonical hash is not bound to the capability grant', async () => {
    const tokens = makeTokens();
    let invoked = false;
    const broker = new EffectBroker(tokens, { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) }, { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) }, { execute: async () => { invoked = true; return {}; } }, { append: async () => {} });
    await assert.rejects(broker.execute({ effectId: 'effect', token: tokens.issue(grant), type: 'crm.write', request: { changed: true }, idempotencyKey: 'idem', lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 }, actor: 'w' }), (error: unknown) => error instanceof EffectBrokerError && error.code === 'REQUEST_HASH_MISMATCH');
    assert.equal(invoked, false);
  });

  it('creates a durable approval interaction instead of executing a required approval effect', async () => {
    const tokens = makeTokens();
    let interactionId = '';
    let invoked = false;
    const broker = new EffectBroker(tokens, { evaluate: async () => ({ effect: 'require_approval', decisionId: 'd-approval', reason: 'high risk', policySnapshotId: 'p1' }) }, { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) }, { execute: async () => { invoked = true; return {}; } }, { append: async () => {} }, { approval: { createApprovalInteraction: async () => { interactionId = 'interaction-1'; return { interactionId, status: 'pending' }; } } });
    await assert.rejects(broker.execute({ effectId: 'effect', token: tokens.issue(grant), type: 'crm.write', request: {}, idempotencyKey: 'idem', lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 }, actor: 'w' }), (error: unknown) => error instanceof EffectBrokerError && error.code === 'APPROVAL_REQUIRED' && error.details.interactionId === 'interaction-1');
    assert.equal(interactionId, 'interaction-1');
    assert.equal(invoked, false);
  });

  it('fail-closes incomplete idempotent replays (ADMITTED must not return as success)', async () => {
    const tokens = makeTokens();
    let invoked = false;
    let parkedReason = '';
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
        markEffectCompletionUnknown: async (input) => {
          parkedReason = input.reason;
          return { id: input.effectId, state: 'COMPLETION_UNKNOWN' };
        },
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
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'COMPLETION_UNKNOWN',
    );
    assert.equal(parkedReason, 'incomplete_idempotent_replay');
    assert.equal(invoked, false);
  });

  it('parks ADMITTED effects when the executor throws so retries do not spin in-flight', async () => {
    const tokens = makeTokens();
    let parkedReason = '';
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      {
        admitEffect: async () => ({
          admitted: true,
          replayed: false,
          effect: { id: 'effect', state: 'ADMITTED' },
        }),
        completeEffect: async () => ({}),
        markEffectCompletionUnknown: async (input) => {
          parkedReason = input.reason;
          return { id: input.effectId, state: 'COMPLETION_UNKNOWN' };
        },
      },
      { execute: async () => { throw new Error('connector timeout'); } },
      { append: async () => {} },
    );
    await assert.rejects(
      broker.execute({
        effectId: 'effect',
        token: tokens.issue(grant),
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem',
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      /connector timeout/,
    );
    assert.equal(parkedReason, 'execute_admitted_failed');
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
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
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
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
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
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
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
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
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
        lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'AUDIENCE_MISMATCH',
    );
    assert.equal(invoked, false);
  });
});

describe('executeAdmitted worker affinity (C-α)', () => {
  const leaseW1 = { workerId: 'w1', workerGeneration: 1, token: 'l', fencingEpoch: 1 };
  const grantW1: CapabilityGrant = { ...grant, workerId: 'w1', workerGeneration: 1 };

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
      token: tokens.issue(grantW1),
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
      workerGeneration: 1,
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
      token: tokens.issue({ ...grant, workerId: 'w2', workerGeneration: 1 }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w2', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
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
      token: tokens.issue(grantW1),
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

  it('rejects WORKER_FENCE_MISMATCH when lease omits generation but grant pins one', async () => {
    const { tokens, broker } = makeAffinityBroker(async () => ({}), {
      localWorkerId: 'w1',
      localWorkerGeneration: 1,
    });
    const admission = await broker.admit({
      effectId: 'eff-gen-missing',
      token: tokens.issue(grantW1),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', token: 'l', fencingEpoch: 1 },
      actor: 'w1',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'WORKER_FENCE_MISMATCH');
  });

  it('rejects WORKER_FENCE_MISMATCH when grant.workerId is whitespace-only', async () => {
    const { tokens, broker } = makeAffinityBroker(async () => ({}), {
      localWorkerId: 'w1',
      localWorkerGeneration: 1,
    });
    const admission = await broker.admit({
      effectId: 'eff-blank-worker',
      token: tokens.issue({ ...grantW1, workerId: '   ' }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w1',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'WORKER_FENCE_MISMATCH');
  });

  it('rejects WORKER_FENCE_MISMATCH when lease.workerId is whitespace-only', async () => {
    const { tokens, broker } = makeAffinityBroker(async () => ({}), {
      localWorkerId: 'w1',
      localWorkerGeneration: 1,
    });
    const admission = await broker.admit({
      effectId: 'eff-blank-lease-worker',
      token: tokens.issue(grantW1),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: '   ', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w1',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'WORKER_FENCE_MISMATCH');
  });

  it('rejects WORKER_FENCE_MISMATCH when lease omits generation even if grant claims the former -1 sentinel', async () => {
    // Regression for the removed `lease.workerGeneration ?? -1` coercion: a
    // grant claiming workerGeneration -1 must never match a lease that
    // simply omits the field.
    const { tokens, broker } = makeAffinityBroker(async () => ({}), { localWorkerId: 'w1' });
    const admission = await broker.admit({
      effectId: 'eff-gen-sentinel',
      token: tokens.issue({ ...grant, workerId: 'w1', workerGeneration: -1 }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', token: 'l', fencingEpoch: 1 },
      actor: 'w1',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'WORKER_FENCE_MISMATCH');
  });

  it('throws WORKER_AFFINITY_VIOLATION when localWorkerGeneration is the former -1 sentinel and lease omits generation', async () => {
    // Regression for the removed `admission.lease.workerGeneration ?? -1`
    // coercion in assertWorkerAffinity: a broker pinned to generation -1
    // must never accept a lease that omits the field.
    let invoked = false;
    const { tokens, broker } = makeAffinityBroker(
      async () => {
        invoked = true;
        return {};
      },
      { localWorkerId: 'w1', localWorkerGeneration: -1 },
    );
    const admission = await broker.admit({
      effectId: 'eff-local-gen-sentinel',
      token: tokens.issue({ ...grant, workerId: 'w1', workerGeneration: -1 }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', token: 'l', fencingEpoch: 1 },
      actor: 'w1',
    });
    // admit() already fails closed at the fence check before this can reach
    // executeAdmitted — asserting that here too, so the two layers stay
    // consistent and neither one alone is load-bearing.
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'WORKER_FENCE_MISMATCH');
    assert.equal(invoked, false);
  });

  it('throws WORKER_AFFINITY_VIOLATION when lease token or fencingEpoch is invalid', async () => {
    const { tokens, broker } = makeAffinityBroker(async () => ({}));
    await broker.admit({
      effectId: 'eff-no-token',
      token: tokens.issue(grantW1),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w1', workerGeneration: 1, token: '', fencingEpoch: 1 },
      actor: 'w1',
    });
    await assert.rejects(
      broker.executeAdmitted({ effectId: 'eff-no-token' }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'WORKER_AFFINITY_VIOLATION',
    );

    const { tokens: tokens2, broker: broker2 } = makeAffinityBroker(async () => ({}));
    await broker2.admit({
      effectId: 'eff-bad-epoch',
      token: tokens2.issue(grantW1),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem2',
      lease: { workerId: 'w1', workerGeneration: 1, token: 'l', fencingEpoch: Number.NaN },
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
      token: tokens.issue({ ...grant, workerId: 'w1', workerGeneration: 3 }),
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
      token: tokens.issue({ ...grant, workerId: 'w2', workerGeneration: 1 }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w2', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w2',
    });
    assert.equal(admission.admitted, true);
    await broker.executeAdmitted({ effectId: 'eff-no-local' });
    assert.equal(invoked, true);
  });

  it('refuses to construct without localWorkerId in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () => makeAffinityBroker(async () => ({}), {}),
        (error: unknown) =>
          error instanceof EffectBrokerError && error.code === 'WORKER_AFFINITY_REQUIRED_IN_PROD',
      );
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe('Task 2 actionDigest / Class A gate', () => {
  it('classifies connector/compensate/crm/http as Class A and llm/local as not', () => {
    assert.equal(isClassAEffectType('connector.github.create_issue'), true);
    assert.equal(isClassAEffectType('compensate.rollback'), true);
    assert.equal(isClassAEffectType('crm.write'), true);
    assert.equal(isClassAEffectType('http.post'), true);
    assert.equal(isClassAEffectType('unknown.family'), true);
    assert.equal(isClassAEffectType('llm.chat'), false);
    assert.equal(isClassAEffectType('retrieve.search'), false);
    assert.equal(isClassAEffectType('local.hash'), false);
    assert.equal(isClassAEffectType('compute.fold'), false);
  });

  it('fail-closed: a Class A family segment anywhere in the path wins over a local./llm. prefix', () => {
    // P1: `local.crm.write` / `local.connector.x` previously bypassed the
    // actionDigest gate because the leading `local.` segment classified the
    // whole type as Class C.
    assert.equal(isClassAEffectType('local.crm.write'), true);
    assert.equal(isClassAEffectType('local.connector.x'), true);
    assert.equal(isClassAEffectType('local.saas.mutate'), true);
    assert.equal(isClassAEffectType('llm.egress.post'), true);
    // Non-Class-A local/llm/retrieve/read/budget/compute types stay non-A.
    assert.equal(isClassAEffectType('local.hash'), false);
    assert.equal(isClassAEffectType('llm.chat'), false);
    assert.equal(isClassAEffectType('retrieve.search'), false);
    assert.equal(isClassAEffectType('read.record'), false);
    assert.equal(isClassAEffectType('budget.check'), false);
    assert.equal(isClassAEffectType('compute.fold'), false);
  });

  it('fail-closed: mixed-case segments cannot bypass the Class A gate', () => {
    // P1: `read.Write` / `llm.CRM.x` / `CRM.write` previously skipped
    // ACTION_DIGEST_REQUIRED because segment/prefix checks were case-sensitive.
    assert.equal(isClassAEffectType('read.Write'), true);
    assert.equal(isClassAEffectType('llm.CRM.x'), true);
    assert.equal(isClassAEffectType('CRM.write'), true);
    // Non-Class-A types stay non-A regardless of case.
    assert.equal(isClassAEffectType('llm.chat'), false);
    assert.equal(isClassAEffectType('LLM.CHAT'), false);
    assert.equal(isClassAEffectType('read.foo'), false);
    assert.equal(isClassAEffectType('READ.FOO'), false);
  });

  it('requires actionDigest for a local.-prefixed effect type carrying a Class A family segment', async () => {
    const tokens = makeTokens();
    let admitCalled = false;
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      {
        admitEffect: async () => {
          admitCalled = true;
          return { admitted: true, effect: { id: 'effect', state: 'ADMITTED' } };
        },
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => {} },
    );
    const { actionDigest: _omit, ...withoutDigest } = grant;
    const admission = await broker.admit({
      effectId: 'eff-local-crm-write',
      token: tokens.issue({ ...withoutDigest, effectTypes: ['local.crm.write'] } as CapabilityGrant),
      type: 'local.crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'ACTION_DIGEST_REQUIRED');
    assert.equal(admitCalled, false);
  });

  it('rejects Class A admit when grant.actionDigest is missing', async () => {
    const tokens = makeTokens();
    let admitCalled = false;
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      {
        admitEffect: async () => {
          admitCalled = true;
          return { admitted: true, effect: { id: 'effect', state: 'ADMITTED' } };
        },
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => {} },
    );
    const { actionDigest: _omit, ...withoutDigest } = grant;
    const admission = await broker.admit({
      effectId: 'eff-no-digest',
      token: tokens.issue(withoutDigest as CapabilityGrant),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'ACTION_DIGEST_REQUIRED');
    assert.equal(admitCalled, false);
  });

  it('rejects Class A admit when grant.actionDigest is empty', async () => {
    const tokens = makeTokens();
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
      { execute: async () => ({ ok: true }) },
      { append: async () => {} },
    );
    const admission = await broker.admit({
      effectId: 'eff-empty-digest',
      token: tokens.issue({ ...grant, effectTypes: ['connector.saas.write'], actionDigest: '' }),
      type: 'connector.saas.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'ACTION_DIGEST_REQUIRED');
  });

  it('rejects Class A admit when grant.actionDigest is whitespace-only', async () => {
    const tokens = makeTokens();
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
      { execute: async () => ({ ok: true }) },
      { append: async () => {} },
    );
    const admission = await broker.admit({
      effectId: 'eff-blank-digest',
      token: tokens.issue({ ...grant, effectTypes: ['connector.saas.write'], actionDigest: '   ' }),
      type: 'connector.saas.write',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'ACTION_DIGEST_REQUIRED');
  });

  it('passes policySnapshotId and grant actionDigest to kernel for Class A', async () => {
    const tokens = makeTokens();
    let captured: { policySnapshotId?: string; actionDigest?: string } = {};
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'snap-42' }) },
      {
        admitEffect: async (input) => {
          captured = { policySnapshotId: input.policySnapshotId, actionDigest: input.actionDigest };
          return { admitted: true, effect: { id: 'effect', state: 'ADMITTED' } };
        },
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => {} },
    );
    const digest = 'b'.repeat(64);
    const admission = await broker.admit({
      effectId: 'eff-pass-digest',
      token: tokens.issue({
        ...grant,
        effectTypes: ['http.put'],
        policySnapshotId: 'snap-42',
        actionDigest: digest,
      }),
      type: 'http.put',
      request: {},
      idempotencyKey: 'idem',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, true);
    assert.equal(captured.policySnapshotId, 'snap-42');
    assert.equal(captured.actionDigest, digest);
  });

  it('allows Class B admit without grant actionDigest and falls back to request hash', async () => {
    const tokens = makeTokens();
    let capturedDigest = '';
    const request = { prompt: 'hi' };
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      {
        admitEffect: async (input) => {
          capturedDigest = input.actionDigest;
          return { admitted: true, effect: { id: 'effect', state: 'ADMITTED' } };
        },
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => {} },
    );
    const { actionDigest: _omit, ...withoutDigest } = grant;
    const admission = await broker.admit({
      effectId: 'eff-class-b',
      token: tokens.issue({
        ...withoutDigest,
        effectTypes: ['llm.chat'],
        requestHash: canonicalRequestHash(request),
      } as CapabilityGrant),
      type: 'llm.chat',
      request,
      idempotencyKey: 'idem',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, true);
    assert.equal(capturedDigest, canonicalRequestHash(request));
  });

  it('allows Class C admit without grant actionDigest', async () => {
    const tokens = makeTokens();
    let admitCalled = false;
    const request = { value: 1 };
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      {
        admitEffect: async () => {
          admitCalled = true;
          return { admitted: true, effect: { id: 'effect', state: 'ADMITTED' } };
        },
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => {} },
    );
    const { actionDigest: _omit, ...withoutDigest } = grant;
    const admission = await broker.admit({
      effectId: 'eff-class-c',
      token: tokens.issue({
        ...withoutDigest,
        effectTypes: ['local.hash'],
        requestHash: canonicalRequestHash(request),
      } as CapabilityGrant),
      type: 'local.hash',
      request,
      idempotencyKey: 'idem',
      lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
      actor: 'w',
    });
    assert.equal(admission.admitted, true);
    assert.equal(admitCalled, true);
  });

  it('fail-closed when requireDurableCapabilityStores without replay/revocations', () => {
    const tokens = makeTokens();
    assert.throws(
      () =>
        new EffectBroker(
          tokens,
          { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
          { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
          { execute: async () => ({}) },
          { append: async () => {} },
          { requireDurableCapabilityStores: true, localWorkerId: 'w1' },
        ),
      (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
    );
  });

  it('fail-closed under production profile without durable stores (localWorkerId set)', () => {
    const tokens = makeTokens();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          new EffectBroker(
            tokens,
            { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
            { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
            { execute: async () => ({}) },
            { append: async () => {} },
            { localWorkerId: 'w1' },
          ),
        (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
      );
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('constructs when requireDurableCapabilityStores with replay + revocations present', () => {
    const tokens = makeTokens();
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
      { execute: async () => ({}) },
      { append: async () => {} },
      {
        requireDurableCapabilityStores: true,
        localWorkerId: 'w1',
        replay: { consume: () => false },
        revocations: { revoke: () => undefined, isRevoked: () => false },
      },
    );
    assert.ok(broker);
  });

  it('constructs when requireDurableCapabilityStores with a replay tenant factory', () => {
    const tokens = makeTokens();
    const broker = new EffectBroker(
      tokens,
      { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
      { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
      { execute: async () => ({}) },
      { append: async () => {} },
      {
        requireDurableCapabilityStores: true,
        localWorkerId: 'w1',
        replay: (_tenantId: string) => ({ consume: () => false }),
        revocations: { revoke: () => undefined, isRevoked: () => false },
      },
    );
    assert.ok(broker);
  });
});

describe('P1: durable stores must reject InMemory classes (presence != durability)', () => {
  it('assertEffectBrokerDurableStores throws when replay is InMemoryCapabilityReplayStore', () => {
    assert.throws(
      () =>
        assertEffectBrokerDurableStores({
          replay: new InMemoryCapabilityReplayStore(),
          revocations: { revoke: () => undefined, isRevoked: () => false },
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
    );
  });

  it('assertEffectBrokerDurableStores throws when revocations is InMemoryCapabilityRevocationStore', () => {
    assert.throws(
      () =>
        assertEffectBrokerDurableStores({
          replay: { consume: () => false },
          revocations: new InMemoryCapabilityRevocationStore(),
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
    );
  });

  it('assertEffectBrokerDurableStores throws when replay/revocations lack consume/isRevoked', () => {
    assert.throws(
      () =>
        assertEffectBrokerDurableStores({
          replay: {} as unknown as { consume: () => boolean },
          revocations: { revoke: () => undefined, isRevoked: () => false },
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
    );
    assert.throws(
      () =>
        assertEffectBrokerDurableStores({
          replay: { consume: () => false },
          revocations: {} as unknown as { isRevoked: () => boolean },
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
    );
  });

  it('assertEffectBrokerDurableStores passes a plain structural store with consume/isRevoked', () => {
    assert.doesNotThrow(() =>
      assertEffectBrokerDurableStores({
        replay: { consume: () => false },
        revocations: { revoke: () => undefined, isRevoked: () => false },
      }),
    );
  });

  it('assertEffectBrokerDurableStores passes a tenant-scoped replay factory', () => {
    assert.doesNotThrow(() =>
      assertEffectBrokerDurableStores({
        replay: (_tenantId: string) => ({ consume: () => false }),
        revocations: { revoke: () => undefined, isRevoked: () => false },
      }),
    );
  });

  it('assertEffectBrokerDurableStores rejects a factory that returns InMemoryCapabilityReplayStore', () => {
    assert.throws(
      () =>
        assertEffectBrokerDurableStores({
          replay: (_tenantId: string) => new InMemoryCapabilityReplayStore(),
          revocations: { revoke: () => undefined, isRevoked: () => false },
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
    );
  });

  it('EffectBroker constructor rejects an InMemoryCapabilityReplayStore under requireDurableCapabilityStores', () => {
    const tokens = makeTokens();
    assert.throws(
      () =>
        new EffectBroker(
          tokens,
          { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
          { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
          { execute: async () => ({}) },
          { append: async () => {} },
          {
            requireDurableCapabilityStores: true,
            localWorkerId: 'w1',
            replay: new InMemoryCapabilityReplayStore(),
            revocations: { revoke: () => undefined, isRevoked: () => false },
          },
        ),
      (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
    );
  });

  it('EffectBroker constructor rejects an InMemoryCapabilityRevocationStore under requireDurableCapabilityStores', () => {
    const tokens = makeTokens();
    assert.throws(
      () =>
        new EffectBroker(
          tokens,
          { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
          { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
          { execute: async () => ({}) },
          { append: async () => {} },
          {
            requireDurableCapabilityStores: true,
            localWorkerId: 'w1',
            replay: { consume: () => false },
            revocations: new InMemoryCapabilityRevocationStore(),
          },
        ),
      (err: unknown) => err instanceof EffectBrokerError && err.code === DURABLE_CAPABILITY_STORES_REQUIRED,
    );
  });
});

describe('P1: COMMANDER_REQUIRE_WORKLOAD_BINDING must gate affinity the same as durable stores', () => {
  it('refuses to construct without localWorkerId when only COMMANDER_REQUIRE_WORKLOAD_BINDING=1 is set', () => {
    const tokens = makeTokens();
    const prev = process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING;
    process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING = '1';
    try {
      assert.throws(
        () =>
          new EffectBroker(
            tokens,
            { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
            { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
            { execute: async () => ({}) },
            { append: async () => {} },
            {
              replay: { consume: () => false },
              revocations: { revoke: () => undefined, isRevoked: () => false },
            },
          ),
        (err: unknown) => err instanceof EffectBrokerError && err.code === 'WORKER_AFFINITY_REQUIRED_IN_PROD',
      );
    } finally {
      if (prev === undefined) delete process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING;
      else process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING = prev;
    }
  });

  it('constructs when COMMANDER_REQUIRE_WORKLOAD_BINDING=1 with localWorkerId + durable stores', () => {
    const tokens = makeTokens();
    const prev = process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING;
    process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING = '1';
    try {
      const broker = new EffectBroker(
        tokens,
        { evaluate: async () => ({ effect: 'allow', decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
        { admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }), completeEffect: async () => ({}) },
        { execute: async () => ({}) },
        { append: async () => {} },
        {
          localWorkerId: 'w1',
          replay: { consume: () => false },
          revocations: { revoke: () => undefined, isRevoked: () => false },
        },
      );
      assert.ok(broker);
    } finally {
      if (prev === undefined) delete process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING;
      else process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING = prev;
    }
  });
});
