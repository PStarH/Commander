# ADR 005: Policy and Effect Broker

## Status

Approved

## Context

Tools, connectors, and model calls can produce irreversible external side effects. Without a central gate, any component can trigger unapproved actions.

## Decision

The `EffectBroker` is the only authorized path for external side effects. Policy decisions are evaluated by a PDP and enforced by a PEP at the broker.

### Model

- **Policy Bundle**: versioned, signed set of rules and effect defaults.
- **Policy Decision Point (PDP)**: evaluates request against policy bundle.
- **Policy Enforcement Point (PEP)**: applies the decision at the broker.
- **Effect**: a single intended external side effect with idempotency key, policy decision, and audit context.

### Rules

1. No external write may execute without a policy decision id recorded in the kernel effect ledger.
2. Policy snapshot is pinned when a run starts; updates do not retroactively change in-flight runs.
3. Irreversible effects require explicit approval recorded in the audit trail.
4. Effect requests include run lease, capability token, idempotency key, and actor.
5. Plugins cannot invoke external APIs directly; they must request an effect through the broker.

## Consequences

- All external side effects are auditable and revocable where possible.
- Policy changes cannot silently bypass in-flight runs.
- Plugin isolation is enforced because plugins cannot hold raw capability tokens.
