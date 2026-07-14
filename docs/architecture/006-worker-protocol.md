# ADR 006: Worker Protocol

## Status

Approved

## Context

Executing agents and tools inside the API process couples scaling, fault domains, and security. A separate worker plane is required.

## Decision

Workers are independent processes that claim work from the kernel via a lease-based protocol.

### Worker Lifecycle

1. **Register**: worker presents identity and capabilities.
2. **Heartbeat**: worker proves liveness within `leaseTtlMs`.
3. **Claim**: worker requests the next available step matching its capabilities and tenant scope.
4. **Execute**: worker performs the step, admitting effects through the broker.
5. **Complete/Fail**: worker reports terminal state with lease and expected version.

### Rules

1. Workers are stateless with respect to run ownership; any worker can resume a reclaimed step.
2. A worker cannot claim work outside its declared capabilities or tenant scope.
3. Gateway scaling must not affect run ownership or recovery.
4. Workers must not write run state directly; all state changes go through the kernel API.
5. Execution isolation: sandbox/container/WASM preferred; subprocess must use seccomp/cgroup/network policy.

## Consequences

- Gateway and workers scale independently.
- Worker crashes do not lose runs.
- Tenant fairness and resource limits are enforced at the kernel before claim.
