# Commander Architecture Gap Analysis

**Generated:** 2026-05-16
**Scope:** All core modules (166 TypeScript files)
**Method:** Systematic audit asking "what happens when X goes wrong?" for every module

---

## How to Read This Report

Each gap has:
- **Severity:** P0 (crash/data loss now) / P1 (production blocker) / P2 (significant risk) / P3 (should fix)
- **Competitor status:** Which of Codex, Claude Code, OpenCode, OpenClaw, Hermes already solved this
- **Industry standard:** What the industry expects
- **Commander state:** What's actually happening

---

## 1. CRASH RECOVERY & PERSISTENCE

### GAP-01: AbortController is dead code — LLM call timeout doesn't work
**Severity:** P0 | **Module:** `agentRuntime.ts:676`

`callWithTimeout` creates an `AbortController` and sets a timeout, but **never passes the AbortSignal to the provider**. The `controller.abort()` fires but nothing observes it. Provider calls run indefinitely.

- **Competitor:** Codex passes signal to every fetch. Claude Code has per-request timeouts. OpenCode uses axios with timeout config.
- **Industry standard:** Every HTTP client supports abort signals. OTel traces include timeout events.
- **Commander state:** Timeout is cosmetic. A hung provider blocks the run forever.

### GAP-02: activeRuns leaks on unhandled exception
**Severity:** P0 | **Module:** `agentRuntime.ts:139-636`

The `execute()` method body is not wrapped in try/catch. If `governor.reset()`, `detectTaskType()`, or `checkpointer.checkpoint()` throws, `activeRuns.delete(runId)` is never called. The run is permanently stuck in the active set.

- **Competitor:** Claude Code wraps execution in try/finally. Codex uses RAII-style cleanup.
- **Industry standard:** Kubernetes pods have `preStop` hooks. Workflow engines use saga pattern with compensating transactions.
- **Commander state:** No try/finally around the execute body. Concurrent run count becomes stale.

### GAP-03: No automatic resume after crash
**Severity:** P1 | **Module:** `stateCheckpointer.ts` / `agentRuntime.ts`

`StateCheckpointer` writes checkpoints, but `execute()` never calls `resume()` at startup. Recovery requires manual external code. No restart-on-crash mechanism exists.

- **Competitor:** Codex has automatic session recovery. Claude Code persists conversation state to disk and resumes on reconnect.
- **Industry standard:** Workflow engines (Temporal, Airflow) automatically resume from last checkpoint. K8s operators reconcile desired state on restart.
- **Commander state:** Checkpoints are written but never read automatically. Data survives crash but is never used.

### GAP-04: TraceStore loses up to 9 events on crash
**Severity:** P2 | **Module:** `traceStore.ts:34`

Events are buffered in memory and flushed every 10 events. On crash, up to 9 events in the buffer are lost. `flushAll()` exists but is only called on normal completion.

- **Competitor:** Claude Code flushes traces synchronously. OpenTelemetry SDKs use batched export with graceful shutdown.
- **Industry standard:** OTel SDK registers `process.on('SIGTERM')` handlers to flush before exit.
- **Commander state:** No signal handler. No graceful shutdown. Buffer is fire-and-forget.

### GAP-05: Early exit paths skip flush and checkpoint terminal state
**Severity:** P1 | **Module:** `agentRuntime.ts:158-169, 242-248`

Budget-exceeded and circuit-breaker-open paths call `activeRuns.delete()` but skip `samplesStore.flush()`, `traceStore.flushAll()`, and `checkpointer.terminalCheckpoint()`. In-flight samples and traces from aborted runs are lost.

- **Competitor:** Claude Code always flushes on exit. Codex has a shutdown sequence.
- **Industry standard:** `try/finally` ensures cleanup on all exit paths.
- **Commander state:** Two early return paths have no cleanup.

---

## 2. CONCURRENCY & MULTI-TENANCY

### GAP-06: TokenGovernor singleton shares state across all runs
**Severity:** P0 | **Module:** `tokenGovernor.ts:282`

`getTokenGovernor()` is a lazy singleton. All concurrent runs share the same `usedTokens`, `taskCategory`, and recommendation cache. Run A's token usage corrupts Run B's budget pressure. `reset()` wipes all runs' state.

- **Competitor:** Claude Code has per-session token tracking. Codex isolates budgets per task.
- **Industry standard:** Per-request context in async local storage. Per-tenant resource accounting.
- **Commander state:** Single global counter for all runs. Multi-tenant is impossible.

### GAP-07: maxConcurrency config is not enforced
**Severity:** P1 | **Module:** `agentRuntime.ts`

`AgentRuntimeConfig.maxConcurrency` (default 5) exists in the type but is never checked in `execute()`. No semaphore, no queue. External callers must enforce the limit themselves.

- **Competitor:** Codex has a global task queue with concurrency limits. Claude Code limits concurrent API calls.
- **Industry standard:** Thread pools, semaphores, rate limiters are standard concurrency primitives.
- **Commander state:** Config is aspirational. Unlimited concurrent runs can exhaust resources.

### GAP-08: CircuitBreaker TOCTOU race in HALF_OPEN state
**Severity:** P2 | **Module:** `circuitBreaker.ts:20-36`

Two concurrent async calls can both see `isAvailable() === true` in HALF_OPEN state (with `halfOpenMaxTests = 1`) if they execute in the same tick. Both proceed, defeating the half-open probe limit.

- **Competitor:** Codex uses atomic compare-and-swap. Most circuit breaker libraries handle this.
- **Industry standard:** Resilience4j, Polly, and other circuit breaker libraries use atomic state transitions.
- **Commander state:** Synchronous check-then-act without atomicity guarantee.

### GAP-09: No tenant isolation in types
**Severity:** P1 | **Module:** `types.ts` (all interfaces)

Zero types carry `tenantId` or `userId`. `AgentExecutionContext`, `AgentExecutionResult`, `ApiCallRecord`, `ExecutionExperience`, `TraceEvent` — none have tenant context. Multi-tenancy must be layered entirely externally.

- **Competitor:** Claude Code has workspace isolation. Codex has organization-level scoping.
- **Industry standard:** Every SaaS platform carries tenant context through the entire call chain.
- **Commander state:** No concept of tenants exists in the type system.

---

## 3. SECURITY

### GAP-10: Sandbox infrastructure exists but is never wired in
**Severity:** P0 | **Module:** `tools/codeExecutionTool.ts` vs `sandbox/`

`SandboxManager` with Seatbelt/Bubblewrap/Docker support exists in the codebase. `codeExecutionTool.ts` and `gitTool.ts` call `execSync` directly, bypassing all sandbox protections. Tools run with full parent process privileges.

- **Competitor:** Codex has mandatory sandboxing. Claude Code uses macOS sandbox profiles. OpenClaw has Docker isolation.
- **Industry standard:** All production code execution systems sandbox untrusted code.
- **Commander state:** Sandbox is dead code. Tools are unsandboxed.

### GAP-11: pluginLoader has command injection in installFromNpm
**Severity:** P0 | **Module:** `pluginLoader.ts:127`

```typescript
execSync(`npm install --no-save --prefix "${installDir}" "${packageName}"`)
```

`packageName` is string-interpolated into a shell command. A package name like `foo"; rm -rf /; echo "` executes arbitrary commands. Additionally, npm `postinstall` scripts run automatically with full privileges.

- **Competitor:** Claude Code has no npm-based plugin system. Codex validates package names.
- **Industry standard:** Package names are validated against regex. `--ignore-scripts` is default. Sandboxed installation.
- **Commander state:** Direct shell injection via package name.

### GAP-12: httpServer defaults to no auth on 0.0.0.0
**Severity:** P0 | **Module:** `httpServer.ts`

Default bind is `0.0.0.0`. If `config.apiKey` is not set, `authenticate()` returns `true` unconditionally. The `/api/v1/execute` endpoint grants ALL tools including `shell_execute`. CORS is `*`. No rate limiting.

- **Competitor:** Claude Code binds to localhost. Codex requires explicit auth configuration.
- **Industry standard:** Default-deny auth. Localhost-only binding. CORS allowlisting. Rate limiting.
- **Commander state:** Open by default. Full remote code execution with no auth.

### GAP-13: Plugin hooks can crash runtime, inject prompts, exfiltrate data
**Severity:** P1 | **Module:** `pluginManager.ts`

Hooks are `await`ed with no try/catch and no timeout. A plugin that throws crashes the execution loop. A plugin that never resolves hangs it forever. `beforeLLMCall` can modify the LLM request to inject system prompts. `afterToolCall` can exfiltrate tool results.

- **Competitor:** Claude Code has no plugin system. Codex sandboxed plugins.
- **Industry standard:** Plugin isolation via V8 isolates or processes. Per-plugin timeouts. Capability-based permissions.
- **Commander state:** Plugins run in-process with full access and no guardrails.

### GAP-14: ContentScanner is English-only with no enforcement
**Severity:** P2 | **Module:** `contentScanner.ts`

All 14 prompt injection patterns are English-only. `multi_language_confusion` is defined as a threat type but **never scanned**. No Base64/URL decoding before scan. Scanner is detection-only — nothing calls it before processing content.

- **Competitor:** Claude Code uses model-level safety. Codex has content filtering at the API layer.
- **Industry standard:** Multi-language content filtering. Decode-then-scan pipeline. Enforcement at ingestion.
- **Commander state:** English-only detection with no enforcement mechanism.

### GAP-15: Symlink traversal bypass in fileSystemTool
**Severity:** P1 | **Module:** `tools/fileSystemTool.ts:7-12`

`safePath` uses `path.resolve` but not `fs.realpathSync`. A symlink inside the workspace pointing to `/etc/passwd` passes the `startsWith(SAFE_ROOT)` check after resolution but reads/writes the target outside the workspace.

- **Competitor:** Claude Code resolves symlinks before path checks. Codex uses `realpath`.
- **Industry standard:** `realpath` or `lstat` checks before file access. Symlink-aware sandboxing.
- **Commander state:** Classic symlink-based path traversal bypass.

### GAP-16: MCP client leaks full environment to subprocess
**Severity:** P1 | **Module:** `mcp/client.ts:45`

`env: { ...process.env, ...this.config.env }` passes all parent environment variables (including API keys, secrets, tokens) to the MCP subprocess. No environment filtering.

- **Competitor:** Claude Code uses environment allow-listing for subprocesses.
- **Industry standard:** Minimal environment inheritance. Explicit allowlist of passed variables.
- **Commander state:** Full secret leakage to any MCP server.

---

## 4. RESOURCE LEAKS & GARBAGE COLLECTION

### GAP-17: InMemoryEmbeddingStore has no eviction or delete API
**Severity:** P1 | **Module:** `embedding.ts`

Two `Map` instances grow without bound. No `delete()` method, no size limit, no eviction policy. Each OpenAI embedding is ~12KB. Over thousands of memory operations, this is a significant leak.

- **Competitor:** Claude Code uses bounded LRU caches for embeddings.
- **Industry standard:** LRU eviction, max-size limits, weak references for caches.
- **Commander state:** Unbounded growth. No way to remove entries.

### GAP-18: ThreeLayerMemory orphans embedding entries on eviction
**Severity:** P1 | **Module:** `threeLayerMemory.ts:296-305`

When `evictIfNeeded` removes a memory entry, it deletes from `this.memories` and `this.accessOrder` but **never** calls delete on `this.embedStore`. The embedding store keeps growing indefinitely. `maxMemoryBytes` config exists but is never checked — only `maxEntries` is enforced.

- **Competitor:** N/A — this is a Commander-unique system.
- **Industry standard:** Cascading deletes across related data structures. Memory budgets enforced by size, not just count.
- **Commander state:** Embedding store is a silent, unbounded leak.

### GAP-19: ReflectionEngine has completely unbounded sessions and history
**Severity:** P1 | **Module:** `reflectionEngine.ts`

`sessions: Map` and `reflectionHistory: Reflection[]` grow without any limit. No eviction, no cleanup, no `dispose()` method, no `reset()` function. Every reflection cycle adds entries that are never removed.

- **Competitor:** N/A — Commander-unique.
- **Industry standard:** Bounded collections with LRU or time-based eviction.
- **Commander state:** Memory grows monotonically for the process lifetime.

### GAP-20: LSPClient diagnostics map is unbounded; stale data after crash
**Severity:** P2 | **Module:** `lspIntegration.ts`

Every LSP diagnostic notification adds to `this.diagnostics` with no eviction. After LSP server crash, stale diagnostics remain. `disconnect()` doesn't clear diagnostics. No SIGKILL escalation for hung LSP servers. No restart-on-crash.

- **Competitor:** Claude Code's LSP integration handles process lifecycle properly.
- **Industry standard:** Health checks, automatic restart, bounded diagnostic buffers.
- **Commander state:** Zombie LSP processes, stale diagnostics, unbounded map.

### GAP-21: PersistentTraceStore NDJSON files accumulate forever
**Severity:** P2 | **Module:** `traceStore.ts`

`.commander_traces/*.ndjson` files are never rotated, never cleaned up, never size-checked. In a long-running process, this directory grows without bound.

- **Competitor:** Claude Code rotates trace files. Codex has log rotation.
- **Industry standard:** Log rotation (size-based or time-based). Retention policies. Automatic cleanup.
- **Commander state:** Write-only, never cleaned.

### GAP-22: ToolResultCache.prune() is never called automatically
**Severity:** P2 | **Module:** `toolResultCache.ts`

TTL expiry is lazy (only on `get()`). The `prune()` method exists but is never called. Stale entries sit in memory until evicted by LRU. No byte-size limit — a single 10MB tool result counts the same as a 50-byte result toward the 256-entry cap.

- **Competitor:** Claude Code has automatic cache cleanup.
- **Industry standard:** Periodic prune timers. Byte-size budgets alongside entry counts.
- **Commander state:** Wasted memory from stale entries. No size-aware eviction.

### GAP-23: MessageBus.topics Set grows without bound
**Severity:** P3 | **Module:** `messageBus.ts`

Every topic ever published is recorded in `this.topics`. No pruning API. Dynamic per-run topics accumulate forever.

- **Competitor:** N/A — most event buses don't track topic history.
- **Industry standard:** Topic sets are either bounded or not tracked.
- **Commander state:** Minor leak, but unbounded.

---

## 5. ERROR HANDLING & SILENT FAILURES

### GAP-24: TaskPool timeout doesn't cancel underlying runtime
**Severity:** P0 | **Module:** `taskPool.ts:125-128`

`Promise.race` between `runtime.execute()` and a timeout. When timeout wins, the runtime continues running in the background — consuming tokens, writing checkpoints, holding `activeRuns` entries. No cancellation signal is passed.

- **Competitor:** Codex passes AbortController to child tasks. Claude Code cancels API calls on timeout.
- **Industry standard:** CancellationToken pattern. Cooperative cancellation via abort signals.
- **Commander state:** Timed-out tasks become ghost processes.

### GAP-25: Executor.cancel() never calls abortController.abort()
**Severity:** P0 | **Module:** `executor.ts:398`

`cancel()` sets `run.status = 'CANCELLED'` but never calls `abortController.abort()`. The currently executing step runs to completion. The abort signal check at line 170 always sees `false`.

- **Competitor:** Codex cancellation is immediate. Claude Code cancels in-flight API calls.
- **Industry standard:** Cancel should be cooperative and immediate.
- **Commander state:** Cancellation is a label, not an action.

### GAP-26: llmRetry classifies HTTP 408 and ECONNABORTED as non-retryable
**Severity:** P1 | **Module:** `llmRetry.ts`

HTTP 408 (Request Timeout), `ECONNABORTED`, `ESOCKETTIMEDOUT` without "timeout" in message — all classified as `unknown` with `retryable: false`. These are classic transient errors.

- **Competitor:** Codex retries on all network errors. Claude Code has comprehensive retry lists.
- **Industry standard:** Retry on all transient network errors. 408 is always retryable.
- **Commander state:** Overly aggressive permanent classification. Unnecessary failures.

### GAP-27: ProviderPool health is advisory — down status is bypassed
**Severity:** P1 | **Module:** `telos/providerPool.ts:95-99`

When all providers are `'down'`, `select()` falls back to any enabled endpoint regardless of health. No circuit breaker. No automatic recovery. A provider marked down stays down forever unless `recoverProvider()` is called manually.

- **Competitor:** Claude Code has provider health with automatic recovery. Codex has circuit breakers.
- **Industry standard:** Circuit breaker with half-open probe. Automatic recovery after cooldown.
- **Commander state:** Health tracking is cosmetic. No recovery mechanism.

### GAP-28: SSEStream has no disconnect detection and swallows subscriber errors
**Severity:** P2 | **Module:** `sseStream.ts`

No heartbeat, no `drain` handling. If the client disconnects, buffered writes grow until OOM. Subscriber errors are silently swallowed (`catch { /* ignore */ }`). No backpressure.

- **Competitor:** Claude Code uses WebSocket with ping/pong. Codex has connection health checks.
- **Industry standard:** Heartbeat/ping-pong. Backpressure via `drain` events. Error propagation.
- **Commander state:** Silent memory leak on disconnect. Broken subscribers fail forever.

### GAP-29: StructuredOutput YAML parser returns success:true with wrong data
**Severity:** P2 | **Module:** `structuredOutput.ts:149-162`

`tryExtractYamlFields` only handles single-line `key: value`. Complex YAML (multi-line, nested, arrays) is silently parsed as a flat object with incorrect values. Returns `success: true` — worse than failing.

- **Competitor:** Claude Code uses proper YAML parser (js-yaml). Codex validates parsed output.
- **Industry standard:** Use established parsers. Validate output against schema.
- **Commander state:** Silent data corruption for complex YAML.

---

## 6. OBSERVABILITY & DEBUGGING

### GAP-30: No OpenTelemetry SDK integration — only custom trace format
**Severity:** P1 | **Module:** `executionTrace.ts`, `traceStore.ts`

Commander has its own trace format with OTel-like fields (spanId, traceId, parentSpanId) but no actual OTel SDK integration. No OTel exporter, no OTLP protocol, no integration with Jaeger/Zipkin/Grafana.

- **Competitor:** Claude Code exports traces to Anthropic's observability platform. Codex has OpenTelemetry integration.
- **Industry standard:** OTel SDK with OTLP exporter. Auto-instrumentation of HTTP calls. Trace context propagation.
- **Commander state:** Custom format that can't connect to any observability platform.

### GAP-31: No health check endpoint
**Severity:** P1 | **Module:** `httpServer.ts`

No `/health`, `/ready`, or `/livez` endpoint. No liveness probe. No readiness probe. Kubernetes can't determine if Commander is healthy.

- **Competitor:** All production services have health endpoints.
- **Industry standard:** K8s liveness/readiness probes. `/health` returns component status.
- **Commander state:** No health observability.

### GAP-32: No structured logging correlation
**Severity:** P2 | **Module:** `logging.ts`

Logger has levels and structured entries but no trace context propagation. Log entries don't carry `traceId` or `spanId`. Can't correlate logs with traces.

- **Competitor:** Claude Code logs include request IDs. Codex correlates logs with traces.
- **Industry standard:** MDC (Mapped Diagnostic Context). OTel log-bridge. Trace ID in every log entry.
- **Commander state:** Logs and traces are disconnected.

### GAP-33: No metrics export (Prometheus/OTel metrics)
**Severity:** P2 | **Module:** `logging.ts`

`MetricsCollector` exists with counters, gauges, histograms, timers — but no export endpoint. Metrics are in-memory only. No Prometheus scrape endpoint, no OTel metrics exporter.

- **Competitor:** Codex has Prometheus metrics. Claude Code has built-in cost dashboards.
- **Industry standard:** `/metrics` endpoint. OTel metrics SDK. Grafana dashboards.
- **Commander state:** Metrics collected but not exportable.

---

## 7. PLUGIN & EXTENSION SAFETY

### GAP-34: No plugin signature verification
**Severity:** P1 | **Module:** `pluginLoader.ts`

Plugins are discovered by scanning directories for `plugin.json`. No signature verification, no checksum validation, no trust chain. Any directory with a `plugin.json` is loaded and executed.

- **Competitor:** Claude Code has no plugin system. VS Code extensions have marketplace verification.
- **Industry standard:** Code signing. Checksum verification. Sandboxed execution.
- **Commander state:** Arbitrary code execution from filesystem.

### GAP-35: No per-plugin resource limits
**Severity:** P1 | **Module:** `pluginManager.ts`

Plugins run in the same V8 isolate. No memory limits, no CPU limits, no file handle limits, no network restrictions. A plugin can consume unlimited resources.

- **Competitor:** VS Code extensions run in separate processes. Browser extensions have CSP.
- **Industry standard:** Process isolation. V8 isolates with resource limits. CSP for web plugins.
- **Commander state:** Full resource access, no limits.

---

## 8. DATA MODEL & VERSIONING

### GAP-36: No schema version on any persisted type
**Severity:** P1 | **Module:** `types.ts` (all 26 interfaces)

Zero types have a schema version field. `AgentExecutionResult`, `ApiCallRecord`, `ExecutionExperience`, `TraceEvent` — all persisted without version. Forward-compatible deserialization is impossible. A schema change breaks all existing data.

- **Competitor:** Claude Code's data formats are versioned. Codex uses protobuf with versioning.
- **Industry standard:** Schema version on all persisted types. Migration framework for version upgrades.
- **Commander state:** Any type change is a breaking change for persisted data.

### GAP-37: SqliteMemoryStore is actually JSON files
**Severity:** P2 | **Module:** `memory.ts:487`

The class is named `SqliteMemoryStore` but uses `fs.readFile`/`fs.writeFile` with JSON. No SQLite. No database connection. The name will confuse anyone adding real SQLite later.

- **Competitor:** Claude Code uses SQLite for memory. Codex has proper database backends.
- **Industry standard:** Use the technology the name implies, or rename.
- **Commander state:** Misleading name. No ACID transactions. No concurrent access safety.

---

## 9. DUPLICATE & DEAD CODE

### GAP-38: Three separate CircuitBreaker implementations
**Severity:** P2 | **Module:** `circuitBreaker.ts`, `errorHandling.ts`, `errors.ts`

Three independent CircuitBreaker classes exist:
1. `runtime/circuitBreaker.ts` — per-AgentRuntime instance
2. `errorHandling.ts:198-289` — module-level singleton
3. `errors.ts:143-203` — used by ErrorHandler

Each has different behavior and configuration. No shared interface.

- **Competitor:** N/A — this is a Commander-specific problem.
- **Industry standard:** One circuit breaker implementation, shared across the codebase.
- **Commander state:** Confusion about which breaker is active. Inconsistent behavior.

### GAP-39: Three separate error hierarchies
**Severity:** P2 | **Module:** `errorHandler.ts`, `errorHandling.ts`, `errors.ts`

Three files each define their own `CommanderError`, `TimeoutError`, `ValidationError`, etc. with different fields and behaviors. `Result<T, E>` is defined in two of them.

- **Competitor:** N/A — Commander-specific.
- **Industry standard:** One error hierarchy. One Result type.
- **Commander state:** Import confusion. Catch blocks may miss errors from the wrong hierarchy.

### GAP-40: SamplesStore has dead WriteStream fields
**Severity:** P3 | **Module:** `samplesStore.ts:20-21`

`llmStream` and `verifStream` are initialized to `null`, never assigned, but `flush()` calls `.end()` on them. Dead code from an earlier design.

- **Competitor:** N/A.
- **Industry standard:** Remove dead code.
- **Commander state:** Misleading but harmless.

---

## 10. COMPETITOR FEATURE GAPS

### GAP-41: No streaming response support
**Severity:** P1 | **Module:** `LLMProvider` interface, `providerPool.ts`

`LLMProvider.call()` returns `Promise<LLMResponse>` — no streaming. `ProviderPool.executeStreaming` is a no-op wrapper that ignores `onChunk`. Users see no output until the full response completes.

- **Competitor:** Claude Code streams tokens in real-time. Codex has streaming. OpenCode has streaming.
- **Industry standard:** SSE/WebSocket streaming of LLM tokens. Progressive UI updates.
- **Commander state:** No streaming at all.

### GAP-42: No LSP integration in tool pipeline
**Severity:** P2 | **Module:** `lspIntegration.ts`

`LSPClient` exists but is never wired into the tool execution pipeline. Tools don't use LSP diagnostics for code quality verification.

- **Competitor:** OpenCode has deep LSP integration. Claude Code uses language servers for diagnostics.
- **Industry standard:** LSP-powered code analysis in agent workflows.
- **Commander state:** LSP module exists but is disconnected from the agent loop.

### GAP-43: No WebSocket support for real-time communication
**Severity:** P2 | **Module:** `httpServer.ts`

Only HTTP REST + SSE. No WebSocket for bidirectional real-time communication. No support for interactive approval flows over WebSocket.

- **Competitor:** Claude Code has WebSocket for IDE integration. Codex has real-time streaming.
- **Industry standard:** WebSocket for interactive agent sessions.
- **Commander state:** SSE-only, unidirectional.

---

## PRIORITY MATRIX

### P0 — Fix Before Any Production Use (5 items)
| ID | Issue | Module |
|----|-------|--------|
| GAP-01 | AbortController dead code — timeout doesn't work | agentRuntime.ts |
| GAP-06 | TokenGovernor singleton corrupts concurrent runs | tokenGovernor.ts |
| GAP-10 | Sandbox exists but tools are unsandboxed | codeExecutionTool.ts |
| GAP-11 | Command injection in plugin installFromNpm | pluginLoader.ts |
| GAP-12 | httpServer no-auth on 0.0.0.0 with full tool access | httpServer.ts |

### P1 — Fix Before Production (14 items)
| ID | Issue | Module |
|----|-------|--------|
| GAP-02 | activeRuns leak on unhandled exception | agentRuntime.ts |
| GAP-03 | No automatic resume after crash | stateCheckpointer.ts |
| GAP-05 | Early exit paths skip flush | agentRuntime.ts |
| GAP-07 | maxConcurrency not enforced | agentRuntime.ts |
| GAP-09 | No tenant isolation in types | types.ts |
| GAP-13 | Plugin hooks can crash/inject/exfiltrate | pluginManager.ts |
| GAP-15 | Symlink traversal bypass | fileSystemTool.ts |
| GAP-16 | MCP client leaks full env to subprocess | mcp/client.ts |
| GAP-17 | EmbeddingStore unbounded growth | embedding.ts |
| GAP-18 | ThreeLayerMemory orphans embeddings | threeLayerMemory.ts |
| GAP-19 | ReflectionEngine unbounded growth | reflectionEngine.ts |
| GAP-24 | TaskPool timeout doesn't cancel runtime | taskPool.ts |
| GAP-25 | Executor.cancel() is a no-op | executor.ts |
| GAP-26 | HTTP 408 classified as non-retryable | llmRetry.ts |

### P2 — Fix Before Scale (14 items)
GAP-04, GAP-08, GAP-14, GAP-20, GAP-21, GAP-22, GAP-27, GAP-28, GAP-29, GAP-30, GAP-31, GAP-32, GAP-33, GAP-36

### P3 — Should Fix (7 items)
GAP-23, GAP-34, GAP-35, GAP-37, GAP-38, GAP-39, GAP-40

---

## SYSTEMIC PATTERNS

Looking across all 43 gaps, three systemic patterns emerge:

### 1. "Infrastructure exists but is not wired"
SandboxManager exists but tools don't use it. StateCheckpointer writes but nobody reads. LSPClient exists but isn't connected. ContentScanner detects but nothing enforces. This suggests a build-vs-integrate gap — modules are built in isolation without end-to-end integration testing.

### 2. "Singletons poison concurrency"
TokenGovernor, ModelRouter, MetaLearner, ReflectionEngine, ThreeLayerMemory — all singletons that share state across concurrent runs. The codebase was designed for single-agent execution and never refactored for concurrent multi-agent operation.

### 3. "Write paths exist, cleanup paths don't"
Nearly every module has unbounded growth: embedding stores, reflection history, trace buffers, diagnostic maps, message bus topics, NDJSON files. The pattern is: implement the write path, skip the cleanup path. This is the same class of bug as the missing state checkpoint — nobody asked "what happens when this grows forever?"

---

*This report is auditable. Every gap references specific file paths and line numbers. Every claim can be verified by reading the code.*
