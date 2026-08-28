import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  type EffectKernelPort,
  type EffectRemoteOutcome,
  type ReconcileEffectSnapshot,
} from './index.js';

const EFFECT: ReconcileEffectSnapshot = {
  id: 'eff-1',
  state: 'COMPLETION_UNKNOWN',
  type: 'github.pull-request.create',
  idempotencyKey: 'idem-1',
  request: { destination: 'github:owner/repo' },
  runId: 'run-1',
  stepId: 'step-1',
  tenantId: 'tenant-1',
};

function broker() {
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'test',
    audience: 'commander.effect-broker',
    keyId: 'test-key',
  });
  const verifier = new CapabilityTokenVerifier({
    issuer: 'test',
    audience: 'commander.effect-broker',
    publicKeys: { 'test-key': issuer.publicKey },
  });
  let executorCalls = 0;
  let effectReads = 0;
  let effectWrites = 0;
  const kernel: EffectKernelPort = {
    admitEffect: async () => ({ admitted: false }),
    completeEffect: async () => null,
    getEffect: async () => {
      effectReads += 1;
      return null;
    },
    reconcileEffect: async () => {
      effectWrites += 1;
      return null;
    },
  };
  return {
    broker: new EffectBroker(
      verifier,
      {
        evaluate: async () => ({
          effect: 'deny',
          decisionId: 'not-used',
          reason: 'not-used',
          policySnapshotId: 'not-used',
        }),
      },
      kernel,
      {
        execute: async () => {
          executorCalls += 1;
          return {};
        },
      },
      { append: async () => undefined },
    ),
    counts: () => ({ executorCalls, effectReads, effectWrites }),
  };
}

describe('snapshot-only UNKNOWN reconciliation', () => {
  it('returns APPLIED without reading, mutating, or re-executing the effect', async () => {
    const harness = broker();
    const result = await harness.broker.reconcileUnknown({
      effect: EFFECT,
      querier: {
        queryOutcome: async () => ({ status: 'APPLIED', response: { prNumber: 42 } }),
      },
    });
    assert.deepEqual(result, { status: 'APPLIED', response: { prNumber: 42 } });
    assert.deepEqual(harness.counts(), { executorCalls: 0, effectReads: 0, effectWrites: 0 });
  });

  it('returns typed UNKNOWN unchanged for the daemon-owned transition', async () => {
    const harness = broker();
    const outcome: EffectRemoteOutcome = {
      status: 'UNKNOWN',
      error: { code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE', message: 'not visible' },
    };
    assert.deepEqual(
      await harness.broker.reconcileUnknown({
        effect: EFFECT,
        querier: { queryOutcome: async () => outcome },
      }),
      outcome,
    );
    assert.deepEqual(harness.counts(), { executorCalls: 0, effectReads: 0, effectWrites: 0 });
  });

  it('rejects a bare UNKNOWN and a non-unknown snapshot', async () => {
    const harness = broker();
    await assert.rejects(
      () =>
        harness.broker.reconcileUnknown({
          effect: EFFECT,
          querier: {
            queryOutcome: async () => ({ status: 'UNKNOWN' }) as EffectRemoteOutcome,
          },
        }),
      (error: unknown) =>
        error instanceof EffectBrokerError && error.code === 'ADAPTER_OUTCOME_INVALID',
    );
    await assert.rejects(
      () =>
        harness.broker.reconcileUnknown({
          effect: { ...EFFECT, state: 'COMPLETED' },
          querier: {
            queryOutcome: async () => ({ status: 'APPLIED', response: {} }),
          },
        }),
      (error: unknown) => error instanceof EffectBrokerError && error.code === 'EFFECT_NOT_UNKNOWN',
    );
  });
});
