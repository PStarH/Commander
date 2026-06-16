# Commander — Architecture & Operator's Manual

> Full core test suite · TypeScript strict · 448 modules · 8 topologies · multi-tenant

## Quick Start

```bash
pnpm install
cd packages/core
pnpm test                        # node:test + vitest suites, must be ALL green
npx tsc --noEmit                  # zero type errors
npx tsx cli.ts plan "your task"   # deliberation plan only
npx tsx cli.ts run "your task"    # full execution
npx tsx cli.ts watch "your task"  # SSE streaming
```

## Directory Map

```
packages/core/src/
├── runtime/             ← Execution engine (122 files — the heart)
│   ├── agentRuntime.ts  ← Main loop: LLM → tools → verification → retry
│   ├── types.ts         ← All shared types (context, config, steps)
│   ├── modelRouter.ts   ↑ Provider selection by task complexity
│   ├── providers/       ↓ 22 providers: OpenAI, Anthropic, Google, DeepSeek, GLM, Xiaomi, Groq, Bedrock, etc.
│   ├── messageBus.ts    ← Pub/sub for inter-agent + system events
│   ├── metricsCollector.ts ← Prometheus counters/gauges/histograms with tenant labels
│   ├── tenantProvider.ts   ← Multi-tenant isolation (NullTenantProvider for single-tenant)
│   ├── toolResultCache.ts  ← SHA-256 based caching with per-tenant key isolation
│   ├── stateCheckpointer.ts ← Crash-safe JSON snapshots (write-tmp, atomic rename)
│   ├── samplesStore.ts     ← NDJSON audit trail (LLM calls, verifications)
│   ├── traceStore.ts       ← Execution trace event storage
│   ├── circuitBreaker.ts   ← Failure threshold → open circuit
│   ├── circuitBreakerRegistry.ts ← Multi-provider circuit breaker management
│   ├── deadLetterQueue.ts  ← Unrecoverable errors for analysis
│   ├── deadLetterQueueSingleton.ts ← Global DLQ instance
│   ├── contextCompactor.ts ← Token-aware message compaction
│   ├── tokenGovernor.ts    ← Token budget enforcement
│   ├── llmRetry.ts         ← Classify errors as retryable/permanent + backoff
│   ├── stepErrorBoundary.ts ← Per-step recovery (skip/retry/abort)
│   ├── stepTimeoutManager.ts ← Per-step timeout enforcement
│   ├── compensationRegistry.ts ← Undo side-effects of failed mutation tools
│   ├── httpServer.ts       ← REST API with auth, rate limiting, tenant key mapping
│   ├── executionTrace.ts   ← Span-based execution tracing
│   ├── agentHandoff.ts     ← Agent-to-agent handoff with inbox
│   ├── agentInbox.ts       ← Persistent inbox for async agent messages
│   ├── providerFallbackChain.ts ← Automatic failover between LLM providers
│   ├── unifiedVerification.ts ← 5-gate quality verification pipeline
│   ├── sseStream.ts        ← Server-Sent Events for real-time agent streaming
│   ├── toolOrchestrator.ts ← Dependency-aware tool execution planning
│   ├── toolPlanner.ts      ← Execution plan generation with parallel stages
│   ├── toolOutputManager.ts ← Token-budgeted tool output management
│   ├── semanticCache.ts    ← Semantic similarity-based result caching
│   ├── singleFlightRequestCache.ts ← Deduplicate concurrent identical requests
│   ├── contextWindow.ts    ← Context window management with sliding window
│   ├── cycleDetector.ts    ← Loop detection to prevent infinite execution
│   ├── reliabilityEngine.ts ← Unified resilience facade
│   ├── runRecovery.ts      ← Crash recovery from persisted state
│   └── ... (80+ more files for auth, proxy, adapters, harnesses, etc.)
│
├── ultimate/            ← Orchestration engine (29 files)
│   ├── deliberation.ts  ← Task analysis: complexity, topology selection
│   ├── topologyRouter.ts ← DAG-based topology: SINGLE, SEQUENTIAL, PARALLEL,
│   │                        HIERARCHICAL, HYBRID, DEBATE, ENSEMBLE, EVALUATOR-OPTIMIZER
│   ├── topologyOptimizer.ts ← Reflexion-based topology performance learning
│   ├── effortScaler.ts  ← Scale agents (1-20) based on task complexity
│   ├── atomizer.ts      ← ROMA-style task decomposition
│   ├── orchestrator.ts  ← Compose pipeline: deliberate → scale → route → execute
│   ├── subAgentExecutor.ts ← Execute subtasks with sub-agents
│   ├── synthesizer.ts   ← Multi-agent synthesis (lead, hierarchical, vote, ensemble)
│   ├── artifactSystem.ts ← Reference-based agent communication (prevents telephone game)
│   ├── agentTeamManager.ts ← Persistent agent teams with inbox messaging
│   ├── capabilityRegistry.ts ← FoA-inspired semantic agent capability matching
│   ├── workCoordinator.ts ← Distributed work queue with claim semantics
│   ├── stateManager.ts  ← Shared state management across subtasks
│   ├── coordinationPolicy.ts ← Policy-based coordination decisions
│   └── pheromoneRouter.ts ← Ant-colony-inspired routing optimization
│
├── tools/               ← 24 built-in tools
│   ├── fileSystemTool.ts, codeFixer.ts, patchTool.ts
│   ├── metaTool.ts, agentTool.ts, answerFormatTool.ts
│   ├── persistenceTool.ts, verificationTool.ts
│   ├── browserTool.ts, webSearchTool.ts, codeSearchTool.ts
│   ├── gitTool.ts, sandboxedExec.ts, scriptTool.ts
│   ├── checkpointTool.ts, handoffTool.ts, mcpToolAdapter.ts
│   ├── codeExecutionTool.ts, codeRefinerTool.ts
│   ├── a2aDelegateTool.ts, requestHumanInputTool.ts, requestToolTool.ts
│   ├── resourceTools.ts, conversationSearchTool.ts
│   └── index.ts         ← Tool registration
│
├── sandbox/             ← Security profiles and execution policy
│   ├── execPolicy.ts, approval.ts, profiles.ts, platforms.ts
│   ├── manager.ts, executionRouter.ts, networkProxy.ts
│   ├── seccompBpf.ts, lane.ts, types.ts
│   └── backends/        ← Seatbelt, Bubblewrap, Docker implementations
│
├── selfEvolution/       ← Meta-learning (Thompson Sampling + Reflexion)
│   ├── metaLearner.ts   ← Thompson Sampling + Beta distribution
│   ├── trajectoryAnalyzer.ts ← Execution trajectory pattern analysis
│   └── evolverAgent.ts  ← Cross-run optimization via agent-guided evolution
│
├── telos/               ← Token-efficient LLM orchestration
│   └── providerPool.ts, types.ts, orchestrator.ts
│
├── mcp/                 ← Model Context Protocol (client + server)
│   ├── client.ts, server.ts, types.ts, a2aCompliance.ts
│
├── saga/                ← Distributed compensating transactions
│   ├── sagaBuilder.ts, coordinator.ts, workerPool.ts
│   ├── checkpointer.ts, approvalManager.ts, retryController.ts
│   └── stores/          ← In-memory and file-based saga stores
│
├── threeLayerMemory.ts  ← Working/Episodic/Long-term memory with embedding
├── pluginManager.ts     ← Hook-based plugin system (before/after LLM, tool, run)
├── reflectionEngine.ts  ← Post-execution self-evaluation
├── hallucinationDetector.ts ← Signal-based hallucination detection
├── privacyRouter.ts     ← Sensitive content detection + local model fallback
├── contentScanner.ts    ← Agent security layer for injection detection
└── index.ts             ← Public API exports (~450 lines)
```

## Core Call Chain

```
CLI / HTTP / API
  │
  ├─ deliberation.ts     ← "What kind of task is this?"
  │   └─ TaskComplexityAnalyzer
  │
  ├─ effortScaler.ts     ← "How many agents? 1 for simple, up to 20 for research"
  │
  ├─ topologyRouter.ts   ← "Which topology fits the dependency graph?"
  │   └─ SINGLE | SEQUENTIAL | PARALLEL | HIERARCHICAL | HYBRID | DEBATE | ENSEMBLE | EVALUATOR-OPT
  │
  ├─ atomizer.ts         ← "Break into subtasks (ROMA decomposition)"
  │
  ├─ agentRuntime.ts.execute(ctx)
  │   │
  │   ├─ acquireSlot()   ← Concurrency semaphore (GAP-07)
  │   │
  │   ├─ [Tenant check]  ← Rate limit + concurrency quota (GAP-09)
  │   │
  │   ├─ resolve tenant-scoped storage/memory  ← Per-tenant isolation
  │   │
  │   ├─ [Retry loop: 0..maxRetries]
  │   │   │
  │   │   ├─ callWithTimeout()     ← LLM provider call
  │   │   │   └─ provider.call()   ← OpenAI/Anthropic/Google etc.
  │   │   │
  │   │   ├─ [Tool execution loop]
  │   │   │   ├─ toolCache.get()   ← SHA-256 hash lookup (per-tenant key)
  │   │   │   ├─ planner.plan()    ← Dependency-aware execution plan
  │   │   │   ├─ executeTool()     ← StepErrorBoundary → tool.execute()
  │   │   │   └─ toolCache.set()   ← Cache result (per-tenant key)
  │   │   │
  │   │   ├─ verification.check()  ← UnifiedVerificationPipeline (5 gates)
  │   │   │
  │   │   └─ checkpoint()          ← StateCheckpointer (atomic write)
  │   │
  │   ├─ [finally]
  │   │   ├─ releaseSlot()
  │   │   ├─ restore tenant overrides
  │   │   └─ flush traces + samples
  │   │
  │   └─ → AgentExecutionResult
  │
  └─ quality gates (hallucination, consistency, completeness, accuracy, safety)
```

## Multi-Tenant Architecture

```
Request → HttpServer
           │
           ├─ authenticate()       ← Bearer token validation
           ├─ resolveTenantFromAuth() ← API key → tenantId mapping
           │
           └─ execute({ tenantId }) → AgentRuntime
                                        │
                                        ├─ TenantProvider.getTenantConfig(tenantId)
                                        │   → per-tenant: tokenBudget, maxConcurrency, maxRunsPerMinute
                                        │
                                        ├─ Rate limit check     → TENANT_RATE_LIMIT error
                                        ├─ Concurrency check    → TENANT_CONCURRENCY_LIMIT error
                                        │
                                        └─ Tenant-scoped instances:
                                            ├─ SamplesStore(path/tenant_{id}/)
                                            ├─ TraceStore(path/tenant_{id}/)
                                            ├─ StateCheckpointer(path/tenant_{id}/)
                                            ├─ ThreeLayerMemory(per-instance via registry)
                                            └─ ToolResultCache(key = SHA256(tenantId + tool + args))
```

Every metric carries a `tenant` label (omitted when undefined for single-tenant compat).
NullTenantProvider = no isolation, backward compatible. SimpleTenantProvider = static config map.

## Key Data Types

| Type | File | Fields |
|------|------|--------|
| `AgentExecutionContext` | `runtime/types.ts` | `agentId, projectId, goal, tenantId?, userId?, tokenBudget, maxSteps, availableTools, contextData` |
| `AgentExecutionResult` | `runtime/types.ts` | `status, summary, steps[], totalTokenUsage, totalDurationMs, error?` |
| `AgentRuntimeConfig` | `runtime/types.ts` | `maxStepsPerRun, maxRetries, timeoutMs, maxConcurrency, budgetHardCapTokens, ...` |
| `TenantConfig` | `runtime/tenantProvider.ts` | `tenantId, tokenBudget, maxConcurrency, maxRunsPerMinute, enabled, workspacePath?` |
| `CheckpointState` | `runtime/stateCheckpointer.ts` | `runId, phase, stepNumber, messages[], tokenUsage, context, ...` |

## Extension Points

| Point | Interface | When it fires |
|-------|-----------|---------------|
| LLM call | `HookManager.fireBeforeLLMCall / fireAfterLLMCall` | Before/after every LLM request |
| Tool call | `HookManager.fireBeforeToolCall / fireAfterToolCall` | Before/after every tool execution |
| Run lifecycle | `HookManager.fireOnAgentComplete / fireOnError` | Run finished or failed |
| Plugin | `CommanderPlugin` interface | Register via `getHookManager().register(plugin)` |
| Custom provider | `LLMProvider` interface | `runtime.registerProvider(name, provider)` |
| Custom tool | `Tool` interface | `runtime.registerTool(name, tool)` |
| Channel adapter | `ChannelAdapter` interface | Telegram etc. |
| Topology | Add case in `topologyRouter.ts` | New orchestration pattern |

## Testing Strategy

```
tests/
├── integration.test.ts           ← End-to-end execution flow
├── chaos-monkey.test.ts          ← CM-T1..T10: fault injection + multi-tenant chaos
├── multiTenant.test.ts            ← T1..T28: tenant isolation, quotas, storage, memory
├── metricsCollector.test.ts       ← Counters, gauges, histograms, exports
├── internal-edge-cases.test.ts    ← 50+ edge cases
├── internal-torture.test.ts       ← Stress tests (10K messages, 50 concurrent calls)
├── hallucinationDetector.test.ts  ← Signal-based detection
├── ultimate-orchestration.test.ts ← Topology routing + decomposition
├── commander-tools-integration.test.ts ← Tool chain execution
├── performance-profiling.test.ts  ← Performance baselines
├── e2e.test.ts                    ← Full CLI workflow
└── ... (50+ more: sandbox, security, plugins, reversibility, etc.)
```

Rules:
- **Zero tolerance for failures**: `# fail 0` is non-negotiable
- **New feature → new tests**: every addition needs isolation + integration coverage
- **Chaos tests are first-class**: they must pass, not just "informational"
- **`npx tsc --noEmit` must pass**: avoid `as any` and `@ts-ignore` in production code

## Production Readiness Checklist

- [ ] Full core test suite green
- [ ] TypeScript strict mode clean
- [ ] Metrics exported via OpenMetrics (`getMetricsCollector().exportOpenMetrics()`)
- [ ] Multi-tenant isolation active (NullTenantProvider for single, SimpleTenantProvider for multi)
- [ ] Rate limiting per tenant
- [ ] Concurrency limiting per tenant
- [ ] State checkpointer crash-safe (atomic tmp → rename)
- [ ] Dead letter queue for unrecoverable errors
- [ ] Circuit breaker for provider failures (5 failures → 30s open)
- [ ] Compensation registry for mutation tool rollback
- [ ] HTTP server with Bearer auth + API key → tenant mapping
- [ ] SSE streaming for real-time execution events
