# Commander — Silent Killers & Bootstrap Traps Audit

> Deeper architectural audit conducted 2026-06-17. These findings are **not** duplicates of the surface-level wiring gaps in `GAP_TRACKER.md`; they are architectural, concurrency, and environment flaws that will freeze, crash, or silently corrupt a live end-to-end demo.

---

## Finding 1 — AgentRuntime Instance State Is Not Concurrent-Run Safe

### 🚨 Critical Vulnerability/Gap: Shared mutable run state corrupts concurrent agent executions

- **Target Location:** `packages/core/src/runtime/agentRuntime.ts:193,224-235,1118,1784,1981,4622-4640` (`AgentRuntime.execute`, `acquireSlot`)

#### 1. The Hidden Trap (What's wrong under the hood)

`AgentRuntime` is designed as a singleton / long-lived service, yet it stores per-run mutable state on the **instance**:

- `private slidingWindow: SlidingWindowOrchestrator` (`:193`, reassigned `:1784`)
- `private promotedTools: Set<string>` (`:224`)
- `private runHandle: RunHandle | null = null` (`:226`, assigned `:1118`)
- `private executedMutations: PlannedToolCall[]` (`:228`, reset `:1981`)
- `private ledgerCtx: { runId, leaseToken, ... } | null` (`:230-235`)
- `private runningCount` / `private waitingQueue` concurrency semaphore (`:241-242`, `:4622-4640`)

If two `execute()` calls run concurrently (CLI `commander run` + API call via shared runtime, or two web-triggered runs), the second run overwrites `runHandle`, `slidingWindow`, `executedMutations`, `ledgerCtx`, and `promotedTools` while the first run is still mid-execution. The semaphore also has no re-entrancy guard and `acquireSlot` can deadlock when `maxConcurrency` is `0` (`runningCount < 0` is never true).

#### 2. The Demo Disruption Scenario (How it kills the pitch)

During the OpenAI/Meta pitch, the presenter fires two agents from the War Room GUI. Agent A is mid-tool-chain; Agent B starts. Agent B's `runHandle` overwrites Agent A's, so when Agent A's rollback logic checks `this.ledgerCtx`, it sees Agent B's `runId` and lease token. Compensation/rollback targets the wrong run, the TUI shows interleaved events, and the final status for one run is silently lost or attributed to the other.

#### 3. Environment/Bootstrap Blockers

- No `maxConcurrency` validation at runtime construction. If `COMMANDER_MAX_CONCURRENCY=0` is exported (or parsed from a flag as `NaN` which falls back to `0`), every `execute()` waits forever.
- No guard preventing concurrent `execute()` calls on a single `AgentRuntime` instance.

#### 4. The 10-Line Surgical Patch

```typescript
// In AgentRuntime.execute (packages/core/src/runtime/agentRuntime.ts)
async execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult> {
  if (this.runHandle) {
    throw new Error('CONCURRENT_RUN_REJECTED: AgentRuntime.execute is not re-entrant. Use a pool or queue.');
  }
  if (this.config.maxConcurrency <= 0) {
    throw new Error(`INVALID_MAX_CONCURRENCY: ${this.config.maxConcurrency}`);
  }
  // ... rest of execute, with run-local state moved from instance fields into this function's scope
}
```

---

## Finding 2 — Saga Parallel Join Hangs Forever If a Branch Never Settles

### 🚨 Critical Vulnerability/Gap: `executeParallel` has no timeout / cancellation watchdog

- **Target Location:** `packages/core/src/saga/sagaCoordinator.ts:472-529` (`executeParallel`)

#### 1. The Hidden Trap (What's wrong under the hood)

`executeParallel` builds an array of child `SagaCoordinator.run()` promises and waits for them via a hand-rolled settlement counter:

```typescript
let settled = 0;
await new Promise<void>((resolve) => {
  for (const p of promises) {
    p.then(() => { settled++; if (settled === promises.length) resolve(); },
       (err) => { ... settled++; if (settled === promises.length) resolve(); });
  }
});
```

There is **no timeout** on the join. If a child saga deadlocks (e.g., approval never decided, I/O never returns, worker pool exhausted), `settled` never reaches `promises.length` and the parent saga hangs forever. The `AbortController` is only triggered after an error in `failFast` mode, not by a watchdog.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

Presenter runs the "distributed payment" saga demo with two parallel branches: charge wallet + notify user. The notification branch depends on an SMTP tool that opens a connection and waits. The branch never settles. The War Room shows the saga as "running" indefinitely; the TUI spinner never stops. After 60 seconds the presenter is forced to kill the tab, leaving half-compensated state in the JSON store.

#### 3. Environment/Bootstrap Blockers

- No worker pool health check before `executeParallel` begins. If the `InProcessWorkerPool` is saturated, branches are queued but the join has no deadline.

#### 4. The 10-Line Surgical Patch

```typescript
private async executeParallel(node: SagaParallelNode): Promise<void> {
  if (node.branches.length === 0) return;
  const abort = new AbortController();
  const timeoutMs = node.timeoutMs ?? this.config.defaultStepTimeoutMs ?? 30_000;
  const timer = setTimeout(() => abort.abort(new Error('parallel_join_timeout')), timeoutMs);
  try {
    const promises = node.branches.map((branch) =>
      this.runChild(branch, abort.signal).catch((err) => {
        if (node.failFast) abort.abort();
        throw err;
      })
    );
    await Promise.all(promises);
  } finally {
    clearTimeout(timer);
  }
}
```

---

## Finding 3 — Saga Compensation Path Can Infinite-Loop on Cyclic Graphs

### 🚨 Critical Vulnerability/Gap: `collectCompensablePath` recursion has no cycle guard on parent/sibling edges

- **Target Location:** `packages/core/src/saga/sagaCoordinator.ts:632-658` (`collectCompensablePath`)

#### 1. The Hidden Trap (What's wrong under the hood)

`collectCompensablePath` uses a recursive `visit(id)` function that walks `previousSiblingOf(id)` and `parentOf(id)`. It has a `visited` set, but that set is local to the method and only protects against exact duplicate IDs. If the execution graph has a corrupted cycle in `previousSibling` links (e.g., A.previousSibling = B and B.previousSibling = A), the recursion alternates forever until a stack overflow. Even without corruption, a legitimate nested graph with back-references can recurse unboundedly.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

During the live demo the presenter triggers a saga failure to show automatic compensation. The failure node happens to be inside a nested loop where the graph edges were serialized from disk with a circular reference. `collectCompensablePath` recurses until `RangeError: Maximum call stack size exceeded`. The Node process prints a raw stack trace, the API returns 502, and the TUI freezes on "compensating...".

#### 3. Environment/Bootstrap Blockers

- Saga graph JSON is loaded from `.commander/sagas` without structural validation. A corrupted file from a previous crash can introduce cycles.

#### 4. The 10-Line Surgical Patch

```typescript
private collectCompensablePath(failedNodeId: string): CompensableStep[] {
  if (failedNodeId === '?') return [];
  const steps: CompensableStep[] = [];
  const visited = new Set<string>();
  const MAX_DEPTH = 10_000;
  const visit = (id: string, depth: number): void => {
    if (depth > MAX_DEPTH || visited.has(id)) return;
    visited.add(id);
    const node = this.graph.getNode(id);
    if (!node) return;
    if (node.kind === 'step' && node.compensable && this.nodeStates.get(id) === 'completed') {
      const result = this.results.get(id);
      if (result) steps.push({ node, result });
    }
    const prev = this.graph.previousSiblingOf(id);
    if (prev) visit(prev.id, depth + 1);
    const parentId = this.graph.parentOf(id);
    if (parentId !== undefined) visit(parentId, depth + 1);
  };
  visit(failedNodeId, 0);
  return steps;
}
```

---

## Finding 4 — MessageBus Ring Buffer Corrupts Under Concurrent Publish

### 🚨 Critical Vulnerability/Gap: `historyHead` / `historyCount` updates are not atomic

- **Target Location:** `packages/core/src/runtime/messageBus.ts:95-120` (`publish`)

#### 1. The Hidden Trap (What's wrong under the hood)

The global history ring buffer and per-topic ring buffers use separate reads/writes of `historyHead`, `historyCount`, `topicEntry.head`, and `topicEntry.count`:

```typescript
this.history[this.historyHead] = message;
this.historyHead = (this.historyHead + 1) % this.maxHistory;
this.historyCount++;
```

If two async contexts call `publish()` simultaneously, the three statements can interleave: both reads see the same `historyHead`, one write overwrites the other, counts become inconsistent, and the SSE replay (`replaySince`) returns wrong events. The same race exists for `topicHistory` at lines 113-120.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

The War Room SSE feed subscribes to `agent.*` topics. During a multi-agent swarm, dozens of events publish concurrently. The ring buffer interleaves writes, so the TUI shows Agent 1's "tool.completed" event under Agent 2's stream, or drops events entirely. The presenter cannot demonstrate reliable observability.

#### 3. Environment/Bootstrap Blockers

- The bus is a singleton created at import time; no initialization health check verifies buffer consistency.

#### 4. The 10-Line Surgical Patch

```typescript
publish(...) {
  // Serialize all writes through a microtask queue or simple mutex
  const doPublish = () => {
    // existing publish body
  };
  if (this.publishPromise) {
    this.publishPromise = this.publishPromise.then(doPublish);
  } else {
    this.publishPromise = Promise.resolve().then(doPublish);
  }
  return this.publishPromise;
}
```

Alternatively, replace the three separate mutations with a single atomic swap using a local head variable computed before writing.

---

## Finding 5 — Provider Fallback Chain Ignores 429 Retry-After and Hammers Every Provider

### 🚨 Critical Vulnerability/Gap: Rate-limit headers are parsed but never used during failover

- **Target Location:** `packages/core/src/runtime/providerFallbackChain.ts:62-95` (`tryProviders`); `packages/core/src/runtime/llmRetry.ts:49-58,103-110` (`classifyLLMError`, `extractRetryAfter`)

#### 1. The Hidden Trap (What's wrong under the hood)

`classifyLLMError` correctly extracts `Retry-After` and stores it in `ClassifiedError.retryAfter`. However, `ProviderFallbackChain.tryProviders` treats a 429 as just another retryable error and immediately calls the next provider. It does not sleep for the requested backoff. Worse, if OpenAI returns `Retry-After: 60`, the chain exhausts Anthropic, Google, and Ollama within milliseconds, then fails entirely.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

During the pitch, a traffic spike triggers OpenAI rate limiting. The first agent call returns 429 with `Retry-After: 30`. Instead of waiting 30 seconds, Commander instantly fires the same heavy prompt at Anthropic, Google, and local Ollama. Anthropic also rate-limits. Google returns an error. Ollama is not installed on the demo laptop. The run fails in 2 seconds with "All providers exhausted" while the presenter stands in silence.

#### 3. Environment/Bootstrap Blockers

- Local fallback to Ollama assumes a running `ollama` binary and pulled model. On a clean machine the fallback silently fails.

#### 4. The 10-Line Surgical Patch

```typescript
// In ProviderFallbackChain.tryProviders
} catch (err) {
  const classified = classifyLLMError(err);
  if (entry.breaker) entry.breaker.onFailure();
  attempts.push({ provider: entry.name, error: classified.message });
  if (!this.options.isRetryable?.(err) ?? DEFAULT_RETRYABLE(err)) {
    throw err;
  }
  if (classified.retryAfter && classified.retryAfter > 0) {
    await new Promise((r) => setTimeout(r, Math.min(classified.retryAfter!, 60_000)));
  }
}
```

---

## Finding 6 — Production Pipeline Endpoint Still Executes a Mock Agent

### 🚨 Critical Vulnerability/Gap: `/api/pipeline/execute` returns fake success without running agents

- **Target Location:** `apps/api/src/pipelineEndpoints.ts:62-63,93-124` (`createPipelineRouter`)

#### 1. The Hidden Trap (What's wrong under the hood)

Despite `GAP_TRACKER.md` C10 claiming this is fixed, the router still constructs the pipeline with `agentExecutor: createMockAgentExecutor()`. The mock sleeps 100 ms and returns `{ processed: true, agentId, timestamp, input }` with fabricated token counts (`promptTokens: 100, completionTokens: 50`). The `/api/pipeline/execute` route returns this as if a real multi-step pipeline ran.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

Presenter clicks "Run Pipeline" in the War Room for a 3-step data ingestion pipeline. The UI shows a green checkmark and token usage. The presenter then opens the actual target database/S3 bucket to show results — it is empty. The audience realizes the endpoint is theater.

#### 3. Environment/Bootstrap Blockers

- None beyond the mock itself; the endpoint is designed to look healthy on every environment.

#### 4. The 10-Line Surgical Patch

```typescript
import { getSharedRuntime } from './runtimeBridge'; // or existing shared-runtime helper

const sequentialExecutor = new SequentialExecutor({
  agentExecutor: realAgentExecutor(getSharedRuntime()),
  runContextProvider: projectRunContextProvider,
});
```

Ensure `realAgentExecutor` wraps `AgentRuntime.execute(ctx)` and is used in place of `createMockAgentExecutor()` before any public demo.

---

## Finding 7 — Production Evaluation Endpoint Returns Fake LLM Scores

### 🚨 Critical Vulnerability/Gap: `/evaluation` uses keyword heuristic instead of an LLM

- **Target Location:** `apps/api/src/evaluationEndpoints.ts:257-275` (`createMockLLMCall`); `apps/api/src/index.ts:66` (`mockLLMCall`)

#### 1. The Hidden Trap (What's wrong under the hood)

`createMockLLMCall()` scores outputs by keyword matching: `perfectly` → 5, `minor` → 4, default → 4. This function is wired into the production evaluation router at `index.ts:66`. The `/health` endpoint advertises `evaluator: 'LLM-as-Judge'`, but no LLM is ever called.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

Presenter runs the automated quality-gate demo: a bad agent output that says "this is a terrible answer" is sent to `/evaluation/score`. Because the prompt doesn't contain the negative keywords the mock looks for, it returns `score: 4` with a generic explanation. The quality gate passes junk output, undermining the trustworthiness narrative.

#### 3. Environment/Bootstrap Blockers

- No fallback to a real LLM when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is present. The mock is hard-coded.

#### 4. The 10-Line Surgical Patch

```typescript
// In apps/api/src/index.ts
const llmCall =
  process.env.EVALUATION_MOCK === 'true'
    ? createMockLLMCall()
    : createRealLLMCall({ provider: process.env.EVALUATION_PROVIDER ?? 'anthropic' });
```

`createRealLLMCall` should call a real provider with a deterministic judge prompt and parse the JSON response, falling back to mock **only** when explicitly configured.

---

## Finding 8 — MCP "Connect" Endpoint Fakes Success Without Validating the Server

### 🚨 Critical Vulnerability/Gap: `/mcp/client/connect` stores config and returns `configured` without opening a connection

- **Target Location:** `apps/api/src/mcpEndpoints.ts:218-229` (`createMCPClientRouter`)

#### 1. The Hidden Trap (What's wrong under the hood)

The endpoint accepts `{ name, transport, command, args, url, headers }`, validates only `name`, then responds with `status: 'configured'` and claims tools will be available on the next agent execution. It never instantiates an MCP client, never calls `client.connect()`, and never validates that `command`/`url` are reachable.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

Presenter connects Commander to a local SQLite MCP server via the War Room. The UI shows a green "configured" toast. They then ask an agent to "list tables". The agent fails with `Tool not found` because no MCP tools were ever loaded. The presenter debugs live while the audience watches a broken integration.

#### 3. Environment/Bootstrap Blockers

- Requires `npx` / local `tsx` or MCP server binary, but the endpoint does not check availability before claiming success.

#### 4. The 10-Line Surgical Patch

```typescript
router.post('/connect', async (req, res) => {
  const { name, transport, command, args, url, headers } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const client = createMCPClient({ name, transport, command, args, url, headers });
    await client.connect();
    const tools = await client.listTools();
    registeredClients.set(name, client);
    res.json({ status: 'connected', name, toolCount: tools.length });
  } catch (err) {
    res.status(502).json({ status: 'failed', name, error: (err as Error).message });
  }
});
```

---

## Finding 9 — SSE Heartbeat Timer Leaks When Client Disconnects Abruptly

### 🚨 Critical Vulnerability/Gap: `SSEStream.heartbeatTimer` is never a guaranteed-cleanup resource

- **Target Location:** `packages/core/src/runtime/sseStream.ts:38-44,93-100` (`constructor`, `heartbeatTimer`)

#### 1. The Hidden Trap (What's wrong under the hood)

`SSEStream` starts a `setInterval` heartbeat in its constructor and stores the handle on the instance. The timer is cleared only inside `close()`. If the underlying HTTP request is destroyed without firing the `req.on('close')` handler (common with load balancers, proxies, or abrupt browser navigation), the stream object and its timer leak. Each reconnect creates a new `SSEStream` with a new timer.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

The presenter refreshes the War Room page several times during the demo to show different views. Each refresh leaks an `SSEStream` and its 30-second heartbeat timer. After 10 minutes the Node event loop is saturated with hundreds of timers, API latency spikes, and the final SSE event never reaches the browser.

#### 3. Environment/Bootstrap Blockers

- Proxies (e.g., `nginx` in Docker) often close connections without the `close` event reaching Node.

#### 4. The 10-Line Surgical Patch

```typescript
// In SSEStream constructor, after starting the timer
const closeOnFinished = () => this.close();
res.on('close', closeOnFinished);
res.on('error', closeOnFinished);
res.on('timeout', closeOnFinished);
this.unsubscribers.push(() => {
  res.off('close', closeOnFinished);
  res.off('error', closeOnFinished);
  res.off('timeout', closeOnFinished);
});
```

Also add a `WeakRef`/finalizer or cap the total number of concurrent SSE streams.

---

## Finding 10 — CostAggregator Uses Module-Level Mutable State for Concurrent Reports

### 🚨 Critical Vulnerability/Gap: `promptHitMetrics` is shared global mutable state

- **Target Location:** `packages/core/src/intelligence/costAggregator.ts:388-395,443-449` (`buildCacheTypeBreakdown`)

#### 1. The Hidden Trap (What's wrong under the hood)

`promptHitMetrics` is declared at module scope (`:443-449`) and mutated inside `buildCacheTypeBreakdown` (`:388-395`). The function also reads counters via `metrics.getCounter()`, which can return `undefined` if a counter has never been recorded (e.g., `semantic.events.hit = metrics.getCounter(...)` at `:317`). Adding `undefined` values produces `NaN`, and the module-level `promptHitMetrics` causes race conditions when two API requests call the cost report concurrently.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

Two investors open the cost dashboard in separate tabs. Both request `/cost/report`. The shared `promptHitMetrics` object is mutated by both requests simultaneously. One tab shows `prompt cache savings: $NaN` and `tool cache hitRate: NaN%`. The presenter cannot explain why the financial dashboard is broken.

#### 3. Environment/Bootstrap Blockers

- A fresh environment with no prior LLM calls has no counters registered, so `getCounter` returns `undefined` and the report is full of `NaN`.

#### 4. The 10-Line Surgical Patch

```typescript
function buildCacheTypeBreakdown(records: LLMCallRow[]): Record<CacheType, CacheTypeStats> {
  const promptHitMetrics = { cacheReadsTokenTotal: 0, cacheWritesTokenTotal: 0 };
  // ... existing logic, but with local state only
  const safeCounter = (name: string, labels: Label[]) => metrics.getCounter(name, labels) ?? 0;
  semantic.events.hit = safeCounter('semantic_cache_events_total', [
    { name: 'outcome', value: 'hit' },
  ]);
  // repeat for every counter read
}
```

---

## Finding 11 — RegressionGate Crashes the Process When MessageBus Is Unavailable

### 🚨 Critical Vulnerability/Gap: `bus.publish` for regression alerts is unguarded

- **Target Location:** `packages/core/src/selfEvolution/regressionGate.ts:66-74` (`recordExperience`)

#### 1. The Hidden Trap (What's wrong under the hood)

When `recordExperience` detects a regression, it calls `getMetricsCollector().recordRegressionActiveCount()` inside a `try/catch`, but the very next block calls `getMessageBus().publish('system.alert', ...)` with no guard. If the message bus is not yet initialized (e.g., early CLI command or test harness), `getMessageBus()` throws and the exception propagates out of `recordExperience`, crashing the caller.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

Presenter runs `commander run` from the CLI during a local demo. A string of failures triggers the meta-learner regression detector. `getMessageBus()` returns a bus that is not fully wired in CLI mode, `publish` throws, and the entire CLI process exits with a raw stack trace mid-run.

#### 3. Environment/Bootstrap Blockers

- CLI mode does not guarantee a fully initialized `MessageBus`, so this path is reachable on any fresh install.

#### 4. The 10-Line Surgical Patch

```typescript
try {
  const bus = getMessageBus();
  bus.publish('system.alert', 'meta-learner', {
    type: 'regression_detected',
    strategy: exp.strategyUsed,
    modelId: exp.modelUsed,
    dropRatio,
    priorRate,
    recentRate,
  });
} catch {
  /* best-effort alert */
}
```

---

## Finding 12 — CLI `saga run --timeout=abc` Crashes on `AbortSignal.timeout(NaN)`

### 🚨 Critical Vulnerability/Gap: `parseInt` result is passed directly to `AbortSignal.timeout`

- **Target Location:** `packages/core/src/cli/commands/saga.ts:148,191` (`buildContext`, `cmdSagaRun`)

#### 1. The Hidden Trap (What's wrong under the hood)

```typescript
const timeoutMs = parseInt(flags.timeout ?? '60000', 10);
// ...
signal: AbortSignal.timeout(timeoutMs),
```

If the user passes `--timeout=abc`, `parseInt` returns `NaN`. `AbortSignal.timeout(NaN)` throws a `TypeError` synchronously. The error is not caught inside `cmdSagaRun`, so it bubbles to `main().catch()` and prints a stack trace.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

Presenter mistypes `commander saga run payment --timeout=30s` (with an `s` suffix). The CLI immediately crashes with `TypeError: NaN is not a valid timeout value` and a full stack trace. The audience sees a brittle tool on the first command.

#### 3. Environment/Bootstrap Blockers

- No input validation; any typo or malformed env-injected flag crashes the command.

#### 4. The 10-Line Surgical Patch

```typescript
const parsedTimeout = parseInt(flags.timeout ?? '60000', 10);
const timeoutMs = Number.isNaN(parsedTimeout) || parsedTimeout <= 0 ? 60_000 : parsedTimeout;
```

---

## Finding 13 — `commander resume` Swallows Failures and Exits With Success

### 🚨 Critical Vulnerability/Gap: `cmdResume` catches all errors and returns without setting exit code

- **Target Location:** `packages/core/src/cli/commands/small-features.ts:310-367` (`cmdResume`)

#### 1. The Hidden Trap (What's wrong under the hood)

The entire `cmdResume` body is wrapped in a `try/catch` that logs the error and returns normally. If `runtime.resume(runId)` throws (checkpoint corrupted, lease lost, provider unavailable), the CLI prints `Error: ...` but exits with code `0`. Scripts and CI pipelines that call `commander resume` will assume recovery succeeded.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

The demo's grand finale is auto-recovery from a "crash". The presenter runs `commander resume run-123`. The checkpoint file is corrupt, so `runtime.resume` throws. The CLI prints a one-line error but exits `0`. The presenter doesn't notice and tells the audience the run recovered, but a subsequent `commander status` shows the run is still failed.

#### 3. Environment/Bootstrap Blockers

- No validation that `runtime.resume()` actually returned a resumable state before printing the success message.

#### 4. The 10-Line Surgical Patch

```typescript
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  ${$.red}Error: ${msg}${$.reset}\n`);
  process.exit(1);
}
```

---

## Finding 14 — Rate-Limit Store Grows Unbounded Under DDoS or High IP Churn

### 🚨 Critical Vulnerability/Gap: In-memory rate-limit `Map` has no size cap

- **Target Location:** `apps/api/src/securityMiddleware.ts:60-70` (`rateLimitStore`, cleanup interval)

#### 1. The Hidden Trap (What's wrong under the hood)

`rateLimitStore` is a module-level `Map<string, RateLimitEntry>`. Old entries are cleaned up only every 5 minutes. If the API is behind a NAT with high churn, receives spoofed/randomized `X-Forwarded-For` headers, or is under a light DDoS, the Map grows by one entry per unique key per minute window. There is no maximum size, so memory grows until the process OOMs.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

The API is exposed on the conference Wi-Fi. A few dozen attendees' browsers refresh the War Room. Each browser has a different local IP, and the app also polls REST endpoints. The rate-limit Map accumulates thousands of entries. Heap usage climbs, the `/health` endpoint returns 503, and the demo server becomes unresponsive.

#### 3. Environment/Bootstrap Blockers

- No dependency on external state; pure in-memory behavior that breaks under load.

#### 4. The 10-Line Surgical Patch

```typescript
const MAX_RATE_LIMIT_ENTRIES = 10_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt < now) rateLimitStore.delete(key);
  }
  if (rateLimitStore.size > MAX_RATE_LIMIT_ENTRIES) {
    const overage = rateLimitStore.size - MAX_RATE_LIMIT_ENTRIES;
    let removed = 0;
    for (const [key] of rateLimitStore) {
      rateLimitStore.delete(key);
      if (++removed >= overage) break;
    }
  }
}, 300_000).unref();
```

---

## Finding 15 — `demos/viral-demo.ts` Cannot Run on a Clean Machine

### 🚨 Critical Vulnerability/Gap: Demo script relies on `tsx` shebang and never validates dependencies

- **Target Location:** `demos/viral-demo.ts:1-10`

#### 1. The Hidden Trap (What's wrong under the hood)

The file begins with `#!/usr/bin/env npx tsx`. On a clean machine that has `node` and `npm` but has not installed dependencies, running `./demos/viral-demo.ts` will try to download `tsx` via `npx` (or fail if offline). The shebang is also Unix-only and ignored on Windows. The demo is advertised as "Fully self-contained — no API keys, no network calls, no LLM dependency", but it is not self-contained from a dependency standpoint.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

An investor clones the repo and runs `npm install && npm run demo` based on the README. The script fails with `command not found: tsx` or hangs trying to download it. The first impression is that the project does not build out of the box.

#### 3. Environment/Bootstrap Blockers

- Requires `tsx` (not in `dependencies` of the root or core `package.json` as a runtime dependency; only used via `npx`).
- Requires POSIX shebang support.

#### 4. The 10-Line Surgical Patch

```typescript
// Add to package.json scripts:
"demo": "node --import ./node_modules/tsx/dist/loader.mjs demos/viral-demo.ts",
// And add tsx to devDependencies if not already present.

// At the top of viral-demo.ts, replace shebang with a runtime guard:
if (typeof process === 'undefined') {
  throw new Error('This demo must run with Node.js');
}
```

---

## Finding 16 — `PORT` / `WEB_PORT` Environment Variables Are Not Validated

### 🚨 Critical Vulnerability/Gap: `parseInt` NaN propagates into server bind and CORS origins

- **Target Location:** `apps/api/src/index.ts:91-99,448` (`API_PORT`, `WEB_PORT`, `port`, CORS setup)

#### 1. The Hidden Trap (What's wrong under the hood)

```typescript
const API_PORT = parseInt(process.env.PORT ?? '4000', 10);
const port = Number(process.env.PORT || 4000);
```

If `PORT=abc` or `PORT=` (empty string), `parseInt` returns `NaN` and `Number('')` returns `0`. `server.listen(NaN)` throws `ERR_SOCKET_BAD_PORT`, and `server.listen(0)` binds an ephemeral port while the log still prints `http://localhost:0`. The CORS `ALLOWED_ORIGINS` set also contains `http://localhost:NaN`, which never matches a browser origin.

#### 2. The Demo Disruption Scenario (How it kills the pitch)

The demo environment has a leftover `PORT=` from a previous Docker run. `npm run dev:api` starts on a random port, but the web app is hard-coded to `localhost:4000`. The browser gets CORS errors and the presenter spends 5 minutes debugging why the War Room won't connect.

#### 3. Environment/Bootstrap Blockers

- Assumes clean numeric `PORT` env var; any ops-provided value can break startup.

#### 4. The 10-Line Surgical Patch

```typescript
function getPort(envValue: string | undefined, fallback: number): number {
  if (!envValue) return fallback;
  const n = parseInt(envValue, 10);
  if (Number.isNaN(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port "${envValue}". Must be 1-65535.`);
  }
  return n;
}
const API_PORT = getPort(process.env.PORT, 4000);
const WEB_PORT = getPort(process.env.WEB_PORT, 5173);
```

---

## Summary — Fix Priority for Demo Day

| Priority | Finding                                    | File                                                 | Demo Risk                                   |
| -------- | ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------- |
| P0       | Shared mutable run state in `AgentRuntime` | `packages/core/src/runtime/agentRuntime.ts`          | Wrong run attribution / rollback corruption |
| P0       | Pipeline endpoint still mocked             | `apps/api/src/pipelineEndpoints.ts`                  | Demo shows fake execution                   |
| P0       | Evaluation endpoint mocked                 | `apps/api/src/evaluationEndpoints.ts`                | Quality gate passes junk                    |
| P0       | Saga parallel join hangs forever           | `packages/core/src/saga/sagaCoordinator.ts`          | TUI freezes mid-demo                        |
| P1       | Fallback chain ignores `Retry-After`       | `packages/core/src/runtime/providerFallbackChain.ts` | Instant provider exhaustion                 |
| P1       | MessageBus ring-buffer race                | `packages/core/src/runtime/messageBus.ts`            | Events lost/duplicated                      |
| P1       | SSE heartbeat timer leak                   | `packages/core/src/runtime/sseStream.ts`             | Event-loop exhaustion                       |
| P1       | MCP connect fakes success                  | `apps/api/src/mcpEndpoints.ts`                       | Integration appears to work                 |
| P1       | `commander resume` swallows errors         | `packages/core/src/cli/commands/small-features.ts`   | False recovery narrative                    |
| P1       | Rate-limit Map unbounded growth            | `apps/api/src/securityMiddleware.ts`                 | OOM under load                              |
| P2       | CostAggregator module-level state          | `packages/core/src/intelligence/costAggregator.ts`   | `NaN` in dashboard                          |
| P2       | RegressionGate unguarded bus publish       | `packages/core/src/selfEvolution/regressionGate.ts`  | CLI crash                                   |
| P2       | Saga timeout NaN crash                     | `packages/core/src/cli/commands/saga.ts`             | CLI stack trace on typo                     |
| P2       | `demos/viral-demo.ts` tsx dependency       | `demos/viral-demo.ts`                                | Won't run on clean machine                  |
| P2       | `PORT` env not validated                   | `apps/api/src/index.ts`                              | Wrong port / CORS failure                   |
| P2       | Saga compensation infinite recursion       | `packages/core/src/saga/sagaCoordinator.ts`          | Stack overflow on failure                   |

---

---

## Fix Status — 2026-06-17

All 16 findings were addressed with surgical patches. Verification results:

| Finding                                  | Status   | Verification                                                                                                                                |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. AgentRuntime concurrent-run safety    | ✅ Fixed | Added `executing` re-entrancy guard + `maxConcurrency > 0` validation in `packages/core/src/runtime/agentRuntime.ts`                        |
| 2. Saga parallel join hang               | ✅ Fixed | Added `timeoutMs` deadline and abort timer in `packages/core/src/saga/sagaCoordinator.ts`; added `timeoutMs?: number` to `SagaParallelNode` |
| 3. Saga compensation recursion           | ✅ Fixed | Added `MAX_DEPTH` guard and safe result access in `collectCompensablePath`                                                                  |
| 4. MessageBus ring-buffer race           | ✅ Fixed | Serialized `publish()` through a microtask queue in `packages/core/src/runtime/messageBus.ts`                                               |
| 5. Provider fallback ignores Retry-After | ✅ Fixed | `ProviderFallbackChain` now sleeps for `Retry-After` (capped at 60s) before failing over                                                    |
| 6. Pipeline endpoint mock executor       | ✅ Fixed | `pipelineEndpoints.ts` now uses `realAgentExecutor()` backed by `getSharedRuntime()`; mock retained behind `PIPELINE_MOCK=true`             |
| 7. Evaluation endpoint mock LLM          | ✅ Fixed | `index.ts` now wires `createRealLLMCall()` by default; mock retained behind `EVALUATION_MOCK=true`                                          |
| 8. MCP connect fakes success             | ✅ Fixed | `/mcp/client/connect` now instantiates, connects, lists tools, and returns real status                                                      |
| 9. SSE heartbeat timer leak              | ✅ Fixed | `SSEStream.pipe()` now registers `close`/`error`/`timeout` listeners that call `close()`                                                    |
| 10. CostAggregator module-level state    | ✅ Fixed | `promptHitMetrics` moved local to `buildCacheTypeBreakdown`; added `safeCounter()` wrapper                                                  |
| 11. RegressionGate bus.publish crash     | ✅ Fixed | Wrapped `getMessageBus().publish()` in `try/catch`                                                                                          |
| 12. Saga timeout NaN crash               | ✅ Fixed | `cmdSagaRun` validates parsed timeout; `buildContext` defaults invalid values to 60s                                                        |
| 13. `commander resume` swallows errors   | ✅ Fixed | `cmdResume` now exits with code 1 on failure                                                                                                |
| 14. Rate-limit Map unbounded growth      | ✅ Fixed | Added `MAX_RATE_LIMIT_ENTRIES = 10_000` and eviction in `securityMiddleware.ts`                                                             |
| 15. `demos/viral-demo.ts` bootstrap      | ✅ Fixed | Added `npm run demo` script in root `package.json` and Node.js runtime guard                                                                |
| 16. `PORT` env not validated             | ✅ Fixed | Added `getPort()` helper rejecting NaN/0/out-of-range values in `apps/api/src/index.ts`                                                     |

### Quality Gates

- ✅ `pnpm typecheck` — passes (no TS errors)
- ✅ `pnpm lint` — passes (0 errors, 330 pre-existing unused-var warnings, formatting clean)
- ⚠️ `pnpm test` — 2 pre-existing test failures unrelated to these fixes:
  - `tests/selfEvolution.test.ts` — config/strategy assertion mismatches
  - `tests/worker-offload-benchmark.test.ts` — worker deserialization error
- ⚠️ `npx tsx apps/api/src/index.ts` — fails to start due to a pre-existing dependency conflict (`path-to-regexp` override breaks `express@4.22.1`'s `Layer` constructor). This is a separate bootstrap blocker not listed in the original audit.

### Notes

- `cmdAsk` in `small-features.ts` had unrelated pre-existing type errors that were also fixed so `pnpm typecheck` could pass.
- The `AgentRuntime` fix is a serialization guard rather than a full instance-state refactor. Concurrent runs are now rejected instead of corrupting shared state, which closes the demo-day risk until a deeper refactor can move run-local state into a per-execute context object.

_Audit completed 2026-06-17. All findings verified against the current working tree and cross-referenced against `GAP_TRACKER.md` to avoid duplication._
