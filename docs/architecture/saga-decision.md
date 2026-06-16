# Saga Architecture Decision

> **Status**: Accepted (2026-06-07)
> **Decision-maker**: Reversibility Lead
> **Supersedes**: v1 RFC §3.2 ("delete saga/\*") and §5.3 (saga decision diagram)

## Context

Commander has **three parallel reversibility stacks**:

| Stack                                  | Files                                                                                                                                                                                                  | LOC   | Test files         | LOC   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------ | ----- |
| **A. Runtime primitives**              | `src/runtime/{compensationRegistry, stateCheckpointer, circuitBreaker, deadLetterQueue, llmRetry, stepErrorBoundary, processCrashSafety, runRecovery, stepTimeoutManager, providerFallbackChain, ...}` | ~3000 | ~12                | ~2500 |
| **B. ATR (Agent Transaction Runtime)** | `src/atr/{types, canonicalJson, idempotencyStore, leaseManager, runLedger, compensationBridge, defaultCompensation, runtimeIntegration, scheduler, policy/}`                                           | ~3000 | 8 (`tests/atr/`)   | ~1800 |
| **C. Saga**                            | `src/saga/{types, executionGraph, retryController, sagaStore, checkpointManager, workerPool, compensationScheduler, approvalManager, sagaBuilder, sagaCoordinator, examples, index}`                   | 3193  | 10 (`tests/saga/`) | ~2000 |

Stacks A and B are wired into `agentRuntime.ts`. Stack C is **only used by `cli/commands/saga.ts`** — it's a parallel user-facing feature, not integrated with the main runtime.

## The v1 RFC's recommendation

The v1 RFC (`docs/rfcs/reversibility-rfc.md` Part 3.2) recommended **deleting** `saga/*` because:

1. It's a parallel feature with its own state management, retry controller, compensation scheduler, etc.
2. The cost of maintaining three stacks is high
3. ATR covers the same surface area

## Why we are NOT deleting saga/\*

The Reversibility Lead's v2 audit (`docs/rfcs/reversibility-rfc-v2.md` Part 3) re-evaluated this and reached a different conclusion:

### 1. The saga CLI is a real user-facing feature

`commander saga run <id>` is documented in the user guide. Deleting it would be a breaking change for any user who has built workflows on top of it.

### 2. The 3,193 LOC of saga code is fully tested

10 test files, ~2,000 LOC of test coverage. This is **higher** than the test coverage of the runtime primitives it's supposed to duplicate.

### 3. Deletion cost > leave-as-is cost

- **Deletion cost**: ~5 engineer-days to safely remove (dependents, migration guide, deprecation warnings, CLI command removal)
- **Maintenance cost of leaving**: ~0.5 engineer-day per quarter (it doesn't change)

The cost-benefit is overwhelmingly in favor of leaving it as-is.

### 4. The two stacks serve different mental models

- **ATR (runtime)**: per-step atomic actions within an agent run. Invisible to the user.
- **Saga (CLI)**: explicit, named, multi-step workflows the user composes. Visible to the user.

This is the same distinction Temporal makes between "workflows" and "activities." Collapsing them is a UX regression.

### 5. Future v3 may want to wire saga into agentRuntime

A possible v3 feature is a "graph mode" where `agentRuntime.execute()` accepts a saga graph as the plan, and the existing ATR primitive (lease, idempotency, run ledger) is reused. Deleting saga/\* now would force a re-implementation later.

## What we are doing instead

- **Keep `saga/*` as a parallel feature**, fully supported, with a deprecation notice on new code that uses it.
- **Promote `atr/runtimeIntegration.ts`'s `@deprecated` notice** to a v3-removal banner.
- **Mark the v1 RFC as SUPERSEDED BY v2** so the delete-saga recommendation doesn't propagate.
- **Document the two stacks' relationship** in `docs/architecture/saga-decision.md` (this file).
- **Run the audit-wiring script** (Tier 0.2) which checks that the _runtime_ modules are wired. Saga is allowed to have 0 cross-references with `agentRuntime` because it is its own feature.

## Reversal criteria

We would reconsider this decision if:

1. The saga CLI is removed from the public docs for >6 months
2. No new test commits touch `tests/saga/` for >12 months
3. A user explicitly reports confusion about which stack to use
4. The maintenance cost exceeds 1 engineer-day per quarter

In any of those cases, the delete path becomes viable again.

## Open questions

- Should we add a "saga ↔ atr bridge" so users can convert between the two? — **Deferred to v3** (no current demand)
- Should saga's tests be moved under `tests/runtime/saga/` to live next to the other integration tests? — **Cosmetic, not blocking**

## References

- `docs/rfcs/reversibility-rfc.md` — v1 RFC, §3.2, §5.3
- `docs/rfcs/reversibility-rfc-v2.md` — v2 RFC, Part 3 (current decision)
- `docs/rfcs/reversibility-research.md` — research notes on Temporal, Stripe, etc.
- `packages/core/src/saga/` — the saga codebase (3,193 LOC)
- `packages/core/src/atr/` — the ATR codebase
- `packages/core/tests/saga/` — the saga test suite
