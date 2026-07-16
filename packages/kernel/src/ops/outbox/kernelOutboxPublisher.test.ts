import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '../../testing/inMemoryRepository.js';
import { InMemoryOutboxDeliveryPort } from './inMemoryOutboxDeliveryPort.js';
import { KernelOutboxPublisher } from './kernelOutboxPublisher.js';

describe('kernel outbox publisher', () => {
  it('acknowledges source only after durable publication', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.createRun({
      id: 'run-a', tenantId: 'tenant-a', intentHash: 'intent', workGraphHash: 'graph',
      workGraphVersion: 'v1', policySnapshotId: 'policy', steps: [{ id: 'step-a', kind: 'agent' }],
    }, 'gateway');
    const delivery = new InMemoryOutboxDeliveryPort();
    const publisher = new KernelOutboxPublisher(repository, delivery);

    assert.deepEqual(await publisher.publish(10), {
      published: 1, duplicates: 0, retried: 0, failed: 0,
    });
    assert.deepEqual(await repository.claimOutbox(10), []);
    const claimed = await delivery.claim('ws2', 10);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.tenantId, 'tenant-a');
  });

  it('retries the source when durable publication fails', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.createRun({
      id: 'run-a', tenantId: 'tenant-a', intentHash: 'intent', workGraphHash: 'graph',
      workGraphVersion: 'v1', policySnapshotId: 'policy', steps: [{ id: 'step-a', kind: 'agent' }],
    }, 'gateway');
    const publisher = new KernelOutboxPublisher(repository, {
      publish: async () => { throw new Error('delivery unavailable'); },
      claim: async () => [], acknowledge: async () => false, retry: async () => false,
    });

    assert.deepEqual(await publisher.publish(10), {
      published: 0, duplicates: 0, retried: 1, failed: 0,
    });
  });
});
