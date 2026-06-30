/**
 * ConcurrentWorkflow — 并行批处理编排模式
 *
 * 所有步骤对同一输入并发执行，互不依赖。
 * 企业效率场景：批量数据分析、多视角审查、高吞吐任务。
 *
 * 设计要点（基于 swarms ConcurrentWorkflow + LangGraph map-reduce best practice）：
 * - 失败隔离：默认 failFast=false，单点失败不影响其他步骤
 * - 并发上限受 maxParallel + tokenBudget 双重约束
 * - finalOutput 为所有结果的数组（按 step 声明顺序，失败的填 StepResult）
 */

import type {
  AnyStep,
  BaseOrchestrationConfig,
  ExecutionContext,
  OrchestrationRun,
  StepExecutor,
  StepResult,
} from './orchestrationPatterns';
import {
  computePatternMetrics,
  executeStepWithRetry,
  mergeTokenUsage,
  runWithConcurrencyLimit,
} from './orchestrationPatterns';

export interface ConcurrentWorkflowConfig extends BaseOrchestrationConfig {
  /** 必填：要并发执行的步骤列表 */
  steps: AnyStep[];
  /** 共享输入（每个 step 都接收此输入；可被 inputTransform 改造） */
  input?: unknown;
}

/**
 * 并发执行所有步骤。
 *
 * @example
 * ```ts
 * const run = await runConcurrentWorkflow({
 *   projectId: 'p1',
 *   maxParallel: 4,
 *   executor: myExecutor,
 *   steps: [
 *     { id: 's1', name: 'market', agentId: 'a1', objective: '...' },
 *     { id: 's2', name: 'risk',   agentId: 'a2', objective: '...' },
 *   ],
 *   input: { symbol: 'AAPL' },
 * });
 * ```
 */
export async function runConcurrentWorkflow(
  config: ConcurrentWorkflowConfig,
): Promise<OrchestrationRun<StepResult[]>> {
  const {
    steps,
    input,
    projectId,
    executor,
    maxParallel = 8,
    failFast = false,
    timeoutMs,
    tokenBudget,
    abortSignal,
    metadata,
    onEvent,
  } = config;

  const runId = `conc-${projectId}-${Date.now()}`;
  const startedAtMs = Date.now();
  const startedAt = new Date().toISOString();
  const context: ExecutionContext = {
    runId,
    projectId,
    abortSignal,
    metadata,
  };

  onEvent?.({ type: 'RUN_STARTED', pattern: 'concurrent', runId, projectId });

  // token 预算追踪
  let consumedTokens = 0;
  let budgetBreached = false;
  const shouldSkipNew = (): boolean => {
    if (!tokenBudget || tokenBudget <= 0) return false;
    return consumedTokens >= tokenBudget;
  };

  // 全局超时
  let globalTimer: ReturnType<typeof setTimeout> | undefined;
  const globalTimeoutPromise =
    timeoutMs !== undefined
      ? new Promise<never>((_, reject) => {
          globalTimer = setTimeout(
            () => reject(new Error(`ConcurrentWorkflow global timeout ${timeoutMs}ms`)),
            timeoutMs,
          );
        })
      : null;

  // 为每个 step 构造执行函数
  const tasks = steps.map((step) => async (): Promise<StepResult> => {
    // 预算耗尽则 skip
    if (shouldSkipNew()) {
      const skipped: StepResult = {
        stepId: step.id,
        status: 'SKIPPED',
        error: 'TOKEN_BUDGET_EXHAUSTED',
        durationMs: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        retryCount: 0,
      };
      onEvent?.({
        type: 'STEP_SKIPPED',
        pattern: 'concurrent',
        runId,
        stepId: step.id,
        reason: 'token budget exhausted',
      });
      return skipped;
    }
    const result = await executeStepWithRetry(
      step,
      input,
      context,
      executor,
      onEvent,
      'concurrent',
    );
    // 累加 token
    if (result.tokenUsage) {
      consumedTokens = mergeTokenUsage(
        { promptTokens: consumedTokens, completionTokens: 0, totalTokens: consumedTokens },
        result.tokenUsage,
      ).totalTokens;
      if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
        budgetBreached = true;
      }
    }
    return result;
  });

  // 测量峰值并发度
  let peakConcurrency = 0;
  let currentlyActive = 0;
  const instrumentedTasks = tasks.map((t) => async () => {
    currentlyActive++;
    if (currentlyActive > peakConcurrency) peakConcurrency = currentlyActive;
    try {
      return await t();
    } finally {
      currentlyActive--;
    }
  });

  let results: StepResult[];
  try {
    const mapSettled = (settled: PromiseSettledResult<StepResult>[]): StepResult[] =>
      settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value as StepResult;
        const reason = s.reason as Error;
        const isBudgetExhausted =
          reason?.message === 'TOKEN_BUDGET_EXHAUSTED';
        return {
          stepId: steps[i].id,
          status: isBudgetExhausted ? 'SKIPPED' : 'FAILURE',
          error: reason?.message ?? 'unknown',
          errorClass: isBudgetExhausted ? undefined : 'transient',
          durationMs: 0,
          startedAt,
          completedAt: new Date().toISOString(),
          retryCount: 0,
        } satisfies StepResult;
      });

    if (globalTimeoutPromise) {
      const settled = await Promise.race([
        runWithConcurrencyLimit(instrumentedTasks, maxParallel, shouldSkipNew),
        globalTimeoutPromise,
      ]);
      results = mapSettled(settled);
    } else {
      const settled = await runWithConcurrencyLimit(
        instrumentedTasks,
        maxParallel,
        shouldSkipNew,
      );
      results = mapSettled(settled);
    }
  } catch (e) {
    const completedAt = new Date().toISOString();
    onEvent?.({
      type: 'RUN_FAILED',
      pattern: 'concurrent',
      runId,
      error: (e as Error).message,
    });
    if (globalTimer) clearTimeout(globalTimer);
    return {
      pattern: 'concurrent',
      runId,
      projectId,
      status: 'FAILED',
      stepResults: [],
      error: (e as Error).message,
      startedAt,
      completedAt,
      metrics: computePatternMetrics([], startedAtMs, Date.now(), 0, budgetBreached),
    };
  }
  if (globalTimer) clearTimeout(globalTimer);

  // 按原始 step 顺序对齐结果
  const byId = new Map(results.map((r) => [r.stepId, r]));
  const orderedResults = steps.map((s) => byId.get(s.id) ?? results[0]);

  const failedCount = orderedResults.filter((r) => r.status === 'FAILURE').length;
  const skippedCount = orderedResults.filter((r) => r.status === 'SKIPPED').length;
  const successCount = orderedResults.filter((r) => r.status === 'SUCCESS').length;

  // 状态判定
  let status: OrchestrationRun['status'];
  if (abortSignal?.aborted) {
    status = 'CANCELLED';
  } else if (successCount === 0 && orderedResults.length > 0) {
    status = 'FAILED';
  } else if (failFast && failedCount > 0) {
    status = 'FAILED';
  } else if (failedCount > 0 || skippedCount > 0) {
    status = 'PARTIAL';
  } else {
    status = 'COMPLETED';
  }

  const completedAt = new Date().toISOString();
  const metrics = computePatternMetrics(
    orderedResults,
    startedAtMs,
    Date.now(),
    peakConcurrency,
    budgetBreached,
  );

  onEvent?.({
    type: 'RUN_COMPLETED',
    pattern: 'concurrent',
    runId,
    status,
  });

  return {
    pattern: 'concurrent',
    runId,
    projectId,
    status,
    stepResults: orderedResults,
    finalOutput: orderedResults,
    startedAt,
    completedAt,
    metrics,
  };
}

/**
 * Builder — 与 SequentialPipelineBuilder 风格一致。
 */
export class ConcurrentWorkflowBuilder {
  private steps: AnyStep[] = [];
  private config: Omit<ConcurrentWorkflowConfig, 'steps' | 'executor'>;
  private executor?: StepExecutor;

  constructor(projectId: string) {
    this.config = { projectId, maxParallel: 8, failFast: false };
  }

  addStep(step: AnyStep): this {
    this.steps.push(step);
    return this;
  }

  withInput(input: unknown): this {
    this.config.input = input;
    return this;
  }

  withMaxParallel(n: number): this {
    this.config.maxParallel = n;
    return this;
  }

  withFailFast(failFast: boolean): this {
    this.config.failFast = failFast;
    return this;
  }

  withTimeout(ms: number): this {
    this.config.timeoutMs = ms;
    return this;
  }

  withTokenBudget(budget: number): this {
    this.config.tokenBudget = budget;
    return this;
  }

  withAbortSignal(signal: AbortSignal): this {
    this.config.abortSignal = signal;
    return this;
  }

  withExecutor(executor: StepExecutor): this {
    this.executor = executor;
    return this;
  }

  withMetadata(metadata: Record<string, unknown>): this {
    this.config.metadata = metadata;
    return this;
  }

  withEventHandler(handler: ConcurrentWorkflowConfig['onEvent']): this {
    this.config.onEvent = handler;
    return this;
  }

  async run(): Promise<OrchestrationRun<StepResult[]>> {
    if (!this.executor) {
      throw new Error('ConcurrentWorkflowBuilder: executor is required (call withExecutor)');
    }
    return runConcurrentWorkflow({
      ...this.config,
      steps: this.steps,
      executor: this.executor,
    });
  }
}
