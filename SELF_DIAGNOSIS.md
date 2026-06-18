# Commander Self-Diagnosis — Internal Only

## Weak Point 1 [CRITICAL]: Unbounded Message Growth in Tool Loop

**File**: `packages/core/src/runtime/agentRuntime.ts`, lines 279-282
**Severity**: CRITICAL — guaranteed context overflow on long chains

The tool execution loop (`while` at line 188) appends assistant messages + tool results to `request.messages` (lines 279-282) on every iteration. The ContextWindowManager exists in `contextWindow.ts` but is **never called** during the tool loop. After 20 iterations (the max), the message array can contain:

- 1 system message
- 1 user message
- 20+ assistant messages (each potentially with tool_calls)
- 20+ tool result messages (potentially very large outputs)
- 20+ follow-up LLM responses

This can easily exceed 200K tokens on long tasks. The only defense is `observationMaskWindow` (default 10) which masks old tool results with placeholders — but the placeholders still consume tokens proportional to the number of tool calls, not their content size.

**Test case**: 50-step task with each step generating 10KB of tool output. On step 20, the context will be ~200KB+.

---

## Weak Point 2 [HIGH]: Silent Error Swallowing in LLM Call

**File**: `packages/core/src/runtime/agentRuntime.ts`, lines 356-383
**Severity**: HIGH — all errors are indistinguishable

`callWithTimeout()` catches ALL exceptions and returns `null`. The caller (line 153, 286) only checks `if (!response)`. The actual error — timeout, rate limit, invalid auth, network failure, bad request, model overloaded — is **lost**. The retry logic (line 322-328) sets a generic `lastError = 'Attempt ${attempt + 1} failed'`.

Consequences:

- No way to distinguish "retryable" (rate limit, timeout) from "permanent" (invalid auth, bad schema)
- Rate-limited requests get retried after only 1 second, almost certainly failing again
- No way to surface meaningful errors to the user
- Debugging is impossible without trace logs

**Test case**: Set invalid API key. The runtime should return error: "Authentication failed: invalid API key". Instead it returns: "All 3 attempts failed".

---

## Weak Point 3 [HIGH]: Self-Correction Loop Can Produce Same Fix Twice

**File**: `packages/core/src/ultimate/orchestrator.ts`, lines 260-318
**Severity**: HIGH — wastes tokens, may not fix issues

The quality gate auto-fix loop runs for `fixAttempt < 2` (exactly 2 attempts). If the first fix attempt fails to pass the quality gate, the second attempt receives the **same synthesis text** and the **same fix instructions**, producing the same (failed) result.

Problems:

- No deduplication of attempted fixes
- No "this approach already failed" feedback to the LLM
- No diminishing confidence as fixes fail
- No circuit breaker: both attempts run even if the first produced zero improvement
- Quality score comparison could regress: no guard against the "fixed" version being worse

**Test case**: Create a synthesis with hallucination score 0.3. Both auto-fix attempts should produce meaningfully different outputs. Current: same input → same output.

---

## Weak Point 4 [MEDIUM]: No Transient vs Permanent Error Distinction

**File**: `packages/core/src/runtime/agentRuntime.ts`, lines 152-329
**Severity**: MEDIUM — wastes time and tokens on doomed retries

The retry loop at line 152 retries ALL failures identically:

- Linear backoff: `retryDelayMs * (attempt + 1)` = 1000ms, 2000ms, 3000ms
- No jitter: concurrent retries from parallel agents collide
- No error type detection: 401 (unauthorized) retried same as 429 (rate limit)
- No maximum total retry time cap

Better approaches (from literature):

- Exponential backoff with jitter: `min(cap, base * 2^attempt * random(0.5, 1))`
- Error classification: 4xx (except 429) = permanent, 5xx/429 = transient
- Circuit breaker: after N consecutive failures, stop retrying for M seconds

---

## Weak Point 5 [MEDIUM]: Circuit Breaker Is Config-Only, Never Active

**Files**: `packages/core/src/ultimate/types.ts` (lines 369-376), `orchestrator.ts`, `agentRuntime.ts`
**Severity**: MEDIUM — no protection against cascading failures

The `UltimateExecutionContext` has a `circuitBreaker` field:

```typescript
circuitBreaker: {
  maxErrors: number;
  cooldownMs: number;
  currentErrors: number;
  tripped: boolean;
}
```

But this field is **never checked** in `agentRuntime.execute()` or `orchestrator.execute()`. The circuit breaker exists as configuration only. If the system encounters repeated failures:

1. No automatic cooldown
2. No degradation of service
3. No "fast fail" for known-broken operations
4. Cascading failures propagate freely

Additionally, global singletons (`getMessageBus()`, `getTraceRecorder()`) accumulate state:

- MessageBus history: max 1000 messages, but no periodic cleanup
- ActiveRuns Set: entries only removed on completion, never on timeout
- No health check endpoint for the runtime

---

## Fix Status

| #   | Weak Point                  | Severity | Fix                                                                                        | Files Changed                                  |
| --- | --------------------------- | -------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 1   | Unbounded message growth    | CRITICAL | ✅ **ELIMINATED** — ContextCompactor integrated into tool loop (agentRuntime.ts line ~293) | `contextCompactor.ts` (new), `agentRuntime.ts` |
| 2   | Silent error swallowing     | HIGH     | ✅ **ELIMINATED** — Structured error classification with retryable/permanent distinction   | `llmRetry.ts` (new), `agentRuntime.ts`         |
| 3   | Duplicate auto-fix attempts | HIGH     | ✅ **ELIMINATED** — Reflexion-style attempt memory in quality gate loop                    | `orchestrator.ts`                              |
| 4   | No error type detection     | MEDIUM   | ✅ **ELIMINATED** — Exponential backoff with jitter, error classification                  | `llmRetry.ts` (new), `agentRuntime.ts`         |
| 5   | Circuit breaker inactive    | MEDIUM   | ✅ **ELIMINATED** — 3-state circuit breaker (CLOSED/OPEN/HALF_OPEN) integrated             | `circuitBreaker.ts` (new), `agentRuntime.ts`   |

**Total fix time**: ~4 hours (faster than estimated due to reusable module design)
**New code**: 3 modules (llmRetry.ts, circuitBreaker.ts, contextCompactor.ts) + surgical edits to 2 existing files
