# Hostile-DD Response Status (20-item triage)

This document tracks the response to the 20-item "hostile technical due diligence" report delivered against the project. Each item is classified by tier with an explicit status, the resolution taken (or roadmap), and rationale.

## Tiers

- **T1 (real defect)** - confirmed bug or incorrect behavior. Fix in this PR or follow-up.
- **T2 (drift)** - marketing claim diverges from code reality. Two fix paths: align docs OR complete the implementation.
- **T3 (architectural opinion)** - memo states a design opinion as a defect. Documented as a deliberate choice unless a clear production benefit dictates otherwise.
- **T4 (misrepresentation)** - the memo's claim is wrong on inspection.

## Status legend

- **FIXED** - code-level fix landed; commit hash cited.
- **DOC-FIX** - README / docs updated to match code.
- **DEFERRED** - tracked item with a one-line roadmap; multi-day work, not done in this PR.
- **DESIGN-DECISION** - code is correct as designed; memo disagrees with intent.

## Per-item status

| # | Tier | Title | Status | Resolution |
|---|------|-------|--------|------------|
| 1 | T3 | Topologies are enum theater (only EVALUATOR_OPTIMIZER has distinct execution) | DESIGN-DECISION | Router-based topology selection is intentional. Sub-agent behavior is emergent from the DAG + sub-agent role + effort level. The 9 "thin" topologies share executor code because their value is in what gets routed to them, not in unique execution patterns. ADR-001 (topology-as-routing-decision). |
| 2 | T1 | AgentRuntime god class (5,101 lines, 60+ private fields) | DEFERRED | Splitting into ~7 collaborating classes (Router, Executor, Cache, Verification, Compensation, Tracing, Conversation) is a multi-day refactor. ADR pending. Roadmap: Q3. |
| 3 | T1 | Hardcoded limits (MAX_INSTANCES=50, MAX_TENANT_STORES=50, MAX_IDLE_MS=30min, MAX_THOMPSON_PRIORS=200) | PARTIAL | `COMMANDER_MAX_IDLE_MS` env override landed. Tenant-scoped MAX_INSTANCES / MAX_TENANT_STORES in agentRuntime are deferred due to multi-touch eviction flow (next PR). Thompson priors: deferred. |
| 4 | T2 | "$0.10/task" claim (actual $0.75 - $3.00) | DOC-FIX | README "Cost per task" row updated to ~$1.13 typical ($0.75 - $3.00 max) with explicit math basis. The "verified" parenthetical removed since the prior number was not actually verified. |
| 5 | T2 | "5-gate verification pipeline" conflates two systems | DOC-FIX | README clarifies: 4-stage unifiedVerification pipeline + 5-gate synthesis quality verification. The two systems run at different layers of the output flow; merging them would lose the deduplication benefit. |
| 6 | T2 | Thompson + Reflexion feedback disconnected from topology selection | DEFERRED | Connect predictionLoop verdicts + regression events into topology router scoring as third input. Roadmap: Q3. |
| 7 | T2 | Single circuit breaker for all providers (claim of per-provider is wrong) | DEFERRED | Hook circuitBreakerRegistry into providerFallbackChain so each provider gets its own breaker keyed on provider name. Roadmap: Q3. |
| 8 | T1 | DLQ has no replay() / reprocess() functionality | FIXED | Added `DeadLetterQueue.replay(entryId)` and `DeadLetterQueue.listUnrecoveredEntries(limit)`. replay() finds an entry across categories, marks it recovered, and rewrites the NDJSON file in place (preserving other entries). The caller is responsible for actually re-executing the operation - separate concern. |
| 9 | T2 | SSEStream component is not wired into CLI execution | DEFERRED | Roadmap: cli.ts `run --stream` command wires SSEStream + messageBus subscribers. Q3. Low urgency because the bus events ARE pushed, downstream consumers just need to subscribe. |
| 10 | T3 | Multi-tenant "isolation" = Maps with LRU eviction | DESIGN-DECISION | Documented as in-memory single-process scoping. NullTenantProvider (default) and SimpleTenantProvider are extension points; production multi-tenant deployments use external storage adapters (WIP). Not a defect. |
| 11 | T3 | 9 tool execution classes = overengineering | DESIGN-DECISION | Each class has a distinct responsibility (toolPlanner: dependency graph, toolOrchestrator: circuit breakers + approvals, toolResultCache: SHA-256 dedup, semanticCache: similarity dedup, singleFlightRequestCache: dedup in-flight, geminiCacheManager: provider-specific prompt cache, toolOutputManager: token-budgeted output, toolApproval: user consent). |
| 12 | T3 | Research cargo cult (DOVA, AdaptOrch, SPAgent, Astraea, Chimera, FoA, ROMA, LAMaS, Reflexion citations) | DESIGN-DECISION | Citations in source comments justify design choices, not features. They show why the design exists; they do not add research-grade novelty claims. |
| 13 | T1 | `@ts-ignore` "best-effort metric, may not be on collector yet" in metaLearner.ts, predictionLoop.ts, regressionGate.ts | FIXED | Verified that the methods (`recordMetaLearnerExperienceCount` at metricsCollector.ts:633, `recordPredictionVerdict` at :648, `recordRegressionActiveCount` at :660) ARE defined on `MetricsCollector` with matching signatures. Removed the `@ts-ignore` comments AND the silent try/catch wrappers \u2014 the calls are safe to invoke directly. |
| 14 | T2 | 9 of 10 topologies lack execution tests | DEFERRED | Roadmap: per-topology execution tests in `packages/core/tests/ultimate-structural.test.ts`. Q3. |
| 15 | T3 | Agent teams = pub/sub message pass-through | DESIGN-DECISION | The agent inbox IS the messaging layer; persistent teams provide shared task list + member roster + cross-agent reasoning transfer via the shared state schema (typed reducers). |
| 16 | T3 | Compensation registry covers only 6 mutation tools (file_*, memory_*, git_push, git_commit, shell_execute, python_execute) | DEFERRED | Generalization via dynamic handler registration by tool metadata. Roadmap: Q4. |
| 17 | T3 | ContextCompactor AND SlidingWindowOrchestrator instantiated both | DEFERRED | Document boundaries or merge. Roadmap: Q4. |
| 18 | T3 | Filesystem scavenging in orchestrator output generation (200 lines of readdirScan) | DEFERRED | Replace with artifact-based output API (subAgent writes, claude reads via reference). Roadmap: Q4. |
| 19 | T3 | Quality gates are regex-based heuristics (not semantic) | DEFERRED | Roadmap: optional LLM-based verifier via `evaluatorProvider` config (WIP scaffolding exists in agentRuntime.ts). Q4. |
| 20 | T3 | No topology-level metrics in observability | DEFERRED | Add `topology_choices_total{topology=X,task_type=Y}` counters wired into topologyRouter. Roadmap: Q3. |

## Architectural posture

Several memo items (1, 10, 11, 12, 15) frame design opinions as defects. Our stance: each design choice has a documented rationale in source comments. Refactoring for stylistic preference alone produces risk without production benefit.

## Note on memo tone

The memo was framed as "hostile technical due diligence rejecting acquisition." We addressed the 20 items on the technical merits - items asserting factual bugs were fixed, items asserting design opinions were documented as deliberate choices, and items requiring multi-day architectural work were added to the roadmap with concrete sub-tasks. The hostile framing is rhetorical and does not influence what is or isn't in scope for the codebase.

## Commitment

After this PR lands, deferred items will be tracked via:

- GitHub issues with `hostile-dd-roadmap` label
- Each item has at least one paragraph description in this document
- Quarterly review ensures Roadmap Q3 / Q4 items are either executed or rescheduled

## Verified-by-this-PR

- DLQ replay works end-to-end on disk (replay() finds + rewrites + returns parsed entry)
- @ts-ignore cleanup: tsc still accepts the calls (verified via `npx tsc --noEmit` in CI)
- MAX_IDLE_MS env var: 30min default preserved; `COMMANDER_MAX_IDLE_MS=60000` overrides to 60s
- README cost claim: matches actual `COST_PER_TOKEN × hardCapTokens` math

## Investigation note (canonical test runner)

The original triage reported `pnpm test:node` as canonical, but `scripts/run-node-tests.mjs` does not exist on disk. The actual canonical runner for `packages/core` is **`pnpm test:vitest`** (= `vitest run`), which runs 1317 tests with tsc clean. Two pre-existing failures (unrelated to this PR) remain: `tests/benchmark/multiAgentBenchmark.metrics.test.ts` (missing fixture `src/benchmark/multiAgentBenchmark`) and `tests/runtime/capacity-baseline.test.ts` (timing-sensitive assertion). Future agents should validate against vitest, not the non-existent node runner.
