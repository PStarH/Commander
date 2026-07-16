import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryOutboxDeliveryPort } from './inMemoryOutboxDeliveryPort.js';
import type { OutboxEnvelope } from './types.js';

const envelope = (eventId: string): OutboxEnvelope => ({
  eventId,
  schemaVersion: 1,
  tenantId: 'tenant-a',
  topic: 'kernel.compensation.requested',
  key: 'tenant-a/run-a/1',
  occurredAt: new Date().toISOString(),
  payload: { runId: 'run-a' },
});

describe('outbox delivery contract', () => {
  it('publishes idempotently and fences acknowledgement', async () => {
    const port = new InMemoryOutboxDeliveryPort();
    const first = await port.publish(envelope('event-1'));
    const duplicate = await port.publish(envelope('event-1'));
    assert.equal(duplicate.deliveryId, first.deliveryId);
    assert.equal(duplicate.duplicate, true);

    const [claimed] = await port.claim('ws2', 1);
    assert.ok(claimed);
    assert.equal(await port.acknowledge(claimed.deliveryId, 'stale'), false);
    assert.equal(await port.acknowledge(claimed.deliveryId, claimed.claimToken), true);
    assert.deepEqual(await port.claim('ws2', 1), []);
  });

  it('retries failures with a new fenced claim', async () => {
    const port = new InMemoryOutboxDeliveryPort({ baseBackoffMs: 1 });
    await port.publish(envelope('event-2'));
    const [first] = await port.claim('ws2', 1);
    assert.ok(first);
    assert.equal(await port.retry(first.deliveryId, first.claimToken, {
      code: 'WS2_FAILED', message: 'transient failure',
    }), true);

    const [second] = await port.claim('ws2', 1, new Date(Date.now() + 10));
    assert.ok(second);
    assert.notEqual(second.claimToken, first.claimToken);
    assert.equal(second.attempts, 2);
  });
});
