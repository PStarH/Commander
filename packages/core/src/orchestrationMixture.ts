/**
 * MixtureOfAgents — 并行专家 + 综合器
 *
 * 多个专家 agent 对同一输入并行给出方案，再由综合器 agent 融合所有方案
 * 输出最终决策。一次出高质量结果，省去串行重试。
 *
 * 设计要点（基于 swarms MixtureOfAgents + together.ai MoA 论文 best practice）：
 * - 专家层全并行（复用 ConcurrentWorkflow 能力）
 * - 综合器作为单独的第二阶段 step，输入 = 所有专家输出
 * - 复用 FusionEngine 检测专家间的文件/资源冲突（不阻塞综合，只附报告）
 * - 支持 minExperts：少于该数量成功时降级为 PARTIAL
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
import type { FusionReport } from './swarm/types';
import { FusionEngine } from './swarm/fusionEngine';

export interface MixtureOfAgentsConfig extends BaseOrchestrationConfig {
  /** 必填：专家步骤列表（并行执行） */
  experts: AnyStep[];
  /** 必填：综合器步骤 — 接收所有专家输出作为输入 */
  synthesizer: AnyStep;
  /** 共享输入（喂给每个专家） */
  input?: unknown;
  /**
   * 综合器要成功所需的最少专家成功数（默认 1）。
   * 少于此值则不调用综合器，直接返回 PARTIAL。
   */
  minExperts?: number;
  /**
   * 是否在专家输出上运行 FusionEngine 冲突检测。
   * 报告会附到 synthesizer 的 input 中（不阻塞综合）。
   * 默认 true。
   */
  detectConflicts?: boolean;
}

/**
 * 喂给综合器的输入结构。
 */
export interface SynthesizerInput {
  /** 原始输入 */
  originalInput: unknown;
  /** 各专家的输出（按声明顺序，失败的为 undefined） */
  expertOutputs: Array<{ stepId: string; output?: unknown; status: StepResult['status'] }>;
  /** FusionEngine 冲突报告（detectConflicts=true 时） */
  fusionReport?: FusionReport;
}

/**
 * 执行 Mixture-of-Agents。
 *
 * @example
 * ```ts
 * const run = await runMixtureOfAgents({
 *   projectId: 'p1',
 *   executor: myExecutor,
 *   input: '设计一个高并发订单系统',
 *   experts: [
 *     { id: 'e1', name: 'cap', agentId: 'a1', objective: '从容量角度' },
 *     { id: 'e2', name: 'sec', agentId: 'a2', objective: '从安全角度' },
 *     { id: 'e3', name: 'cost', agentId: 'a3', objective: '从成本角度' },
 *   ],
 *   synthesizer: { id: 'syn', name: 'syn', agentId: 'a4', objective: '综合三专家方案' },
 * });
 * ```
 */
export async function runMixtureOfAgents(config: MixtureOfAgentsConfig): Promise<OrchestrationRun> {
  const {
    experts,
    synthesizer,
    input,
    minExperts = 1,
    detectConflicts = true,
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

  const runId = `moa-${projectId}-${Date.now()}`;
  const startedAtMs = Date.now();
  const startedAt = new Date().toISOString();
  const context: ExecutionContext = { runId, projectId, abortSignal, metadata };

  onEvent?.({ type: 'RUN_STARTED', pattern: 'mixture-of-agents', runId, projectId });

  let consumedTokens = 0;
  let budgetBreached = false;
  let peakConcurrency = 0;
  let currentlyActive = 0;

  // ============ 阶段 1：专家并行 ============
  const expertTasks = experts.map((step) => async (): Promise<StepResult> => {
    if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
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
        pattern: 'mixture-of-agents',
        runId,
        stepId: step.id,
        reason: 'token budget exhausted',
      });
      return skipped;
    }
    currentlyActive++;
    if (currentlyActive > peakConcurrency) peakConcurrency = currentlyActive;
    try {
      const result = await executeStepWithRetry(
        step,
        input,
        context,
        executor,
        onEvent,
        'mixture-of-agents',
      );
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
    } finally {
      currentlyActive--;
    }
  });

  const expertSettled = await runWithConcurrencyLimit(expertTasks, maxParallel);
  const expertResults: StepResult[] = expertSettled.map((s, i) =>
    s.status === 'fulfilled'
      ? (s.value as StepResult)
      : ({
          stepId: experts[i].id,
          status: 'FAILURE',
          error: (s.reason as Error)?.message ?? 'unknown',
          errorClass: 'transient',
          durationMs: 0,
          startedAt,
          completedAt: new Date().toISOString(),
          retryCount: 0,
        } satisfies StepResult),
  );

  const successCount = expertResults.filter((r) => r.status === 'SUCCESS').length;
  const allStepResults: StepResult[] = [...expertResults];

  // ============ 阶段 1.5：FusionEngine 冲突检测（可选） ============
  let fusionReport: FusionReport | undefined;
  if (detectConflicts) {
    // 把专家输出适配为 SwarmNode 形态供 FusionEngine 复用
    const swarmNodes = expertResults
      .filter((r) => r.status === 'SUCCESS' && r.output !== undefined)
      .map((r) => ({
        id: r.stepId,
        goal: '',
        parentId: null,
        status: 'completed' as const,
        workerOutput: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
        subNodes: [],
        children: [],
        dependencies: [],
      }));
    if (swarmNodes.length >= 2) {
      fusionReport = new FusionEngine().analyze(swarmNodes, 1);
    }
  }

  // ============ 阶段 2：综合器 ============
  let synthesizerResult: StepResult | undefined;
  if (successCount < minExperts) {
    // 专家数不足，跳过综合器
    synthesizerResult = {
      stepId: synthesizer.id,
      status: 'SKIPPED',
      error: `only ${successCount}/${experts.length} experts succeeded (minExperts=${minExperts})`,
      durationMs: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      retryCount: 0,
    };
    onEvent?.({
      type: 'STEP_SKIPPED',
      pattern: 'mixture-of-agents',
      runId,
      stepId: synthesizer.id,
      reason: 'insufficient experts',
    });
  } else if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
    // 预算耗尽
    budgetBreached = true;
    synthesizerResult = {
      stepId: synthesizer.id,
      status: 'SKIPPED',
      error: 'TOKEN_BUDGET_EXHAUSTED',
      durationMs: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      retryCount: 0,
    };
    onEvent?.({
      type: 'STEP_SKIPPED',
      pattern: 'mixture-of-agents',
      runId,
      stepId: synthesizer.id,
      reason: 'token budget exhausted',
    });
  } else {
    const synInput: SynthesizerInput = {
      originalInput: input,
      expertOutputs: expertResults.map((r) => ({
        stepId: r.stepId,
        output: r.output,
        status: r.status,
      })),
      fusionReport,
    };
    currentlyActive++;
    if (currentlyActive > peakConcurrency) peakConcurrency = currentlyActive;
    try {
      synthesizerResult = await executeStepWithRetry(
        synthesizer,
        synInput,
        context,
        executor,
        onEvent,
        'mixture-of-agents',
      );
      if (synthesizerResult.tokenUsage) {
        consumedTokens = mergeTokenUsage(
          { promptTokens: consumedTokens, completionTokens: 0, totalTokens: consumedTokens },
          synthesizerResult.tokenUsage,
        ).totalTokens;
        if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
          budgetBreached = true;
        }
      }
    } finally {
      currentlyActive--;
    }
  }
  allStepResults.push(synthesizerResult);

  // ============ 状态判定 ============
  const failedCount = allStepResults.filter((r) => r.status === 'FAILURE').length;
  const skippedCount = allStepResults.filter((r) => r.status === 'SKIPPED').length;
  let status: OrchestrationRun['status'];
  if (abortSignal?.aborted) {
    status = 'CANCELLED';
  } else if (synthesizerResult.status === 'SUCCESS') {
    status = 'COMPLETED';
  } else if (synthesizerResult.status === 'SKIPPED' && successCount > 0) {
    status = 'PARTIAL';
  } else if (failFast && failedCount > 0) {
    status = 'FAILED';
  } else if (successCount === 0) {
    status = 'FAILED';
  } else {
    status = 'PARTIAL';
  }

  const completedAt = new Date().toISOString();
  const metrics = computePatternMetrics(
    allStepResults,
    startedAtMs,
    Date.now(),
    peakConcurrency,
    budgetBreached,
  );

  onEvent?.({
    type: 'RUN_COMPLETED',
    pattern: 'mixture-of-agents',
    runId,
    status,
  });

  return {
    pattern: 'mixture-of-agents',
    runId,
    projectId,
    status,
    stepResults: allStepResults,
    finalOutput: synthesizerResult.output,
    startedAt,
    completedAt,
    metrics,
  };
}

/**
 * Builder。
 */
export class MixtureOfAgentsBuilder {
  private experts: AnyStep[] = [];
  private synthesizerStep?: AnyStep;
  private config: Omit<MixtureOfAgentsConfig, 'experts' | 'synthesizer' | 'executor'>;
  private executor?: StepExecutor;

  constructor(projectId: string) {
    this.config = {
      projectId,
      maxParallel: 8,
      failFast: false,
      minExperts: 1,
      detectConflicts: true,
    };
  }

  addExpert(step: AnyStep): this {
    this.experts.push(step);
    return this;
  }

  setSynthesizer(step: AnyStep): this {
    this.synthesizerStep = step;
    return this;
  }

  withInput(input: unknown): this {
    this.config.input = input;
    return this;
  }

  withMinExperts(n: number): this {
    this.config.minExperts = n;
    return this;
  }

  withDetectConflicts(b: boolean): this {
    this.config.detectConflicts = b;
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

  withEventHandler(handler: MixtureOfAgentsConfig['onEvent']): this {
    this.config.onEvent = handler;
    return this;
  }

  async run(): Promise<OrchestrationRun> {
    if (!this.executor) {
      throw new Error('MixtureOfAgentsBuilder: executor is required');
    }
    if (!this.synthesizerStep) {
      throw new Error('MixtureOfAgentsBuilder: synthesizer is required (call setSynthesizer)');
    }
    if (this.experts.length === 0) {
      throw new Error('MixtureOfAgentsBuilder: at least one expert is required');
    }
    return runMixtureOfAgents({
      ...this.config,
      experts: this.experts,
      synthesizer: this.synthesizerStep,
      executor: this.executor,
    });
  }
}
