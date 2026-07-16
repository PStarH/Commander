export interface OutboxEnvelope {
  eventId: string;
  schemaVersion: 1;
  tenantId: string;
  topic: string;
  key: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface ClaimedOutboxDelivery extends OutboxEnvelope {
  deliveryId: string;
  claimToken: string;
  attempts: number;
  availableAt: string;
}

export interface OutboxDeliveryError {
  code: string;
  message: string;
}

export interface OutboxDeliveryPort {
  publish(envelope: OutboxEnvelope): Promise<{ deliveryId: string; duplicate: boolean }>;
  claim(consumerId: string, limit: number, now?: Date): Promise<ClaimedOutboxDelivery[]>;
  acknowledge(deliveryId: string, claimToken: string): Promise<boolean>;
  retry(deliveryId: string, claimToken: string, error: OutboxDeliveryError, now?: Date): Promise<boolean>;
}

export interface OutboxDeliveryOptions {
  claimTtlMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_OUTBOX_DELIVERY_OPTIONS: OutboxDeliveryOptions = {
  claimTtlMs: 60_000,
  maxAttempts: 10,
  baseBackoffMs: 1_000,
  maxBackoffMs: 300_000,
};
