# Observability & Reversibility to Industry Top 1 — Design Spec

**Date**: 2026-06-28
**Status**: Approved
**Author**: Commander Team
**Goal**: Push observability and reversibility both to 10/10, building the most trustworthy agent runtime for enterprise use.

---

## 1. Design Philosophy: Enterprise Trust Triangle

```
         Observability (10/10)
         "I can see what the system does"
             /                \
            /                  \
           /                    \
  Reversibility ------------- Auditability
  (10/10)                     (already strong)
  "Recovers from failure"   "Tamper-evident trace"
```

Enterprise trust = Visibility + Recoverability + Auditability. Commander already has strong auditability (AuditChainLedger HMAC hash chain, SLO→incident pipeline). This spec focuses on visibility and recoverability while ensuring all three synergize: the event log serves recoverability (replay), auditability (hash chain), and visibility (real-time event stream monitoring).

## 2. Current State (Post-P0 Partial)

| Domain | Score | Key Gaps |
|--------|-------|----------|
| Observability | 7.2/10 | W3C tracing middleware lost, PII redaction lost, eval platform shallow, no log aggregation, no Grafana bundle, dual MetricsCollector |
| Reversibility | 5.5/10 | EventSourcingEngine WAL init saved but no event sync, RecoveryBootstrapper not wired, ContractEventBus in-memory, 3 saga impls, no determinism, no replay recovery |

## 3. Architecture Decision: Hybrid (Event Sourcing + Checkpoint + Compensation)

**Chosen over full Temporalization.** Three recovery paths provide defense-in-depth:
1. **Event log replay** — strongest, reconstructs state event-by-event
2. **Checkpoint recovery** — fast path, resumes from last checkpoint
3. **Compensation rollback** — handles external side effects (Temporal lacks this)

Conflict resolution: event log replay takes precedence; checkpoint is optimization; compensation handles irreversible external effects.

**Soft determinism** (not hard): don't forbid Date.now/random/LLM (Temporal approach), instead **record all non-deterministic inputs** to the event log. Replay uses recorded values, guaranteeing "replay produces same result." More pragmatic for LLM-native systems.

## 4. Execution Plan: 3 Phases

### Phase 0: Event Sourcing Foundation Repair (1-2 weeks)

#### 4.1 Re-apply Lost P0 Code

**a) `runLedger.ts` event sync** — Add `emitSourcingEvent(type, payload)` private method. Fire-and-forget to EventSourcingEngine at 6 state transitions: `start`/`beginExecuting`/`beginVerifying`/`commit`/`recordAction`/`abort`. Each event includes runId, tenantId, state, timestamp. Never blocks state machine (try-catch + reportSilentFailure).

**b) `httpServer.ts` W3C tracing middleware** — Import `extractTraceFromHeaders`/`createTraceContext`/`runWithTrace`. Each HTTP request: extract trace context from `x-request-id`/`x-trace-id`/`x-span-id`/`x-baggage` headers or create new. Wrap handler in `runWithTrace(traceContext, handler)`. AsyncLocalStorage propagates traceId to all downstream logs, LLM calls, tool executions, message bus events.

**c) `openTelemetryExporter.ts` PII redaction** — Add `redactInput`/`redactOutput`/`redactToolArgs` config options (default all true). Add `redactSpan(span)` method that strips `gen_ai.prompt`/`gen_ai.completion`/`gen_ai.tool.call.arguments`/`data.input`/`data.output`/`tool.args`/`arguments` attributes before queuing. Even if Collector endpoint is misconfigured, user prompts/completions never touch network or disk.

#### 4.2 RecoveryBootstrapper Wiring

Call `RecoveryBootstrapper.bootstrap()` in `serviceInitializer.ts` and `httpServer.ts` startup sequence, after `installProcessCrashHandlers`:
- Scan RunLedger for runs in EXECUTING/VERIFYING/PAUSED
- Validate lease expiry → fence (bump fencing epoch) → recover or abort+compensate → write DLQ
- Idempotent, silent return if no zombies
- Log summary if scanned > 0

#### 4.3 EventSourcingEngine Deep Wiring

Beyond RunLedger sync, cover the **complete agent execution lifecycle** via subscriber pattern (zero invasion of agentRuntime.ts God object):

```
Event types:
  run.started / run.executing / run.verifying / run.committed / run.aborted
  action.recorded
  llm.call.started / llm.call.completed
  tool.call.started / tool.call.completed
  checkpoint.written
  compensation.started / compensation.completed
```

**New file: `runtime/eventSourcingSubscriber.ts`** — Subscribes to MessageBus topics, forwards events to EventSourcingEngine WAL. Decoupled: engine failure doesn't affect agent runtime.

```typescript
export class EventSourcingSubscriber {
  constructor(private bus: MessageBus, private engine: EventSourcingEngine) {}
  start(): void {
    this.bus.subscribe('llm.call.started', (e) => this.forward(e));
    this.bus.subscribe('llm.call.completed', (e) => this.forward(e));
    this.bus.subscribe('tool.call.started', (e) => this.forward(e));
    this.bus.subscribe('tool.call.completed', (e) => this.forward(e));
    // ... run/action/checkpoint/compensation topics
  }
  private async forward(event: BusEvent): Promise<void> {
    try {
      await this.engine.append({ type: event.topic, payload: event.data, correlationId: event.runId });
    } catch (err) {
      reportSilentFailure(err, 'eventSourcingSubscriber:forward');
    }
  }
}
```

Wire subscriber in `serviceInitializer.ts` after EventSourcingEngine init.

#### 4.4 Event Log Health Monitoring

**New file: `runtime/eventSourcingHealth.ts`** — 9th component in healthCheck.ts:
- WAL write latency (p95 of last 100 appends)
- Hash chain integrity (hourly `verifyIntegrity()`)
- WAL file size (>100MB triggers compaction alert)
- Event backlog ratio (events.length vs snapshots count)

#### 4.5 Phase 0 Acceptance Criteria

- [ ] RunLedger 6 state transitions write to EventSourcingEngine
- [ ] LLM/tool/checkpoint/compensation events flow via subscriber
- [ ] RecoveryBootstrapper executes on serviceInitializer + httpServer startup
- [ ] W3C trace context propagates through all HTTP requests, logs carry correlation ID
- [ ] PII redaction default on, OTel spans contain no raw prompt/completion
- [ ] healthCheck includes event log health component
- [ ] Full test suite passes (2852+ tests)
- [ ] New tests: event sourcing wiring, recovery bootstrap, PII redaction

---

### Phase 1: Observability → 10/10 (3-4 weeks)

#### 4.6 Evaluation Platform (2-3 weeks)

**a) LLM-as-Judge engine** — New file `evaluation/llmJudgeEngine.ts`:
- 5-dimension scoring: correctness / completeness / safety / helpfulness / latency-cost efficiency
- Each dimension 0-1 score + confidence
- Judge prompt template versioned, supports A/B comparison
- Batch evaluation: async queue, results to `.commander_eval/judge-results.ndjson`
- Anti-self-eval bias: judge model must differ from evaluated model provider
- **Cost circuit breaker** (user feedback): token bucket rate limiting + per-evaluation token hard cap

**b) Dataset version management** — New file `evaluation/datasetManager.ts`:
- Dataset = named collection of test cases (input + expected output + metadata)
- Versioning: each modification creates new immutable version, supports rollback
- Persistence: SQLite `eval_datasets` + `eval_dataset_items` + `eval_dataset_versions` tables
- Import/export: JSON Lines, Langfuse-compatible format

**c) A/B experiment comparison** — Extend `experimentRunner.ts`:
- Experiment = compare multiple configs (prompt version / model / params) on dataset
- Statistical significance: Wilcoxon signed-rank test (non-parametric, small sample)
- Reuse existing `/compare/:runIdA/:runIdB` endpoint, extend for eval results

**d) Evaluation HTTP API** — Extend `observability/httpApi.ts`:
```
POST   /api/v1/eval/datasets              Create dataset
GET    /api/v1/eval/datasets              List datasets
POST   /api/v1/eval/datasets/:id/items    Add test cases
POST   /api/v1/eval/judge                 Trigger LLM-as-Judge
POST   /api/v1/eval/experiments           Create A/B experiment
GET    /api/v1/eval/experiments/:id       Get experiment results
```

#### 4.7 Log Aggregation Layer (1 week)

**a) Log persistence** — Extend `logging.ts`:
- New optional `LogPersistence` layer: async write to SQLite `app_logs` table (WAL mode)
- `PRAGMA busy_timeout = 5000` + `PRAGMA synchronous = NORMAL` (user feedback: prevent SQLITE_BUSY)
- Env var `COMMANDER_LOG_PERSIST=true` enables, default off
- Auto-rotation: retain 7 days, auto-cleanup
- **Backpressure degradation** (user feedback): if write queue >10000, drop Debug/Info, persist only Error

**b) Log query API** — New file `observability/logApi.ts`:
```
GET /api/v1/logs?level=error&component=AgentRuntime&traceId=xxx&since=2026-06-28T00:00
```
- Filter by level / component / traceId / runId / time range
- Pagination + cursor (avoid memory explosion)

#### 4.8 Grafana/Prometheus Bundle (3-5 days)

**a) Docker Compose** — New `deploy/observability/docker-compose.yml`:
- Prometheus (scrape `/metrics`)
- Grafana (pre-configured dashboards)
- Jaeger (receive OTLP, optional)

**b) Pre-configured dashboards** — `deploy/observability/grafana/dashboards/`:
- **Developer view** (user feedback: role-based layering): run success rate, token cost, p95 latency
- **Mechanistic view**: WAL latency, lock contention, event backlog ratio, circuit breaker state
- LLM Performance: per-model successRate / tokenUsage / latency
- Security: audit event rate, DLQ backlog, compensation execution count

**c) Helm** — Update `deploy/helm/commander/values.yaml`:
- `otel.enabled` default `true`
- New `grafana.enabled`, `prometheus.enabled` options

#### 4.9 Unify Dual MetricsCollector (1 week)

- Legacy `logging.ts` MetricsCollector → **adapter** delegating to `getMetricsCollector()`
- Security audit logger switches to main collector's `recordSecurityEvent()`
- Deprecate `getGlobalMetrics()`, unify to `getMetricsCollector()`
- Add `summary` metric type (currently only counter/gauge/histogram)

#### 4.10 Phase 1 Acceptance Criteria

- [ ] LLM-as-Judge supports 5-dimension scoring + confidence + batch + cost circuit breaker
- [ ] Dataset versioning supports create/modify/rollback/import/export
- [ ] A/B experiment supports statistical significance test
- [ ] Log persistence (SQLite WAL + busy_timeout + backpressure) + query API
- [ ] Docker Compose one-click full observability stack
- [ ] Grafana pre-configured with Developer + Mechanistic views
- [ ] Dual MetricsCollector unified to single interface
- [ ] Full test suite + new eval platform tests

---

### Phase 2: Reversibility → 10/10 (4-8 weeks)

#### 4.11 Soft Determinism Constraint (2-3 weeks, core)

**Design: record, don't forbid.** Non-deterministic inputs are captured to event log; replay uses recorded values.

**a) Non-determinism capture** — New file `runtime/determinismCapture.ts`:
```typescript
export class DeterminismCapture {
  captureTimestamp(runId: string): number  // records Date.now()
  captureRandom(runId: string): number     // records Math.random()
  captureLLMResponse(runId: string, step: number, response: unknown): void
  captureToolResponse(runId: string, step: number, response: unknown): void
  replay(runId: string): ReplayContext  // reads recorded values from event log
}
```

**b) ReplayContext** — Returns recorded values during replay, doesn't recompute:
- `getTimestamp()` → recorded timestamp
- `getRandom()` → recorded random value
- `getLLMResponse(step)` → recorded LLM response (no LLM call)
- `getToolResponse(step)` → recorded tool response (no tool execution)

**c) Wiring** — Via `phases/` stage hooks, not invading agentRuntime main loop:
- `phases/planning.ts`: capture/replay LLM responses
- `phases/toolExecution.ts`: capture/replay tool responses
- Replay mode triggered by `RunRecovery.attempt()` when complete event log exists

**d) Replay correctness test** — New `tests/reversibility/replay-determinism.test.ts`:
- Record full run's non-deterministic inputs
- Replay from event log, verify each step matches original
- Verify LLM not re-called (mock assertion)

#### 4.12 Event Replay Recovery (2 weeks)

**Three-path recovery strategy selector** — Extend `runRecovery.ts`:
```typescript
attempt(runId: string): RecoveryResult {
  if (this.hasCompleteEventLog(events))  → replayRecovery(runId, events)   // strongest
  else if (this.hasCheckpoint(runId))    → checkpointRecovery(runId)        // fast path
  else                                    → abortAndCompensate(runId)        // fallback
}
```

**Replay recovery flow** (`replayRecovery()`):
1. Read all events for run from EventSourcingEngine (`run.started` → `llm.call.completed` → `tool.call.completed` → ...)
2. Build ReplayContext with all recorded non-deterministic inputs
3. Replay agent execution loop from `run.started`
4. Per-step compare: replay result vs event log → continue if match, alert + degrade to checkpoint if mismatch
5. Reach crash point → resume execution

**Snapshot acceleration** — Periodic `engine.snapshot()` (every 50 steps or 5 min), replay starts from latest snapshot, `engine.compact(snapshotId)` cleans pre-snapshot events.

#### 4.13 Persist ContractEventBus (1 week)

Wire `ContractEventBus` to EventSourcingEngine WAL backend:
- `publish()` writes to both in-memory log (for real-time subscribers) and WAL (for durability)
- `replayFrom()` reads from WAL instead of in-memory log
- Survives restart, replay capability preserved

#### 4.14 Consolidate 3 Saga Implementations (2-3 weeks)

ATR RunLedger becomes single source of truth, others become adapters:
- `sagaCoordinator.ts` `collectAllCompensable()` → delegates to `RunLedger.getCompensableActions()`
- `compensationRegistry.ts` `compensateAll()` → delegates to `RunLedger.abortAndCompensate()`
- `compensationBridge.ts` retired (bridge no longer needed)
- Preserve external APIs (backward compat), internal delegation to RunLedger

#### 4.15 Remaining Gaps (1 week)

**a) GitSnapshot index persistence** — New `atr/gitSnapshotStore.ts`:
- Persist runId→ref mapping to SQLite
- Survives process crash, `restoreGitSnapshot()` works after restart

**b) Schema migration/rollback** — New `runtime/migrationManager.ts`:
- `schema_version` table tracks current version
- `migrations/` directory, sequential execution by version
- Support down migration (rollback)
- Auto-check on startup

#### 4.16 Enterprise Trust Safeguards (throughout Phase 2)

**a) Recovery drill test** — `tests/reversibility/recovery-drill.test.ts`:
- Simulate process crash (kill -9)
- Verify RecoveryBootstrapper auto-recovers zombies
- Verify event replay matches original run state
- Verify compensation rollback executes correctly

**b) Recovery SLA monitoring** — Extend SLO:
- `recovery.time_to_recover`: p95 time from crash to recovery
- `replay.accuracy`: consistency rate of replay vs original run
- `compensation.success_rate`: compensation success rate

**c) Gradual rollout** — Event replay recovery per-tenant:
- `tenantConfig.recoveryStrategy: 'checkpoint' | 'replay' | 'hybrid'`
- New tenants default `hybrid` (prefer replay, degrade to checkpoint)
- Can rollback to `checkpoint`-only at any time

#### 4.17 Phase 2 Acceptance Criteria

- [ ] Soft determinism capture records timestamp/random/LLM response/tool response
- [ ] Event replay recovery: reconstruct agent state from event log, matches original
- [ ] Replay correctness test: mock LLM not re-called
- [ ] ContractEventBus persisted to WAL, survives restart
- [ ] 3 Saga impls consolidated to single RunLedger source of truth
- [ ] GitSnapshot index persisted to SQLite
- [ ] Schema migration/rollback available
- [ ] Recovery drill test passes (kill -9 scenario)
- [ ] Recovery SLA SLO monitoring active
- [ ] Gradual rollout config usable
- [ ] Full test suite + new reversibility tests

---

## 5. Final Maturity Projection

| Dimension | Current | Phase 0 | Phase 1 | Phase 2 |
|-----------|---------|---------|---------|---------|
| Event sourcing | 3 | 7 | 7 | **10** |
| Replay recovery | 5 | 5 | 5 | **10** |
| Determinism | 2 | 2 | 2 | **10** |
| Compensation/Saga | 9 | 9 | 9 | **10** |
| Crash recovery | 6 | 8 | 8 | **10** |
| Distributed tracing | 5 | 8 | 9 | **10** |
| Structured logging | 6 | 7 | **10** | **10** |
| Eval platform | 6 | 6 | **10** | **10** |
| Dashboards | 7 | 7 | **10** | **10** |
| Metrics | 9 | 9 | **10** | **10** |
| Cost/Token | 10 | 10 | **10** | **10** |
| Security audit | 9 | 9 | **10** | **10** |
| SLO/alert/incident | 9 | 9 | **10** | **10** |
| Health checks | 8 | 9 | **10** | **10** |
| DLQ | 9 | 9 | 9 | **10** |
| Lease/fencing | 9 | 9 | 9 | **10** |
| Idempotency | 9 | 9 | 9 | **10** |

**Observability: 7.2 → 10/10 | Reversibility: 5.5 → 10/10**

## 6. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| EventSourcingEngine WAL corruption | Hash chain verifyIntegrity() hourly, compaction, checkpoint fallback |
| Replay mismatch (non-determinism not fully captured) | Per-step compare + auto-degrade to checkpoint recovery |
| Saga consolidation breaks existing behavior | Adapters preserve external API, comprehensive regression tests |
| Eval platform cost explosion | Token bucket + hard cap per evaluation |
| Log persistence SQLite lock contention | busy_timeout=5000, synchronous=NORMAL, backpressure degradation |
| Gradual rollout safety | Per-tenant recoveryStrategy config, instant rollback to checkpoint-only |
