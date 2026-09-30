import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '../../testing/inMemoryRepository.js';
import { InMemoryOutboxDeliveryPort } from './inMemoryOutboxDeliveryPort.js';
import { KernelOutboxPublisher } from './kernelOutboxPublisher.js';

describe('kernel outbox publisher', () => {
  it('acknowledges source only after durable publication', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.createRun(
      {
        id: 'run-a',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [{ id: 'step-a', kind: 'agent' }],
      },
      'gateway',
    );
    const delivery = new InMemoryOutboxDeliveryPort();
    const publisher = new KernelOutboxPublisher(repository, delivery);

    assert.deepEqual(await publisher.publish(10), {
      published: 1,
      duplicates: 0,
      retried: 0,
      failed: 0,
    });
    assert.deepEqual(await repository.claimOutbox(10), []);
    const claimed = await delivery.claim('ws2', 10);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.tenantId, 'tenant-a');
  });

  it('retries the source when durable publication fails', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.createRun(
      {
        id: 'run-a',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [{ id: 'step-a', kind: 'agent' }],
      },
      'gateway',
    );
    // F-K1-24: assert the source row is genuinely retried, not merely counted.
    // The first publication fails; the row must stay unpublished so a later
    // attempt can publish it. A publisher that counted a retry without retrying
    // would leave the row claimed and the second publish would return 0.
    let failNext = true;
    const delivered: string[] = [];
    const publisher = new KernelOutboxPublisher(repository, {
      publish: async (envelope) => {
        if (failNext) {
          failNext = false;
          throw new Error('delivery unavailable');
        }
        delivered.push(envelope.eventId);
        return { deliveryId: `delivery-${envelope.eventId}`, duplicate: false };
      },
      claim: async () => [],
      acknowledge: async () => false,
      retry: async () => false,
    });

    const failedAt = new Date();
    assert.deepEqual(await publisher.publish(10, failedAt), {
      published: 0,
      duplicates: 0,
      retried: 1,
      failed: 0,
    });
    assert.deepEqual(delivered, [], 'a failed publication must not be delivered');

    // Past the retry backoff (retryOutbox schedules at now + 2^(attempts-1)s and
    // releases the 60s claim) the same row must be claimable and publish.
    const second = await publisher.publish(10, new Date(failedAt.getTime() + 1_500));
    assert.deepEqual(second, { published: 1, duplicates: 0, retried: 0, failed: 0 });
    assert.equal(delivered.length, 1, 'the retried source row must be published exactly once');
    assert.deepEqual(
      await repository.claimOutbox(10, new Date(failedAt.getTime() + 200_000)),
      [],
      'the successful publication must have acknowledged the source row',
    );
  });
});
