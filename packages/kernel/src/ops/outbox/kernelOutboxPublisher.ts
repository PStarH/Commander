import type { KernelRepository } from '../../repository.js';
import type { KernelOutboxMessage } from '../../types.js';
import type { OutboxDeliveryError, OutboxDeliveryPort, OutboxEnvelope } from './types.js';

export interface KernelOutboxPublishResult {
  published: number;
  duplicates: number;
  retried: number;
  failed: number;
}

const toEnvelope = (message: KernelOutboxMessage): OutboxEnvelope => ({
  eventId: message.eventId,
  schemaVersion: 1,
  tenantId: message.tenantId,
  topic: message.topic,
  key: message.key,
  occurredAt: message.createdAt,
  payload: structuredClone(message.payload),
});

const normalizeError = (error: unknown): OutboxDeliveryError => ({
  code: 'DELIVERY_PUBLISH_FAILED',
  message: error instanceof Error ? error.message : String(error),
});

export class KernelOutboxPublisher {
  constructor(
    private readonly repository: KernelRepository,
    private readonly delivery: OutboxDeliveryPort,
  ) {}

  async publish(limit = 100, now = new Date()): Promise<KernelOutboxPublishResult> {
    const result: KernelOutboxPublishResult = {
      published: 0, duplicates: 0, retried: 0, failed: 0,
    };
    for (const source of await this.repository.claimOutbox(limit, now)) {
      if (!source.claimToken) {
        result.failed++;
        continue;
      }
      try {
        const delivery = await this.delivery.publish(toEnvelope(source));
        delivery.duplicate ? result.duplicates++ : result.published++;
        if (!await this.repository.markOutboxPublished(source.id, source.claimToken)) result.failed++;
      } catch (error) {
        const retried = await this.repository.retryOutbox(
          source.id, source.claimToken, normalizeError(error), now,
        );
        retried ? result.retried++ : result.failed++;
      }
    }
    return result;
  }
}
