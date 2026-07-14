# ADR 002: Run/Step State Machine

## Status

Approved

## Context

The legacy system uses lowercase step states (`pending`, `executing`, `verifying`, `committed`) while the kernel uses uppercase run states (`PENDING`, `RUNNING`, `SUCCEEDED`). This inconsistency creates mapping bugs and makes contract tests fragile.

## Decision

Use a single canonical state machine defined in `packages/contracts`.

### Run States

`PENDING` → `RUNNING` → (`SUCCEEDED` | `FAILED` | `CANCELLED`)
`PENDING` → `PAUSED` → `RUNNING` → ...
`RUNNING` → `PAUSED` → `RUNNING` → ...
`RUNNING` → `COMPENSATING` → (`COMPENSATED` | `FAILED`)

### Step States

`PENDING` → `RUNNING` → (`SUCCEEDED` | `FAILED` | `CANCELLED` | `SKIPPED`)
`RUNNING` → `WAITING_FOR_HUMAN` → `RUNNING`
`RUNNING` → `RETRY_WAIT` → `RUNNING`

### Rules

1. All public APIs and SDKs use the exact state strings from `packages/contracts`.
2. State transitions are validated by pure functions in `packages/contracts`.
3. Terminal states (`SUCCEEDED`, `FAILED`, `CANCELLED`, `COMPENSATED` for runs; `SUCCEEDED`, `FAILED`, `CANCELLED`, `SKIPPED` for steps) cannot transition to another state.
4. Legacy lowercase states are deprecated and must be removed during WP7.

## Consequences

- Consistent state handling across gateway, kernel, worker, and SDK.
- Invalid transitions are rejected at the contract boundary before reaching storage.
- Existing SDK consumers must migrate to uppercase states.
