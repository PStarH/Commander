/**
 * Canonical event envelope for Architecture V2.
 *
 * Every domain event persisted by the kernel or emitted by the outbox carries
 * this envelope. It is intentionally independent of transport serialization.
 */

export type AggregateType = 'run' | 'step' | 'effect' | 'interaction' | 'worker';

export interface KernelEvent {
  eventId: string;
  aggregateType: AggregateType;
  aggregateId: string;
  sequence: number;
  type: string;
  /** Authorization scope. Named `tenantId` per ADR 007. */
  tenantId: string;
  /** Stable identifier of the run that produced this event. */
  runId: string;
  stepId?: string;
  /** Identifier of the command/event that caused this event. */
  causationId?: string;
  /** Identifier of the end-to-end request/run correlation. */
  correlationId?: string;
  /** Identity that triggered the event (worker, gateway, user, kernel). */
  actor: string;
  /** Version of the event schema; bumped on breaking envelope changes. */
  schemaVersion: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}
