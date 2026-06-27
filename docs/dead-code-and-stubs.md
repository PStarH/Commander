# Dead Code, Stubs, and Unwired Modules Audit

> Full codebase scan: 2026-06-24. Last updated: 2026-06-24.
> Organized by severity. Resolve or remove before v1.0.0.

---

## CRITICAL — Written but Never Integrated (all REMOVED 2026-06-24)

The following orphaned modules were identified and have been **deleted**:

| Module                                                          | Lines | Action                                                                                                                             |
| --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `actor/` (actorSystem, workerAgent, supervisor, mailbox, types) | 1,728 | **DELETED** — completely orphaned                                                                                                  |
| `inspectorAgent.ts`                                             | 571   | **DELETED** — barrel-only export, replacement exists                                                                               |
| `frameworkIntegration.ts`                                       | 237   | **DELETED** — orphaned                                                                                                             |
| `adaptiveOrchestrator.ts`                                       | 649   | **DELETED** — half-orphaned, no active callers                                                                                     |
| `tokenBudgetAllocator.ts`                                       | 393   | **DELETED** — half-orphaned, no active callers                                                                                     |
| `tests/integration.test.ts`                                     | 448   | **DELETED** — sole consumer of `TokenBudgetAllocator` / `AdaptiveOrchestrator` / `InspectorAgent`; test target was itself orphaned |
| `tests/e2e.test.ts`                                             | 418   | **DELETED** — same verdict; integration tested deleted subsystems                                                                  |

---

## HIGH — Duplicate / Overlapping Modules (RESOLVED 2026-06-24)

| New Module                              | Old Module               | Action                                                                                      |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `ultimate/companyEngine.ts` (534 lines) | `company.ts` (356 lines) | **DELETED** — old company.ts removed, all imports redirected to `ultimate/companyEngine.ts` |

---

## HIGH — Stubs That Look Real (Health Check)

5 health check methods always return `healthy` + "not implemented", making the `/health/detailed` endpoint deceptive:

| File:Line                    | Method                   | Returns                                                                   |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `runtime/healthCheck.ts:107` | `checkCircuitBreaker()`  | `{ status: 'healthy', message: 'Circuit breaker check not implemented' }` |
| `runtime/healthCheck.ts:111` | `checkDeadLetterQueue()` | `{ status: 'healthy', message: 'DLQ check not implemented' }`             |
| `runtime/healthCheck.ts:146` | `checkCompensation()`    | `{ status: 'healthy', message: 'Compensation check not implemented' }`    |
| `runtime/healthCheck.ts:150` | `checkEventBus()`        | `{ status: 'healthy', message: 'Event bus check not implemented' }`       |
| `runtime/healthCheck.ts:154` | `checkProviders()`       | `{ status: 'healthy', message: 'Provider check not implemented' }`        |

**Impact:** Operators think the system is healthy when circuit breakers may be open, DLQ may be full, and providers may be down.

---

## HIGH — Explicit Stubs

| File                                             | Issue                                                            | Impact                                       |
| ------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------- |
| `harness/mcpHarness.ts`                          | All capabilities false, `runAttempt()` returns "not implemented" | MCP server-mode delegation non-functional    |
| `selfEvolution/strategyPerformanceTracker.ts:85` | `analyzeModelPerformance()` returns empty Map                    | Called but always produces empty results     |
| `runtime/httpServer.ts:982`                      | `/api/v1/plan` endpoint is a "deliberation-only stub"            | API endpoint exists but doesn't do real work |

---

## MEDIUM — Deprecated but Not Removed

| File:Line                                         | Deprecated     | Replacement                  | Status                       |
| ------------------------------------------------- | -------------- | ---------------------------- | ---------------------------- |
| `atr/runtimeIntegration.ts:4`                     | Entire file    | `ExecutionScheduler`         | Has replacement, not deleted |
| `security/rotationSignoffVerifier.ts:438,772,933` | 3 sync methods | Corresponding Async versions | Marked advisory-only         |

---

## MEDIUM — TODO / Placeholder Features

| File:Line                               | Content                                             |
| --------------------------------------- | --------------------------------------------------- |
| `sandbox/teeEnclave.ts:303`             | `TODO(v2): CID pool for concurrent Nitro execution` |
| `security/adaptiveHitl.ts:992`          | `TODO: Implement Thompson Sampling weight learning` |
| `security/sandboxVerifier.ts:379`       | `placeholder for memory/CPU enforcement checks`     |
| `security/postQuantumCrypto.ts:345`     | `placeholder for ML-KEM-768` key exchange           |
| `security/postQuantumCrypto.ts:394`     | `placeholder until Node.js exposes SHAKE-256`       |
| `runtime/internalUrls.ts:181`           | `For now, return a placeholder`                     |
| `intelligence/costAggregator.ts:386`    | `placeholder: tracked at hit level only`            |
| `ultimate/runtimeWorkflowAdapter.ts:13` | `placeholder for RL training`                       |

---

## MEDIUM — Logic Breakpoints (FIXED 2026-06-24)

| File:Line                                  | Issue                                      | Fix                            |
| ------------------------------------------ | ------------------------------------------ | ------------------------------ |
| `ultimate/deliberation.ts:696`             | `isValidTopology` rejected canonical names | Added all 14 valid names       |
| `ultimate/topologyRouter.ts:102`           | Epsilon defaulted to 0                     | Changed to 0.05                |
| `ultimate/subAgentExecutor.ts:129`         | `writeCheckpoint` all-zero stub            | Now uses real node data        |
| `ultimate/runtimeWorkflowAdapter.ts:29-66` | Duplicate type definitions                 | Removed, imports from types.ts |
| `ultimate/runtimeWorkflowAdapter.ts`       | `stageDurations` never written             | Now tracks phase durations     |

---

## MEDIUM — Duplicate Definitions (FIXED 2026-06-24)

| File                                 | Types                                                         | Source of truth             |
| ------------------------------------ | ------------------------------------------------------------- | --------------------------- |
| `ultimate/runtimeWorkflowAdapter.ts` | `TaskState`, `EvidenceItem`, `StepResult`, `WorkflowDecision` | `ultimate/types.ts:585-643` |

Note: `AdaptiveExecutionResult` kept locally because it uses `AgentExecutionResult` (not `UltimateExecutionResult`).

---

## LOW — Dead Code

| File:Line                    | Description                                                            | Risk |
| ---------------------------- | ---------------------------------------------------------------------- | ---- |
| `harness/harnessRegistry.ts` | `-10` priority tier1 rule unreachable (shadowed by priority-0 default) | Low  |
| `ultimate/task.ts:9`         | `import * as os from 'os'` unused                                      | Low  |

---

## LOW — Synchronous I/O in Async Contexts

| File                                      | Method                | Issue                                                  |
| ----------------------------------------- | --------------------- | ------------------------------------------------------ |
| `selfEvolution/metaLearnerPersistence.ts` | `persist()`           | `fs.existsSync`/`fs.mkdirSync` blocks event loop       |
| `ultimate/explorationEventLog.ts`         | `appendToDisk()`      | `appendFileSync` blocks event loop                     |
| `harness/harnessInfrastructure.ts`        | `PatchEngine.apply()` | `fs.readFileSync`/`fs.writeFileSync` blocks event loop |

---

## LOW — Code Duplication

| Pattern                  | Locations                                                          | Recommendation                                       |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `emitEvent()` copy-paste | `DefaultHarness`, `CodeAgentHarness`, `Tier1Harness`, `McpHarness` | Extract to shared base class                         |
| Steer queue duplication  | Each harness has own `steerQueueInternal` + `steer()`              | Use `SteerQueueImpl` from `harnessInfrastructure.ts` |
| Agent loop overlap       | `CodeAgentHarness` (984 lines) and `Tier1AgentLoop` (558 lines)    | Consolidate into strategy pattern                    |
| Provider fallback chain  | `orchestrator.ts` lines 186-193 and 1219-1226                      | Extract to shared helper                             |

---

## INFO — Missing Module

| Expected path               | Status                         | Notes                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/memory/` | **Directory exists** (6 files) | `conversationStore.ts`, `jsonStore.ts`, `reflectionPipeline.ts`, `sqliteMemoryStore.ts`, `unifiedMemory.ts`, `userModel.ts`. Memory is also scattered across `selfEvolution/metaLearner.ts`, `selfEvolution/crossModelMemory.ts`, `selfEvolution/metaLearnerPersistence.ts` |

---

## INFO — Security Notes

| File                             | Issue                                                                  | Severity |
| -------------------------------- | ---------------------------------------------------------------------- | -------- |
| `ultimate/artifactSystem.ts:134` | Regex injection — user query passed to `new RegExp()` without escaping | Medium   |
| `ultimate/taskPool.ts:228`       | Non-atomic token budget reservation under concurrent dispatch          | Low      |

---

## INFO — Design Debt (working but fragile)

| File                           | Issue                                                              | Severity |
| ------------------------------ | ------------------------------------------------------------------ | -------- |
| `runtime/agentRuntime.ts`      | 4,607-line God object, 76 singletons, 110 catch blocks (61 silent) | Critical |
| `ultimate/orchestrator.ts`     | 2,010-line God class, `execute()` ~900 lines                       | Critical |
| `ultimate/deliberation.ts:557` | `deliberateWithLLM` adds latency with no behavioral benefit        | Medium   |
| `ultimate/atomizer.ts`         | ASPECT always 3 subtasks, STEP always 4 — not adaptive             | Medium   |
| `ultimate/synthesizer.ts`      | Quality gates use regex, penalize legitimate hedging               | Medium   |

---

## Resolution Tracking

| Item                                                                                  | Status       | Date                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `isValidTopology` missing canonical names                                             | **FIXED**    | 2026-06-24                                                                                                                            |
| `topologyRouter` epsilon default 0                                                    | **FIXED**    | 2026-06-24                                                                                                                            |
| `writeCheckpoint` all-zero stub                                                       | **FIXED**    | 2026-06-24                                                                                                                            |
| `runtimeWorkflowAdapter` duplicate types                                              | **FIXED**    | 2026-06-24                                                                                                                            |
| `stageDurations` never populated                                                      | **FIXED**    | 2026-06-24                                                                                                                            |
| `actor/` orphaned module (1,728 lines)                                                | **DELETED**  | 2026-06-24                                                                                                                            |
| `inspectorAgent` + `frameworkIntegration` orphaned                                    | **DELETED**  | 2026-06-24                                                                                                                            |
| `adaptiveOrchestrator` + `tokenBudgetAllocator` half-orphaned                         | **DELETED**  | 2026-06-24                                                                                                                            |
| `company.ts` duplicate of `ultimate/companyEngine.ts`                                 | **DELETED**  | 2026-06-24                                                                                                                            |
| Stricter topology enum in `commander.schema.json` (9 entries vs runtime 5 canonicals) | **DEFERRED** | awaiting user decision (ide-relax vs update-enum)                                                                                     |
| 5 healthCheck stubs returning fake "healthy"                                          | **FIXED**    | 2026-06-24                                                                                                                            |
| `McpHarness` empty stub                                                               | **FIXED**    | 2026-06-24                                                                                                                            |
| `deliberation.ts:225` hardcoded year `2025`/`2026` in temporal detection              | **FIXED**    | 2026-06-24                                                                                                                            |
| `inspectorAgent` deprecated, replacement exists                                       | **DELETED**  | 2026-06-24                                                                                                                            |
| `atr/runtimeIntegration` deprecated, replacement exists                               | **OPEN**     | —                                                                                                                                     |
| Circuit-breaker snapshot only reflects CLOSED (no HALF-OPEN detection)                | **OPEN**     | —                                                                                                                                     |
| DLQ >500 unhealthy threshold is process-wide (not per-tenant)                         | **RESOLVED** | 2026-06-25 — `tenantManager.ts` provides per-tenant store isolation with per-tenant rate limits, concurrency caps, and storage quotas |
| `/api/runtime/health` does not yet surface `HealthCheckResult` (doc promises it)      | **FIXED**    | 2026-06-25 — `buildHealthSources()` wires real data to all 3 health endpoints                                                       |
| Hub Glue `installHubGlue()` never called (5 Phase-2 correlators dormant)              | **FIXED**    | 2026-06-26 — `serviceInitializer.ts` `initializeServices()` now calls `installHubGlue()` at boot, activating `toolBlockedHandler` + `CycleCorrelator`/`RetryHookCorrelator`/`SemanticCircuitCorrelator`; `hubGlue` added to `reversibility.matrix.json` for regression protection |
| `complianceAuditReport` zero runtime caller                                          | **FIXED**    | 2026-06-26 — `httpServer.ts` adds `GET /api/v1/security/compliance-audit` route calling `getComplianceAuditManager().generateFullReport()` (ISO 42001 + NIST AI RMF); tenant-scoped via `runWithTenant` |
| `euAiActCompliance` zero runtime caller                                              | **FIXED**    | 2026-06-26 — `httpServer.ts` adds `GET /api/v1/security/eu-ai-act` route calling `getEuAiActComplianceReporter().generateReport()` (Articles 12/13/14); tenant-scoped |
| `mcpObservability` `registerObservabilityTools()` zero caller                         | **FIXED**    | 2026-06-26 — `CommanderMcpServerOptions` gains optional `observability` field; when set, constructor calls `registerObservabilityTools()` exposing 4 MCP tools (timeline/summary/compare/tool-metrics) |
| `incrementalSCC` zero runtime caller                                                  | **FIXED**    | 2026-06-26 — `agentHandoff.ts` integrates SCC at 5 lifecycle points (request/accept/reject/complete/pruneUnresolved); circular handoff chains rejected with `status='failed'` + deadlock alert published to messageBus |
| `supervisionTree` zero runtime caller                                                 | **FIXED**    | 2026-06-26 — `serviceInitializer.ts` creates root supervisor + registers agent child + subscribes `agent.failed` events to trigger `reportChildCrash`; `InitializedServices` gains `supervisor` field; zero changes to `agentRuntime.ts` |
| `speculativeExecutor` zero runtime caller                                             | **FIXED**    | 2026-06-26 — `toolExecutionService.ts` maintains `recentToolCalls` sliding window, records patterns after successful execution, adds `triggerSpeculativeExecution()` method; `agentRuntime.ts` fires it (fire-and-forget) after `fireBeforeLLMCall`; config defaults to `enabled: false` |
