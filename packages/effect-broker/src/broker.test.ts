import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenService,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
} from './index.js';
const grant = {
  jti: 'jti',
  tenantId: 'tenant',
  runId: 'run',
  stepId: 'step',
  effectTypes: ['crm.write'],
  expiresAt: '2099-01-01T00:00:00.000Z',
  policySnapshotId: 'p1',
  requestHash: canonicalRequestHash({}),
};
describe('EffectBroker', () => {
  it('supports separate Ed25519 issuer and verifier keys', async () => {
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
    const token = issuer.issue({
      jti: 'ed-jti',
      tenantId: 'tenant',
      runId: 'run',
      stepId: 'step',
      effectTypes: ['crm.write'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      policySnapshotId: 'p1',
      requestHash: canonicalRequestHash({}),
    });
    assert.equal((await verifier.verify(token)).issuer, 'commander-issuer');
    const [header, payload, signature] = token.split('.');
    const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    await assert.rejects(verifier.verify(`${header}.${payload}.${tamperedSignature}`), /signature/);
  });

  it('requires matching capability, allow policy, kernel admission, and records completion', async () => {
    const tokens = new CapabilityTokenService('x'.repeat(32));
    let completed = false;
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'd1',
          reason: 'ok',
          policySnapshotId: 'p1',
        }),
      },
      {
        admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }),
        completeEffect: async () => {
          completed = true;
          return {};
        },
      },
      { execute: async () => ({ ok: true }) },
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
    assert.equal(result.response?.ok, true);
    assert.equal(completed, true);
  });
  it('fails closed before executor invocation when policy denies', async () => {
    const tokens = new CapabilityTokenService('x'.repeat(32));
    let invoked = false;
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'deny',
          decisionId: 'd1',
          reason: 'no',
          policySnapshotId: 'p1',
        }),
      },
      {
        admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }),
        completeEffect: async () => null,
      },
      {
        execute: async () => {
          invoked = true;
          return {};
        },
      },
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
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'POLICY_DENIED',
    );
    assert.equal(invoked, false);
  });

  it('rejects a request whose canonical hash is not bound to the capability grant', async () => {
    const tokens = new CapabilityTokenService('y'.repeat(32));
    let invoked = false;
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'd1',
          reason: 'ok',
          policySnapshotId: 'p1',
        }),
      },
      {
        admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
      },
      {
        execute: async () => {
          invoked = true;
          return {};
        },
      },
      { append: async () => {} },
    );
    await assert.rejects(
      broker.execute({
        effectId: 'effect',
        token: tokens.issue(grant),
        type: 'crm.write',
        request: { changed: true },
        idempotencyKey: 'idem',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      }),
      (error: unknown) =>
        error instanceof EffectBrokerError && error.code === 'REQUEST_HASH_MISMATCH',
    );
    assert.equal(invoked, false);
  });

  it('creates a durable approval interaction instead of executing a required approval effect', async () => {
    const tokens = new CapabilityTokenService('z'.repeat(32));
    let interactionId = '';
    let invoked = false;
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'require_approval',
          decisionId: 'd-approval',
          reason: 'high risk',
          policySnapshotId: 'p1',
        }),
      },
      {
        admitEffect: async () => ({ admitted: true, effect: { id: 'effect', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
      },
      {
        execute: async () => {
          invoked = true;
          return {};
        },
      },
      { append: async () => {} },
      {
        approval: {
          createApprovalInteraction: async () => {
            interactionId = 'interaction-1';
            return { interactionId, status: 'pending' };
          },
        },
      },
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
      (error: unknown) =>
        error instanceof EffectBrokerError &&
        error.code === 'APPROVAL_REQUIRED' &&
        error.details.interactionId === 'interaction-1',
    );
    assert.equal(interactionId, 'interaction-1');
    assert.equal(invoked, false);
  });
});
