import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import { KERNEL_COMPENSATION_TOPIC } from '@commander/kernel';
import { CompensationDaemon, reverseCompensationEffectIds } from './compensationDaemon.js';

const COMP_PAYLOAD = {
  type: 'kernel.compensation.requested',
  tenantId: 'tenant-a',
  runId: 'run-cmp',
  stepId: 'step-cmp',
  compensationAction: 'compensate.github.pull-request.create',
  compensationPayload: { originalEffectId: 'effect-1', forwardResponse: { prNumber: 1 } },
  idempotencyKey: 'cmp:effect-1:1.0.0',
};

describe('CompensationDaemon', () => {
  it('reverseCompensationEffectIds processes latest effect first', () => {
    assert.deepEqual(reverseCompensationEffectIds(['a', 'b', 'c']), ['c', 'b', 'a']);
  });

  it('succeeds once when adapter is registered (single claim path)', async () => {
    const kernel = new InMemoryKernelRepository();
    kernel.seedOutboxMessage({
      topic: KERNEL_COMPENSATION_TOPIC,
      tenantId: 'tenant-a',
      key: 'tenant-a/run-cmp/effect-1',
      payload: COMP_PAYLOAD,
    });
    const daemon = new CompensationDaemon({
      repository: kernel,
      registry: {
        resolve: (action) => (action === 'compensate.github.pull-request.create' ? {} : null),
        outcomeQuerierFor: () => null,
        listDescriptors: () => [],
      } as never,
      broker: {
        admit: async () => ({ admitted: true, effectId: 'eff', replayed: false }),
        executeAdmitted: async () => ({ effectId: 'eff', replayed: false, response: {} }),
      },
      tokenProvider: async () => 'token',
      pollIntervalMs: 60_000,
      batchSize: 10,
    });
    const result = await daemon.tick();
    assert.equal(result.consumed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
  });

  it('retries unregistered adapter messages instead of starving them', async () => {
    const kernel = new InMemoryKernelRepository();
    const seeded = kernel.seedOutboxMessage({
      topic: KERNEL_COMPENSATION_TOPIC,
      tenantId: 'tenant-a',
      key: 'tenant-a/run-cmp/effect-1',
      payload: COMP_PAYLOAD,
    });
    const daemon = new CompensationDaemon({
      repository: kernel,
      registry: { resolve: () => null, outcomeQuerierFor: () => null, listDescriptors: () => [] } as never,
      broker: {
        admit: async () => ({ admitted: true, effectId: 'eff', replayed: false }),
        executeAdmitted: async () => ({ effectId: 'eff', replayed: false, response: {} }),
      },
      tokenProvider: async () => 'token',
      pollIntervalMs: 60_000,
      batchSize: 10,
    });
    const result = await daemon.tick();
    assert.equal(result.consumed, 1);
    assert.equal(result.succeeded, 0);
    assert.ok(result.failed >= 1);
    const reclaimed = await kernel.claimOutboxByTopic(
      KERNEL_COMPENSATION_TOPIC,
      10,
      new Date(Date.now() + 120_000),
    );
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.id, seeded.id);
  });

  it('returns zero counts when consumeCompensationBatch rejects', async () => {
    const kernel = new InMemoryKernelRepository();
    const daemon = new CompensationDaemon({
      repository: {
        ...kernel,
        claimOutboxByTopic: async () => {
          throw new Error('db unavailable');
        },
      } as never,
      registry: { resolve: () => null, outcomeQuerierFor: () => null, listDescriptors: () => [] } as never,
      broker: {
        admit: async () => ({ admitted: true, effectId: 'eff', replayed: false }),
        executeAdmitted: async () => ({ effectId: 'eff', replayed: false, response: {} }),
      },
      tokenProvider: async () => 'token',
      pollIntervalMs: 60_000,
      batchSize: 10,
    });
    const result = await daemon.tick();
    assert.deepEqual(result, { consumed: 0, succeeded: 0, failed: 0 });
  });
});
