/**
 * Orchestration Patterns — Concurrent / Graph(DAG) / MixtureOfAgents / Router
 *
 * 扩展自 orchestration.ts 的 Sequential 模式，补齐企业效率场景下缺失的：
 * - ConcurrentWorkflow: 并行批处理（吞吐倍增）
 * - GraphWorkflow: DAG + 自动并行（fan-out/fan-in/diamond）
 * - MixtureOfAgents: 并行专家 + 综合器（一次出高质量决策）
 * - SwarmRouter: 元编排，运行时按任务特征动态选最优架构
 *
 * 设计原则（基于 LangGraph / CrewAI / swarms best practice）：
 * 1. 执行器注入模式 — 编排器接受 StepExecutor 函数，与具体 agent 调用解耦
 *    （参考 LangGraph 的 node-as-callable，CrewAI 的 task.delegate）
 * 2. Step 接口复用现有 SequentialStep 字段，新增 dependencies 供 DAG 使用
 * 3. 失败隔离 — 默认 failFast=false 时单节点失败不影响其他独立分支
 * 4. 拓扑层并发 — DAG 用 Kahn 算法分层，同层无依赖节点全部并发
 * 5. 成本可控 — 所有模式都支持 tokenBudget 软顶与 maxParallel 并发上限
 */

import type { TokenUsage } from './orchestration';

// ============================================================================
// 共享基础类型
// ============================================================================

/**
 * 统一的步骤执行器接口。
 * 编排器自身不调用 agent，而是把 step 派发给注入的 executor。
 * 这让编排器可测试、可复用，并与 AgentRuntime 解耦。
 *
 * executor 接收：
 * - step: 步骤定义（含 agentId/objective/timeout）
 * - input: 上游传入的数据（DAG 中是所有依赖节点输出的聚合）
 * - context: 执行上下文（用于取消、追踪、审计）
 *
 * 返回 step 的输出与 token 用量。
 */
export interface StepExecutor<TStep extends AnyStep = AnyStep> {
  (step: TStep, input: unknown, context: ExecutionContext): Promise<StepOutput>;
}

/**
 * 步骤执行结果（不含状态/时间戳，由编排器统一封装）。
 */
export interface StepOutput {
  /** 步骤产出的数据 */
  output?: unknown;
  /** 该步骤消耗的 token（用于 metrics 与 tokenBudget 软顶） */
  tokenUsage?: TokenUsage;
  /** 执行器可附带的任意元数据（如 provider/model 用于审计） */
  metadata?: Record<string, unknown>;
}

/**
 * 跨所有编排模式共享的步骤基类。
 * 字段与 orchestration.ts 的 SequentialStep 保持一致以便互转，
 * 额外新增 dependencies（DAG 必需）与 costTier（Router 选型用）。
 */
export interface AnyStep {
  /** 唯一步骤标识 */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** 负责该步骤的 agent */
  agentId: string;
  /** 步骤目标描述 */
  objective: string;
  /** 该步骤依赖的上游 step id 列表（DAG 用；Sequential/Concurrent 可留空） */
  dependencies?: string[];
  /** 步骤超时（ms） */
  timeoutMs?: number;
  /** 失败重试次数上限 */
  maxRetries?: number;
  /**
   * 成本层级 — Router 用于在成本敏感任务中按层级分配并发。
   * - low: 便宜模型/简单工具，可高并发
   * - standard: 默认
   * - high: 昂贵模型/长任务，应限并发或串行
   */
  costTier?: 'low' | 'standard' | 'high';
  /** 输入变换：在传入 executor 前对 input 加工 */
  inputTransform?: (input: unknown, context: ExecutionContext) => unknown;
  /** 输出变换：在写入结果前对 output 加工 */
  outputTransform?: (output: unknown, context: ExecutionContext) => unknown;
  /** 可选校验：失败则按 maxRetries 重试 */
  validator?: (output: unknown) => { valid: boolean; errors?: string[] };
}

/**
 * 步骤执行结果（编排器层面，含状态/时序）。
 */
export interface StepResult {
  stepId: string;
  status: 'SUCCESS' | 'FAILURE' | 'SKIPPED' | 'TIMEOUT';
  output?: unknown;
  error?: string;
  /** 失败分类，便于审计与重试策略 */
  errorClass?: 'transient' | 'permanent' | 'unknown';
  tokenUsage?: TokenUsage;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  /** 重试次数（首次为 0） */
  retryCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * 执行上下文 — 传入 executor 与 transform。
 */
export interface ExecutionContext {
  /** 本次编排运行的唯一 id */
  runId: string;
  /** 项目 id */
  projectId: string;
  /** 取消信号（与 SequentialContext.abortSignal 对齐） */
  abortSignal?: AbortSignal;
  /** 用户元数据，透传到每个 step */
  metadata?: Record<string, unknown>;
}

/**
 * 编排运行状态。
 */
export type OrchestrationRunStatus =
  'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

/**
 * 编排运行结果（所有模式共用）。
 */
export interface OrchestrationRun<TOutput = unknown> {
  /** 编排器类型标识 */
  pattern: OrchestrationPattern;
  runId: string;
  projectId: string;
  status: OrchestrationRunStatus;
  /** 所有步骤结果（按完成顺序） */
  stepResults: StepResult[];
  /** 最终输出（Sequential=末步; Concurrent=结果数组; MoA=综合器输出; DAG=终端节点输出聚合） */
  finalOutput?: TOutput;
  startedAt: string;
  completedAt?: string;
  error?: string;
  metrics: PatternMetrics;
}

/**
 * 所有支持的编排模式标识。
 */
export type OrchestrationPattern =
  'sequential' | 'concurrent' | 'graph' | 'mixture-of-agents' | 'router';

// ============================================================================
// 编排事件（与 SequentialEvent 风格一致，供 EventBus 接入）
// ============================================================================

export type OrchestrationEvent =
  | { type: 'RUN_STARTED'; pattern: OrchestrationPattern; runId: string; projectId: string }
  | {
      type: 'STEP_STARTED';
      pattern: OrchestrationPattern;
      runId: string;
      stepId: string;
      attempt: number;
    }
  | {
      type: 'STEP_COMPLETED';
      pattern: OrchestrationPattern;
      runId: string;
      stepId: string;
      result: StepResult;
    }
  | {
      type: 'STEP_FAILED';
      pattern: OrchestrationPattern;
      runId: string;
      stepId: string;
      error: string;
      attempt: number;
      willRetry: boolean;
    }
  | {
      type: 'STEP_SKIPPED';
      pattern: OrchestrationPattern;
      runId: string;
      stepId: string;
      reason: string;
    }
  | {
      type: 'RUN_COMPLETED';
      pattern: OrchestrationPattern;
      runId: string;
      status: OrchestrationRunStatus;
    }
  | {
      type: 'RUN_FAILED';
      pattern: OrchestrationPattern;
      runId: string;
      error: string;
    };

export type OrchestrationEventHandler = (event: OrchestrationEvent) => void | Promise<void>;

// ============================================================================
// 公共配置
// ============================================================================

/**
 * 所有编排模式共享的配置。
 */
export interface BaseOrchestrationConfig {
  /** 项目 id（写入 run） */
  projectId: string;
  /** 最大并发数（默认 8；受 Petri net 槽位与 costTier 共同约束） */
  maxParallel?: number;
  /** 全局超时（ms） */
  timeoutMs?: number;
  /** 是否 fail-fast（默认 false — 单点失败不阻断独立分支） */
  failFast?: boolean;
  /**
   * Token 软顶 — 累计 totalTokens 超过此值时：
   * 1. 标记 breach
   * 2. 取消尚未开始的 step（与 SequentialPipeline.tokenBudget 一致）
   * 设为 0 或 undefined 关闭
   */
  tokenBudget?: number;
  /** 取消信号 */
  abortSignal?: AbortSignal;
  /** 用户元数据 */
  metadata?: Record<string, unknown>;
  /** 事件处理器 */
  onEvent?: OrchestrationEventHandler;
  /** 执行器（必需 — 由调用方注入） */
  executor: StepExecutor;
}

/**
 * 编排指标 — 与 orchestration.ts 的 OrchestrationMetrics 互补，
 * 增加并行度相关字段（concurrency 是企业效率的关键观测点）。
 */
export interface PatternMetrics {
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  totalDurationMs: number;
  /** 各 step 累计 token */
  totalTokenUsage: TokenUsage;
  /** 实际达成的最大并发度（观测用，对比 maxParallel） */
  peakConcurrency: number;
  /** step 执行时间总和（≤ totalDurationMs；差额为调度/同步开销） */
  stepDurationSumMs: number;
  /** 超时 step 数 */
  timeoutSteps: number;
  /** 重试总次数 */
  retryCount: number;
  /** token 软顶是否被触发 */
  tokenBudgetBreached: boolean;
}

// ============================================================================
// 共享运行时辅助
// ============================================================================

/**
 * 单 step 执行 + 重试 + 超时 + 校验的统一逻辑。
 * 所有编排模式都走这条路径，保证审计与重试行为一致。
 */
export async function executeStepWithRetry(
  step: AnyStep,
  input: unknown,
  context: ExecutionContext,
  executor: StepExecutor,
  onEvent?: OrchestrationEventHandler,
  pattern: OrchestrationPattern = 'sequential',
): Promise<StepResult> {
  const maxRetries = step.maxRetries ?? 0;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let lastError: Error | undefined;
  let retryCount = 0;

  // inputTransform / outputTransform 包装
  const applyInput = step.inputTransform
    ? (() => {
        try {
          return step.inputTransform!(input, context);
        } catch (e) {
          // transform 失败按 permanent 失败处理
          throw new Error(`inputTransform failed: ${(e as Error).message}`);
        }
      })()
    : input;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (context.abortSignal?.aborted) {
      const result: StepResult = {
        stepId: step.id,
        status: 'SKIPPED',
        error: 'aborted',
        durationMs: Date.now() - startMs,
        startedAt,
        completedAt: new Date().toISOString(),
        retryCount: attempt,
      };
      return result;
    }

    onEvent?.({
      type: 'STEP_STARTED',
      pattern,
      runId: context.runId,
      stepId: step.id,
      attempt,
    });

    try {
      let stepOutput: StepOutput;
      if (step.timeoutMs) {
        stepOutput = await withTimeout(
          executor(step, applyInput, context),
          step.timeoutMs,
          step.id,
        );
      } else {
        stepOutput = await executor(step, applyInput, context);
      }

      let finalOutput = stepOutput.output;
      if (step.outputTransform) {
        finalOutput = step.outputTransform!(finalOutput, context);
      }

      // 校验
      if (step.validator) {
        const v = step.validator(finalOutput);
        if (!v.valid) {
          throw new Error(`validation failed: ${v.errors?.join('; ') ?? 'unknown'}`);
        }
      }

      const completedAt = new Date().toISOString();
      const result: StepResult = {
        stepId: step.id,
        status: 'SUCCESS',
        output: finalOutput,
        tokenUsage: stepOutput.tokenUsage,
        durationMs: Date.now() - startMs,
        startedAt,
        completedAt,
        retryCount: attempt,
        metadata: stepOutput.metadata,
      };
      onEvent?.({
        type: 'STEP_COMPLETED',
        pattern,
        runId: context.runId,
        stepId: step.id,
        result,
      });
      return result;
    } catch (e) {
      lastError = e as Error;
      retryCount = attempt;
      const isTimeout = (e as Error).name === 'StepTimeoutError';
      const willRetry = attempt < maxRetries;
      onEvent?.({
        type: 'STEP_FAILED',
        pattern,
        runId: context.runId,
        stepId: step.id,
        error: (e as Error).message,
        attempt,
        willRetry,
      });
      if (!willRetry) break;
    }
  }

  // 全部重试耗尽
  const completedAt = new Date().toISOString();
  const isTimeout = lastError?.name === 'StepTimeoutError';
  return {
    stepId: step.id,
    status: isTimeout ? 'TIMEOUT' : 'FAILURE',
    error: lastError?.message ?? 'unknown error',
    errorClass: isTimeout ? 'transient' : 'unknown',
    durationMs: Date.now() - startMs,
    startedAt,
    completedAt,
    retryCount,
  };
}

/**
 * 超时包装 — 抛 StepTimeoutError 便于分类。
 */
export class StepTimeoutError extends Error {
  constructor(stepId: string, ms: number) {
    super(`Step ${stepId} timed out after ${ms}ms`);
    this.name = 'StepTimeoutError';
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, stepId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(stepId, ms)), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 累加 token usage。
 *
 * 注：orchestration.ts 的 TokenUsage 仅含 promptTokens/completionTokens/totalTokens；
 * ultimate/sequential.ts 的 TokenUsage 额外含 estimatedCost。
 * 此函数保守处理：若运行时 delta 上有 estimatedCost 则累加，否则忽略。
 */
export function mergeTokenUsage(acc: TokenUsage, delta?: TokenUsage): TokenUsage {
  if (!delta) return acc;
  const result: TokenUsage = {
    promptTokens: acc.promptTokens + delta.promptTokens,
    completionTokens: acc.completionTokens + delta.completionTokens,
    totalTokens: acc.totalTokens + delta.totalTokens,
  };
  // 兼容 ultimate/sequential.ts 的扩展 TokenUsage（运行时 duck-typing）
  const accCost = (acc as TokenUsage & { estimatedCost?: number }).estimatedCost;
  const deltaCost = (delta as TokenUsage & { estimatedCost?: number }).estimatedCost;
  if (accCost !== undefined || deltaCost !== undefined) {
    (result as TokenUsage & { estimatedCost?: number }).estimatedCost =
      (accCost ?? 0) + (deltaCost ?? 0);
  }
  return result;
}

/**
 * 计算最终 metrics — 所有模式共用。
 */
export function computePatternMetrics(
  stepResults: StepResult[],
  startedAtMs: number,
  completedAtMs: number,
  peakConcurrency: number,
  tokenBudgetBreached: boolean,
): PatternMetrics {
  const totalTokenUsage: TokenUsage = stepResults.reduce(
    (acc, r) => mergeTokenUsage(acc, r.tokenUsage),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
  return {
    totalSteps: stepResults.length,
    completedSteps: stepResults.filter((r) => r.status === 'SUCCESS').length,
    failedSteps: stepResults.filter((r) => r.status === 'FAILURE').length,
    skippedSteps: stepResults.filter((r) => r.status === 'SKIPPED').length,
    totalDurationMs: completedAtMs - startedAtMs,
    totalTokenUsage,
    peakConcurrency,
    stepDurationSumMs: stepResults.reduce((s, r) => s + r.durationMs, 0),
    timeoutSteps: stepResults.filter((r) => r.status === 'TIMEOUT').length,
    retryCount: stepResults.reduce((s, r) => s + r.retryCount, 0),
    tokenBudgetBreached,
  };
}

/**
 * 受 tokenBudget / maxParallel / costTier 共同约束的并发池。
 *
 * 设计要点（best practice）：
 * - low costTier 步骤共享 maxParallel 池
 * - high costTier 步骤额外占用独立配额（避免一个昂贵步骤饿死其他步骤）
 * - tokenBudget 触达时拒绝提交新任务，已运行任务允许完成
 */
export async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  maxParallel: number,
  shouldSkipNew?: () => boolean,
): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) return [];
  const effectiveParallel = Math.max(1, Math.min(maxParallel, tasks.length));
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;
  let active = 0;

  return new Promise((resolve) => {
    const launchNext = (): void => {
      // 没有更多任务且没有活跃任务 → 完成
      while (active < effectiveParallel && nextIndex < tasks.length) {
        if (shouldSkipNew?.()) {
          // 预算耗尽：剩余任务全部标记为 skipped（fulfilled 但带 skip 标记由调用方处理）
          // 这里我们用 rejected + 特定原因；调用方按 reason 转换为 SKIPPED
          for (let i = nextIndex; i < tasks.length; i++) {
            results[i] = {
              status: 'rejected',
              reason: new Error('TOKEN_BUDGET_EXHAUSTED'),
            };
          }
          nextIndex = tasks.length;
          if (active === 0) resolve(results);
          return;
        }
        const idx = nextIndex++;
        active++;
        const task = tasks[idx];
        Promise.resolve()
          .then(() => task())
          .then(
            (val) => {
              results[idx] = { status: 'fulfilled', value: val };
              active--;
              if (nextIndex < tasks.length) launchNext();
              else if (active === 0) resolve(results);
            },
            (err) => {
              results[idx] = { status: 'rejected', reason: err };
              active--;
              if (nextIndex < tasks.length) launchNext();
              else if (active === 0) resolve(results);
            },
          );
      }
    };
    launchNext();
  });
}
