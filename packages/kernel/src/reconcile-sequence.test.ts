import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';

describe('reconcile effect event sequences', () => {
  it('escalate at reconcileAttempts=0 then reconcile uses non-overlapping sequences', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      {
        id: 'run-seq',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [{ id: 'step-a', kind: 'agent' }],
      },
      'gateway',
    );
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    const admitted = await kernel.admitEffect({
      id: 'effect-seq',
      runId: 'run-seq',
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      type: 'ticket.create',
      idempotencyKey: 'idem-seq',
      policyDecisionId: 'decision-1',
      request: { title: 't' },
      lease: claimed!.lease!,
      actor: 'worker-1',
    });
    assert.equal(admitted.admitted, true);
    await kernel.markEffectCompletionUnknown({
      effectId: 'effect-seq',
      tenantId: 'tenant-a',
      reason: 'timeout',
      actor: 'worker-1',
    });
    await kernel.requestReconcile({ effectId: 'effect-seq', tenantId: 'tenant-a' });
    const [claimedReconcile] = await kernel.claimReconcileEffects({ limit: 1 });
    assert.ok(claimedReconcile);
    assert.equal(claimedReconcile.effect.reconcileAttempts, 0);
    const escalated = await kernel.escalateReconcile({
      effectId: 'effect-seq',
      tenantId: 'tenant-a',
      claimToken: claimedReconcile.claimToken,
      reason: 'adapter missing',
    });
    assert.equal(escalated, true);
    const reconciled = await kernel.reconcileEffect({
      effectId: 'effect-seq',
      tenantId: 'tenant-a',
      state: 'COMPLETED',
      response: { ok: true },
      actor: 'reconciler',
    });
    assert.equal(reconciled?.state, 'COMPLETED');
    const effectEvents = (await kernel.listEvents('run-seq', 'tenant-a')).filter(
      (event) => event.aggregateId === 'effect-seq',
    );
    const sequences = effectEvents.map((event) => event.sequence);
    assert.equal(new Set(sequences).size, sequences.length);
    assert.ok(effectEvents.some((event) => event.type === 'effect.reconcile_escalated'));
    assert.ok(effectEvents.some((event) => event.type === 'effect.reconciled_completed'));
  });
});
