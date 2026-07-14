# ADR 007: Event Semantics

## Status

Approved

## Context

Events are used for audit, recovery, outbox fan-out, and downstream analytics. Without a stable envelope, consumers cannot reconstruct history or guarantee ordering.

## Decision

All domain events carry a canonical envelope and are persisted in the kernel event store.

### Envelope Fields

- `eventId`: unique identifier
- `aggregateType`: `run` | `step` | `effect` | `interaction` | `worker`
- `aggregateId`: the affected aggregate
- `sequence`: monotonic sequence within the aggregate
- `type`: semantic event type (e.g., `run.paused`, `step.succeeded`)
- `tenantId`: authorization scope
- `runId`: the run this event belongs to
- `stepId`: optional step scope
- `causationId`: id of the command/event that caused this event
- `correlationId`: end-to-end request/run correlation
- `actor`: identity that triggered the event
- `schemaVersion`: envelope schema version
- `payload`: event-specific data
- `occurredAt`: ISO 8601 timestamp

### Rules

1. Events are append-only and immutable.
2. Sequence numbers are monotonic per aggregate.
3. The event store is the source of truth for replay and audit.
4. Outbox entries are derived from events; published flag tracks delivery.
5. Consumers must tolerate at-least-once delivery and idempotent handling.

## Consequences

- Reproducible run history.
- Downstream consumers can subscribe to specific event topics.
- Replay after failover yields the same terminal state.
