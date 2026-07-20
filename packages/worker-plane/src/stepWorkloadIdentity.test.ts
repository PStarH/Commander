import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resetControlPlane } from './workerRuntimeAdapter.js';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
} from '@commander/effect-broker';
import type { ClaimedStep } from './types.js';
import {
  getStepWorkloadBinding,
  getStepWorkloadContext,
  mintStepCapabilityToken,
  requireStepWorkloadBinding,
  runWithStepWorkloadIdentity,
} from './stepWorkloadIdentity.js';

const step: ClaimedStep = {
  id: 'step-1',
  runId: 'run-1',
  tenantId: 'tenant-a',
  kind: 'agent',
  version: 1,
  attempt: 1,
  input: {},
  lease: {
    workerId: 'w1',
    token: 'lease',
    fencingEpoch: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};

describe('stepWorkloadIdentity (L3-07)', () => {
  it('issues step-scoped identity and exposes binding via ALS', () => {
    resetControlPlane();
    runWithStepWorkloadIdentity(step, () => {
      const binding = getStepWorkloadBinding();
      assert.ok(binding);
      assert.equal(binding.tenantId, 'tenant-a');
      assert.equal(binding.runId, 'run-1');
      assert.equal(binding.stepId, 'step-1');
      assert.match(binding.workloadId, /^wl_run-1_step-1_/);
    });
    assert.equal(getStepWorkloadBinding(), undefined);
  });

  it('mintStepCapabilityToken uses identity tenant/run/step/workloadId only', async () => {
    resetControlPlane();
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'k1',
    });
    await runWithStepWorkloadIdentity(step, async () => {
      const binding = requireStepWorkloadBinding();
      // mint API has no tenantId/runId/stepId fields — grant must mirror ALS binding only.
      const token = mintStepCapabilityToken({
        issuer,
        effectType: 'crm.write',
        request: { action: 'x' },
      });
      const ver = new CapabilityTokenVerifier({
        issuer: 'commander-worker',
        audience: 'commander.effect-broker',
        publicKeys: { k1: issuer.publicKey },
      });
      const grant = await ver.verify(token);
      assert.equal(grant.tenantId, binding.tenantId);
      assert.equal(grant.runId, binding.runId);
      assert.equal(grant.stepId, binding.stepId);
      assert.equal(grant.workloadId, binding.workloadId);
      assert.equal(grant.requestHash, canonicalRequestHash({ action: 'x' }));
    });
  });

  it('requireStepWorkloadBinding fails outside ALS', () => {
    resetControlPlane();
    assert.throws(() => requireStepWorkloadBinding(), /WORKLOAD_IDENTITY_REQUIRED/);
  });

  it('requireStepWorkloadBinding fails closed when step identity expired', () => {
    resetControlPlane();
    runWithStepWorkloadIdentity(step, () => {
      const ctx = getStepWorkloadContext();
      assert.ok(ctx);
      ctx.identity.expiresAt = '2020-01-01T00:00:00.000Z';
      assert.throws(() => requireStepWorkloadBinding(), /WORKLOAD_IDENTITY_EXPIRED/);
      assert.throws(
        () =>
          mintStepCapabilityToken({
            issuer: CapabilityTokenIssuer.generate({
              issuer: 'commander-worker',
              audience: 'commander.effect-broker',
              keyId: 'k1',
            }),
            effectType: 'crm.write',
            request: {},
          }),
        /WORKLOAD_IDENTITY_EXPIRED/,
      );
    });
  });

  it('routes broker admit with binding and rejects cross-tenant mint', async () => {
    resetControlPlane();
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'k1',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { k1: issuer.publicKey },
    });
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow' as const,
          decisionId: 'd1',
          reason: 'ok',
          policySnapshotId: 'policy',
        }),
      },
      {
        admitEffect: async () => ({ admitted: true, effect: { id: 'e1', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => undefined },
      { audience: 'commander.effect-broker', requireRequestBinding: true },
    );

    await runWithStepWorkloadIdentity(step, async () => {
      const binding = requireStepWorkloadBinding();
      const good = mintStepCapabilityToken({
        issuer,
        effectType: 'crm.write',
        request: {},
      });
      const admitted = await broker.admit({
        effectId: 'eff-1',
        token: good,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-1',
        lease: { workerId: 'w1', token: 'lease', fencingEpoch: 1 },
        actor: 'w1',
        workloadBinding: binding,
      });
      assert.equal(admitted.admitted, true);

      const badToken = issuer.issue({
        jti: 'bad',
        tenantId: 'tenant-b',
        runId: 'run-1',
        stepId: 'step-1',
        effectTypes: ['crm.write'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        requestHash: canonicalRequestHash({}),
      });
      const rejected = await broker.admit({
        effectId: 'eff-2',
        token: badToken,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-2',
        lease: { workerId: 'w1', token: 'lease', fencingEpoch: 1 },
        actor: 'w1',
        workloadBinding: binding,
      });
      assert.equal(rejected.admitted, false);
      assert.equal(rejected.reason, 'TENANT_MISMATCH');
    });
  });

  it('isolates ALS binding across concurrent steps (no cross-step reuse)', async () => {
    resetControlPlane();
    const stepA: ClaimedStep = { ...step, id: 'step-a', runId: 'run-a' };
    const stepB: ClaimedStep = { ...step, id: 'step-b', runId: 'run-b', tenantId: 'tenant-b' };
    const seen: Array<{ stepId: string; tenantId: string; workloadId: string }> = [];

    await Promise.all([
      runWithStepWorkloadIdentity(stepA, async () => {
        await new Promise((r) => setTimeout(r, 20));
        const b = requireStepWorkloadBinding();
        seen.push({ stepId: b.stepId, tenantId: b.tenantId, workloadId: b.workloadId });
      }),
      runWithStepWorkloadIdentity(stepB, async () => {
        await new Promise((r) => setTimeout(r, 5));
        const b = requireStepWorkloadBinding();
        seen.push({ stepId: b.stepId, tenantId: b.tenantId, workloadId: b.workloadId });
      }),
    ]);

    assert.equal(seen.length, 2);
    const byStep = Object.fromEntries(seen.map((s) => [s.stepId, s]));
    assert.equal(byStep['step-a']?.tenantId, 'tenant-a');
    assert.equal(byStep['step-b']?.tenantId, 'tenant-b');
    assert.notEqual(byStep['step-a']?.workloadId, byStep['step-b']?.workloadId);
  });
});
