# ADR 003: Persistence and Event Sourcing

## Status

Approved

## Context

Production deployments previously relied on SQLite, local WAL files, and in-process `Map` objects. These are not shared across replicas and lose data on process loss.

## Decision

**Target (Enterprise Gateway):** production authority is a shared transactional PostgreSQL database. Object storage holds large payloads. Event sourcing provides auditability and recovery.

**Today:** `/v1` kernel uses Postgres when enabled; object-storage-as-payload-store and full event-sourced reconstruction are **not fully shipped**. Local CLI still uses SQLite/local WAL.

### Storage Responsibilities

- **PostgreSQL**: run/step aggregates, leases, idempotency keys, timers, interactions, policy decisions, transactional outbox.
- **Object Storage**: large event payloads, prompts/responses, artifacts, checkpoint snapshots, evaluation evidence.
- **Event Bus**: outbox delivery and fan-out only; not the source of truth.

### Rules

1. Every write to a run or step uses `(run_id, fencing_epoch, expected_version)` conditional update.
2. Local files, SQLite, and `Map` are permitted only in local-dev/test modes.
3. Production configuration must fail closed if PostgreSQL or object storage is unavailable; no silent fallback.
4. Recovery is performed by the scheduler/kernel replaying events, not by restoring API process state.
5. Outbox pattern guarantees at-least-once event delivery.

## Consequences

- Multi-replica deployments share a single source of truth.
- Worker crashes can be recovered by lease expiration and replay.
- Local-dev mode must be explicitly enabled and must not be selectable in production builds.
