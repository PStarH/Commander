/**
 * Proves reclaim → kernel compensation outbox → consumeCompensationBatch
 * end-to-end (closes the topic/payload/lease gap from the reliability audit).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReclaimDaemon } from './reclaimDaemon.js';
import {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
  normalizeCompensationPayload,
} from './compensationConsumer.js';
import { InMemoryKernelRepository } from '../testing/inMemoryRepository.js';

describe('normalizeCompensationPayload', () => {
  it('maps kernel reclaim payloads to compensate.rollback', () => {
    const normalized = normalizeCompensationPayload({
      eventId: 'e1',
      type: 'kernel.compensation.requested',
      tenantId: 'tenant-a',
      runId: 'run-a',
      stepId: 'step-a',
      effectIds: ['effect-a'],
      fencingEpoch: 1,
    });
    assert.ok(normalized);
    assert.equal(normalized!.compensationAction, 'compensate.rollback');
    assert.deepEqual(normalized!.compensationPayload?.effectIds, ['effect-a']);
  });
});

describe('reclaim → compensation consume (integration)', () => {
  it('drains commander.kernel.compensation.requested through the consumer', async () => {
    const repository = new InMemoryKernelRepository();
    const base = new Date();
    await repository.createRun(
      {
        id: 'run-a',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [
          {
            id: 'step-a',
            kind: 'agent',
            maxAttempts: 1,
            scheduledAt: new Date(base.getTime() - 1_000).toISOString(),
          },
        ],
      },
      'gateway',
    );
    const claimed = await repository.claimNextStep({
      tenantId: 'tenant-a',
      workerId: 'worker-a',
      leaseTtlMs: 1_000,
      now: base,
    });
    assert.ok(claimed?.lease);
    assert.equal(
      (
        await repository.admitEffect({
          id: 'effect-a',
          runId: 'run-a',
          stepId: 'step-a',
          tenantId: 'tenant-a',
          type: 'tool.write',
          idempotencyKey: 'effect-key',
          request: { tool: 'write' },
          policyDecisionId: 'decision-a',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          lease: claimed.lease,
          actor: 'worker-a',
        })
      ).admitted,
      true,
    );
    assert.ok(
      await repository.completeEffect(
        'effect-a',
        'tenant-a',
        claimed.lease,
        { ok: true },
        'worker-a',
      ),
    );

    await new ReclaimDaemon(repository).tick(new Date(base.getTime() + 2_000));
    assert.equal((await repository.getRun('run-a', 'tenant-a'))?.state, 'COMPENSATING');

    // Legacy topic must stay empty — reclaim writes the kernel topic.
    assert.equal((await repository.claimOutboxByTopic('commander.compensation', 10)).length, 0);

    let executed = 0;
    const result = await consumeCompensationBatch(
      repository,
      {
        async admit(input) {
          assert.equal(input.type, 'compensate.rollback');
          const admitted = await repository.admitEffect({
            id: input.effectId,
            runId: 'run-a',
            stepId: 'step-a',
            tenantId: 'tenant-a',
            type: input.type,
            idempotencyKey: input.idempotencyKey,
            request: input.request,
            policyDecisionId: 'cmp-decision',
            policySnapshotId: 'policy-v1',
            actionDigest: 'a'.repeat(64),
            lease: {
              workerId: input.lease.workerId,
              workerGeneration: input.lease.workerGeneration,
              token: input.lease.token,
              fencingEpoch: input.lease.fencingEpoch,
            },
            actor: input.actor,
          });
          return {
            admitted: admitted.admitted,
            effectId: input.effectId,
            replayed: !!admitted.replayed,
            reason: admitted.reason,
          };
        },
        async executeAdmitted(input) {
          executed += 1;
          const completed = await repository.completeEffect(
            input.effectId,
            'tenant-a',
            { workerId: 'cmp-worker', token: 'cmp-lease', fencingEpoch: 1 },
            { rolledBack: true },
            'compensation-consumer:cmp-worker',
          );
          assert.ok(completed);
          return { effectId: input.effectId, replayed: false, response: { rolledBack: true } };
        },
      },
      async () => 'cmp-token',
      { workerId: 'cmp-worker', topic: KERNEL_COMPENSATION_TOPIC },
    );

    assert.equal(result.consumed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
    assert.equal(executed, 1);
    assert.equal(
      (await repository.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10)).length,
      0,
      'acked compensation message must not be reclaimed',
    );
  });
});
