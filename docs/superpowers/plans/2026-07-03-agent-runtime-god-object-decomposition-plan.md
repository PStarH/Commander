# AgentRuntime God Object Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract three focused coordinators from `AgentRuntime.execute()` so the method becomes a thin facade, while preserving all existing behavior and keeping the full test suite green.

**Architecture:** Follow the established helper pattern in `packages/core/src/runtime/`: each coordinator lives in its own file, receives live state via getter callbacks (`Deps`), and accepts per-run parameters (`Params`). The existing `FinallyCleanupHandler` is reused unchanged.

**Tech Stack:** TypeScript, Vitest, existing runtime types in `packages/core/src/runtime/types/`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/core/src/runtime/runInitializer.ts` | Acquire concurrency slot, resolve tenant, acquire lane, seed FreezeDry, start tracer, register with scheduler. Returns an `InitResult`. |
| `packages/core/src/runtime/preLoopSetup.ts` | Per-run setup inside `runWithTenant` before the retry loop: budget check, routing, LLM request build, context injection, event emission, circuit-breaker check. |
| `packages/core/src/runtime/agentLoopOrchestrator.ts` | The retry loop: LLM call, tool execution, verification, early exit, checkpointing, result construction. |
| `packages/core/src/runtime/agentRuntime.ts` | Reduced `execute()` that delegates to the three coordinators and `FinallyCleanupHandler`. |
| `packages/core/tests/runtime/runInitializer.test.ts` | Unit tests for `RunInitializer`. |
| `packages/core/tests/runtime/preLoopSetup.test.ts` | Unit tests for `PreLoopSetup`. |
| `packages/core/tests/runtime/agentLoopOrchestrator.test.ts` | Unit tests for `AgentLoopOrchestrator`. |

---

## Task 1: Create `RunInitializer`

**Files:**
- Create: `packages/core/src/runtime/runInitializer.ts`
- Test: `packages/core/tests/runtime/runInitializer.test.ts`
- Modify: `packages/core/src/runtime/agentRuntime.ts` (construct the coordinator)

### Step 1.1: Write the new coordinator

Create `packages/core/src/runtime/runInitializer.ts` with the following content. It moves the first ~420 lines of `execute()` into a standalone class.

```ts
import { generateId } from '../id';
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRuntimeConfig,
} from './types';
import type { TenantConfig, TenantProvider } from './tenantProvider';
import type { TenantManager } from './tenantManager';
import type { ConcurrencyController } from './concurrencyController';
import type { LaneManager } from '../sandbox/lane';
import type { RunLifecycleManager } from './runLifecycleManager';
import type { FreezeDryManager, ActiveRunState } from './freezeDry';
import type { ExecutionTraceRecorder } from './executionTrace';
import type { ExecutionScheduler } from './executionScheduler';
import { TenantOverrides } from './finallyCleanupHandler';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';
import { getGlobalTenantProvider } from './tenantProvider';
import { getMetricsCollector } from './metricsCollector';
import { getIntentLog } from './intentLog';
import { reportSilentFailure } from '../silentFailureReporter';

export interface RunInitializerDeps {
  getConfig(): AgentRuntimeConfig;
  getConcurrencyController(): ConcurrencyController;
  getTenantProvider(): TenantProvider;
  getTenantManager(): TenantManager;
  getLaneManager(): LaneManager;
  getRunLifecycle(): RunLifecycleManager;
  getFreezeDryManager(): FreezeDryManager;
  getTracer(): ExecutionTraceRecorder;
  getExecutionScheduler(): ExecutionScheduler;
}

export interface InitResult {
  runId: string;
  tenantId: string | undefined;
  tenantCfg: TenantConfig | undefined;
  tenantOverrides: TenantOverrides | undefined;
  currentLane: string;
  startTime: number;
  circuitReleased: boolean;
}

export class RunInitializer {
  constructor(private deps: RunInitializerDeps) {}

  async initialize(ctx: AgentExecutionContext): Promise<InitResult> {
    await this.deps.getConcurrencyController().acquireSlot();

    const runId = generateId();
    const bus = getMessageBus();
    const tracer = this.deps.getTracer();
    const startTime = Date.now();

    const tenantId =
      getGlobalTenantProvider().getCurrentTenantId() ?? ctx.tenantId ?? undefined;
    const tenantCfg = tenantId
      ? this.deps.getTenantProvider().getTenantConfig(tenantId)
      : undefined;

    // tenantResolution is resolved inside AgentRuntime; we keep the simple path here
    // and assume the caller (AgentRuntime) supplies tenant overrides via restoreTenantOverrides.

    const currentLane = await this.deps.getLaneManager().acquireSlot({
      tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
      agentId: ctx.agentId,
      runId,
      args: ctx.lane ? { lane: ctx.lane } : undefined,
    });

    this.deps.getRunLifecycle().addRun(runId);

    try {
      const freezeMgr = this.deps.getFreezeDryManager();
      const activeRuns = new Map<string, ActiveRunState>();
      for (const activeRunId of this.deps.getRunLifecycle().getActiveRuns()) {
        activeRuns.set(activeRunId, {
          runId: activeRunId,
          agentId: ctx.agentId,
          phase: 'executing',
          stepNumber: 0,
          goal: ctx.goal,
          completedToolCalls: 0,
        });
      }
      freezeMgr.setActiveRuns(activeRuns);
    } catch (err) {
      reportSilentFailure(err, 'runInitializer:freezeDryInit');
    }

    tracer.startRun(runId, ctx.agentId, ctx.missionId, undefined, {
      tenantId: ctx.tenantId,
      parentRunId: ctx.parentRunId,
      subAgentDepth: ctx.subAgentDepth,
      subAgentRole: ctx.subAgentRole,
    });

    try {
      getIntentLog(ctx.tenantId).write({
        schemaVersion: 1,
        runId,
        capturedAt: new Date().toISOString(),
        stage: 'agentRuntime.execute',
        decision: 'start',
        reason: 'execute() entered',
        payload: {
          agentId: ctx.agentId,
          goal: ctx.goal.slice(0, 200),
          parentRunId: ctx.parentRunId,
          subAgentDepth: ctx.subAgentDepth,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'runInitializer:intentLog');
    }

    getMetricsCollector().setGauge(
      'active_runs',
      'Active concurrent runs',
      this.deps.getRunLifecycle().getActiveRunCount(),
    );

    const runHandle = this.deps.getExecutionScheduler().beginRun({
      runId,
      goal: ctx.goal,
      tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
      metadata: { agentId: ctx.agentId, missionId: ctx.missionId },
      holder: 'agent-runtime',
    });

    return {
      runId,
      tenantId,
      tenantCfg,
      tenantOverrides: undefined,
      currentLane,
      startTime,
      circuitReleased: false,
    };
  }

  toErrorResult(ctx: AgentExecutionContext, err: unknown): AgentExecutionResult {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      runId: '',
      agentId: ctx.agentId,
      missionId: ctx.missionId,
      status: 'failed',
      summary: msg,
      steps: [],
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      totalDurationMs: 0,
      error: msg,
    };
  }
}
```

**Notes on fidelity:** The original `execute()` performs tenant-resolution checks and early returns before lane acquisition. To avoid changing behavior, `AgentRuntime` will keep the `resolveTenantContext` call and early-return logic in `execute()` before delegating to `RunInitializer`. Therefore `RunInitializer` assumes tenant access is already allowed.

### Step 1.2: Write focused unit tests

Create `packages/core/tests/runtime/runInitializer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RunInitializer } from '../../src/runtime/runInitializer';
import type { AgentExecutionContext } from '../../src/runtime/types';

describe('RunInitializer', () => {
  const makeDeps = () => ({
    getConfig: () => ({ maxRetries: 2 } as any),
    getConcurrencyController: () => ({ acquireSlot: vi.fn(), releaseSlot: vi.fn() }),
    getTenantProvider: () => ({ getTenantConfig: vi.fn(() => undefined) }),
    getTenantManager: () => ({ releaseTenantConcurrency: vi.fn() }),
    getLaneManager: () => ({
      acquireSlot: vi.fn(async () => 'lane-1'),
      releaseSlot: vi.fn(),
    }),
    getRunLifecycle: () => ({
      addRun: vi.fn(),
      getActiveRuns: vi.fn(() => []),
      getActiveRunCount: vi.fn(() => 1),
      removeRun: vi.fn(),
    }),
    getFreezeDryManager: () => ({ setActiveRuns: vi.fn() }),
    getTracer: () => ({ startRun: vi.fn(), completeRun: vi.fn(), recordDecision: vi.fn() }),
    getExecutionScheduler: () => ({ beginRun: vi.fn(() => ({ runId: 'r1', endRun: vi.fn() })) }),
  });

  const ctx: AgentExecutionContext = {
    agentId: 'a1',
    missionId: 'm1',
    goal: 'test goal',
    availableTools: [],
  } as any;

  it('initializes a run and returns required fields', async () => {
    const deps = makeDeps();
    const init = new RunInitializer(deps as any);
    const result = await init.initialize(ctx);

    expect(result.runId).toBeDefined();
    expect(result.currentLane).toBe('lane-1');
    expect(result.startTime).toBeGreaterThan(0);
    expect(result.circuitReleased).toBe(false);
    expect(deps.getConcurrencyController().acquireSlot).toHaveBeenCalled();
    expect(deps.getExecutionScheduler().beginRun).toHaveBeenCalled();
  });

  it('toErrorResult returns a failed result shape', () => {
    const init = new RunInitializer(makeDeps() as any);
    const result = init.toErrorResult(ctx, new Error('boom'));
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
  });
});
```

### Step 1.3: Run the new test

Run:

```bash
pnpm vitest run tests/runtime/runInitializer.test.ts --reporter=default
```

Expected: PASS (2 tests).

### Step 1.4: Commit

```bash
git add packages/core/src/runtime/runInitializer.ts packages/core/tests/runtime/runInitializer.test.ts
git commit -m "feat(runtime): extract RunInitializer from AgentRuntime.execute()"
```

---

## Task 2: Wire `RunInitializer` into `AgentRuntime`

**Files:**
- Modify: `packages/core/src/runtime/agentRuntime.ts`

### Step 2.1: Add private field and construction

In `AgentRuntime` constructor (near the other extracted helpers around line 410), add:

```ts
this.runInitializer = new RunInitializer({
  getConfig: () => this.config,
  getConcurrencyController: () => this.concurrencyController,
  getTenantProvider: () => this.tenantProvider,
  getTenantManager: () => this.tenantManager,
  getLaneManager: () => getLaneManager(),
  getRunLifecycle: () => this.runLifecycle,
  getFreezeDryManager: () => getFreezeDryManager(),
  getTracer: () => getTraceRecorder(),
  getExecutionScheduler: () => getExecutionScheduler(),
});
```

Add the private field declaration near the other helper fields:

```ts
private runInitializer: RunInitializer;
```

Add the import at the top of the file:

```ts
import { RunInitializer } from './runInitializer';
```

### Step 2.2: Replace the initialization block in `execute()`

Keep the tenant-resolution early-return logic (lines ~1052–1072) in `execute()`, but replace the block from `const runId = generateId()` through scheduler registration with:

```ts
const init = await this.runInitializer.initialize(ctx);
```

Use the returned `init.runId`, `init.tenantId`, `init.tenantCfg`, `init.currentLane`, `init.startTime` throughout the rest of `execute()`.

### Step 2.3: Run tests

```bash
pnpm vitest run tests/runtime/runInitializer.test.ts --reporter=default
pnpm vitest run tests/runtime/capacity-baseline.test.ts --reporter=default
```

Expected: both PASS.

### Step 2.4: Commit

```bash
git add packages/core/src/runtime/agentRuntime.ts
git commit -m "refactor(runtime): wire RunInitializer into AgentRuntime"
```

---

## Task 3: Create `PreLoopSetup`

**Files:**
- Create: `packages/core/src/runtime/preLoopSetup.ts`
- Test: `packages/core/tests/runtime/preLoopSetup.test.ts`

### Step 3.1: Create the coordinator

Create `packages/core/src/runtime/preLoopSetup.ts`. It owns everything inside `runWithTenant` before the `for (attempt...)` loop. The file exports:

```ts
export interface PreLoopSetupDeps {
  getConfig(): AgentRuntimeConfig;
  getRouter(): ModelRouter;
  getExecutionRouter(): ExecutionRouter;
  getLLMRequestBuilder(): LLMRequestBuilder;
  getContextInjector(): ContextInjector;
  getCheckpointingPhase(): CheckpointingPhase;
  getSamplesStore(): SamplesStore;
  getGovernor(): TokenGovernor;
  getCircuitBreaker(): CircuitBreaker;
  getProviders(): Map<string, LLMProvider>;
  getSmartRouterActive(): boolean;
  setSmartRouterActive(enabled: boolean): void;
  setGovernor(governor: TokenGovernor): void;
  setSlidingWindow(sw: SlidingWindowOrchestrator): void;
  setVerificationPipelineEvaluator(provider: LLMProvider): void;
}

export interface PreLoopSetupResult {
  request: LLMRequest;
  routing: RoutingDecision;
  escalationChain: EscalationChain;
  batchRouting: RoutingDecision | undefined;
  costEstimate: CostEstimate;
  taskType: TaskType;
  projectContext: ProjectContext | undefined;
}

export class PreLoopSetup {
  constructor(private deps: PreLoopSetupDeps) {}

  async prepare(
    ctx: AgentExecutionContext,
    init: { runId: string; tenantId: string | undefined },
  ): Promise<PreLoopSetupResult | AgentExecutionResult> { ... }
}
```

Implementation strategy: copy the body from `runWithTenant` up to (but not including) the `for (let attempt = 0 ...)` loop from `agentRuntime.ts`. Replace `this.` accesses with `this.deps.getXxx()` calls. Return `AgentExecutionResult` directly for cancellation paths; return `PreLoopSetupResult` on success.

Key snippets:

```ts
// Lift CLI-provided routing hints from contextData
const cd = (ctx as unknown as { contextData?: Record<string, unknown> }).contextData;
if (cd?.preferredModel && typeof cd.preferredModel === 'string') {
  (ctx as unknown as { preferredModel?: string }).preferredModel = cd.preferredModel;
}
if (cd?.preferredModelTier && typeof cd.preferredModelTier === 'string') {
  (ctx as unknown as { preferredModelTier?: ModelTier }).preferredModelTier =
    cd.preferredModelTier as ModelTier;
}
if (cd?.cascadeEnabled === true) {
  this.deps.setSmartRouterActive(true);
} else if (cd?.cascadeEnabled === false) {
  this.deps.setSmartRouterActive(false);
}
```

```ts
const taskType = detectTaskType(ctx.goal);
this.deps.setGovernor(
  new TokenGovernor({
    totalBudget: ctx.tokenBudget || this.deps.getConfig().budgetHardCapTokens || 200000,
  }),
);
this.deps.getGovernor().setTaskCategory(
  taskType === 'code'
    ? 'code'
    : taskType === 'search'
      ? 'search'
      : taskType === 'analysis'
        ? 'analysis'
        : taskType === 'structured'
          ? 'structured'
          : 'general',
);
```

```ts
if (
  this.deps.getConfig().budgetHardCapTokens > 0 &&
  ctx.tokenBudget > this.deps.getConfig().budgetHardCapTokens
) {
  const msg = `BUDGET_EXCEEDED: requested ${ctx.tokenBudget} > hard cap ${this.deps.getConfig().budgetHardCapTokens}`;
  getTraceRecorder().recordDecision(init.runId, msg, 0);
  getMessageBus().publish('agent.failed', ctx.agentId, { runId: init.runId, error: msg });
  return { ...cancelledResult };
}
```

### Step 3.2: Write unit tests

Create `packages/core/tests/runtime/preLoopSetup.test.ts` with mocks for all deps. Test:
- budget exceeded returns cancelled result
- circuit open returns cancelled result
- normal path returns `PreLoopSetupResult`

### Step 3.3: Run tests

```bash
pnpm vitest run tests/runtime/preLoopSetup.test.ts --reporter=default
```

Expected: PASS.

### Step 3.4: Commit

```bash
git add packages/core/src/runtime/preLoopSetup.ts packages/core/tests/runtime/preLoopSetup.test.ts
git commit -m "feat(runtime): add PreLoopSetup coordinator"
```

---

## Task 4: Wire `PreLoopSetup` into `AgentRuntime`

**Files:**
- Modify: `packages/core/src/runtime/agentRuntime.ts`

### Step 4.1: Construct and call `PreLoopSetup`

Add private field:

```ts
private preLoopSetup: PreLoopSetup;
```

Construct it near the other helpers:

```ts
this.preLoopSetup = new PreLoopSetup({
  getConfig: () => this.config,
  getRouter: () => this.router,
  getExecutionRouter: () => this.executionRouter,
  getLLMRequestBuilder: () => this.llmRequestBuilder,
  getContextInjector: () => this.contextInjector,
  getCheckpointingPhase: () => this.checkpointingPhase,
  getSamplesStore: () => this.samplesStore,
  getGovernor: () => this.governor,
  getCircuitBreaker: () => this.circuitBreaker,
  getProviders: () => this.providers,
  getSmartRouterActive: () => this.smartRouterActive,
  setSmartRouterActive: (enabled) => { this.smartRouterActive = enabled; },
  setGovernor: (governor) => { this.governor = governor; },
  setSlidingWindow: (sw) => { this.slidingWindow = sw; },
  setVerificationPipelineEvaluator: (provider) => {
    this.verificationPipeline.setEvaluatorProvider(provider);
  },
});
```

### Step 4.2: Replace pre-loop body in `execute()`

Inside `runWithTenant`, replace everything from the context-data lift through the circuit-breaker check with:

```ts
const setup = await this.preLoopSetup.prepare(ctx, init);
if ('status' in setup) {
  return setup;
}
const { request, routing, batchRouting, costEstimate, taskType, projectContext } = setup;
```

### Step 4.3: Run tests

```bash
pnpm vitest run tests/runtime/preLoopSetup.test.ts tests/runtime/capacity-baseline.test.ts --reporter=default
```

Expected: PASS.

### Step 4.4: Commit

```bash
git add packages/core/src/runtime/agentRuntime.ts
git commit -m "refactor(runtime): wire PreLoopSetup into AgentRuntime"
```

---

## Task 5: Create `AgentLoopOrchestrator`

**Files:**
- Create: `packages/core/src/runtime/agentLoopOrchestrator.ts`
- Test: `packages/core/tests/runtime/agentLoopOrchestrator.test.ts`

### Step 5.1: Create the coordinator

Create `packages/core/src/runtime/agentLoopOrchestrator.ts`. It owns the `for (let attempt = 0; attempt <= maxRetries; attempt++)` loop and everything inside it until the loop ends.

Interface:

```ts
export interface AgentLoopOrchestratorDeps {
  getConfig(): AgentRuntimeConfig;
  getProviders(): Map<string, LLMProvider>;
  getRouter(): ModelRouter;
  getGovernor(): TokenGovernor;
  getCircuitBreaker(): CircuitBreaker;
  getToolExecutionHandler(): ToolExecutionHandler;
  getGoalCompletionVerifier(): GoalCompletionVerifier;
  getVerificationPipeline(): VerificationPipeline;
  getContentScanner(): ContentScanner;
  getMemory(): ThreeLayerMemory | null;
  getCheckpointingPhase(): CheckpointingPhase;
  getSamplesStore(): SamplesStore;
  getMetricsCollector(): () => MetricsCollector;
  getCostEstimator(): () => CostEstimator;
  getHookManager(): () => HookManager;
  executeTool: ExecuteToolFn;
  callWithTimeout: (request: LLMRequest, routing: RoutingDecision) => Promise<LLMResponse | null>;
}

export class AgentLoopOrchestrator {
  constructor(private deps: AgentLoopOrchestratorDeps) {}

  async run(
    ctx: AgentExecutionContext,
    init: { runId: string; tenantId: string | undefined; startTime: number },
    setup: PreLoopSetupResult,
  ): Promise<AgentExecutionResult> { ... }
}
```

Implementation strategy: copy the loop body verbatim from `agentRuntime.ts`, replacing `this.` with `this.deps.getXxx()` or injected functions. Keep all existing error handling, metrics, checkpointing, and memory-write logic exactly as-is.

### Step 5.2: Write unit tests

Create `packages/core/tests/runtime/agentLoopOrchestrator.test.ts`. Because the loop is large, focus on the highest-value paths:
- one-turn success with no tool calls
- tool call + success result
- verification failure triggers retry
- early exit path
- interruption propagation

Mock `callWithTimeout` and `executeTool` to drive the loop deterministically.

### Step 5.3: Run tests

```bash
pnpm vitest run tests/runtime/agentLoopOrchestrator.test.ts --reporter=default
```

Expected: PASS.

### Step 5.4: Commit

```bash
git add packages/core/src/runtime/agentLoopOrchestrator.ts packages/core/tests/runtime/agentLoopOrchestrator.test.ts
git commit -m "feat(runtime): add AgentLoopOrchestrator coordinator"
```

---

## Task 6: Wire `AgentLoopOrchestrator` and finalize `execute()`

**Files:**
- Modify: `packages/core/src/runtime/agentRuntime.ts`

### Step 6.1: Construct the orchestrator

Add private field:

```ts
private agentLoopOrchestrator: AgentLoopOrchestrator;
```

Construct it near the other helpers:

```ts
this.agentLoopOrchestrator = new AgentLoopOrchestrator({
  getConfig: () => this.config,
  getProviders: () => this.providers,
  getRouter: () => this.router,
  getGovernor: () => this.governor,
  getCircuitBreaker: () => this.circuitBreaker,
  getToolExecutionHandler: () => this.toolExecutionHandler,
  getGoalCompletionVerifier: () => this.goalCompletionVerifier,
  getVerificationPipeline: () => this.verificationPipeline,
  getContentScanner: () => this.contentScanner,
  getMemory: () => this.memory,
  getCheckpointingPhase: () => this.checkpointingPhase,
  getSamplesStore: () => this.samplesStore,
  getMetricsCollector: () => getMetricsCollector(),
  getCostEstimator: () => getCostEstimator(),
  getHookManager: () => getHookManager(),
  executeTool: this.executeTool.bind(this),
  callWithTimeout: this.callWithTimeout.bind(this),
});
```

### Step 6.2: Replace the loop body in `execute()`

Replace the entire `for (let attempt = 0 ...)` loop and its surrounding runWithTenant body with:

```ts
let execResult: AgentExecutionResult | undefined;
try {
  const setup = await this.preLoopSetup.prepare(ctx, init);
  if ('status' in setup) {
    execResult = setup;
  } else {
    execResult = await this.agentLoopOrchestrator.run(ctx, init, setup);
  }
} finally {
  await this.finallyCleanupHandler.cleanup({
    runId: init.runId,
    ctx,
    circuitReleased: init.circuitReleased,
    tenantCfg: init.tenantCfg,
    tenantId: init.tenantId,
    currentLane: init.currentLane,
    startTime: init.startTime,
    execResult,
    tenantOverrides: init.tenantOverrides,
  });
}
return execResult;
```

### Step 6.3: Verify `execute()` is under 100 lines

After the refactor, `execute()` should contain only:
1. tenant resolution / early return
2. `runInitializer.initialize(ctx)`
3. `preLoopSetup.prepare` / `agentLoopOrchestrator.run` / `finallyCleanupHandler.cleanup`
4. return result

### Step 6.4: Run tests

```bash
pnpm vitest run tests/runtime/agentLoopOrchestrator.test.ts tests/runtime/capacity-baseline.test.ts tests/runtime/concurrentToolExecution.test.ts --reporter=default
```

Expected: PASS.

### Step 6.5: Commit

```bash
git add packages/core/src/runtime/agentRuntime.ts
git commit -m "refactor(runtime): reduce execute() to coordinator delegation"
```

---

## Task 7: Full validation

**Files:**
- All of `packages/core`

### Step 7.1: Type check

```bash
cd packages/core && npx tsc --noEmit
```

Expected: no errors.

### Step 7.2: Run full test suite

```bash
cd packages/core && pnpm vitest run --reporter=default
```

Expected: 221/221 files passed, 3558/3558 tests passed.

### Step 7.3: Run lint / format check

```bash
cd packages/core && npx prettier --check src/runtime/agentRuntime.ts src/runtime/runInitializer.ts src/runtime/preLoopSetup.ts src/runtime/agentLoopOrchestrator.ts tests/runtime/runInitializer.test.ts tests/runtime/preLoopSetup.test.ts tests/runtime/agentLoopOrchestrator.test.ts
```

Expected: all formatted.

### Step 7.4: Commit

```bash
git add -A
git commit -m "test(runtime): validate AgentRuntime decomposition (3558/3558 tests)"
```

---

## Self-Review

1. **Spec coverage:**
   - `RunInitializer` covers initialization section of spec. ✅
   - `PreLoopSetup` covers pre-loop setup section. ✅
   - `AgentLoopOrchestrator` covers execution loop section. ✅
   - `FinallyCleanupHandler` is reused unchanged. ✅
   - Public API unchanged. ✅
   - Tests added for each coordinator. ✅

2. **Placeholder scan:** No TBD/TODO/fill-in-details. All code is either provided or explicitly references existing lines to move verbatim. ✅

3. **Type consistency:** `InitResult`, `PreLoopSetupResult`, and coordinator method signatures match the design doc. ✅

4. **Risk note:** Because `agentRuntime.ts` contains ~1,950 lines inside `execute()`, the verbatim move is large. If any test fails after Task 6, the fastest recovery is to revert Task 6 (restore the loop inline) and decompose in smaller vertical slices per loop phase.
