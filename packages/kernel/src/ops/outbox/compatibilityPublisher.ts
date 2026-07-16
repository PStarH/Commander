import type { KernelRepository } from '../../repository.js';

export interface EventPublisher {
  publish(message: {
    topic: string;
    key: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/** Compatibility surface for existing publisher consumers during the package merge. */
export class OutboxPublisher {
  constructor(
    private readonly outbox: KernelRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async publishOnce(limit = 100): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;
    for (const message of await this.outbox.claimOutbox(limit)) {
      if (!message.claimToken) {
        failed++;
        continue;
      }
      try {
        await this.publisher.publish({
          topic: message.topic,
          key: message.key,
          payload: message.payload,
        });
        await this.outbox.markOutboxPublished(message.id, message.claimToken)
          ? published++
          : failed++;
      } catch (error) {
        if (typeof this.outbox.retryOutbox === 'function') {
          await this.outbox.retryOutbox(message.id, message.claimToken, {
            code: 'DELIVERY_PUBLISH_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        failed++;
      }
    }
    return { published, failed };
  }
}
