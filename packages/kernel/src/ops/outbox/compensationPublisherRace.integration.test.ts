/**
 * Interleaved publisher (claimOutbox) vs compensation consumer
 * (claimOutboxByTopic) race — proves denylist holds under concurrent ticks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '../../testing/inMemoryRepository.js';
import {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
  LEGACY_COMPENSATION_TOPIC,
} from '../compensationConsumer.js';
import { InMemoryOutboxDeliveryPort } from './inMemoryOutboxDeliveryPort.js';
import { KernelOutboxPublisher } from './kernelOutboxPublisher.js';

describe('compensationPublisherRace', () => {
  it('publisher never steals compensation topics across 100 interleaved rounds', async () => {
    const repository = new InMemoryKernelRepository();
    const delivery = new InMemoryOutboxDeliveryPort();
    const publisher = new KernelOutboxPublisher(repository, delivery);

    await repository.createRun(
      {
        id: 'run-race',
        tenantId: 'tenant-race',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [{ id: 'step-race', kind: 'agent' }],
      },
      'gateway',
    );

    let legacySeeded = 0;
    for (let i = 0; i < 40; i++) {
      repository.seedOutboxMessage({
        topic: KERNEL_COMPENSATION_TOPIC,
        tenantId: 'tenant-race',
        key: `tenant-race/run-race/cmp-${i}`,
        payload: {
          type: 'kernel.compensation.requested',
          tenantId: 'tenant-race',
          runId: 'run-race',
          stepId: 'step-race',
          compensationAction: 'compensate.github.pull-request.create',
          compensationPayload: {
            originalEffectId: `effect-${i}`,
            forwardResponse: { prNumber: i },
            destination: 'github://octo/repo/pulls',
          },
          idempotencyKey: `cmp:effect-${i}:1.0.0`,
        },
      });
      if (i % 3 === 0) {
        repository.seedOutboxMessage({
          topic: LEGACY_COMPENSATION_TOPIC,
          tenantId: 'tenant-race',
          key: `tenant-race/run-race/legacy-${i}`,
          payload: { type: 'compensation.requested', tenantId: 'tenant-race' },
        });
        legacySeeded++;
      }
    }

    // Noise rows for the generic publisher path.
    for (let i = 0; i < 20; i++) {
      repository.seedOutboxMessage({
        topic: 'kernel.effect.completed',
        tenantId: 'tenant-race',
        key: `tenant-race/run-race/noise-${i}`,
        payload: { type: 'kernel.effect.completed', effectId: `noise-${i}` },
      });
    }

    const deliveredCompensationTopics: string[] = [];
    for (let round = 0; round < 100; round++) {
      const [pub] = await Promise.all([
        publisher.publish(5),
        consumeCompensationBatch(
          repository,
          {
            admit: async () => ({ admitted: true, effectId: `eff-${round}`, replayed: false }),
            executeAdmitted: async () => ({
              effectId: `eff-${round}`,
              replayed: false,
              response: { ok: true },
            }),
          },
          async () => 'race-token',
          { workerId: 'race-consumer', limit: 5, topic: KERNEL_COMPENSATION_TOPIC },
        ),
      ]);
      assert.ok(pub.published + pub.duplicates + pub.retried + pub.failed >= 0);
    }

    const claimed = await delivery.claim('ws2', 500);
    for (const msg of claimed) {
      if (
        msg.topic === KERNEL_COMPENSATION_TOPIC ||
        msg.topic === LEGACY_COMPENSATION_TOPIC
      ) {
        deliveredCompensationTopics.push(msg.topic);
      }
    }
    assert.deepEqual(
      deliveredCompensationTopics,
      [],
      'kernel-ops publisher must not deliver compensation topics under interleaved load',
    );

    // Legacy is never claimed by KERNEL topic consumer; publisher denylist keeps it out of WS2.
    const remainingLegacy = await repository.claimOutboxByTopic(LEGACY_COMPENSATION_TOPIC, 100);
    assert.equal(remainingLegacy.length, legacySeeded);
    assert.equal(
      (await repository.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 100)).length,
      0,
      'all kernel compensation rows should be consumed or claimed-through by consumer',
    );
  });
});

