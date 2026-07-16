import { randomUUID } from 'node:crypto';
import {
  DEFAULT_OUTBOX_DELIVERY_OPTIONS,
  type ClaimedOutboxDelivery,
  type OutboxDeliveryError,
  type OutboxDeliveryOptions,
  type OutboxDeliveryPort,
  type OutboxEnvelope,
} from './types.js';

interface DeliveryRecord {
  deliveryId: string;
  envelope: OutboxEnvelope;
  attempts: number;
  availableAt: number;
  consumerId?: string;
  claimToken?: string;
  claimedAt?: number;
  acknowledgedAt?: number;
  lastError?: OutboxDeliveryError;
  movedToDlqAt?: number;
}

export class InMemoryOutboxDeliveryPort implements OutboxDeliveryPort {
  private readonly options: OutboxDeliveryOptions;
  private readonly byEventId = new Map<string, DeliveryRecord>();
  private readonly byDeliveryId = new Map<string, DeliveryRecord>();

  constructor(options: Partial<OutboxDeliveryOptions> = {}) {
    this.options = { ...DEFAULT_OUTBOX_DELIVERY_OPTIONS, ...options };
  }

  async publish(envelope: OutboxEnvelope): Promise<{ deliveryId: string; duplicate: boolean }> {
    const existing = this.byEventId.get(envelope.eventId);
    if (existing) return { deliveryId: existing.deliveryId, duplicate: true };
    const record: DeliveryRecord = {
      deliveryId: randomUUID(),
      envelope: structuredClone(envelope),
      attempts: 0,
      availableAt: Date.parse(envelope.occurredAt),
    };
    this.byEventId.set(envelope.eventId, record);
    this.byDeliveryId.set(record.deliveryId, record);
    return { deliveryId: record.deliveryId, duplicate: false };
  }

  async claim(consumerId: string, limit: number, now = new Date()): Promise<ClaimedOutboxDelivery[]> {
    const at = now.getTime();
    return [...this.byDeliveryId.values()]
      .filter((record) =>
        !record.acknowledgedAt &&
        !record.movedToDlqAt &&
        record.availableAt <= at &&
        (!record.claimedAt || record.claimedAt + this.options.claimTtlMs <= at),
      )
      .sort((a, b) => a.availableAt - b.availableAt)
      .slice(0, limit)
      .map((record) => {
        record.attempts++;
        record.consumerId = consumerId;
        record.claimToken = randomUUID();
        record.claimedAt = at;
        return {
          ...structuredClone(record.envelope),
          deliveryId: record.deliveryId,
          claimToken: record.claimToken,
          attempts: record.attempts,
          availableAt: new Date(record.availableAt).toISOString(),
        };
      });
  }

  async acknowledge(deliveryId: string, claimToken: string): Promise<boolean> {
    const record = this.byDeliveryId.get(deliveryId);
    if (!record || record.acknowledgedAt || record.claimToken !== claimToken) return false;
    record.acknowledgedAt = Date.now();
    record.claimToken = undefined;
    record.claimedAt = undefined;
    return true;
  }

  async retry(deliveryId: string, claimToken: string, error: OutboxDeliveryError, now = new Date()): Promise<boolean> {
    const record = this.byDeliveryId.get(deliveryId);
    if (!record || record.acknowledgedAt || record.claimToken !== claimToken) return false;
    record.lastError = structuredClone(error);
    record.claimToken = undefined;
    record.claimedAt = undefined;
    record.consumerId = undefined;
    if (record.attempts >= this.options.maxAttempts) {
      record.movedToDlqAt = now.getTime();
      return true;
    }
    const backoff = Math.min(
      this.options.baseBackoffMs * 2 ** Math.max(0, record.attempts - 1),
      this.options.maxBackoffMs,
    );
    record.availableAt = now.getTime() + backoff;
    return true;
  }
}
