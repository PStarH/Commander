# Dead Code and Stubs Audit

Generated: 2026-06-23 from full codebase scan.

## Stubs (explicitly unimplemented)

| File | Issue | Impact |
|------|-------|--------|
| `packages/core/src/harness/mcpHarness.ts` | All capabilities false, `runAttempt()` returns "not implemented" | MCP server-mode delegation non-functional |
| `packages/core/src/ultimate/subAgentExecutor.ts:129` `writeCheckpoint` | **FIXED** — was all-zero stub, now uses real node data | Crash recovery now has useful state |

## Dead Code

| File:Line | Description | Risk |
|-----------|-------------|------|
| `packages/core/src/harness/harnessRegistry.ts` | `-10` priority tier1 rule is unreachable — covered by priority-0 default rule | Low (dead config, no runtime effect) |
| `packages/core/src/selfEvolution/strategyPerformanceTracker.ts:85` `analyzeModelPerformance()` | Returns empty Map with comment "We need experiences to do this..." | Medium (called but always empty) |
| `packages/core/src/ultimate/runtimeWorkflowAdapter.ts` | `stageDurations` Map is populated but never written to — always empty in metrics | Low (exposed metric always 0) |
| `packages/core/src/ultimate/task.ts:9` | `import * as os from 'os'` — unused import | Low (tree-shaken) |

## Logic Breakpoints (FIXED this session)

| File:Line | Issue | Fix |
|-----------|-------|-----|
| `packages/core/src/ultimate/deliberation.ts:696` `isValidTopology` | Only accepted legacy names (SEQUENTIAL/PARALLEL/etc), rejected canonical names (CHAIN/DISPATCH/ORCHESTRATOR/REVIEW) | Added all 14 valid names to validation array |
| `packages/core/src/ultimate/topologyRouter.ts:102` | Epsilon defaulted to 0 (exploration disabled) despite interface documenting 0.05 | Changed default to 0.05 |
| `packages/core/src/ultimate/subAgentExecutor.ts:129` `writeCheckpoint` | All-zero checkpoint state (stepNumber:0, tokenUsage:{0,0,0}, durationMs:0) | Now uses real node.tokenUsage, node.durationMs, node.subtasks.length |

## Duplicate Definitions

| File | Types duplicated | Source of truth |
|------|-----------------|-----------------|
| `packages/core/src/ultimate/runtimeWorkflowAdapter.ts:29-66,161-176,328-340` | `TaskState`, `EvidenceItem`, `StepResult`, `SubWorkflow`, `WorkflowDecision`, `AdaptiveExecutionResult` | `packages/core/src/ultimate/types.ts:585-643` |

Note: `AdaptiveExecutionResult` has a minor type mismatch — local uses `AgentExecutionResult`, types.ts uses `UltimateExecutionResult`. Needs reconciliation.

## Synchronous I/O in Async Contexts

| File | Method | Issue |
|------|--------|-------|
| `packages/core/src/selfEvolution/metaLearnerPersistence.ts` | `persist()` | Uses `fs.existsSync`/`fs.mkdirSync` — blocks event loop |
| `packages/core/src/ultimate/explorationEventLog.ts` | `appendToDisk()` | Uses `appendFileSync` — blocks event loop |
| `packages/core/src/harness/harnessInfrastructure.ts` | `PatchEngine.apply()` | Uses `fs.readFileSync`/`fs.writeFileSync` — blocks event loop |

## Code Duplication

| Pattern | Locations | Recommendation |
|---------|-----------|----------------|
| `emitEvent()` copy-paste | `DefaultHarness`, `CodeAgentHarness`, `Tier1Harness`, `McpHarness` | Extract to shared base class or mixin |
| Steer queue duplication | Each harness has own `steerQueueInternal: SteerMessage[]` + `steer()` method | Use `SteerQueueImpl` from `harnessInfrastructure.ts` |
| Agent loop overlap | `CodeAgentHarness` (984 lines) and `Tier1AgentLoop` (558 lines) | Consolidate into single loop with strategy pattern |
| Provider fallback chain | `orchestrator.ts` lines 186-193 and 1219-1226 (identical 6-provider chain) | Extract to shared helper |

## Missing Module

| Expected path | Status | Notes |
|---------------|--------|-------|
| `packages/core/src/memory/` | **DOES NOT EXIST** | Memory scattered across `selfEvolution/metaLearner.ts`, `selfEvolution/crossModelMemory.ts`, `selfEvolution/metaLearnerPersistence.ts` |

## Security Notes

| File | Issue | Severity |
|------|-------|----------|
| `packages/core/src/ultimate/artifactSystem.ts:134` | Regex injection — user query passed to `new RegExp()` without escaping | Medium |
| `packages/core/src/ultimate/taskPool.ts:228` | Non-atomic token budget reservation under concurrent dispatch | Low |

## Design Debt (working but fragile)

| File | Issue | Severity |
|------|-------|----------|
| `packages/core/src/ultimate/deliberation.ts:557` | `deliberateWithLLM` admits it adds latency with no behavioral benefit | Medium |
| `packages/core/src/ultimate/atomizer.ts` | ASPECT always 3 subtasks, STEP always 4 — not adaptive | Medium |
| `packages/core/src/ultimate/synthesizer.ts` | Quality gates use regex heuristics, penalize legitimate hedging | Medium |
| `packages/core/src/ultimate/deliberation.ts:225` | Hardcoded year `2025`/`2026` in temporal detection | Low |
| `packages/core/src/runtime/agentRuntime.ts` | 4,607-line God object, 76 singletons, 110 catch blocks | Critical |
| `packages/core/src/ultimate/orchestrator.ts` | 2,010-line God class, `execute()` ~900 lines | Critical |
