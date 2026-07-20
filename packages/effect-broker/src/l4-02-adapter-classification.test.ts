import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdapterExecutionError,
  EffectBroker,
  EffectBrokerError,
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  canonicalRequestHash,
} from './index.js';

describe('L4-02 adapter execution classification', () => {
  it('NOT_COMMITTED AdapterExecutionError calls failEffect', async () => {
    let failed = false;
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'test',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { test: issuer.publicKey },
    });
    const request = { destination: 'github://o/r/pulls' };
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'test-allow',
          policySnapshotId: 'test-policy',
        }),
      },
      {
        admitEffect: async () => ({
          admitted: true,
          effect: { id: 'kernel-eff-1', state: 'ADMITTED' },
        }),
        completeEffect: async () => null,
        failEffect: async () => {
          failed = true;
          return { id: 'kernel-eff-1', state: 'FAILED' };
        },
      },
      {
        execute: async () => {
          throw new AdapterExecutionError('auth failed', {
            code: 'GITHUB_AUTH_FAILED',
            commitState: 'NOT_COMMITTED',
            retryMode: 'NEVER',
          });
        },
      },
      { append: async () => {} },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: false,
        localWorkerId: 'worker-1',
      },
    );
    const token = issuer.issue({
      jti: 'jti-1',
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      effectTypes: ['connector.github.pull-request.create'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(request),
    });
    await assert.rejects(
      () =>
        broker.execute({
          effectId: 'eff-1',
          token,
          type: 'connector.github.pull-request.create',
          request,
          idempotencyKey: 'key-1',
          lease: { workerId: 'worker-1', token: 'lease', fencingEpoch: 1 },
          actor: 'worker-1',
        }),
      (error: unknown) =>
        error instanceof EffectBrokerError && error.code === 'EFFECT_FAILED',
    );
    assert.equal(failed, true);
  });

  it('UNKNOWN AdapterExecutionError parks effect without replaying write', async () => {
    let parked = false;
    let executeCount = 0;
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'test',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { test: issuer.publicKey },
    });
    const request = { destination: 'github://o/r/pulls' };
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'test-allow',
          policySnapshotId: 'test-policy',
        }),
      },
      {
        admitEffect: async () => ({
          admitted: true,
          effect: { id: 'kernel-eff-2', state: 'ADMITTED' },
        }),
        completeEffect: async () => null,
        markEffectCompletionUnknown: async () => {
          parked = true;
          return { id: 'kernel-eff-2', state: 'COMPLETION_UNKNOWN' };
        },
      },
      {
        execute: async () => {
          executeCount += 1;
          throw new AdapterExecutionError('upstream timeout', {
            code: 'GITHUB_UPSTREAM_TIMEOUT',
            commitState: 'UNKNOWN',
            retryMode: 'QUERY_FIRST',
          });
        },
      },
      { append: async () => {} },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: false,
        localWorkerId: 'worker-1',
      },
    );
    const token = issuer.issue({
      jti: 'jti-2',
      tenantId: 'tenant-a',
      runId: 'run-2',
      stepId: 'step-2',
      effectTypes: ['connector.github.pull-request.create'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(request),
    });
    await assert.rejects(
      () =>
        broker.execute({
          effectId: 'eff-2',
          token,
          type: 'connector.github.pull-request.create',
          request,
          idempotencyKey: 'key-2',
          lease: { workerId: 'worker-1', token: 'lease', fencingEpoch: 1 },
          actor: 'worker-1',
        }),
      (error: unknown) =>
        error instanceof EffectBrokerError && error.code === 'COMPLETION_UNKNOWN',
    );
    assert.equal(executeCount, 1, 'write must not be retried without query');
    assert.equal(parked, true);
  });
});
