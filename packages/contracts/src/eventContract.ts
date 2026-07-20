import type { AggregateType } from './events.js';
import { EVENT_CONTRACT_VERSION, type VersionedContract } from './versioned.js';

export { EVENT_CONTRACT_VERSION };

export interface EventPayloadV2 {
  eventId: string;
  aggregateType: AggregateType;
  aggregateId: string;
  sequence: number;
  type: string;
  tenantId: string;
  runId: string;
  stepId?: string;
  causationId?: string;
  correlationId?: string;
  actor: string;
  schemaVersion: typeof EVENT_CONTRACT_VERSION;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export type EventContractV2 = VersionedContract<'event', typeof EVENT_CONTRACT_VERSION, EventPayloadV2>;

export function wrapEventV2(payload: EventPayloadV2): EventContractV2 {
  return { kind: 'event', schemaVersion: EVENT_CONTRACT_VERSION, payload };
}
