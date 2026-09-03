/** Proves automatic reclaim cannot manufacture executable compensation authority. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReclaimDaemon } from './reclaimDaemon.js';
import { KERNEL_COMPENSATION_TOPIC, normalizeCompensationPayload } from './compensationConsumer.js';
import {
  InMemoryKernelRepository,
  seedFreshOperationsDrains,
} from '../testing/inMemoryRepository.js';

describe('normalizeCompensationPayload', () => {
  it('rejects legacy reclaim payloads instead of synthesizing compensate.rollback', () => {
    const normalized = normalizeCompensationPayload({
      eventId: 'e1',
      type: 'kernel.compensation.requested',
      tenantId: 'tenant-a',
      runId: 'run-a',
      stepId: 'step-a',
      effectIds: ['effect-a'],
      fencingEpoch: 1,
    });
    assert.equal(normalized, null);
  });
});

describe('reclaim → compensation authority boundary', () => {
  it('leaves automatic reclaim non-executable and invokes zero adapters', async () => {
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
    const effectRequest = {
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
    };
    assert.deepEqual(
      await repository.admitEffect(effectRequest),
      { admitted: false, reason: 'OPERATIONS_NOT_READY' },
      'the old fixture must not bypass Class A admission readiness',
    );
    seedFreshOperationsDrains(repository, 'tenant-a');
    assert.equal((await repository.admitEffect(effectRequest)).admitted, true);
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
    assert.equal((await repository.getRun('run-a', 'tenant-a'))?.state, 'RUNNING');

    // Reclaim is not an authorization authority and emits no executable compensation work.
    assert.equal((await repository.claimOutboxByTopic('commander.compensation', 10)).length, 0);

    const messages = await repository.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10);
    assert.equal(messages.length, 0);
    const events = await repository.listEvents('run-a', 'tenant-a');
    assert.equal(
      events.some((event) => event.type === 'compensation.authorization_required'),
      true,
    );
  });
});
