# RFC v2: Reversibility — From Built-But-Unwired to Production-Grade

**Author**: Reversibility Lead
**Status**: Active Draft (supersedes v1 of 2026-06-05)
**Date**: 2026-06-07
**Scope**: `packages/core/src/`
**Reviewers**: Runtime Lead, Reliability Lead, Security Lead

---

## Executive Summary

Commander has **~7,000 lines of reversibility infrastructure** across three parallel stacks: the runtime primitives, the **ATR (Agent Transaction Runtime)** settlement kernel, and the orphaned **saga/\* layer**. By raw line count, it is one of the most resilience-rich open-source agent frameworks in existence.

**However, an honest audit reveals the real problem is not absence of components — it is presence of _unwired_ components.** Of the 8 features proposed in v1, **7 are implemented as standalone modules but 7 are NOT called from the agent runtime**. This creates _false confidence_: a future incident will reveal that the safety net has holes the tests never exercised.

| v1 Item                          | Module                                      | Tests              | Wired into `agentRuntime`?      |
| -------------------------------- | ------------------------------------------- | ------------------ | ------------------------------- |
| 1.1 Process crash safety         | `runtime/processCrashSafety.ts` (147 LOC)   | ✅ unit            | ❌ never called                 |
| 1.2 Delete dead code             | `atr/runtimeIntegration.ts` (253 LOC)       | ⚠️ coverage exists | ❌ still present, `@deprecated` |
| 1.3 Run recovery from checkpoint | `runtime/runRecovery.ts` (92 LOC)           | ✅ unit            | ❌ never called                 |
| 2.1 Step timeout                 | `runtime/stepTimeoutManager.ts`             | ✅ unit            | ❌ never imported               |
| 2.2 Sub-agent guard              | `ultimate/subAgentGuard.ts`                 | ✅ unit            | ❌ never imported               |
| 2.3 Provider fallback            | `runtime/providerFallbackChain.ts` (92 LOC) | ✅ unit            | ❌ never imported               |
| 2.4 Compensation retry queue     | **does not exist**                          | —                  | —                               |
| 3.2 Reflexion self-correction    | `memory/reflexionInjector.ts`               | ❌ none            | ❌ never imported               |

**This RFC v2 has one job: close the integration gap.**

The 4-week plan that follows is overwhelmingly **wiring work, not new code**. Every tier produces a single PR that:

1. Imports the existing module into `agentRuntime.ts`
2. Writes an integration test that exercises it end-to-end
3. Removes the same module's `@deprecated` tag (if any) and old code path
4. Updates the chaos test to inject the relevant failure

---

## Part 1: Honest Status — What the Audit Found

I performed the audit on 2026-06-07 by reading 20+ files and grepping for usage. Findings:

### 1.1 Three Independent Reversibility Stacks

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Commander Reversibility Stacks                  │
├──────────────────────────┬──────────────────────────────────────────┤
│ STACK A: Runtime         │ CompensationRegistry (in-memory)          │
│ primitives              │ StateCheckpointer (atomic JSON)          │
│ (runtime/*.ts)          │ CircuitBreaker (Hystrix-style)           │
│                          │ DeadLetterQueue (NDJSON)                 │
│                          │ StepErrorBoundary (per-op recovery)      │
│                          │ processCrashSafety (process handlers)   │
│                          │ runRecovery (checkpoint resume)         │
│                          │ stepTimeoutManager (AbortController)    │
│                          │ providerFallbackChain (sequential fail) │
│                          │ toolResultCache (FNV-1a content hash)   │
├──────────────────────────┼──────────────────────────────────────────┤
│ STACK B: ATR Kernel      │ LeaseManager (process fencing + epoch)  │
│ (atr/*.ts)              │ IdempotencyStore (SQLite, 24h TTL)      │
│                          │ RunLedger (CRUD, saga semantics)        │
│                          │ ExecutionScheduler (state machine)     │
│                          │ CompensationBridge (legacy ↔ ledger)   │
│                          │ defaultCompensation (snapshot undo)    │
│                          │ policy/* (allow/deny/require_approval) │
│                          │ adapters/github (PR compensation)      │
├──────────────────────────┼──────────────────────────────────────────┤
│ STACK C: Saga            │ sagaCoordinator (graph executor)        │
│ (saga/*.ts)             │ sagaBuilder (fluent DSL)                │
│                          │ executionGraph (DAG)                    │
│                          │ compensationScheduler                  │
│                          │ retryController                         │
│                          │ approvalManager (HITL gates)            │
│                          │ checkpointManager (NDJSON)              │
│                          │ sagaStore (persistence)                 │
│                          │ workerPool (8 in-process workers)      │
└──────────────────────────┴──────────────────────────────────────────┘
```

**Stack A is the runtime's per-instance tool layer.**
**Stack B is the durable transaction kernel — wired into `agentRuntime` at 6 call sites (lines 449, 1262, 1349, 1620, 1747, 1816).**
**Stack C is a complete parallel orchestrator — only the CLI command `cli/commands/saga.ts` uses it.**

### 1.2 The "Built-But-Unwired" Anti-Pattern

```
Tier 2.3: ProviderFallbackChain EXISTS (92 LOC, full implementation, 1 test file).
         agentRuntime.execute() at line 1620 calls scheduler.scheduleAction() and
         at the LLM call path calls router.call() DIRECTLY. No fallback chain
         wrapping the call. So if OpenAI is down, the circuit breaker opens
         (slowly, per Hystrix config) and the user gets an error. The fallback
         chain that would skip to Anthropic in milliseconds is sitting in
         /runtime, unused.

Tier 1.1: processCrashSafety EXISTS (147 LOC, full implementation, 1 test file).
         process.on('uncaughtException') is NOT installed anywhere. A single
         uncaught error in any LLM callback or tool execution kills the
         process. All in-flight leases are held until TTL (30s). All
         unflushed DLQ entries are lost.

Tier 1.3: runRecovery EXISTS (92 LOC, full implementation, 1 test file).
         grep "runRecovery\|RunRecovery" packages/core/src/ returns 0 hits
         outside the file itself. No public API exposes it. No CLI command
         uses it. A user whose run crashes has to call checkpointer.resume()
         manually and figure out the lease validation themselves.

Tier 2.1: stepTimeoutManager EXISTS. agentRuntime's LLM call path has
         no timeout. A 30-minute CoT call (rare but documented) would block
         a worker for 30 minutes.

Tier 2.2: subAgentGuard EXISTS. subAgentExecutor.executeAtomicNode does
         NOT consult it. A sub-agent can loop forever (until maxSteps from
         config, not until subAgentGuard's stricter budget).

Tier 3.2: reflexionInjector EXISTS. agentRuntime's verification path does
         NOT call it. Failed verification → run fails, no self-correction.
```

**Every one of these is a false-positive in any reliability test that doesn't go through the full integration path.** A unit test passes, a chaos test on the component passes, but the production path doesn't use the component.

### 1.3 Saga Stack — Still Orphaned

The `saga/*` stack (3,193 LOC) has its own full implementation with:

- DAG execution (parallel/nested/approval nodes)
- Per-step retry with exp backoff + jitter
- Compensation in REVERSE dependency order
- Approval gates with `AbortSignal.timeout`
- NDJSON checkpoint store
- Per-step timeout via `runWithTimeout`

**Wired into**: `cli/commands/saga.ts` only.

**Not wired into**: `agentRuntime.execute()`.

This is the v1 RFC's "Option B: Delete" recommendation. **I do not recommend deletion in v2.** The saga CLI is a real user-facing feature (the user is testing agent workflows via `commander saga` commands). The right move is:

1. Make saga its own first-class feature with a public API
2. Have agentRuntime OPTIONALLY use saga graphs (via `useATR: true` config flag) for users who want explicit graph-based compensation
3. Keep it as-is for now, but document the choice

---

## Part 2: Failure Scenario Matrix — Answering the 4 Questions

The user's mandate requires that every design explicitly answer:

1. What happens if step N fails?
2. What happens if process crashes?
3. What happens if LLM hallucinates?
4. What happens if tool output is wrong?

Below is the 18-mode matrix from v1 RFC, **updated with v2's audit findings** and the 4-questions treatment. Modes marked **🟢** are correctly handled today. Modes marked **🟡** have partial coverage. Modes marked **🔴** have a gap.

### Mode 1: Tool call fails (network, validation, execution)

| Question                            | Answer                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens if step N fails?       | `StepErrorBoundary.execute()` (line 1684) catches → DLQ → `compensationRegistry.compensate` retries in-memory 3 times → success/failure reported                                |
| What if process crashes?            | `stateCheckpointer.checkpoint()` writes a JSON snapshot at every LLM→tool→verify cycle. On restart, `runRecovery.attempt()` can resume (BUT it's not called — see Tier 1.3 gap) |
| What if LLM hallucinates tool call? | `toolCallValidator` + `toolCallRepair` (7 strategies) intercept before execute. Repaired or rejected with structured error fed back to LLM                                      |
| What if tool output is wrong?       | `UnifiedVerificationPipeline` (5 gates) + `hallucinationDetector` (13 signals) flag. No automatic re-prompt — `reflexionInjector` exists but isn't wired (Tier 3.2 gap)         |
| **Status**                          | 🟡 Compensation retry is in-memory only. `compensationQueue.ts` (Tier 2.4) is the missing piece. Reflexion is not wired.                                                        |

### Mode 2: LLM call fails (provider error, timeout)

| Question                      | Answer                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens if step N fails? | `circuitBreaker.onFailure()` + `llmRetry.computeBackoff()` retries 2-3 times. If all retries fail, StepErrorBoundary returns `abort`                                                                 |
| What if process crashes?      | Same as Mode 1 — checkpoint resumes. BUT the LLM call's idempotency key is in `idempotencyStore` (24h TTL). On retry, `scheduleAction` returns the cached failure — does NOT re-attempt the LLM call |
| What if LLM hallucinates?     | Different from "fails" — hallucination is bad output, not error. See Mode 7                                                                                                                          |
| What if tool output is wrong? | n/a — this is LLM call, not tool call                                                                                                                                                                |
| **Status**                    | 🟡 **CRITICAL GAP**: `providerFallbackChain` is not wired. A primary provider outage hits `circuitBreaker` then user-visible error. Should fall back to next provider in <1s.                        |
| **v2 fix**                    | Tier 2.3 wire-up: wrap `router.call()` in `fallbackChain.tryProviders()`                                                                                                                             |

### Mode 3: Sub-agent fails

| Question                                  | Answer                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens if step N fails?             | `subAgentExecutor` catch → `compensateAll` (in-memory 3 retries) + DLQ + scheduler abort                                                                    |
| What if process crashes?                  | `atr/scheduler.abortRun()` runs compensation for uncompensated actions. The sub-agent's own state is in its own RunHandle. Each sub-agent has its own lease |
| What if LLM hallucinates in sub-agent?    | No verifier agent — sub-agent output is trusted. `reflexionInjector` not invoked                                                                            |
| What if sub-agent's tool output is wrong? | `UnifiedVerificationPipeline` runs at the parent level, but does NOT recursively verify sub-agents                                                          |
| **Status**                                | 🟡 `subAgentGuard` (max steps/tokens/cost) is not consulted. A sub-agent can run until the parent's `maxSteps` config. No per-sub-agent budget enforcement. |
| **v2 fix**                                | Tier 2.2 wire-up: instantiate `subAgentGuard` in `subAgentExecutor.executeAtomicNode`, check before each step                                               |

### Mode 4: Process crashes mid-run 🔴

| Question                      | Answer                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What happens if step N fails? | n/a — process is dead                                                                                                                                                                                                                                                                                                                                  |
| What if process crashes?      | **DLQ entries in buffer (10 max per category) are FLUSHED via `flush()` only on category overflow or explicit call. Most recent un-flushed DLQ entries ARE LOST.** StateCheckpointer writes are atomic (write-tmp + rename), so the LAST checkpoint is durable. `processCrashSafety` IS installed (the module exists) but is NOT called from anywhere. |
| What if LLM hallucinates?     | n/a — process is dead                                                                                                                                                                                                                                                                                                                                  |
| What if tool output is wrong? | n/a — process is dead                                                                                                                                                                                                                                                                                                                                  |
| **Status**                    | 🔴 **CRITICAL**. The v1 RFC called this out. The module was written but never `installProcessCrashHandlers(deps)` is called in `agentRuntime.ts` or `httpServer.ts`.                                                                                                                                                                                   |
| **v2 fix**                    | Tier 1.1 wire-up: call `installProcessCrashHandlers({ dlq, leaseManager, activeRunIds, ... })` in `AgentRuntime` constructor and HTTP server startup. Add DLQ auto-flush on every Nth record (currently 10) — reduce to 1 to eliminate the window.                                                                                                     |

### Mode 5: Process crashes mid-tool-call

| Question                      | Answer                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What happens if step N fails? | n/a                                                                                                                                                                                                                                                                                                                                                                                        |
| What if process crashes?      | `idempotencyStore` has the `in_progress` record. On resume, `scheduleAction` calls `idempotency.begin(key)` which sees `state='in_progress'`, attempts reclaim (UPDATE WHERE expires_at <= now), succeeds (assuming TTL elapsed), returns `acquired=true`. New attempt runs.                                                                                                               |
| What if LLM hallucinates?     | n/a                                                                                                                                                                                                                                                                                                                                                                                        |
| What if tool output is wrong? | n/a                                                                                                                                                                                                                                                                                                                                                                                        |
| **Status**                    | 🟢 **STRONG**. Stripe-style reclaim-on-expire is implemented. But `runRecovery` is not called, so users must manually invoke it.                                                                                                                                                                                                                                                           |
| **v2 fix**                    | Tier 1.3 wire-up: expose `runRecovery.attempt()` via `agentRuntime.resume(runId)` (currently `resume()` just calls `checkpointer.resume()` without consulting the ledger). The new flow: 1) `checkpointer.loadCheckpoint()`; 2) `leaseManager.validate()`; 3) `runLedger.listActions()` to populate `completedToolCallIds`; 4) hand off to LLM with that set as the "already-done" prefix. |

### Mode 6: Two processes resume same run

| Question      | Answer                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens? | Process A acquires lease epoch=5. Process B tries to `beginRun(runId)` — sees existing lease, returns `acquired: false, lease: { token, epoch: 5 }`. Process B uses the same lease token. If A crashes and B detects via `heartbeat` failure, B calls `leaseManager.acquire()` which sees expired lease, bumps epoch to 6, returns `acquired: true, reclaimed: true`. A's zombie writes are now fenced. |
| **Status**    | 🟢 **STRONG**. This is the canonical pattern, implemented correctly with SQLite-backed leases.                                                                                                                                                                                                                                                                                                          |
| **v2 note**   | No change needed. Just ensure the test matrix exercises it (see Tier 1.3 tests in v1's CM-T1..T10 already cover the lease path; extend with a multi-process simulation if possible).                                                                                                                                                                                                                    |

### Mode 7: LLM hallucinates tool call

| Question                                    | Answer                                                                                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What if step N fails?                       | `toolCallValidator` rejects with `formatValidationErrors` returned to LLM as `tool_result` with `error: true`. LLM self-corrects on next iteration. `toolCallRepair` (7 strategies: JSON repair, type coercion, missing-field defaults, etc.) runs first. |
| What if process crashes?                    | n/a — the hallucinated call was rejected before any side effect                                                                                                                                                                                           |
| What if LLM hallucinates answer (not call)? | `hallucinationDetector` (13 signals: internal rep, self-consistency, citation grounding, etc.) flags. `UnifiedVerificationPipeline` decides pass/fail. No automatic re-prompt.                                                                            |
| What if tool output is wrong?               | Same as "hallucinated answer" path                                                                                                                                                                                                                        |
| **Status**                                  | 🟡 **PARTIAL**. `toolCallValidator` is wired. `reflexionInjector` exists but is not invoked by the verification pipeline.                                                                                                                                 |
| **v2 fix**                                  | Tier 3.2 wire-up: after `verification.check()` returns `verdict: 'fail'` AND `confidence < 0.5`, invoke `reflexionInjector.generateReflection()` and feed back to LLM. Cap at 2 iterations.                                                               |

### Mode 8: Tool returns wrong output

| Question                 | Answer                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?            | `UnifiedVerificationPipeline.check()` runs 5 gates (schema, semantics, consistency, completeness, accuracy). If any fails with low confidence, `verdict: 'fail'`. Currently: run aborts. With v2 fix: `reflexionInjector` runs. |
| What if process crashes? | n/a                                                                                                                                                                                                                             |
| **Status**               | 🟡 Same as Mode 7. Detection is strong; recovery is weak.                                                                                                                                                                       |
| **v2 fix**               | Tier 3.2 (same as Mode 7). Additionally: Tier 3.1 — when `toolCallValidator` produces errors, format them as `{ originalArgs, errors: [...] }` and feed back to LLM (currently in some paths but not consistently).             |

### Mode 9: Tenant quota exceeded

| Question                 | Answer                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?            | `tenantProvider.checkQuota()` runs at `execute()` start. If `maxRunsPerMinute` exceeded, returns `TENANT_RATE_LIMIT`. If `maxConcurrency` exceeded, returns `TENANT_CONCURRENCY_LIMIT`. |
| What if process crashes? | n/a — no run was started                                                                                                                                                                |
| **Status**               | 🟢 **STRONG**. Tested by CM-T7.                                                                                                                                                         |

### Mode 10: Provider rate limit (HTTP 429)

| Question                 | Answer                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?            | `llmRetry.classifyLLMError` returns `retryable: true, retryAfter: <header>`. StepErrorBoundary waits `retryAfter` ms, retries. If retries exhausted, circuit breaker opens. **Then user-visible error.** |
| What if process crashes? | Idempotency key replay (see Mode 5)                                                                                                                                                                      |
| **Status**               | 🟡 **SHOULD fall back to next provider, but doesn't.** `providerFallbackChain` is the answer.                                                                                                            |
| **v2 fix**               | Tier 2.3 wire-up.                                                                                                                                                                                        |

### Mode 11: All retries exhausted

| Question                 | Answer                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?            | DLQ entry recorded (category: `tool` or `llm` or `execution`). Circuit breaker opens. Run status: `failed`.                                   |
| What if process crashes? | DLQ is NDJSON, survives crash. Circuit breaker state is in-memory — RESETS on restart.                                                        |
| **Status**               | 🟡 DLQ has `getRetryableEntries()` filter (line 159) but no automated retry worker. A failed run is "dead" until someone manually re-invokes. |

### Mode 12: Compensation itself fails 🔴

| Question                 | Answer                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?            | `compensationRegistry.compensateAll()` does 3 in-memory retries. On 4th failure, action is deleted from `pendingActions`, logged to DLQ (`category: 'execution'` — note: NOT `compensation`, the DLQ has a `compensation` category that goes unused). `getPendingCount()` no longer sees it. **The side effect is uncompensated and the system does not retry.** |
| What if process crashes? | n/a — the failed compensation record is in DLQ (NDJSON) but not in a retry queue                                                                                                                                                                                                                                                                                 |
| **Status**               | 🔴 **CRITICAL**. This is the v1 RFC's Tier 2.4 — never built. Failed compensations become orphaned side effects.                                                                                                                                                                                                                                                 |
| **v2 fix**               | Tier 2.4 build: `compensationQueue.ts` — durable queue with exponential backoff, max 10 attempts, then moves to manual review. Persist in SQLite (consistent with `runLedger`).                                                                                                                                                                                  |

### Mode 13: Checkpoint write fails

| Question                 | Answer                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?            | `stateCheckpointer.checkpoint()` catches the error, logs to `getGlobalLogger().warn()`. The in-memory state continues. The next checkpoint attempt retries. |
| What if process crashes? | The previous checkpoint is on disk (atomic write-tmp + rename). The current state is lost, but `runRecovery` can resume from the previous checkpoint.       |
| **Status**               | 🟢 **STRONG**. Atomic write-tmp + rename is robust.                                                                                                         |

### Mode 14: Network partition during multi-agent handoff

| Question                 | Answer                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?            | `agentInbox` (persistent) buffers messages. `agentHandoff` writes to inbox + emits a `MessageBus` event. Receiver polls or subscribes. |
| What if process crashes? | Inbox is on disk. Receiver picks up on restart.                                                                                        |
| **Status**               | 🟢 **STRONG**.                                                                                                                         |

### Mode 15: Lease expires during long tool call

| Question                 | Answer                                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?            | The tool call's lease is held via `leaseManager.heartbeat()` (called by `subAgentRuntimeIntegration` periodically). If the tool call takes longer than TTL (30s default), heartbeat extends. If heartbeat fails (lease lost), the tool result is discarded. |
| What if process crashes? | n/a — process is dead                                                                                                                                                                                                                                       |
| **Status**               | 🟢 **STRONG**.                                                                                                                                                                                                                                              |

### Mode 16: Token budget exhausted

| Question      | Answer                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| What happens? | `tokenGovernor` enforces soft cap (warn) + hard cap (abort). `ctx.tokenBudget` is decremented per LLM call. |
| **Status**    | 🟢 **STRONG**.                                                                                              |

### Mode 17: LLM takes 10+ minutes on a single step

| Question      | Answer                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens? | The provider's HTTP timeout is whatever the SDK sets (OpenAI: 10 min, Anthropic: configurable, Ollama: none). `stepTimeoutManager` exists but is not wired. |
| **Status**    | 🔴 **CRITICAL**. No LLM-call-level timeout. A 30-minute CoT call blocks a worker.                                                                           |
| **v2 fix**    | Tier 2.1 wire-up: pass `AbortSignal` to provider's `call()` method. Default 120s, configurable per agent.                                                   |

### Mode 18: Sub-agent runs forever

| Question                             | Answer                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What happens?                        | `cycleDetector` catches exact/alternating/drift loops in the message history. Hard cap is `config.maxSteps` (default varies by topology).                                                 |
| What if sub-agent makes no progress? | `cycleDetector` may not flag a "drift" that's actually two steps forward, three back, two forward — different content each time. `subAgentGuard` with `noProgressSteps` would catch this. |
| **Status**                           | 🟡 `subAgentGuard` exists but not wired.                                                                                                                                                  |
| **v2 fix**                           | Tier 2.2 wire-up.                                                                                                                                                                         |

### Failure Matrix Summary (v2)

| Mode                        | Status         | v2 Tier     |
| --------------------------- | -------------- | ----------- |
| 1: Tool call fails          | 🟡             | 2.4         |
| 2: LLM call fails           | 🟡→🟢 with 2.3 | **2.3**     |
| 3: Sub-agent fails          | 🟡             | 2.2         |
| 4: Process crashes          | 🔴             | **1.1**     |
| 5: Process crashes mid-tool | 🟡             | **1.3**     |
| 6: Two processes resume     | 🟢             | (test only) |
| 7: LLM hallucinates         | 🟡             | 3.2 + 3.1   |
| 8: Tool returns wrong       | 🟡             | 3.2 + 3.1   |
| 9: Quota exceeded           | 🟢             | (test only) |
| 10: Provider rate limit     | 🟡→🟢 with 2.3 | **2.3**     |
| 11: All retries exhausted   | 🟡             | 2.4 + 4     |
| 12: Compensation fails      | 🔴             | **2.4**     |
| 13: Checkpoint write fails  | 🟢             | (test only) |
| 14: Network partition       | 🟢             | (test only) |
| 15: Lease expires           | 🟢             | (test only) |
| 16: Token budget            | 🟢             | (test only) |
| 17: LLM 10+ min             | 🔴             | **2.1**     |
| 18: Sub-agent forever       | 🟡             | **2.2**     |

**5 of the 6 critical paths in v2 are integration work, not new code. Tier 2.4 is the only net-new module.**

---

## Part 3: The v2 Implementation Plan

### Tier 0: Foundation (Week 1, 2 days)

**0.1 Add `tests/reversibility.test.ts` skeleton** (0.5 day)

- New test file: `packages/core/tests/reversibility.test.ts`
- 18 `describe` blocks, one per failure mode
- Each block has at minimum 1 passing test (regression) and 1 failing test (the v2 fix)
- Pattern: `describe('Mode N: <name>', () => { it('regression: <current behavior>', ...); it('v2 fix: <expected new behavior>', ...); })`
- Result: **any v2 PR can be reviewed by running a single test file**

**0.2 Add `scripts/audit-wiring.ts`** (0.5 day)

- New dev tool that greps for each shipped-but-unwired module and reports call sites
- Output: `processCrashSafety: 0 call sites in src/ (expected: ≥1)`
- Run in CI; fail if any module from the v2 matrix shows 0 call sites
- Prevents regression of "built but unwired" anti-pattern

**0.3 Add `reversibility.matrix.json`** (0.5 day)

- Machine-readable version of Part 2's matrix
- Each mode has: `name`, `current_status`, `v2_fix`, `test_path`, `wired_call_sites`
- CI consumes it; docs are auto-generated

**0.4 Documentation: kill dead code references** (0.5 day)

- Update `atr/runtimeIntegration.ts` `@deprecated` notice — promote to removal in v3
- Add deprecation warning to `saga/*` if not chosen for production path
- Update `docs/rfcs/reversibility-rfc.md` with `SUPERSEDED BY v2` header

### Tier 1: Critical Safety (Week 1-2, 4 days)

#### 1.1 Wire `processCrashSafety` into `agentRuntime` and `httpServer` 🔴

**Goal**: `process.on('uncaughtException')` is installed by both the CLI and the HTTP server.

**Files**:

- `packages/core/src/runtime/agentRuntime.ts` — call `installProcessCrashHandlers({ dlq, leaseManager, activeRunIds, leaseTokenFor, fencingEpochFor, tenantIdFor })` in constructor
- `packages/core/src/httpServer.ts` — same call
- `packages/core/src/runtime/deadLetterQueue.ts` — reduce buffer size from 10 to 1 (eliminate the unflushed-DLQ window)

**Tests**:

- `tests/reversibility.test.ts` Mode 4 block:
  - `regression: process.on('uncaughtException') has no handler (capture before fix)` ← currently passes
  - `v2 fix: installProcessCrashHandlers() installs uncaughtException handler that writes DLQ and releases leases`
  - Chaos test: `tests/chaos-monkey.test.ts` CM-T11: synthetic uncaughtException mid-execution → DLQ entry written + run aborted + lease released

**Acceptance**:

- `process.on('uncaughtException')` count in `agentRuntime` ≥ 1
- `tests/reversibility.test.ts` Mode 4 all green
- `pnpm test` zero failures

#### 1.2 Wire `runRecovery` into `agentRuntime.resume()` 🔴

**Goal**: Calling `agentRuntime.resume(runId)` returns a state that includes:

- The last `CheckpointState` (messages, token usage, step number)
- The `RunLedger` actions as a `completedToolCallIds` set
- The live lease status (validated against `LeaseManager`)
- A `resumeToken` the caller passes to the LLM continuation prompt so it knows where to pick up

**Files**:

- `packages/core/src/runtime/agentRuntime.ts` line 1941 (`resume(runId: string)`) — refactor to:
  ```ts
  async resume(runId: string, opts?: { tenantId?: string }): Promise<RunRecoveryResult> {
    const recovery = new RunRecovery(this.checkpointer, this.leaseManager);
    return recovery.attempt(runId, opts);
  }
  ```
- `packages/core/src/runtime/runRecovery.ts` — extend to read `RunLedger.getTransaction(runId).actions` and add each `action.idempotencyKey` to `completedToolCallIds`
- `packages/core/src/cli.ts` — add `commander resume <runId>` subcommand that prints recovery state

**Tests**:

- `tests/reversibility.test.ts` Mode 5 block:
  - `v2 fix: resume(runId) returns completedToolCallIds sourced from BOTH checkpoint messages AND RunLedger actions`
  - `v2 fix: resume on a fenced run returns status: 'lease_lost' with errorMessage`
  - `v2 fix: resume on a non-existent run returns status: 'not_found'`

**Acceptance**:

- `commander resume <runId>` CLI command works
- `grep "runRecovery\|RunRecovery" packages/core/src/` ≥ 1 (currently 0)
- Resume successfully skips already-executed tool calls (verified by test)

#### 1.3 Decide saga/\* fate — DOCUMENT ONLY, NO DELETION (0.5 day)

**Goal**: Document why saga/\* is kept as-is, write a `docs/architecture/saga-decision.md`.

**Rationale for NOT deleting**:

- The saga CLI is a real user-facing feature
- The 3,193 LOC is fully tested (10 test files, ~2,000 LOC of test coverage)
- The cost of deletion > cost of leaving as a parallel feature
- Future v3 may wire saga into `agentRuntime` as an opt-in graph mode

**Files**:

- `docs/architecture/saga-decision.md` (new, ~200 words explaining the decision and the criteria for revisiting)
- Update `docs/rfcs/reversibility-rfc.md` Part 5.3 (saga decision diagram) with the new recommendation: **Option C — Keep as parallel feature**

### Tier 2: Resilience (Week 2-3, 5 days)

#### 2.1 Wire `stepTimeoutManager` into the LLM call path 🔴

**Goal**: Every LLM call is bounded by a configurable timeout (default 120s, agent-config-overridable).

**Files**:

- `packages/core/src/runtime/agentRuntime.ts` line ~1400 (LLM call site) — wrap with `stepTimeoutManager.executeWithTimeout(signal => provider.call(req, { signal }), config.llmTimeoutMs, fallback)`
- `packages/core/src/runtime/types.ts` `AgentExecutionContext` — add `llmTimeoutMs?: number` field
- `packages/core/src/runtime/providers/*.ts` — accept and respect `AbortSignal`

**Tests**:

- `tests/reversibility.test.ts` Mode 17 block:
  - `v2 fix: LLM call aborts after llmTimeoutMs when provider hangs`
  - `v2 fix: LLM call cancellation propagates to provider's HTTP request`
  - Chaos test CM-T12: mock provider with 5s delay → abort fires at 2s

**Acceptance**:

- 0 tests in suite can hang longer than `llmTimeoutMs + 5s` (new test invariant)
- All 22 LLM providers updated to accept AbortSignal

#### 2.2 Wire `subAgentGuard` into `subAgentExecutor.executeAtomicNode`

**Goal**: Every sub-agent step checks `subAgentGuard.check(progressMetric)` before execution.

**Files**:

- `packages/core/src/ultimate/subAgentExecutor.ts` `executeAtomicNode` — instantiate guard at start, check before each step, return `abort` if `stop`
- `packages/core/src/ultimate/subAgentGuard.ts` — already exists
- `packages/core/src/runtime/types.ts` `SubAgentContext` — add `guardLimits?: SubAgentLimits`

**Tests**:

- `tests/reversibility.test.ts` Mode 18 block:
  - `v2 fix: sub-agent aborts after maxSteps even if cycle detector misses the loop`
  - `v2 fix: sub-agent aborts after noProgressSteps=5 if no measurable progress`
  - `v2 fix: sub-agent cost cap stops execution at maxCostUsd`

#### 2.3 Wire `providerFallbackChain` into `agentRuntime` LLM call 🔴

**Goal**: If primary provider's circuit opens or returns retryable error, automatically try next provider.

**Files**:

- `packages/core/src/runtime/agentRuntime.ts` line ~1400 (LLM call) — wrap with `fallbackChain.tryProviders([{ name: primary, attempt, breaker }, { name: secondary, ... }])`
- `packages/core/src/runtime/agentRuntimeConfig.ts` — add `fallbackProviders: string[]` and `degradeModel?: string`
- `packages/core/src/runtime/circuitBreaker.ts` `CircuitBreakerRegistry` — already exists; ensure lookup is per-provider

**Tests**:

- `tests/reversibility.test.ts` Mode 2 / Mode 10 block:
  - `v2 fix: OpenAI outage → Anthropic fallback in <1s`
  - `v2 fix: All providers exhausted → degrade model attempt`
  - `v2 fix: Permanent error (401) does NOT trigger fallback`
  - Chaos test CM-T13: primary breaker open → secondary returns in test window
- Add `tests/chaos-monkey.test.ts` CM-T14: primary provider disabled for 1 hour, all user requests succeed via fallback

#### 2.4 Build `compensationQueue.ts` (NEW MODULE) 🔴

**Goal**: Failed compensations move to a durable retry queue with exponential backoff, max 10 attempts, then escalate to manual review.

**Files** (all new):

- `packages/core/src/atr/compensationQueue.ts` (~200 LOC)
  - SQLite-backed (`.commander/compensation_queue.db`)
  - Schema: `compensation_jobs (id, run_id, action_id, tool_name, args_json, attempts, next_attempt_at, last_error, escalated_at)`
  - API: `enqueue(action)`, `processPending(handlers)`, `listEscalated()`
  - Background worker: every 30s scan for due jobs, attempt compensation, re-queue with backoff on failure
  - Lease integration: only process jobs for live runIds (skip if run is FENCED)
- `packages/core/src/atr/runLedger.ts` `abortAndCompensate` — on compensation failure, enqueue to `compensationQueue` instead of just dropping
- `packages/core/src/cli.ts` — `commander compensation list` and `commander compensation retry <id>`

**Tests**:

- `packages/core/tests/atr/compensationQueue.test.ts` (new):
  - Enqueue, process, succeed → removed from queue
  - Enqueue, process, fail → backoff scheduled
  - 10 failures → `escalated_at` set, `listEscalated()` returns it
  - Stale job (run fenced) → skipped
- `tests/reversibility.test.ts` Mode 12 block:
  - `v2 fix: compensation failure enqueues to durable queue, not dropped`
  - `v2 fix: queue retries 10 times with exponential backoff`
  - `v2 fix: after 10 failures, escalation record created`

### Tier 3: Semantic Hardening (Week 3-4, 4 days)

#### 3.1 Feed `toolCallValidator` errors back to LLM as structured retry

**Goal**: When `toolCallValidator` rejects a tool call, the LLM sees the original args + the structured errors + suggested fixes, in a format it can learn from.

**Files**:

- `packages/core/src/runtime/agentRuntime.ts` line ~1700 (tool call error path) — instead of returning `error: 'validation failed'`, return:
  ```ts
  { toolCallId, error: true, output: '', validationFeedback: {
      originalArgs: toolCall.arguments,
      errors: validator.formatValidationErrors(),
      suggestedFixes: repair.suggestions(),
  }}
  ```
- `packages/core/src/runtime/toolCallValidator.ts` — already has `formatValidationErrors`; ensure it returns structured JSON
- `packages/core/src/runtime/toolCallRepair.ts` — already has 7 strategies; add `suggestions()` method

**Tests**:

- `tests/reversibility.test.ts` Mode 7 block:
  - `v2 fix: LLM hallucinated args → second iteration produces valid args after seeing validationFeedback`

#### 3.2 Wire `reflexionInjector` into the verification pipeline

**Goal**: When `UnifiedVerificationPipeline` returns `verdict: 'fail'` with `confidence < 0.5`, automatically:

1. Generate a verbal reflection via `reflexionInjector.generateReflection(output, reason)`
2. Re-prompt LLM with reflection as additional system context
3. Re-run verification
4. Cap at 2 iterations

**Files**:

- `packages/core/src/runtime/agentRuntime.ts` line ~1900 (verification path) — wrap with `reflexionLoop()`
- `packages/core/src/memory/reflexionInjector.ts` — already exists; ensure API is `async generateReflection(output, reason): Promise<string>`
- `packages/core/src/runtime/agentRuntimeConfig.ts` — add `reflexionMaxIterations?: number` (default 2)

**Tests**:

- `tests/reversibility.test.ts` Mode 8 block:
  - `v2 fix: failed verification → reflexion loop produces correct output on iteration 2`
  - `v2 fix: reflexion loop respects maxIterations cap`
  - `v2 fix: reflexion loop respects tokenBudget`

### Tier 4: Observability (Week 4, 3 days)

#### 4.1 DLQ entries tagged with failure mode

Every DLQ entry's `tags[]` includes the corresponding mode number from Part 2.

**Files**: `packages/core/src/runtime/deadLetterQueue.ts` — extend `enqueue()` to accept `failureMode?: 1..18` and include in tags.

**Test**: `tests/reversibility.test.ts` — for each mode, trigger the failure, assert DLQ entry has the right tag.

#### 4.2 Per-step latency telemetry

**Files**: `packages/core/src/metricsCollector.ts` — add `recordStepLatency(phase, durationMs)` histogram with p50/p95/p99 percentiles.

**Test**: `tests/reversibility.test.ts` — run 100 steps, assert histogram is populated.

#### 4.3 Provider health dashboard data

**Files**: `packages/core/src/runtime/circuitBreaker.ts` — add `getStats(): { provider, state, errorRate, requestCount, lastFailureAt }` per-provider.

**Test**: `tests/reversibility.test.ts` — fail primary 3 times, assert dashboard data reflects open circuit.

#### 4.4 Cost tracking per failure mode

**Files**: `packages/core/src/metricsCollector.ts` — add `recordCostByFailureMode(mode, costUsd)` counter.

**Test**: `tests/reversibility.test.ts` — trigger each mode, assert cost attributed correctly.

---

## Part 4: Diagram — The v2 Architecture

### 4.1 Current State (built-but-unwired)

```
                    ┌─────────────────────────────────────────┐
                    │         agentRuntime.execute(ctx)        │
                    │  [2,037 LOC, lines 449/1262/1349/1620/  │
                    │   1747/1816 wired to scheduler]          │
                    └────┬──────────────────────────┬─────────┘
                         │                          │
            ┌────────────▼──────────┐    ┌──────────▼──────────┐
            │  LLM Call Path        │    │  Tool Call Path     │
            │  router.call(req)     │    │  scheduler          │
            │  [NO timeout, NO      │    │   .scheduleAction   │
            │   fallback chain,     │    │  [compensation OK]  │
            │   NO sub-agent guard] │    └──────────┬──────────┘
            └────────────┬──────────┘               │
                         │                          │
                         ▼                          ▼
                  ┌──────────────────────────────────────┐
                  │  External systems / tools             │
                  └──────────────────────────────────────┘

   ──────────────────── ORPHANED MODULES ────────────────────

   [processCrashSafety.ts]   ← never installed
   [runRecovery.ts]          ← never called
   [stepTimeoutManager.ts]   ← never imported
   [subAgentGuard.ts]        ← never consulted
   [providerFallbackChain]   ← never used
   [reflexionInjector.ts]    ← never invoked
   [compensationQueue.ts]    ← does not exist

   ──────────────────── ORPHANED STACK ──────────────────────

   [saga/* — 3,193 LOC]      ← only used by cli/commands/saga.ts
```

### 4.2 Proposed State (v2)

```
                    ┌─────────────────────────────────────────┐
                    │         agentRuntime.execute(ctx)        │
                    │  + new wire-ups at lines:                │
                    │    L1: installProcessCrashHandlers()     │
                    │    L2: runRecovery (resume)              │
                    │    L3: stepTimeoutManager (LLM)          │
                    │    L4: providerFallbackChain (LLM)       │
                    │    L5: subAgentGuard (sub-agent)         │
                    │    L6: compensationQueue.enqueue()       │
                    │    L7: reflexionInjector (verify)         │
                    └────┬──────────────────────────┬─────────┘
                         │                          │
            ┌────────────▼──────────┐    ┌──────────▼──────────┐
            │  LLM Call Path        │    │  Tool Call Path     │
            │  fallbackChain        │    │  scheduler          │
            │   .tryProviders([     │    │   .scheduleAction   │
            │     primary, fb1, fb2 │    │  + compensable      │
            │   ])                  │    │  + idempotent       │
            │  with AbortSignal     │    └──────────┬──────────┘
            │  llmTimeoutMs=120s    │               │
            └────────────┬──────────┘               │
                         │                          │
                         ▼                          ▼
                  ┌──────────────────────────────────────┐
                  │  External systems / tools             │
                  └──────────────────────────────────────┘

   ──────────────────── ON CRASH ────────────────────────────

   uncaughtException
        │
        ├─► processCrashSafety.gracefulShutdown()
        │     │
        │     ├─► dlq.record({ category: 'execution', tags: ['crash'] })
        │     ├─► leaseManager.release() for each activeRunId
        │     └─► scheduler.abortRun() → compensationQueue.enqueue()
        │              │
        │              └─► Background worker retries with backoff
        │
        └─► process.exit(1) after 3s

   ──────────────────── ON RESUME ──────────────────────────

   agentRuntime.resume(runId)
        │
        ├─► runRecovery.attempt(runId)
        │     │
        │     ├─► checkpointer.loadCheckpoint() → state.messages
        │     ├─► leaseManager.validate() → live lease check
        │     ├─► runLedger.getTransaction() → completedToolCallIds
        │     └─► return { status, completedToolCallIds, resumeFromStep }
        │
        └─► Continue LLM call with prefix of completed messages
            + cache of completed tool results
```

### 4.3 Saga Decision

```
              ┌────────────────────────────┐
              │ saga/* (3,193 LOC, tested) │
              └─────────────┬──────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
     ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
     │ Option A:   │ │ Option B:   │ │ Option C:   │
     │ Wire into   │ │ Delete      │ │ Keep as     │
     │ agentRuntime│ │ entirely    │ │ parallel    │
     │ (useSaga:   │ │             │ │ feature,    │
     │  true)      │ │             │ │ document    │
     └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
            │                │               │
       2 weeks         0.5 day         0.5 day
       Risk: drift     Risk: lose      Risk: none
       with new        user feature    v3 may wire
       scheduler                        opt-in
            │                │               │
       ❌ (parallel     ❌ (breaks      ✅ (v2 pick)
       impls)           saga CLI)
```

**v2 decision: Option C (Keep as parallel feature, document the choice).** Revisit in v3 once ATR's general use is more established.

---

## Part 5: Test Matrix — Failure → Test Mapping

Every failure scenario gets an explicit test. This is the table the v1 RFC promised but never delivered.

| Mode | Failure                 | Test File                                                           | Test Name                                                                           | Status |
| ---- | ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| 1    | Tool fails              | `tests/reversibility.test.ts`                                       | `M1: tool error → compensation queue, 3 retries, then DLQ`                          | v2     |
| 2    | LLM fails (provider)    | `tests/reversibility.test.ts`                                       | `M2: primary provider 503 → fallback in <1s`                                        | v2     |
| 3    | Sub-agent fails         | `tests/reversibility.test.ts`                                       | `M3: sub-agent aborts on subAgentGuard.stop`                                        | v2     |
| 4    | Process crashes         | `tests/reversibility.test.ts` + `tests/chaos-monkey.test.ts CM-T11` | `M4: uncaughtException → DLQ + lease released + exit 1`                             | v2     |
| 5    | Crash mid-tool          | `tests/reversibility.test.ts`                                       | `M5: resume(runId) returns RunRecoveryResult with completedToolCallIds from ledger` | v2     |
| 6    | Two processes resume    | `tests/atr/c6AgentRuntimeLease.test.ts` (existing)                  | `c6: dual-process lease fencing`                                                    | ✅     |
| 7    | LLM hallucinates tool   | `tests/reversibility.test.ts`                                       | `M7: hallucinated args → validator feedback → correct args on retry`                | v2     |
| 8    | Tool wrong output       | `tests/reversibility.test.ts`                                       | `M8: verification fail → reflexion → correct output`                                | v2     |
| 9    | Quota exceeded          | `tests/chaos-monkey.test.ts CM-T7` (existing)                       | `c7: concurrent quota enforced`                                                     | ✅     |
| 10   | Provider 429            | `tests/reversibility.test.ts`                                       | `M10: 429 → wait retryAfter → fallback if exhausted`                                | v2     |
| 11   | All retries exhausted   | `tests/reversibility.test.ts`                                       | `M11: 3 retries fail → DLQ retryable entry → circuit open`                          | v2     |
| 12   | Compensation fails      | `tests/reversibility.test.ts`                                       | `M12: compensation failure → durable queue, not dropped`                            | v2     |
| 13   | Checkpoint write fails  | `tests/reversibility.test.ts`                                       | `M13: tmp write fails → atomic rename skips, prior checkpoint durable`              | v2     |
| 14   | Network partition       | `tests/agentInbox.test.ts` (existing)                               | `inbox: persistent across restart`                                                  | ✅     |
| 15   | Lease expires long tool | `tests/atr/leaseManager.test.ts` (existing)                         | `lease: heartbeat extends, fence on epoch mismatch`                                 | ✅     |
| 16   | Token budget            | `tests/tokenGovernor.test.ts` (existing)                            | `token: soft warn, hard abort`                                                      | ✅     |
| 17   | LLM 10+ min             | `tests/reversibility.test.ts` + `tests/chaos-monkey.test.ts CM-T12` | `M17: llmTimeoutMs aborts at 2s, fallback attempts in <1s`                          | v2     |
| 18   | Sub-agent forever       | `tests/reversibility.test.ts`                                       | `M18: noProgressSteps=5 aborts, cycle detector miss caught`                         | v2     |

**Net new tests**: 14 in `tests/reversibility.test.ts`, 3 new chaos tests (CM-T11, T12, T13). ~28 test cases total.

**v1 RFC's promise of `tests/reversibility.test.ts` was never delivered. v2 delivers it.**

---

## Part 6: Timeline (4 weeks, 1 engineer)

| Week | Days    | Tier               | Outputs                                                                                                           |
| ---- | ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1    | Mon-Tue | 0.1-0.4 Foundation | `tests/reversibility.test.ts` skeleton, `scripts/audit-wiring.ts`, `reversibility.matrix.json`, saga decision doc |
| 1    | Wed-Fri | 1.1 + 1.2          | `processCrashSafety` wired, `runRecovery` wired + CLI command                                                     |
| 2    | Mon     | 1.3                | Saga decision documented                                                                                          |
| 2    | Tue-Wed | 2.1                | `stepTimeoutManager` wired to LLM path                                                                            |
| 2    | Thu-Fri | 2.3                | `providerFallbackChain` wired to LLM path                                                                         |
| 3    | Mon-Tue | 2.4                | `compensationQueue.ts` built + enqueue integration                                                                |
| 3    | Wed-Thu | 2.2                | `subAgentGuard` wired to subAgentExecutor                                                                         |
| 3    | Fri     | 3.1                | `toolCallValidator` feedback structured                                                                           |
| 4    | Mon-Tue | 3.2                | `reflexionInjector` wired to verification pipeline                                                                |
| 4    | Wed-Fri | 4.1-4.4            | Observability (DLQ tags, latency histogram, dashboard data, cost tracking)                                        |

**Total**: ~20 working days, 1 engineer, ~1,200 LOC added (mostly compensationQueue.ts + 18 test cases), ~0 LOC removed.

**Risk**: All wire-ups touch the critical `agentRuntime` LLM/tool call paths. Mitigation: feature-flag each tier (`enableStepTimeout`, `enableProviderFallback`, etc.), so it can be turned off if a regression appears. Default ON after week 3.

---

## Part 7: Success Criteria (End of v2)

- [ ] `tests/reversibility.test.ts` has 18 `describe` blocks, all green
- [ ] `tests/chaos-monkey.test.ts` has 13+ scenarios (was 10), all green
- [ ] `npx tsc --noEmit` zero errors
- [ ] `pnpm test` zero failures
- [ ] `scripts/audit-wiring.ts` reports `0 unwired modules` for v2's tier list
- [ ] `process.on('uncaughtException')` handler count in production ≥ 1
- [ ] `grep "runRecovery\|RunRecovery" packages/core/src/` ≥ 1 (currently 0)
- [ ] Primary provider outage: 0 user-visible failures in 1-hour chaos test
- [ ] LLM call never blocks longer than `llmTimeoutMs + 5s` in any test
- [ ] Compensation failure never leaves an orphaned side effect — every failure either retries or escalates
- [ ] Each failure mode in the matrix has a corresponding test in `tests/reversibility.test.ts`
- [ ] `reversibility.matrix.json` is committed and CI-validated

---

## Part 8: What v2 Explicitly Does NOT Do

To keep scope honest:

- **Does NOT delete saga/\*. Kept as parallel feature. (v3 may opt-in wire.)**
- **Does NOT delete `runtimeIntegration.ts`. Kept with `@deprecated` tag. (v3 may remove.)**
- **Does NOT build a verifier-agent pattern for sub-agents.** (Tier 3.3 in v1; deferred to v3.)
- **Does NOT add cross-tool contradiction detection.** (Tier 3.3 in v1; deferred to v3.)
- **Does NOT add PALADIN-style failure exemplar bank.** (Tier 3.4 in v1; deferred to v3.)
- **Does NOT add consensus voting across multi-agent runs.** (Tier 3.3 in v1; deferred to v3.)
- **Does NOT rewrite `agentRuntime.ts`.** It is 2,037 LOC; rewriting is high-risk. v2 adds minimal wire-up code at the existing seam points.

**v3 candidates** (out of scope here):

1. Saga opt-in mode in `agentRuntime`
2. Verifier agent pattern
3. Cross-tool contradiction detection
4. PALADIN exemplar bank
5. JSON workflow DSL (Conductor pattern)
6. Multi-cluster replication (Temporal pattern)

---

## Part 9: Open Questions for Reviewers

1. **Saga retention**: Confirm Option C (keep as parallel, document). Or do reviewers want a more aggressive position?
2. **Compensation queue storage**: SQLite (consistent with `runLedger`) or separate NDJSON file? Recommend SQLite for atomicity.
3. **`processCrashSafety` exit timeout**: 3s default. Long enough for DLQ flush, short enough to not block K8s liveness probes (default 30s). OK?
4. **`llmTimeoutMs` default**: 120s. Covers 99% of providers' p99. Override per agent. Sound reasonable?
5. **Reflexion iterations**: 2 default. 3 if `costEstimate < $0.10`? Recommend: simple 2.
6. **Compensation queue max attempts**: 10 with backoff. After 10, move to manual review. OK?
7. **Wire-up risk**: Should each tier have a kill-switch feature flag, or roll forward with rollback-ready commits? Recommend: feature flag for first 3 days after merge, then default ON.

---

## Part 10: References

(See `docs/rfcs/reversibility-research.md` for full citations.)

- Temporal Workflow Concepts: https://docs.temporal.io/workflows
- Temporal "Workflow Engine Design Principles": https://temporal.io/blog/workflow-engine-principles
- Stripe Idempotency: https://stripe.com/blog/idempotency
- AWS Builders' Library: Timeouts, retries, jitter: https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
- AWS Builders' Library: Avoiding fallback: https://aws.amazon.com/builders-library/avoiding-fallback-in-distributed-systems/
- Netflix Conductor: https://netflix.github.io/conductor/
- Azure Durable Functions: https://docs.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview
- Google Cloud Workflows: https://cloud.google.com/workflows/docs
- Argo Workflows: https://argoprojects.github.io/argo-workflows/
- PALADIN: https://arxiv.org/abs/2509.25238
- Reflexion: https://arxiv.org/abs/2303.11381
- SelfCheckGPT: https://arxiv.org/abs/2303.08896
- Anthropic: Effective Harnesses: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Redis: Why Multi-Agent LLM Systems Fail: https://redis.io/blog/why-multi-agent-llm-systems-fail/
- Google SRE Book: https://sre.google/sre-book/
- Stripe Engineering Blog: https://stripe.com/blog/idempotency

---

## Appendix A: v1 vs v2 Comparison

| v1 RFC (2026-06-05)                                                     | v2 RFC (this document)                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Proposed 8 tiers of new work                                            | **Proposes 4 tiers of mostly WIRING work**                                 |
| Claimed ~10 days, ~1,500 LOC                                            | **~20 days, ~1,200 LOC added, ~0 LOC removed**                             |
| Recommended deleting saga/\*                                            | **Recommends keeping saga/\* as parallel feature**                         |
| Did not specify which existing modules were unwired                     | **Explicitly audits and names all unwired modules**                        |
| Promised `tests/reversibility.test.ts`                                  | **Actually delivers it (18 describe blocks)**                              |
| 18 failure modes                                                        | **18 failure modes + 4-questions matrix for each**                         |
| No automation to prevent the "built-but-unwired" pattern from recurring | **Adds `scripts/audit-wiring.ts` for CI**                                  |
| Listed gaps as items to build                                           | **Lists gaps as items to WIRE (most of the work is in `agentRuntime.ts`)** |

**The most important change in v2**: it acknowledges that the dominant risk is not absence of capability but absence of integration. The plan reflects that.

---

_This RFC is intentionally a working document. It will be updated weekly as tiers complete. The latest version lives at `docs/rfcs/reversibility-rfc-v2.md`. The implementation plan and acceptance criteria are mirrored in `.sisyphus/plans/reversibility-rfc-v2.md` for tracking._
