# ADR 004: Identity and Capability

## Status

Approved

## Context

Long-lived API keys and implicit trust between components create blast radius. A leaked key or compromised worker can access arbitrary resources.

## Decision

Adopt workload identity with short-lived, scoped capability tokens.

**Today:** tenant context is bound from verified identity claims
(`jwtMiddleware`, `tenantContextMiddleware`), and kernel step writes require a
run lease (`packages/kernel/src/types.ts:247-266`); capability tokens are
additionally required at effect admission
(`packages/effect-broker/src/index.ts`). Workers register with a bearer token
(`COMMANDER_WORKER_AUTH_TOKEN`) plus a subject claim
(`packages/worker-plane/src/bootstrap.ts:251-253`); mTLS worker registration is
**not yet** implemented — mTLS currently exists only on the optional TLS 1.3
tenant-authority proof listener. Plugin privilege reduction is enforced by
`buildSandboxedLoadContext`.

### Model

- **Principal**: human or service identity authenticated via IdP/API key.
- **Workload Identity**: identity assigned to a running worker/process.
- **Capability Token**: short-lived, signed token granting specific actions on specific resources.

### Rules

1. Tenant context must come from verified identity claims, never from an unauthenticated header or path parameter.
2. Kernel step writes are gated by a valid run lease (worker id, generation, token, fencing epoch); effect admission additionally requires a capability token and a policy decision.
3. Capability tokens are scoped to `(tenantId, runId, stepId, action, expiry)`.
4. Workers authenticate by signed registration with a claim secret (stored hashed) plus worker-generation fencing; heartbeats keep identity live. Worker-side mTLS is not implemented (see the `Today` note above).
5. Third-party plugins run with strictly less privilege than the host system.

## Consequences

- Stolen long-lived keys have limited value.
- Compromised workers can only affect their leased steps.
- Cross-tenant access is rejected at the identity boundary.
