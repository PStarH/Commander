# Architecture Boundary Finding — Dual PEP + EffectBroker health honesty

Date: 2026-07-20  
Auditor: Architecture Boundary Auditor  
Severity: High (systemic strangler debt) + Medium (claim honesty — fixed here)

## Fixed in this change (small, isolated)

**Violation:** Gateway `/ready` and `/v1/health` probed
`@commander/core/security/effectBroker.getEffectBroker()`, which is a process-local
registry with **zero** production `setEffectBroker` call sites. Null was mapped to
`fail`, so healthy API nodes permanently reported `effectBroker: fail`.

**Why it existed:** WS3 honesty work added a real probe, but the wrong dependency
was chosen (API-local stub vs worker-plane broker). Soft-gating prevented outage,
but still painted a permanent red that operators cannot clear without a fake stub.

**Fix:** `probeEffectBroker(null) → unknown` (WS3 §6.2). Tests + module header
updated. Does **not** wire a fake green broker.

## Residual high-value boundary — Dual Policy Enforcement Points

### Intended architecture (ADR 005)

> EffectBroker is the **only** authorized path for external side effects.

### Actual architecture (strangler)

| Plane | PEP | Ledger | Capability model | Live path |
| --- | --- | --- | --- | --- |
| V1 local / CLI / in-process AgentRuntime | `SideEffectGate` → ATR `scheduleAction` + PolicyHook | ATR RunLedger (SQLite) | RunHandle | `ToolExecutionService` |
| V2 worker plane | `@commander/effect-broker` `EffectBroker.execute` | kernel effect tables + outbox | Capability token + workload binding + lease fencing | `toolStepExecutor` / `connectorStepExecutor` / LLM bridge |
| Gateway health | core `getEffectBroker()` stub | n/a | n/a | **never set** |

Additionally, name collision: `packages/core/src/security/effectBroker.ts`
exports interface `EffectBroker` + get/set, while `packages/effect-broker`
exports the real class. Callers reading `getEffectBroker` from core are not
talking to the worker monopoly.

### Why this dual design exists

Deliberate strangler: WS2 closed soft bypass on SideEffectGate and built worker
monopoly tests (L3-03a/b), but did not yet redirect every AgentRuntime tool /
provider fetch through the broker. Header in `sideEffectGate.ts` states:

> Full convergence to delegate through the unified EffectBroker.admit/execute
> is deferred to the StepExecutor redirect phase.

### Systemic risks if left unowned

1. **Policy drift:** two PDPs (ATR PolicyHook vs broker PolicyEvaluator) can
   disagree on the same tool name.
2. **Audit split:** ATR ledger vs kernel effect ledger — incomplete enterprise
   evidence bundles for V1-path effects.
3. **False ops signals:** (addressed) health keys named `effectBroker` that do
   not measure the real monopoly.
4. **Local-only bypass surface:** `mustRouteExternalEffectThroughBroker` + catalog
   `localOnly` must stay fail-closed in production (already tested) — any new
   tool path that skips both PEPs is a security regression.

### Recommended strategic work (do NOT implement as drive-by)

Owner: WS2 / effect monopoly completion (strategic engineering agents).

1. Rename core registry to `LocalEffectBrokerHandle` (or delete) to kill name
   collision with `@commander/effect-broker`.
2. Make AgentRuntime / provider fetch paths go through worker StepExecutors only
   on enterprise profile (no in-process external egress).
3. Unify policy snapshot IDs so V1 SideEffectGate decisions are either:
   - delegated to the same PDP as the broker, or
   - hard-disabled when `COMMANDER_V2_MODE=1` / enterprise profile.
4. Gateway readiness: if effect monopoly is required for a deployment profile,
   probe **worker liveness / effect admission** (real dependency), not the
   unused core registry.
5. Keep L3-03a/b monopoly tests green; never raise localOnly surface in prod.

### Out of scope for Architecture Boundary Auditor PRs

Merging PEPs is a major redesign. This change only restores health claim honesty
and documents the dual-PEP residual for strategic agents.
