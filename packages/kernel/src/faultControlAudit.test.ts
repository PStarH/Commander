import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';

describe('fault-control audit persistence', () => {
  it('appends an immutable fault-control event to the campaign event stream', async () => {
    const repository = new InMemoryKernelRepository();

    await repository.appendFaultControlAudit({
      tenantId: 'tenant-a',
      runId: 'campaign-a',
      effectId: 'effect-a',
      type: 'fault_control.accepted',
      actor: 'adapter-ops-fault-control',
      payload: { capabilityJti: 'jti-a', destinationHash: 'a'.repeat(64) },
    });

    const events = await repository.listEvents('campaign-a', 'tenant-a');
    assert.deepEqual(
      events.map((event) => ({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        type: event.type,
        actor: event.actor,
        payload: event.payload,
      })),
      [
        {
          aggregateType: 'fault-control',
          aggregateId: 'campaign-a:effect-a',
          type: 'fault_control.accepted',
          actor: 'adapter-ops-fault-control',
          payload: { capabilityJti: 'jti-a', destinationHash: 'a'.repeat(64) },
        },
      ],
    );
  });
});
