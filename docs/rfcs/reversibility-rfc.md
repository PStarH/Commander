# RFC: Reversibility — Making Commander a Production-Grade Agent Runtime

**Author**: Reversibility Lead
**Status**: Draft
**Date**: June 5, 2026
**Scope**: `packages/core/src/`

---

## Executive Summary

Commander is **already far ahead of most open-source agent frameworks** in resilience infrastructure. It has circuit breakers, cycle detection, schema validation, compensation registries, idempotency stores, lease managers, dead letter queues, and a recently-built `ExecutionScheduler` with replay detection.

**However**, there are **three structural risks** blocking production deployment:

1. **Dead code at scale** — 3,193 lines of saga code in `src/saga/` and 253 lines of `runtimeIntegration.ts` are **not wired into the agent runtime**. They're parallel implementations that drift over time, increase test surface area without protecting users, and create false confidence.

2. **Missing process-level crash safety** — There is **no `process.on('uncaughtException')` or `unhandledRejection'` handler**. A single uncaught error in any LLM callback or tool execution kills the entire process, losing all in-flight state, mid-flight leases, and held tokens.

3. **No daisy-chained provider fallback** — The `modelRouter.ts` picks a provider upfront, but if that provider's circuit breaker opens, the runtime does not automatically try the next provider. A 30-second OpenAI outage becomes a 30-second user outage.

This RFC proposes a **2-week hardening plan** that:

- Closes the dead-code gap by picking one design and deleting the other
- Adds process-level crash safety with checkpoint-finalization on exit
- Adds provider fallback chains
- Adds 4 targeted resilience patterns from the research
- Closes 6 specific gaps identified in the failure-mode audit

---

## Part 1: Research Synthesis

We surveyed 8 production-grade systems and 4 LLM-agent failure-mode studies. The full research is documented separately in `docs/rfcs/reversibility-research.md`. Top 5 universal principles:

| #   | Principle                                                                                                                       | Source                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Event sourcing + replay** is the foundation. All durable engines record immutable event logs and replay to reconstruct state. | [Temporal Workflow Concepts](https://docs.temporal.io/workflows)                                                                 |
| 2   | **Deterministic workflow, non-deterministic activities** is the only safe separation.                                           | [Temporal determinism](https://docs.temporal.io/workflows#how-workflow-replay-works)                                             |
| 3   | **Transactional outbox** for cross-component consistency — write state + queue in one local transaction.                        | [Temporal "Workflow Engine Design Principles"](https://temporal.io/blog/workflow-engine-principles)                              |
| 4   | **Idempotency keys for safe retry** — Stripe's pattern is the gold standard.                                                    | [Stripe Blog: Designing robust APIs with idempotency](https://stripe.com/blog/idempotency)                                       |
| 5   | **Compensation ≠ fallback**. Fallback is dangerous (Amazon's 2001 outage); compensation is the saga answer.                     | [Amazon Builders' Library: Avoiding fallback](https://aws.amazon.com/builders-library/avoiding-fallback-in-distributed-systems/) |

**Top 5 anti-patterns observed in production outages**:

1. ❌ **Fallback in distributed systems** — Amazon's 2001 cache→DB fallback took down fulfillment
2. ❌ **Non-deterministic workflow code** — Temporal bans it via SDK enforcement
3. ❌ **Retry amplification** — 3 retries × 5 tiers = 243× amplification
4. ❌ **Circuit breakers without half-open testing** — Amazon prefers token buckets
5. ❌ **Compensation that can't compensate itself** — comp must be idempotent + retryable

---

## Part 2: Failure Mode Matrix

For each failure mode: what Commander currently does, what's missing, and the proposed fix.

| #   | Failure                                              | Current handler                                                                | Correct?   | Gap                                                                                                                           | Priority        |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | **Tool call fails** (network, validation, execution) | `StepErrorBoundary` (line 1684) + DLQ + `compensationRegistry.compensate`      | ✅ Mostly  | Compensation is _retried_ with simple loop, not idempotency-tracked. If compensation itself fails, only logged.               | 🟡 Med          |
| 2   | **LLM call fails** (provider error, timeout)         | `circuitBreaker.onFailure` + `llmRetry` with jitter                            | ✅ Mostly  | No automatic fallback to next provider. Circuit open = user-visible failure.                                                  | 🔴 High         |
| 3   | **Sub-agent fails**                                  | `subAgentExecutor` catch → `compensateAll` + DLQ + scheduler abort             | ✅ Mostly  | No verifier agent to validate sub-agent output. State conflicts not detected.                                                 | 🟡 Med          |
| 4   | **Process crashes mid-run**                          | `StateCheckpointer` writes after every step                                    | ✅ Mostly  | **No `process.on('uncaughtException')` handler** — crashes lose leases, hold tokens indefinitely, never flush DLQ.            | 🔴 **Critical** |
| 5   | **Process crashes mid-tool-call**                    | Idempotency key in `toolResultCache` + `idempotencyStore`                      | ✅ Mostly  | On resume, no automatic walk through completed-tool-call-IDs in checkpoint. Manual resume only.                               | 🟡 Med          |
| 6   | **Two processes resume same run**                    | Lease manager + fencing epoch in `scheduler.beginRun`                          | ✅ Correct | None                                                                                                                          | —               |
| 7   | **LLM hallucinates tool call**                       | `toolCallValidator` + `toolCallRepair` + hallucination gate (`promotedTools`)  | ✅ Mostly  | `formatValidationErrors` not consistently fed back to LLM as retryable error. No PALADIN-style failure-exemplar retrieval.    | 🟡 Med          |
| 8   | **Tool returns wrong output**                        | `UnifiedVerificationPipeline` (5 gates) + `hallucinationDetector` (13 signals) | ✅ Strong  | No multi-sample consistency check (SelfCheckGPT). No cross-tool contradiction detection.                                      | 🟢 Low          |
| 9   | **Tenant quota exceeded**                            | `tenantProvider` + rate limiting                                               | ✅ Correct | None                                                                                                                          | —               |
| 10  | **Provider rate limit**                              | `circuitBreaker` + `llmRetry` backoff                                          | ✅ Correct | None                                                                                                                          | —               |
| 11  | **All retries exhausted**                            | DLQ entry + `circuitBreaker.open`                                              | ✅ Mostly  | DLQ has no automated re-attempt with backoff. Stays "dead" forever.                                                           | 🟢 Low          |
| 12  | **Compensation itself fails**                        | Logged to DLQ (`category: 'execution'`)                                        | ⚠️ Gap     | **No escalation, no retry of compensation, no manual re-attempt mechanism.**                                                  | 🔴 High         |
| 13  | **Checkpoint write fails**                           | Atomic `write-tmp-rename`                                                      | ✅ Strong  | If `fs.rename` fails on disk full / permission, in-memory state still works for current run, but next restart loses recovery. | 🟡 Med          |
| 14  | **Network partition during multi-agent handoff**     | `agentInbox` (persistent) + `agentHandoff`                                     | ✅ Correct | None                                                                                                                          | —               |
| 15  | **Lease expires during long tool call**              | Fencing epoch rejects stale writes                                             | ✅ Correct | None                                                                                                                          | —               |
| 16  | **Token budget exhausted**                           | `TokenGovernor` (soft cap + hard cap)                                          | ✅ Correct | None                                                                                                                          | —               |
| 17  | **LLM takes 10+ minutes on a single step**           | `effectiveTimeout = tool.timeout ?? config.timeoutMs` for tools                | ⚠️ Gap     | **No step-level timeout in LLM call path itself.** A 10-minute CoT call is unprotected.                                       | 🔴 High         |
| 18  | **Sub-agent runs forever** (infinite reasoning)      | `cycleDetector` catches exact/alternating/drift loops                          | ✅ Mostly  | No `maxStepsPerAgent` hard cap. No "no-progress" detection (steps continue but goal not advancing).                           | 🔴 High         |

---

## Part 3: Codebase Audit

### 3.1 What Commander Already Has (excellent)

| File                               | LOC  | Pattern                                               | Production-ready? |
| ---------------------------------- | ---- | ----------------------------------------------------- | ----------------- |
| `runtime/circuitBreaker.ts`        | 250+ | Hystrix-style sliding window, per-provider            | ✅                |
| `runtime/llmRetry.ts`              | 100+ | Error classification + exp backoff + jitter           | ✅                |
| `runtime/stepErrorBoundary.ts`     | 200+ | Per-step recovery (retry/skip/abort)                  | ✅                |
| `runtime/deadLetterQueue.ts`       | 250+ | Persistent NDJSON failure log                         | ✅                |
| `runtime/cycleDetector.ts`         | 200+ | 3-type loop detection (consecutive/alternating/drift) | ✅                |
| `runtime/toolCallValidator.ts`     | 200+ | Compiled JSON schema validation                       | ✅                |
| `runtime/toolCallRepair.ts`        | 100+ | 7-strategy malformed arg repair                       | ✅                |
| `runtime/compensationRegistry.ts`  | 200+ | Saga pattern with idempotent compensation             | ✅                |
| `runtime/structuredOutput.ts`      | 150+ | 5-strategy JSON extraction                            | ✅                |
| `runtime/hallucinationDetector.ts` | 400+ | 13-signal hallucination detection                     | ✅                |
| `runtime/unifiedVerification.ts`   | 400+ | 5-stage verification pipeline                         | ✅                |
| `runtime/contextCompactor.ts`      | 200+ | 4-layer progressive compaction                        | ✅                |
| `runtime/tokenGovernor.ts`         | 100+ | Token budget enforcement                              | ✅                |
| `runtime/toolOutputManager.ts`     | 100+ | Per-tool output caps                                  | ✅                |
| `runtime/stateCheckpointer.ts`     | 350+ | Atomic crash-safe checkpoints                         | ✅                |
| `runtime/agentHandoff.ts`          | —    | Persistent inbox for handoffs                         | ✅                |
| `runtime/agentInbox.ts`            | —    | Persistent inbox for async messages                   | ✅                |
| `runtime/modelRouter.ts`           | 200+ | Provider selection by task complexity                 | ✅                |
| `runtime/tenantProvider.ts`        | 200+ | Per-tenant quotas + isolation                         | ✅                |
| `atr/scheduler.ts`                 | 365  | `getExecutionScheduler()` singleton                   | ✅ (new)          |
| `atr/compensationBridge.ts`        | 125  | Bridge between ATR saga and registry                  | ✅                |
| `atr/runLedger.ts`                 | 717  | Per-run ledger with actions                           | ✅                |
| `atr/idempotencyStore.ts`          | 386  | Idempotency keys + replay                             | ✅                |
| `atr/leaseManager.ts`              | 359  | Lease tokens + fencing epochs                         | ✅                |

**Total: ~5,500 lines of resilience infrastructure.** This is more than LangGraph, AutoGen, CrewAI, or any other open-source agent framework ships out of the box.

### 3.2 The Dead-Code Problem

**`src/saga/` (3,193 LOC, 12 files, 10 test files):**

| File                       | LOC | Wired into runtime?                    |
| -------------------------- | --- | -------------------------------------- |
| `sagaCoordinator.ts`       | 646 | ❌ Only used by `cli/commands/saga.ts` |
| `sagaBuilder.ts`           | 239 | ❌ Only used by `sagaCoordinator.ts`   |
| `executionGraph.ts`        | 281 | ❌ Only used by `sagaCoordinator.ts`   |
| `workerPool.ts`            | 93  | ❌ Only used by `sagaCoordinator.ts`   |
| `checkpointManager.ts`     | 124 | ❌ Only used by `sagaCoordinator.ts`   |
| `compensationScheduler.ts` | 163 | ❌ Only used by `sagaCoordinator.ts`   |
| `approvalManager.ts`       | 326 | ❌ Only used by `sagaCoordinator.ts`   |
| `retryController.ts`       | 114 | ❌ Only used by `sagaCoordinator.ts`   |
| `sagaStore.ts`             | 137 | ❌ Only used by `sagaCoordinator.ts`   |
| `examples.ts`              | 127 | ❌ Only used by `sagaCoordinator.ts`   |
| `types.ts`                 | 225 | ❌ Only used by `sagaCoordinator.ts`   |
| `index.ts`                 | 17  | ❌ Only exports to CLI                 |

**`src/atr/runtimeIntegration.ts` (253 LOC):**

Contains `wrapToolExecutionWithATR`, `startATRRun`, `finalizeATRRun` — a **competing integration design** that uses `ATRContext` (with `completedToolCallIds`, `completedActionResults`) instead of the `ExecutionScheduler.beginRun/commitRun/abortRun` pattern that was wired in Phase 3.

**`grep -rn "wrapToolExecutionWithATR"`** in `src/runtime/`: **0 results.** It's exported but unused.

### 3.3 The Two-Integration Problem

There are now **two parallel ATR integration paths**:

```
┌─────────────────────────────────────────┐
│  agentRuntime.execute()                  │
└────────────┬────────────────────────────┘
             │
   Phase 3 (mine):  scheduler.beginRun ──► scheduleAction ──► recordResult/Error ──► commitRun/abortRun
   Legacy:          wrapToolExecutionWithATR (UNUSED)
```

These are NOT compatible — the legacy uses `completedToolCallIds` as an in-memory cache, while the new uses `idempotencyStore` directly. The legacy is more sophisticated (handles in-progress state with wait + re-check), but it's dead code.

**Recommended action**: Delete `runtimeIntegration.ts` and consolidate on `ExecutionScheduler`. The legacy's "in-progress state" handling can be added to `scheduleAction` if needed (currently it fail-fasts on `state === 'in_progress'`).

### 3.4 Other Gaps

- **No `process.on('uncaughtException')`** in `agentRuntime.ts` or `httpServer.ts`. A single uncaught error in a Promise rejection kills the process, leaving leases held, mid-flight DLQ unwritten, and no graceful shutdown signal.
- **No automatic resume from checkpoint**. The `stateCheckpointer` writes snapshots, but no public API exists to load a snapshot and replay from it.
- **No provider fallback chain**. `modelRouter.ts` picks one provider. If it fails, no automatic failover.
- **No step-level timeout** for LLM calls. Only tool-level timeouts exist.
- **No sub-agent lifetime guard** (max steps / max cost / max wall clock).
- **No cross-tool contradiction detection**.

---

## Part 4: Proposed Implementation Plan

### 4.1 Tier 1 — Critical Fixes (Week 1, 3 days)

**1.1 Process-level crash safety** (1 day)

Add to `agentRuntime.ts` and `httpServer.ts`:

```typescript
// New file: src/runtime/processSafety.ts
import { getGlobalLogger } from '../logging';
import { StateCheckpointer } from './stateCheckpointer';
import { DeadLetterQueue } from './deadLetterQueue';

export function installProcessCrashHandlers(deps: {
  checkpointer: StateCheckpointer;
  dlq: DeadLetterQueue;
  activeRunIds: Set<string>;
}): void {
  let shuttingDown = false;
  const log = getGlobalLogger();

  const gracefulShutdown = async (
    source: 'uncaught' | 'unhandled' | 'SIGTERM' | 'SIGINT',
    err?: Error,
  ) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.error('AgentRuntime', `Process crash: ${source}`, { error: err?.message });

    // 1. Force-flush all in-flight checkpointer writes
    try {
      await deps.checkpointer.flushAll();
    } catch (e) {
      log.error('AgentRuntime', 'Failed to flush checkpointer on crash', {
        error: (e as Error).message,
      });
    }

    // 2. Record to DLQ
    for (const runId of deps.activeRunIds) {
      try {
        deps.dlq.record({
          id: `crash-${runId}-${Date.now()}`,
          category: 'execution',
          runId,
          agentId: 'system',
          timestamp: new Date().toISOString(),
          errorClass: 'crash',
          errorMessage: `Process crash: ${source}: ${err?.message ?? 'unknown'}`,
          retryable: true,
          attemptNumber: 0,
          operationName: 'process.crash',
          compensated: false,
          recovered: false,
          tags: ['crash', source],
        });
      } catch {}
    }

    // 3. Give DLQ time to flush (NDJSON is sync, but be safe)
    setTimeout(() => process.exit(1), 500);
  };

  process.on('uncaughtException', (err) => gracefulShutdown('uncaught', err));
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    gracefulShutdown('unhandled', err);
  });
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
```

**1.2 Delete dead code** (0.5 day)

- Delete `src/atr/runtimeIntegration.ts` (253 LOC) — superseded by `ExecutionScheduler`
- Move `wrapToolExecutionWithATR`'s "in-progress state with wait + re-check" pattern into `ExecutionScheduler.scheduleAction` as a new behavior

**1.3 Add automatic resume from checkpoint** (1.5 days)

```typescript
// New file: src/runtime/runRecovery.ts
export interface RunRecoveryResult {
  status: 'recovered' | 'fenced' | 'not_found' | 'lease_lost';
  resumeFromStep?: number;
  completedToolCallIds: Set<string>;
  context?: AgentExecutionContext;
}

export async function attemptRunRecovery(
  runId: string,
  checkpointer: StateCheckpointer,
  leaseManager: LeaseManager,
  options?: { tenantId?: string; maxLeaseAgeMs?: number },
): Promise<RunRecoveryResult> {
  const state = await checkpointer.loadCheckpoint(runId);
  if (!state) return { status: 'not_found', completedToolCallIds: new Set() };

  // 1. Validate lease
  const leaseStatus = await leaseManager.validate(runId, state.leaseToken, state.fencingEpoch);
  if (leaseStatus === 'lost') return { status: 'lease_lost', completedToolCallIds: new Set() };
  if (leaseStatus === 'fenced') return { status: 'fenced', completedToolCallIds: new Set() };

  // 2. Reconstruct completed-tool-call set from checkpoint
  const completedToolCallIds = new Set<string>();
  for (const step of state.steps) {
    for (const tc of step.toolCalls) {
      if (tc.result) completedToolCallIds.add(tc.id);
    }
  }

  return {
    status: 'recovered',
    resumeFromStep: state.stepNumber,
    completedToolCallIds,
    context: state.context,
  };
}
```

### 4.2 Tier 2 — Resilience Patterns (Week 1-2, 4 days)

**2.1 Step-level timeout with AbortController** (0.5 day)

```typescript
// New file: src/runtime/stepTimeoutManager.ts
export class StepTimeoutManager {
  private abortController = new AbortController();

  async executeWithTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    fallback: T,
    onTimeout?: () => void,
  ): Promise<T> {
    const timer = setTimeout(() => {
      this.abortController.abort(new Error(`Step timeout after ${timeoutMs}ms`));
      onTimeout?.();
    }, timeoutMs);

    try {
      return await Promise.race([
        fn(this.abortController.signal),
        new Promise<T>((_, reject) => {
          this.abortController.signal.addEventListener('abort', () => {
            reject(new StepTimeoutError(`Step exceeded ${timeoutMs}ms`));
          });
        }),
      ]);
    } catch (err) {
      if (err instanceof StepTimeoutError) {
        this.abortController = new AbortController(); // Reset for next call
        return fallback;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class StepTimeoutError extends Error {
  readonly isStepTimeout = true;
}
```

Wire into `agentRuntime.execute()`: pass `AbortSignal` to provider's `call()` method.

**2.2 Sub-agent lifetime guard** (1 day)

```typescript
// New file: src/ultimate/subAgentGuard.ts
export interface SubAgentLimits {
  maxSteps: number; // 25
  maxTokens: number; // 50_000
  maxWallClockMs: number; // 5 * 60_000
  maxCostUsd: number; // 0.50
  noProgressSteps: number; // 5 steps with no measurable progress
}

export class SubAgentGuard {
  private stepCount = 0;
  private tokenUsage = 0;
  private costUsd = 0;
  private startTime = Date.now();
  private lastProgressMetric = 0;
  private noProgressCount = 0;

  constructor(private limits: SubAgentLimits) {}

  check(progressMetric: number): 'continue' | 'warn' | 'stop' {
    this.stepCount++;
    const elapsed = Date.now() - this.startTime;

    // Hard limits
    if (this.stepCount >= this.limits.maxSteps) return 'stop';
    if (this.tokenUsage >= this.limits.maxTokens) return 'stop';
    if (elapsed >= this.limits.maxWallClockMs) return 'stop';
    if (this.costUsd >= this.limits.maxCostUsd) return 'stop';

    // No-progress detection
    if (progressMetric === this.lastProgressMetric) {
      this.noProgressCount++;
      if (this.noProgressCount >= this.limits.noProgressSteps) return 'stop';
    } else {
      this.noProgressCount = 0;
      this.lastProgressMetric = progressMetric;
    }

    // Soft warning
    if (this.stepCount >= this.limits.maxSteps * 0.8) return 'warn';
    if (elapsed >= this.limits.maxWallClockMs * 0.8) return 'warn';

    return 'continue';
  }

  record(tokenUsage: number, costUsd: number): void {
    this.tokenUsage += tokenUsage;
    this.costUsd += costUsd;
  }
}
```

Wire into `subAgentExecutor.executeNode()`.

**2.3 Provider fallback chain** (1 day)

```typescript
// New file: src/runtime/providerFallbackChain.ts
export interface ProviderChainConfig {
  primary: string; // 'claude-sonnet-4'
  fallbacks: string[]; // ['gpt-4o', 'gemini-2.5-pro']
  degradeModel?: string; // 'gpt-4o-mini' (cheap, always works)
  circuitBreakerPerProvider: boolean;
}

export class ProviderFallbackChain {
  constructor(
    private config: ProviderChainConfig,
    private router: ModelRouter,
    private breakers: Map<string, CircuitBreaker>,
  ) {}

  async call(prompt: LLMRequest, context: AgentExecutionContext): Promise<LLMResponse> {
    const tried: string[] = [];
    const lastError: Error[] = [];

    for (const provider of [this.config.primary, ...this.config.fallbacks]) {
      tried.push(provider);

      const breaker = this.breakers.get(provider);
      if (breaker && !breaker.isAvailable()) {
        lastError.push(new Error(`${provider}: circuit open`));
        continue;
      }

      try {
        const result = await this.router.callByName(provider, prompt, context);
        breaker?.onSuccess();
        return { ...result, provider, tried, fellBackFrom: tried[0] !== this.config.primary };
      } catch (err) {
        breaker?.onFailure();
        lastError.push(err as Error);
      }
    }

    // All providers failed — try degrade model (cheap, last resort)
    if (this.config.degradeModel) {
      try {
        const result = await this.router.callByName(this.config.degradeModel, prompt, context);
        return {
          ...result,
          provider: this.config.degradeModel,
          tried,
          fellBackFrom: true,
          degraded: true,
        };
      } catch (err) {
        lastError.push(err as Error);
      }
    }

    throw new AllProvidersExhaustedError(
      `All providers failed: ${lastError.map((e) => e.message).join('; ')}`,
    );
  }
}
```

Wire into `agentRuntime.execute()`: replace direct `router.call()` with `fallbackChain.call()`.

**2.4 Compensation retry queue** (1.5 days)

The current `compensationRegistry.compensate()` is synchronous and just retries in a loop. If it fails after retries, it's only logged to DLQ. There needs to be a **durable retry queue**:

```typescript
// New file: src/atr/compensationQueue.ts
export interface QueuedCompensation {
  id: string;
  actionId: string;
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: string; // ISO timestamp
  lastError?: string;
}

export class CompensationQueue {
  private store: NDJSONStore<QueuedCompensation>;

  async enqueue(
    action: CompensableAction,
    opts: { tenantId?: string; delayMs?: number },
  ): Promise<void> {
    const entry: QueuedCompensation = {
      id: generateId(),
      actionId: action.actionId,
      runId: action.runId ?? 'unknown',
      toolName: action.toolName,
      args: action.args,
      attempts: 0,
      nextAttemptAt: new Date(Date.now() + (opts.delayMs ?? 0)).toISOString(),
    };
    await this.store.append(entry);
  }

  async processPending(
    handlers: Map<string, CompensationHandler>,
  ): Promise<{ succeeded: number; failed: number }> {
    // Background task — runs every 30s
    // Reads pending, attempts each, re-queues failures with exponential backoff
    // Max 10 attempts, then moves to manual review
  }
}
```

### 4.3 Tier 3 — Validation Feedback + Reflexion (Week 2, 3 days)

**3.1 Wire validation feedback into LLM retry** (1 day)

`toolCallValidator.ts` produces structured `formatValidationErrors`, but it's not consistently fed back to the LLM. The fix: in `agentRuntime.execute()` after a tool call fails validation, return a structured error that includes the original request and the validation feedback, so the LLM can self-correct on the next iteration.

**3.2 Add Reflexion self-correction loop** (2 days)

When `UnifiedVerificationPipeline` flags an output as low-confidence, automatically:

1. Generate a verbal reflection (LLM self-critique)
2. Re-prompt the LLM with the reflection as additional context
3. Re-run the verification
4. Cap at 2-3 iterations before giving up

### 4.4 Tier 4 — Observability (Ongoing)

- Per-step latency telemetry (p50/p95/p99)
- DLQ entries tagged with failure mode (1-18) for aggregate analysis
- Loop detection alerts → structured event + DLQ entry
- Provider health dashboard (circuit breaker state + error rate)
- Cost tracking per failure mode

---

## Part 5: Diagrams

### 5.1 Current Execution Flow (after C1-C10 + Phase 3)

```
┌──────────────────────────────────────────────────────────────────┐
│  agentRuntime.execute(ctx)                                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 1. acquireSlot()          ← C7 concurrency                  │ │
│  │ 2. tenant.checkQuota()    ← C8 tenant                       │ │
│  │ 3. this.activeRuns.add(runId)                                │ │
│  │ 4. scheduler.beginRun()  ──────► RunHandle { lease, epoch }  │ │
│  │ 5. try { runWithTenant(...)                                  │ │
│  │      LLM call → tool call → verification                     │ │
│  │      [per tool call:                                         │ │
│  │        scheduler.scheduleAction  ──► idempotencyStore       │ │
│  │        if replayed: return cached                            │ │
│  │        tool.execute()                                        │ │
│  │        scheduler.recordResult | recordError                 │ │
│  │      ]                                                       │ │
│  │      verification.check()                                    │ │
│  │      this.checkpointer.checkpoint()                          │ │
│  │    }                                                         │ │
│  │ 6. scheduler.commitRun() | abortRun()                       │ │
│  │ 7. activeRuns.delete()  ← C4 swap/restore                   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 Proposed Enhanced Flow (with Tiers 1-3)

```
┌──────────────────────────────────────────────────────────────────┐
│  agentRuntime.execute(ctx)                                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 1. installProcessCrashHandlers()  ← TIER 1.1                │ │
│  │ 2. acquireSlot()                                            │ │
│  │ 3. tenant.checkQuota()                                      │ │
│  │ 4. activeRuns.add(runId)                                    │ │
│  │ 5. subAgentGuard = new SubAgentGuard({maxSteps: 25, ...})  │ │
│  │ 6. stepTimeout = new StepTimeoutManager({stepMs: 120_000}) │ │
│  │ 7. scheduler.beginRun()                                     │ │
│  │ 8. try {                                                    │ │
│  │      stepTimeout.executeWithTimeout(() =>                   │ │
│  │        providerFallbackChain.call(LLMRequest)  ← TIER 2.3 │ │
│  │      )                                                       │ │
│  │      if (subAgentGuard.check(progress) === 'stop') abort    │ │
│  │      scheduler.scheduleAction ──► idempotencyStore          │ │
│  │      if (replayed) return cached                             │ │
│  │      tool.execute()                                          │ │
│  │      if (validation fails) return retryable structured err  │ │
│  │      scheduler.recordResult | recordError                   │ │
│  │      verification.check()                                    │ │
│  │      if (verification.lowConfidence) Reflexion loop         │ │
│  │      checkpointer.checkpoint()                                │ │
│  │    }                                                         │ │
│  │ 9. scheduler.commitRun() | abortRun()                       │ │
│  │ 10. if (abortRun) compensationQueue.enqueue()  ← TIER 2.4  │ │
│  │ 11. activeRuns.delete()                                      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3 Saga Code Decision

```
                           ┌─────────────────────┐
                           │ saga/* (3,193 LOC)  │
                           │ runtimeIntegration  │
                           │ (253 LOC)           │
                           └──────────┬──────────┘
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                  Option A: Keep              Option B: Delete
                  (Make it real)              (Consolidate)
                         │                         │
              Wire SagaCoordinator        Delete 3,446 LOC
              into agentRuntime.          Move "in-progress
              Move wrapToolExecu          state wait" pattern
              tionWithATR to legacy       into ExecutionScheduler.
              mode (useATR: true).        Add 50 LOC.
                         │                         │
              Effort: 2 weeks             Effort: 0.5 day
              Risk: drift with new        Risk: lose 1 nicety
              scheduler design
                         │                         │
              Recommendation: ❌            Recommendation: ✅
              (parallel impls)
```

**Decision: Option B (Delete)** — Parallel implementations drift. The ExecutionScheduler I just wired in Phase 3 is the single integration point. The saga CLI command (`cli/commands/saga.ts`) is a separate user-facing feature and can keep its own implementation.

---

## Part 6: Testing Strategy

Every proposed change must include:

1. **Unit test** for the new module
2. **Integration test** wiring it into `agentRuntime.execute()`
3. **Chaos test** (existing in `tests/chaos-monkey.test.ts`):
   - Inject `process.crash()` mid-execution
   - Inject `provider.timeout()` mid-call
   - Inject `compensation.fail()` mid-compensation
4. **Failure-mode scenario test** (new test file: `tests/reversibility.test.ts`):
   - Each of the 18 failure modes from Part 2 gets a focused test
   - Each test asserts the exact recovery behavior

### 6.1 Specific Tests for Tier 1

```typescript
// tests/reversibility.test.ts

describe('Reversibility — process crash safety', () => {
  it('records DLQ entry when uncaughtException fires mid-execution', async () => {
    const runtime = new AgentRuntime();
    const executePromise = runtime.execute(ctx);

    // Simulate crash
    setTimeout(() => process.emit('uncaughtException', new Error('synthetic crash')), 50);

    await executePromise.catch(() => {});

    const dlqEntries = runtime.dlq.list({ runId: ctx.runId });
    expect(dlqEntries.some((e) => e.category === 'execution' && e.tags.includes('crash'))).toBe(
      true,
    );
  });

  it('flushes in-flight checkpointer on SIGTERM', async () => {
    // ...
  });
});

describe('Reversibility — provider fallback', () => {
  it('falls back to secondary provider when primary circuit opens', async () => {
    const breaker = new CircuitBreaker(2, 1000);
    const chain = new ProviderFallbackChain(
      { primary: 'openai', fallbacks: ['anthropic'] },
      router,
      new Map([['openai', breaker]]),
    );

    // Force openai to fail
    breaker.onFailure();
    breaker.onFailure();

    const result = await chain.call(req, ctx);
    expect(result.provider).toBe('anthropic');
    expect(result.fellBackFrom).toBe(true);
  });
});
```

---

## Part 7: Implementation Timeline

| Week | Day | Task                                                              | LOC    | Risk |
| ---- | --- | ----------------------------------------------------------------- | ------ | ---- |
| 1    | Mon | Tier 1.1: Process crash safety                                    | 100    | Low  |
| 1    | Tue | Tier 1.2: Delete dead code (runtimeIntegration, decide saga fate) | -3,500 | Low  |
| 1    | Wed | Tier 1.3: Automatic run recovery from checkpoint                  | 200    | Med  |
| 1    | Thu | Tier 2.1: Step-level timeout with AbortController                 | 80     | Low  |
| 1    | Fri | Tier 2.2: Sub-agent lifetime guard                                | 150    | Med  |
| 2    | Mon | Tier 2.3: Provider fallback chain                                 | 200    | Med  |
| 2    | Tue | Tier 2.4: Compensation retry queue                                | 250    | Med  |
| 2    | Wed | Tier 3.1: Validation feedback → LLM retry                         | 100    | Low  |
| 2    | Thu | Tier 3.2: Reflexion self-correction loop                          | 200    | Med  |
| 2    | Fri | Tier 4: Observability + tests + docs                              | 300    | Low  |

**Total: ~10 days, ~1,500 LOC added, ~3,500 LOC removed.**

---

## Part 8: Success Criteria

After 2 weeks:

- ✅ `tests/chaos-monkey.test.ts` passes with **15 new chaos scenarios**
- ✅ `tests/reversibility.test.ts` passes with **18 failure-mode tests**
- ✅ `npx tsc --noEmit` has 0 errors
- ✅ `pnpm test` has 0 failures (currently 2 pre-existing)
- ✅ Process-level crash safety: 0 lost leases on synthetic SIGTERM test
- ✅ Provider fallback: 0 user-visible failures during 1-hour chaos test with primary provider disabled
- ✅ Saga dead code: 0 references to `wrapToolExecutionWithATR` outside `src/atr/`
- ✅ Compensation queue: 100% of failed compensations either succeed via retry OR move to manual review queue

---

## Part 9: Open Questions for Reviewers

1. **Saga code fate**: Confirm Option B (delete) is preferred over Option A (make it real). The saga CLI is a user-facing feature, but the implementation should be re-evaluated.

2. **Compensation queue persistence**: Use SQLite (consistent with `runLedger`) or a separate file? Recommend SQLite for atomicity.

3. **Provider fallback policy**: Should the runtime **automatically** pick the best provider or **respect user choice**? Recommend: respect user choice for primary, automatic fallback for the rest.

4. **Step timeout default**: 2 minutes? 5 minutes? Configurable? Recommend: configurable, default 2 min (covers 99% of cases).

5. **Sub-agent limits defaults**: maxSteps=25, maxTokens=50K, maxWallClock=5min, maxCost=$0.50. Sound reasonable?

6. **Reflexion loop iterations**: 2 or 3 before giving up? Recommend: 2 (3 if cost is low).

---

## Part 10: References

- [Temporal Workflow Concepts](https://docs.temporal.io/workflows)
- [Temporal Blog: Workflow Engine Design Principles](https://temporal.io/blog/workflow-engine-principles)
- [AWS Step Functions Documentation](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)
- [Stripe API: Idempotent Requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe Blog: Designing robust APIs with idempotency](https://stripe.com/blog/idempotency)
- [Amazon Builders' Library: Timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Amazon Builders' Library: Avoiding fallback in distributed systems](https://aws.amazon.com/builders-library/avoiding-fallback-in-distributed-systems/)
- [Azure Durable Functions](https://docs.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview)
- [Netflix Conductor](https://netflix.github.io/conductor/)
- [Argo Workflows](https://argoproj.github.io/argo-workflows/)
- [Google Cloud Workflows](https://cloud.google.com/workflows/docs)
- [PALADIN: Failure-injection training for tool recovery](https://arxiv.org/abs/2509.25238)
- [Reflexion: Self-reflection for LLM agents](https://arxiv.org/abs/2303.11381)
- [SelfCheckGPT: Zero-resource hallucination detection](https://arxiv.org/abs/2303.08896)
- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Redis: Why Multi-Agent LLM Systems Fail](https://redis.io/blog/why-multi-agent-llm-systems-fail/)
- [AWS Prescriptive Guidance: Serverless Saga Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/implement-the-serverless-saga-pattern-with-aws-step-functions.html)
- [Google SRE Book: Cascading failures](https://sre.google/sre-book/)

---

## Appendix A: Detailed Codebase Audit Notes

### A.1 Files I Read in Detail

- `src/atr/scheduler.ts` (365 LOC) — `ExecutionScheduler` with beginRun/commitRun/abortRun/scheduleAction/recordResult/recordError
- `src/atr/runtimeIntegration.ts` (253 LOC) — **dead code**, parallel `wrapToolExecutionWithATR` design
- `src/atr/runLedger.ts` (717 LOC) — per-run transaction log with actions
- `src/atr/idempotencyStore.ts` (386 LOC) — `begin/complete/fail` with `state: 'in_progress' | 'completed' | 'failed'`
- `src/atr/leaseManager.ts` (359 LOC) — `acquire/validate/release` with fencing epoch
- `src/atr/compensationBridge.ts` (125 LOC) — bridges ATR ↔ CompensationRegistry
- `src/atr/defaultCompensation.ts` (178 LOC) — default handlers for known mutation tools
- `src/runtime/agentRuntime.ts` (1961 LOC) — has `getExecutionScheduler()`, `runHandle`, `commitRun/abortRun` wired in (Phase 3)

### A.2 The Saga Files (3,193 LOC, 12 files)

| File                             | What's there                                                                       | Wired?              |
| -------------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| `sagaCoordinator.ts` (646)       | Full saga orchestrator with nested coordinators, parallel branches, error handling | ❌ only CLI         |
| `sagaBuilder.ts` (239)           | Fluent API for building saga definitions                                           | ❌ only coordinator |
| `executionGraph.ts` (281)        | DAG representation with topological sort                                           | ❌ only coordinator |
| `workerPool.ts` (93)             | Concurrent worker pool for saga steps                                              | ❌ only coordinator |
| `checkpointManager.ts` (124)     | Saga-specific checkpointing                                                        | ❌ only coordinator |
| `compensationScheduler.ts` (163) | Compensate in reverse dependency order                                             | ❌ only coordinator |
| `approvalManager.ts` (326)       | Human-in-the-loop approval gates                                                   | ❌ only coordinator |
| `retryController.ts` (114)       | Per-step retry policies                                                            | ❌ only coordinator |
| `sagaStore.ts` (137)             | Persistent saga state (NDJSON)                                                     | ❌ only coordinator |
| `examples.ts` (127)              | Built-in example sagas (order-fulfillment, refund-approval)                        | ❌ only coordinator |
| `types.ts` (225)                 | Saga type definitions                                                              | ❌ only coordinator |
| `index.ts` (17)                  | Barrel export                                                                      | ❌ only CLI         |

### A.3 Test Coverage

| Test                                                        | Status               | Count |
| ----------------------------------------------------------- | -------------------- | ----- |
| `tests/atr/` (ExecutionScheduler, lease, idempotency, etc.) | ✅ 223 pass          | 223   |
| `tests/chaos-monkey.test.ts`                                | ✅ 10 scenarios pass | 10    |
| `tests/runtime/dagConverter.test.ts` (C1)                   | ✅ 7 pass            | 7     |
| `tests/runtime/toolPlanner.test.ts` (C1)                    | ✅ 8 pass            | 8     |
| `tests/ultimate/topologyRouter.test.ts` (C1)                | ✅ 70 pass           | 70    |
| `tests/saga/` (10 files)                                    | ✅ all pass          | ~80   |
| Total                                                       |                      | ~400  |

### A.4 What's Missing in Tests

- No test for `wrapToolExecutionWithATR` (the dead code) — fortunately unused
- No test for process-level crash recovery
- No test for sub-agent lifetime guard
- No test for provider fallback chain
- No test for compensation retry queue
- No chaos test that injects `process.kill()` mid-execution
