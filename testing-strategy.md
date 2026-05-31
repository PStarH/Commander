# Commander Testing Strategy

## Executive Summary

Commander is a multi-agent orchestration system with a deliberation → scaling → topology → decomposition → execution → synthesis → quality-gate pipeline. This document defines a layered testing strategy covering unit, integration, E2E, performance, and chaos testing across all subsystems.

**Test Framework:** Vitest (unit/integration), k6 (load/performance), custom chaos harness (chaos)
**Current Coverage:** statements 21%, branches 65%, functions 40%, lines 21%
**Target Coverage:** statements 60%, branches 80%, functions 70%, lines 60%

---

## 1. Unit Test Priorities

### Priority Tiers

#### Tier 1 — Critical Path (must pass before any merge)
These modules form the core execution pipeline; bugs here cascade everywhere.

| Module | Key Functions | Test Focus |
|--------|--------------|------------|
| `ultimate/deliberation.ts` | `deliberate()`, `deliberateWithLLM()` | Keyword classifier accuracy, LLM fallback, edge cases (empty input, adversarial strings) |
| `ultimate/topologyRouter.ts` | `routeTopology()` | Correct topology for each DAG shape, budget-constrained routing, fallback logic |
| `ultimate/atomizer.ts` | `decompose()` | Recursive termination, dependency cycle detection, max depth enforcement, all 3 strategies (ASPECT/STEP/RECURSIVE) |
| `ultimate/effortScaler.ts` | `scale()` | Agent count bounds (1–20), token budget allocation, SIMPLE→DEEP_RESEARCH mapping correctness |
| `runtime/agentRuntime.ts` | `executeStep()` | Caching, retry, observation masking, context window management |
| `runtime/modelRouter.ts` | `route()` | Tier selection (eco→standard→power→consensus), fallback cascade, cost thresholds |
| `runtime/circuitBreaker.ts` | `trip()`, `reset()` | State transitions (CLOSED→OPEN→HALF_OPEN), timeout behavior |
| `runtime/llmRetry.ts` | `classifyLLMError()`, `computeBackoff()` | Error classification accuracy, exponential backoff with jitter, max retries |
| `synthesizer.ts` | `synthesize()` | Quality gate enforcement (hallucination/consistency/completeness/accuracy/safety), merge logic |
| `artifactSystem.ts` | `resolve()` | Reference resolution, circular reference detection, stale artifact handling |

#### Tier 2 — Important (target 80% coverage)
Supporting subsystems with well-defined interfaces.

| Module | Test Focus |
|--------|------------|
| `telos/tokenSentinel.ts` | Budget enforcement, overage detection, graceful degradation |
| `telos/providerPool.ts` | Provider failover, health checks, cost tracking accuracy |
| `selfEvolution/metaLearner.ts` | Thompson Sampling convergence, Reflexion persistence, cross-session state |
| `sandbox/execPolicy.ts` | Policy evaluation, command blocklisting, escalation paths |
| `runtime/messageBus.ts` | Pub/sub delivery, ordering guarantees, subscriber failure isolation |
| `pluginLoader.ts` / `pluginManager.ts` | Load/enable/disable lifecycle, version compatibility checks |
| `capabilityRegistry.ts` | Semantic matching accuracy, capability deduplication, registry CRUD |
| `agentTeamManager.ts` | Team creation, inbox messaging, shared task assignment |

#### Tier 3 — Coverage (target 50%+ coverage)
Utility and peripheral modules.

| Module | Test Focus |
|--------|------------|
| `runtime/embedding.ts` | Vector generation (real + mock providers), dimension validation |
| `runtime/executionTrace.ts` | Trace recording, serialization, retrieval |
| `runtime/sseStream.ts` | Event formatting, connection lifecycle, backpressure |
| `contentScanner.ts` | Content classification, PII detection |
| `threeLayerMemory.ts` | Layer promotion/demotion, capacity limits, TTL expiration |
| `logging.ts` | Structured output, level filtering, redaction |

### Unit Test Patterns

```typescript
// Example: Deterministic test with mocked LLM
describe('deliberate', () => {
  it('classifies trivial tasks as SIMPLE without LLM call', () => {
    const plan = deliberate({ input: 'What time is it?' });
    expect(plan.effortLevel).toBe('SIMPLE');
    expect(plan.estimatedAgentCount).toBe(1);
  });

  it('detects cycle in task DAG and falls back to SEQUENTIAL', () => {
    const dag = createCyclicDAG();
    const topology = routeTopology(dag);
    expect(topology).toBe('SEQUENTIAL'); // safe fallback
  });

  it('respects max decomposition depth', () => {
    const task = { complexity: 10, maxDepth: 3 };
    const tree = decompose(task);
    expect(maxDepth(tree)).toBeLessThanOrEqual(3);
  });
});
```

### Mocking Strategy

| Layer | Mock Approach |
|-------|--------------|
| LLM providers | Record/replay fixtures from `tests/helpers/` — never call real APIs in unit tests |
| File system | `memfs` or `tmp` directories for sandbox/state tests |
| Network (HTTP/SSE) | MSW (Mock Service Worker) or hand-rolled `http.Server` |
| Time-dependent logic | `vi.useFakeTimers()` for circuit breaker, retry backoff, TTL |
| Randomness | Seed-based RNG for chaos monkey determinism |

---

## 2. Integration Test Scenarios

Integration tests verify subsystem wiring and data flow across module boundaries.

### 2.1 Pipeline Integration

| Scenario | Subsystems | Validation |
|----------|-----------|------------|
| **Full pipeline: SIMPLE task** | Deliberation → EffortScale → Topology → Decompose → Execute → Synthesize | Single agent, correct topology (SINGLE), quality gates pass |
| **Full pipeline: COMPLEX task** | All phases | Multi-agent (4–8), HIERARCHICAL topology, dependency ordering, artifact passing |
| **Full pipeline: DEEP_RESEARCH** | All phases | Max agents (15–20), ENSEMBLE/DEBATE topology, iterative synthesis |
| **Budget-constrained pipeline** | Telos + Orchestrator | Topology downgrades under budget pressure, agent count reduced, graceful degradation |
| **Pipeline with failing subtask** | Runtime + Synthesizer | Dead letter queue captures failure, compensation triggered, partial synthesis succeeds |

### 2.2 Runtime Integration

| Scenario | Components | Validation |
|----------|-----------|------------|
| **Model router fallback cascade** | ModelRouter + Providers | Provider A fails → B tried → C tried → consensus fallback |
| **Message bus + agent handoff** | MessageBus + AgentHandoff + AgentInbox | Task assigned via inbox, executed, result published |
| **Circuit breaker integration** | CircuitBreaker + AgentRuntime | Trip after N failures, half-open probe, recovery |
| **State checkpoint + recovery** | StateCheckpointer + AgentRuntime | Crash mid-execution → resume from last checkpoint |
| **MCP distributed execution** | MCPRemoteRuntime + SubAgent | Remote agent executes subtask, returns artifact, local synthesizes |

### 2.3 Sandbox Integration

| Scenario | Validation |
|----------|------------|
| **Exec policy blocks dangerous commands** | `rm -rf /`, `curl` to unapproved hosts → blocked with audit log |
| **Sandbox resource limits** | Memory/CPU/timeout limits enforced, process killed on violation |
| **Multi-tenant isolation** | Tenant A state invisible to Tenant B, shared resources properly partitioned |

### 2.4 Integration Test Infrastructure

```typescript
// Use test fixtures for LLM responses
const mockProvider = createRecordedProvider('fixtures/complex-task-responses.json');

// Shared setup for pipeline tests
beforeEach(async () => {
  orchestrator = createTestOrchestrator({
    providers: [mockProvider],
    budget: { maxTokens: 100_000, maxCostUsd: 1.0 },
    telemetry: new InMemoryTelemetryCollector(),
  });
});
```

---

## 3. E2E Test Flows

End-to-end tests exercise the full system from CLI entry to final output.

### 3.1 Happy Path Flows

| Flow | Steps | Assertion |
|------|-------|-----------|
| **CLI: simple query** | `commander run "What is 2+2?"` → pipeline → stdout | Output contains "4", exit code 0, latency < 5s |
| **CLI: complex research** | `commander run "Compare React vs Vue"` → pipeline → report | Multi-agent synthesis, structured output, quality gates pass |
| **CLI: code generation** | `commander run "Write a fizzbuzz in Python"` → pipeline | Valid Python output, test cases pass |
| **API: submit task** | POST `/tasks` → GET `/tasks/:id/status` → GET `/tasks/:id/result` | Task completes, result matches expected structure |
| **API: streaming** | POST `/tasks` with SSE → real-time events | Progress events emitted, final event contains result |
| **Multi-agent debate** | Task requiring consensus → DEBATE topology | Multiple agent responses, convergence message, final answer |

### 3.2 Error & Recovery Flows

| Flow | Steps | Assertion |
|------|-------|-----------|
| **Provider outage** | Mock primary provider failure → fallback | Task completes via secondary provider, no data loss |
| **Mid-execution crash** | Kill process at 50% → restart | Checkpoint recovered, task resumes, completes |
| **Invalid input** | Malformed/empty/adversarial input → pipeline | Graceful error message, no crash, appropriate exit code |
| **Budget exhaustion** | Set budget to 10 tokens → complex task | Early termination with partial results, clear error |
| **Concurrent tasks** | Submit 10 tasks simultaneously | All complete, no cross-contamination, fair scheduling |

### 3.3 E2E Test Infrastructure

- **Fixture-based:** Pre-recorded LLM responses for deterministic E2E runs
- **Docker Compose:** Spin up full stack (HTTP server + Redis + providers) for integration E2E
- **Snapshot testing:** Compare synthesized outputs against golden snapshots (with review for drift)

---

## 4. Performance Benchmarks

### 4.1 Latency Benchmarks

| Metric | Target | Measurement |
|--------|--------|-------------|
| Deliberation (keyword) | < 1ms | P99 latency for `deliberate()` |
| Deliberation (LLM) | < 200ms | P99 with mock provider |
| Topology routing | < 5ms | P99 for `routeTopology()` |
| Task decomposition (SIMPLE) | < 10ms | P99 for single-agent tasks |
| Task decomposition (COMPLEX) | < 100ms | P99 for multi-agent DAG construction |
| Full pipeline (SIMPLE) | < 5s | End-to-end with mocked LLM |
| Full pipeline (COMPLEX) | < 30s | End-to-end with mocked LLM (8 agents) |
| Synthesis (5 agents) | < 500ms | Synthesis phase only |

### 4.2 Throughput Benchmarks

| Metric | Target | Setup |
|--------|--------|-------|
| Concurrent tasks (HTTP API) | 50 req/s sustained | k6 load test with 10 VUs |
| Message bus throughput | 1000 events/s | Synthetic pub/sub benchmark |
| Task checkpoint write | 100 writes/s | StateCheckpointer benchmark |
| Artifact resolution | 500 lookups/s | ArtifactSystem benchmark |

### 4.3 Resource Benchmarks

| Metric | Target | Measurement |
|--------|--------|-------------|
| Memory per agent execution | < 50MB | RSS delta during agentRuntime.execute() |
| Memory for 20-agent pipeline | < 500MB | RSS peak during DEEP_RESEARCH topology |
| Token estimation accuracy | ±5% | Compare estimated vs actual token counts |
| CPU utilization (8 agents) | < 80% single core | During parallel execution |

### 4.4 Performance Regression Detection

```yaml
# .commander_benchmarks/baseline.json
{
  "deliberate_keyword_p99_us": 800,
  "full_pipeline_simple_ms": 4500,
  "full_pipeline_complex_ms": 25000,
  "concurrent_tasks_rps": 55,
  "memory_per_agent_mb": 45,
  "synthesis_5agents_ms": 400
}
```

- **CI gate:** Fail if any metric regresses > 20% from baseline
- **Trend tracking:** Store results in `.commander_benchmarks/` with git history
- **k6 thresholds:** `http_req_duration: p(95)<500`, `errors: rate<0.01`

### 4.5 Benchmark Implementation

- Use `tests/runtime/performance-profiling.test.ts` for micro-benchmarks
- Extend `tests/load/load-test.k6.js` for API throughput
- Add `benchmark.test.ts` for regression detection
- Store baselines in `.commander_benchmarks/`

---

## 5. Chaos Testing Approach

Chaos testing validates system resilience under unpredictable, adversarial conditions.

### 5.1 Existing Chaos Infrastructure

The system already has `chaos-monkey.test.ts` with:
- Random delay injection (0–5000ms)
- Random error injection (5% rate)
- Message shuffling (10% rate)
- Language switching (multilingual input corruption)

### 5.2 Chaos Test Categories

#### Network Chaos
| Injection | Target | Expected Behavior |
|-----------|--------|-------------------|
| **Provider timeout** | LLM API calls | Retry with backoff → circuit breaker trips → fallback provider |
| **Network partition** | MCP remote runtime | Local execution fallback, no hanging |
| **DNS failure** | All external calls | Graceful degradation, cached results used |
| **Partial response** | Streaming SSE | Connection reconnect, resume from last event ID |
| **TLS certificate expiry** | Provider connections | Clear error, skip to next provider |

#### Process Chaos
| Injection | Target | Expected Behavior |
|-----------|--------|-------------------|
| **OOM kill mid-agent** | AgentRuntime | Checkpoint recovery, partial result preserved |
| **SIGTERM during synthesis** | Synthesizer | Graceful shutdown, partial synthesis output |
| **Fork bomb from sandbox** | Sandbox exec | Resource limits kill children, parent process safe |
| **Infinite loop agent** | AgentRuntime | Timeout kills agent, step boundary catches, DLQ entry |

#### Data Chaos
| Injection | Target | Expected Behavior |
|-----------|--------|-------------------|
| **Corrupted state file** | StateCheckpointer | Detect corruption, rebuild from last valid checkpoint |
| **Circular artifact references** | ArtifactSystem | Detect and break cycle, return error artifact |
| **Massive context overflow** | ContextCompactor | Auto-compact, preserve critical information |
| **Adversarial LLM output** | Synthesizer | Quality gates catch hallucinations, reject/retry |
| **Encoding corruption** | Content scanner | Detect malformed UTF-8, quarantine content |

#### Resource Chaos
| Injection | Target | Expected Behavior |
|-----------|--------|-------------------|
| **Disk full** | State persistence | Queue writes, alert, graceful degradation |
| **Token budget overflow** | TokenSentinel | Hard stop, enforce budget, partial results |
| **Connection pool exhaustion** | ModelRouter | Queue requests, no crashes, eventual completion |
| **Concurrent write conflicts** | AgentTeamManager | Optimistic locking, no data corruption |

### 5.3 Chaos Test Execution

```typescript
// chaos-engine.test.ts — Extended chaos framework
describe('Chaos Engine', () => {
  const chaos = new ChaosEngine({
    seed: Date.now(),           // reproducible per run
    maxConcurrent: 3,           // max simultaneous injections
    budget: { maxInjections: 50, maxDurationMs: 60_000 },
  });

  it('survives 30 seconds of random chaos on full pipeline', async () => {
    const result = await chaos.run(async (inject) => {
      inject.network.partition({ durationMs: 2000, target: 'provider.openai' });
      inject.process.kill({ signal: 'SIGTERM', probability: 0.05 });
      inject.data.corrupt({ probability: 0.1, target: 'checkpoint' });
      inject.resource.exhaust({ target: 'disk', durationMs: 5000 });
      
      return runFullPipeline(SIMPLE_TASK);
    });

    expect(result.completed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.metrics.recoveryCount).toBeGreaterThan(0); // system self-healed
  });
});
```

### 5.4 Chaos Metrics & Reporting

| Metric | Target | Description |
|--------|--------|-------------|
| **Recovery rate** | 100% | % of chaos events the system recovered from |
| **MTTR (Mean Time To Recovery)** | < 5s | Average time to recover from injected failure |
| **Data integrity** | 100% | No data loss or corruption after chaos |
| **Graceful degradation** | > 95% | % of tasks completing (possibly partial) under chaos |
| **No cascading failures** | 100% | Single injection never causes multiple unrelated failures |

### 5.5 Chaos Testing Schedule

- **CI (every PR):** Lightweight chaos — 5 injections, 10s duration, deterministic seed
- **Nightly:** Medium chaos — 25 injections, 30s duration, varied seeds
- **Weekly:** Heavy chaos — 50+ injections, 60s duration, resource exhaustion, network partitions
- **Pre-release:** Full chaos — 100+ injections, 120s, all categories, stress conditions

---

## 6. Test Infrastructure & CI/CD

### 6.1 Test Suites

| Suite | Runner | Scope | Duration Target |
|-------|--------|-------|-----------------|
| `unit` | Vitest | Tier 1–3 unit tests | < 2 min |
| `integration` | Vitest | Subsystem wiring tests | < 5 min |
| `e2e` | Vitest + Docker | Full pipeline flows | < 10 min |
| `performance` | Vitest + k6 | Benchmarks | < 5 min |
| `chaos` | Vitest | Chaos monkey tests | < 3 min |

### 6.2 CI Pipeline

```
PR Created
  ├── lint (eslint)
  ├── unit tests (parallel)
  ├── integration tests (parallel)
  ├── lightweight chaos (deterministic)
  ├── performance regression check
  └── coverage gate (statements ≥ 60%)
      
Nightly
  ├── full test suite
  ├── medium chaos
  ├── k6 load tests
  └── benchmark trend update

Pre-release
  ├── all nightly checks
  ├── heavy chaos
  └── E2E smoke suite
```

### 6.3 Test Data Management

- **LLM fixtures:** `tests/helpers/fixtures/` — recorded provider responses
- **Task fixtures:** `tests/helpers/tasks/` — standard task definitions per complexity level
- **Golden snapshots:** `tests/__snapshots__/` — expected outputs for E2E tests
- **Chaos seeds:** Generated per-run, logged for reproducibility

### 6.4 Coverage Thresholds (Updated)

```typescript
// vitest.config.ts targets
thresholds: {
  statements: 60,  // from 21
  branches: 80,    // from 65
  functions: 70,   // from 40
  lines: 60,       // from 21
}
```

### 6.5 Key Commands

```bash
# Unit tests
pnpm --filter @commander/core test

# Integration tests  
pnpm --filter @commander/core test -- --include='tests/runtime/*.test.ts'

# E2E tests
pnpm --filter @commander/core test -- --include='tests/e2e.test.ts'

# Chaos tests
pnpm --filter @commander/core test -- --include='tests/chaos-monkey.test.ts'

# Performance benchmarks
pnpm --filter @commander/core test -- --include='tests/benchmark.test.ts'

# Load tests (requires k6)
k6 run packages/core/tests/load/load-test.k6.js

# Coverage report
pnpm --filter @commander/core test -- --coverage
```

---

## 7. Prioritized Roadmap

### Phase 1: Foundation (Week 1–2)
- [ ] Add Tier 1 unit tests for `deliberation.ts`, `topologyRouter.ts`, `atomizer.ts`, `circuitBreaker.ts`
- [ ] Implement deterministic LLM fixture system (record/replay)
- [ ] Add vitest configuration for parallel test execution
- [ ] Raise branch coverage from 65% → 75%

### Phase 2: Integration (Week 3–4)
- [ ] Pipeline integration tests (SIMPLE → COMPLEX → DEEP_RESEARCH)
- [ ] Runtime integration: model router fallback, message bus, state checkpoint
- [ ] Sandbox integration: exec policy, resource limits, tenant isolation
- [ ] E2E flows: CLI happy path, API task submission, streaming

### Phase 3: Performance & Chaos (Week 5–6)
- [ ] Performance benchmarks with regression detection baselines
- [ ] Extend chaos monkey with network/process/data/resource categories
- [ ] k6 load test expansion (task submission, concurrent agents)
- [ ] CI gates: latency thresholds, throughput minimums, chaos recovery rate

### Phase 4: Hardening (Week 7–8)
- [ ] Achieve all coverage targets (statements 60%, branches 80%)
- [ ] Nightly chaos runs with reporting dashboard
- [ ] Pre-release chaos protocol
- [ ] Documentation: test writing guide for contributors
