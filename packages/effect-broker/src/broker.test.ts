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
    await assert.rejects(verifier.verify(`${token.slice(0, -1)}x`), /signature/);
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
