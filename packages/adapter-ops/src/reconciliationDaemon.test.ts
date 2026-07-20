import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import { EffectBroker } from '@commander/effect-broker';
import { ActionAdapterRegistry } from '@commander/action-adapters';
import { ReconciliationDaemon } from './reconciliationDaemon.js';

describe('ReconciliationDaemon', () => {
  it('escalates unregistered adapter effects during tick', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      {
        id: 'run-recon',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [{ id: 'step-recon', kind: 'tool' }],
      },
      'gateway',
    );
    const step = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(step?.lease);
    await kernel.admitEffect({
      id: 'effect-recon',
      runId: 'run-recon',
      stepId: step.id,
      tenantId: 'tenant-a',
      type: 'connector.unknown.effect',
      idempotencyKey: 'recon-key',
      policyDecisionId: 'policy',
      request: {},
      lease: step.lease,
      actor: 'worker-1',
    });
    await kernel.markEffectCompletionUnknown({
      effectId: 'effect-recon',
      tenantId: 'tenant-a',
      reason: 'timeout',
      actor: 'worker-1',
    });
    const daemon = new ReconciliationDaemon({
      repository: kernel,
      registry: ActionAdapterRegistry.empty(),
      actor: 'reconciliation-daemon',
      pollIntervalMs: 60_000,
      batchSize: 10,
      brokerFactory: () =>
        new EffectBroker(
          { verify: async () => ({ jti: 'x', tenantId: 'tenant-a', runId: 'r', stepId: 's', effectTypes: [], expiresAt: '' }) },
          { evaluate: async () => ({ effect: 'allow', decisionId: 'd', policySnapshotId: 'p' }) },
          {
            getEffect: (id, tenantId) => kernel.getEffect(id, tenantId),
            reconcileEffect: (input) => kernel.reconcileEffect(input),
          },
          { execute: async () => { throw new Error('no write'); } },
          { append: async () => {} },
          { requireRequestBinding: false },
        ),
    });
    const stats = await daemon.tick();
    assert.equal(stats.claimed, 1);
    assert.equal(stats.escalated, 1);
    const effect = await kernel.getEffect('effect-recon', 'tenant-a');
    assert.ok(effect?.reconcileEscalatedAt);
  });

  it('returns zero counts when claimReconcileEffects rejects', async () => {
    const kernel = new InMemoryKernelRepository();
    const daemon = new ReconciliationDaemon({
      repository: {
        ...kernel,
        claimReconcileEffects: async () => {
          throw new Error('db unavailable');
        },
      } as never,
      registry: ActionAdapterRegistry.empty(),
      actor: 'reconciliation-daemon',
      pollIntervalMs: 60_000,
      batchSize: 10,
      brokerFactory: () =>
        new EffectBroker(
          { verify: async () => ({ jti: 'x', tenantId: 'tenant-a', runId: 'r', stepId: 's', effectTypes: [], expiresAt: '' }) },
          { evaluate: async () => ({ effect: 'allow', decisionId: 'd', policySnapshotId: 'p' }) },
          {
            getEffect: (id, tenantId) => kernel.getEffect(id, tenantId),
            reconcileEffect: (input) => kernel.reconcileEffect(input),
          },
          { execute: async () => { throw new Error('no write'); } },
          { append: async () => {} },
          { requireRequestBinding: false },
        ),
    });
    const stats = await daemon.tick();
    assert.deepEqual(stats, { claimed: 0, completed: 0, escalated: 0, rescheduled: 0 });
  });
});
