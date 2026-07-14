# ADR 004: Identity and Capability

## Status

Approved

## Context

Long-lived API keys and implicit trust between components create blast radius. A leaked key or compromised worker can access arbitrary resources.

## Decision

Adopt workload identity with short-lived, scoped capability tokens.

### Model

- **Principal**: human or service identity authenticated via IdP/API key.
- **Workload Identity**: identity assigned to a running worker/process.
- **Capability Token**: short-lived, signed token granting specific actions on specific resources.

### Rules

1. Tenant context must come from verified identity claims, never from an unauthenticated header or path parameter.
2. Kernel write operations require a valid run lease + capability token + policy decision.
3. Capability tokens are scoped to `(tenantId, runId, stepId, action, expiry)`.
4. Workers authenticate via mTLS or signed registration; heartbeats keep identity live.
5. Third-party plugins run with strictly less privilege than the host system.

## Consequences

- Stolen long-lived keys have limited value.
- Compromised workers can only affect their leased steps.
- Cross-tenant access is rejected at the identity boundary.
