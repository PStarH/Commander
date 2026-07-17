/**
 * L3-07 — workload binding enforcement at EffectBroker.admit().
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
  type CapabilityGrant,
  type WorkloadBinding,
} from './index.js';

function makeTokens() {
  const iss = CapabilityTokenIssuer.generate({
    issuer: 'commander-issuer',
    audience: 'commander.effect-broker',
    keyId: 'k1',
  });
  const ver = new CapabilityTokenVerifier({
    issuer: 'commander-issuer',
    audience: 'commander.effect-broker',
    publicKeys: { k1: iss.publicKey },
  });
  return { iss, ver };
}

const binding: WorkloadBinding = {
  tenantId: 'tenant-a',
  runId: 'run-1',
  stepId: 'step-1',
  workloadId: 'wl_run-1_step-1_abc',
};

const baseGrant: CapabilityGrant = {
  jti: 'jti-1',
  tenantId: 'tenant-a',
  runId: 'run-1',
  stepId: 'step-1',
  workloadId: 'wl_run-1_step-1_abc',
  effectTypes: ['crm.write'],
  expiresAt: '2099-01-01T00:00:00.000Z',
  requestHash: canonicalRequestHash({}),
} as unknown as CapabilityGrant;

function makeBroker(tokens: CapabilityTokenVerifier) {
  return new EffectBroker(
    tokens,
    { evaluate: async () => ({ effect: 'allow' as const, decisionId: 'd1', reason: 'ok', policySnapshotId: 'p1' }) },
    {
      admitEffect: async () => ({ admitted: true, effect: { id: 'e1', state: 'ADMITTED' } }),
      completeEffect: async () => ({}),
    },
    { execute: async () => ({ ok: true }) },
    { append: async () => undefined },
    { audience: 'commander.effect-broker', requireRequestBinding: true },
  );
}

describe('L3-07 workload binding', () => {
  it('rejects WORKLOAD_BINDING_REQUIRED in production when binding is missing', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker(ver);
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const admission = await broker.admit({
        effectId: 'eff-1',
        token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-1',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      });
      assert.equal(admission.admitted, false);
      assert.equal(admission.reason, 'WORKLOAD_BINDING_REQUIRED');
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('rejects TENANT_MISMATCH when grant tenant differs from binding', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker(ver);
    const token = iss.issue({
      ...baseGrant,
      tenantId: 'tenant-b',
      requestHash: canonicalRequestHash({}),
    });
    const admission = await broker.admit({
      effectId: 'eff-2',
      token,
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-2',
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
      actor: 'w',
      workloadBinding: binding,
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'TENANT_MISMATCH');
  });

  it('rejects RUN_MISMATCH and STEP_MISMATCH', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker(ver);
    const runBad = await broker.admit({
      effectId: 'eff-3',
      token: iss.issue({ ...baseGrant, runId: 'run-x', requestHash: canonicalRequestHash({}) }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-3',
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
      actor: 'w',
      workloadBinding: binding,
    });
    assert.equal(runBad.admitted, false);
    assert.equal(runBad.reason, 'RUN_MISMATCH');

    const stepBad = await broker.admit({
      effectId: 'eff-4',
      token: iss.issue({ ...baseGrant, stepId: 'step-x', requestHash: canonicalRequestHash({}) }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-4',
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
      actor: 'w',
      workloadBinding: binding,
    });
    assert.equal(stepBad.admitted, false);
    assert.equal(stepBad.reason, 'STEP_MISMATCH');
  });

  it('rejects WORKLOAD_BINDING_REQUIRED under enterprise profile', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker(ver);
    const origEnv = process.env.NODE_ENV;
    const origProfile = process.env.COMMANDER_PROFILE;
    process.env.NODE_ENV = 'test';
    process.env.COMMANDER_PROFILE = 'enterprise';
    try {
      const admission = await broker.admit({
        effectId: 'eff-ent',
        token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-ent',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
      });
      assert.equal(admission.admitted, false);
      assert.equal(admission.reason, 'WORKLOAD_BINDING_REQUIRED');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origProfile === undefined) delete process.env.COMMANDER_PROFILE;
      else process.env.COMMANDER_PROFILE = origProfile;
    }
  });

  it('rejects WORKLOAD_MISMATCH when workloadId differs', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker(ver);
    const admission = await broker.admit({
      effectId: 'eff-wl-diff',
      token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-wl-diff',
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
      actor: 'w',
      workloadBinding: { ...binding, workloadId: 'wl_other' },
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'WORKLOAD_MISMATCH');
  });

  it('admits when grant matches binding', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker(ver);
    const admission = await broker.admit({
      effectId: 'eff-5',
      token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-5',
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
      actor: 'w',
      workloadBinding: binding,
    });
    assert.equal(admission.admitted, true);
  });

  it('rejects WORKLOAD_MISMATCH when grant has workloadId but binding omits it', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker(ver);
    const admission = await broker.admit({
      effectId: 'eff-wl',
      token: iss.issue({ ...baseGrant, requestHash: canonicalRequestHash({}) }),
      type: 'crm.write',
      request: {},
      idempotencyKey: 'idem-wl',
      lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
      actor: 'w',
      workloadBinding: {
        tenantId: binding.tenantId,
        runId: binding.runId,
        stepId: binding.stepId,
      },
    });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'WORKLOAD_MISMATCH');
  });

  it('rejects expired capability token before binding check matters', async () => {
    const { iss, ver } = makeTokens();
    const broker = makeBroker(ver);
    const token = iss.issue({
      ...baseGrant,
      expiresAt: '2020-01-01T00:00:00.000Z',
      requestHash: canonicalRequestHash({}),
    });
    await assert.rejects(
      broker.admit({
        effectId: 'eff-exp',
        token,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-exp',
        lease: { workerId: 'w', token: 'l', fencingEpoch: 1 },
        actor: 'w',
        workloadBinding: binding,
      }),
    );
  });
});
