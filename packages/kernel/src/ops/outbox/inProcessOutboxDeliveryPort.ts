import { randomUUID } from 'node:crypto';
import type {
  ClaimedOutboxDelivery,
  OutboxDeliveryError,
  OutboxDeliveryPort,
  OutboxEnvelope,
} from './types.js';

/** Local sqlite stack: mark outbox published in-process without external delivery. */
export class InProcessOutboxDeliveryPort implements OutboxDeliveryPort {
  private readonly deliveries = new Map<string, OutboxEnvelope>();

  async publish(envelope: OutboxEnvelope): Promise<{ deliveryId: string; duplicate: boolean }> {
    const existing = [...this.deliveries.entries()].find(([, e]) => e.eventId === envelope.eventId);
    if (existing) return { deliveryId: existing[0], duplicate: true };
    const deliveryId = randomUUID();
    this.deliveries.set(deliveryId, envelope);
    return { deliveryId, duplicate: false };
  }

  async claim(_consumerId: string, _limit: number): Promise<ClaimedOutboxDelivery[]> {
    return [];
  }

  async acknowledge(_deliveryId: string, _claimToken: string): Promise<boolean> {
    return true;
  }

  async retry(
    _deliveryId: string,
    _claimToken: string,
    _error: OutboxDeliveryError,
  ): Promise<boolean> {
    return true;
  }
}
