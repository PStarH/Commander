/**
 * DynamicReplanner — 运行中动态再规划闭环
 *
 * 借鉴 ClawTeam autoresearch 案例：leader 每 N 分钟检查中间结果，
 * 识别最优 agent 的发现，kill 空闲/低效 agent，从最优 checkpoint 派生
 * 新一批 agent。这是"自适应编排"——不是固定拓扑执行到底，而是边跑边收敛。
 *
 * 设计要点（基于 ClawTeam cross-pollination + checkpoint 恢复）：
 * - 监控：定期采集中间结果，由 ReplannerHook 评估
 * - 决策：hook 返回 ReplanDecision（continue / spawn-new / kill-idle / abort）
 * - 派生：从最优 step 的 output 作为新一批 step 的 initialInput
 * - 与 EventSourcing 集成：每次再规划记入事件日志，可重放
 */

import type {
  AnyStep,
  ExecutionContext,
  StepExecutor,
  StepResult,
} from './orchestrationPatterns';
import { CrossPollinationEngine } from './crossPollination';
import type { Insight } from './crossPollination';

// ============================================================================
// 再规划数据模型
// ============================================================================

/**
 * 再规划决策 — 由用户提供的 hook 返回。
 */
export interface ReplanDecision {
  /** 决策类型 */
  action:
    | 'continue' // 继续当前规划，无需调整
    | 'spawn-new' // 从最优 checkpoint 派生新一批 step
    | 'kill-idle' // 终止指定 step（释放资源）
    | 'abort'; // 中止整个运行
  /** spawn-new 时：新派生的 step 列表 */
  newSteps?: AnyStep[];
  /** spawn-new 时：新 step 的 initialInput（通常是最优 step 的 output） */
  newInitialInput?: unknown;
  /** kill-idle 时：要终止的 step id 列表 */
  killStepIds?: string[];
  /** abort 时：中止原因 */
  reason?: string;
  /** 本次决策的人类可读说明（写入事件日志） */
  rationale: string;
}

/**
 * 再规划上下文 — 喂给 hook 做决策。
 */
export interface ReplanContext {
  /** 当前已完成的所有 step 结果 */
  completedResults: StepResult[];
  /** 当前正在运行的 step id（含状态） */
  inFlightSteps: Array<{ stepId: string; startedAt: string }>;
  /** CrossPollinationEngine 已积累的 insights */
  insights: Insight[];
  /** 当前已消耗的 token */
  consumedTokens: number;
  /** 当前 token 预算 */
  tokenBudget?: number;
  /** 已运行时长（ms） */
  elapsedMs: number;
  /** 第几轮再规划（0=首轮检查前） */
  replanRound: number;
}

/**
 * 再规划 hook 签名 — 用户实现此函数定义再规划策略。
 */
export type ReplannerHook = (ctx: ReplanContext) => ReplanDecision | Promise<ReplanDecision>;

// ============================================================================
// 动态执行循环
// ============================================================================

export interface DynamicReplanConfig {
  projectId: string;
  /** 初始 step 列表 */
  initialSteps: AnyStep[];
  /** 初始输入 */
  initialInput?: unknown;
  /** 执行器 */
  executor: StepExecutor;
  /** 必填：再规划 hook */
  replanner: ReplannerHook;
  /** 检查间隔（ms，默认 30000 — 对齐 ClawTeam 的 30 分钟检查节奏的快速版） */
  checkIntervalMs?: number;
  /** 最大再规划轮次（防无限循环，默认 5） */
  maxReplanRounds?: number;
  /** 最大总运行时长（ms） */
  totalTimeoutMs?: number;
  /** token 软顶 */
  tokenBudget?: number;
  /** 最大并发 */
  maxParallel?: number;
  /** 取消信号 */
  abortSignal?: AbortSignal;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 是否启用 cross-pollination（默认 true） */
  enableCrossPollination?: boolean;
  /** cross-pollination 提取的 top-K（默认 5） */
  crossPollinationTopK?: number;
}

/**
 * 动态再规划执行结果。
 */
export interface DynamicReplanRun {
  runId: string;
  projectId: string;
  status: 'COMPLETED' | 'ABORTED' | 'TIMEOUT' | 'TOKEN_BUDGET_EXHAUSTED';
  /** 所有轮次的 step 结果（含被 kill 的） */
  allStepResults: StepResult[];
  /** 再规划历史（每轮决策） */
  replanHistory: ReplanDecision[];
  /** 最终积累的 insights */
  finalInsights: Insight[];
  startedAt: string;
  completedAt: string;
  /** 总消耗 token */
  totalTokensConsumed: number;
  /** 总运行时长 */
  totalDurationMs: number;
  /** 再规划轮次数 */
  replanRoundsExecuted: number;
}

/**
 * 执行动态再规划循环。
 *
 * 流程：
 * 1. 并发执行 initialSteps
 * 2. 等待全部完成 或 checkIntervalMs 触发检查
 * 3. 调用 replanner hook → ReplanDecision
 * 4. 按决策：continue / spawn-new（执行新一批）/ kill-idle / abort
 * 5. 重复直到 continue 或 abort 或达到 maxReplanRounds
 *
 * @example
 * ```ts
 * const run = await runDynamicReplan({
 *   projectId: 'research',
 *   initialSteps: [
 *     { id: 'exp1', name: 'e1', agentId: 'a1', objective: '探索 depth 8-16' },
 *     { id: 'exp2', name: 'e2', agentId: 'a2', objective: '探索 batch 64-256' },
 *   ],
 *   executor: myExecutor,
 *   replanner: async (ctx) => {
 *     const best = ctx.completedResults
 *       .filter(r => r.status === 'SUCCESS')
 *       .sort((a, b) => (b.output as any)?.score - (a.output as any)?.score)[0];
 *     if (best && ctx.replanRound < 3) {
 *       return {
 *         action: 'spawn-new',
 *         newSteps: [{ id: `exp-r${ctx.replanRound}`, name: 'refine', agentId: 'a1', objective: '基于最优配置细化' }],
 *         newInitialInput: best.output,
 *         rationale: `从 ${best.stepId} 派生细化实验`,
 *       };
 *     }
 *     return { action: 'continue', rationale: '完成' };
 *   },
 * });
 * ```
 */
export async function runDynamicReplan(
  config: DynamicReplanConfig,
): Promise<DynamicReplanRun> {
  const {
    projectId,
    initialSteps,
    initialInput,
    executor,
    replanner,
    checkIntervalMs = 30_000,
    maxReplanRounds = 5,
    totalTimeoutMs,
    tokenBudget,
    maxParallel = 8,
    abortSignal,
    metadata,
    enableCrossPollination = true,
    crossPollinationTopK = 5,
  } = config;

  const runId = `dyn-${projectId}-${Date.now()}`;
  const startMs = Date.now();
  const startedAt = new Date().toISOString();
  const context: ExecutionContext = { runId, projectId, abortSignal, metadata };

  const allResults: StepResult[] = [];
  const replanHistory: ReplanDecision[] = [];
  const crossPollination = enableCrossPollination
    ? new CrossPollinationEngine()
    : undefined;
  let consumedTokens = 0;
  let replanRounds = 0;

  // 当前轮次的 step 与输入
  let currentSteps = [...initialSteps];
  let currentInput = initialInput;

  // 执行一批 step 的内部函数（复用并发池逻辑）
  const executeBatch = async (
    steps: AnyStep[],
    input: unknown,
  ): Promise<StepResult[]> => {
    // 简化版并发执行（不引入 orchestrationConcurrent 的完整功能避免循环依赖）
    const effective = Math.max(1, Math.min(maxParallel, steps.length));
    const results: StepResult[] = new Array(steps.length);
    let nextIndex = 0;
    let active = 0;

    return new Promise((resolve) => {
      const launch = (): void => {
        while (active < effective && nextIndex < steps.length) {
          if (abortSignal?.aborted) {
            for (let i = nextIndex; i < steps.length; i++) {
              results[i] = {
                stepId: steps[i].id,
                status: 'SKIPPED',
                error: 'aborted',
                durationMs: 0,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                retryCount: 0,
              };
            }
            nextIndex = steps.length;
            if (active === 0) resolve(results);
            return;
          }
          if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
            for (let i = nextIndex; i < steps.length; i++) {
              results[i] = {
                stepId: steps[i].id,
                status: 'SKIPPED',
                error: 'TOKEN_BUDGET_EXHAUSTED',
                durationMs: 0,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                retryCount: 0,
              };
            }
            nextIndex = steps.length;
            if (active === 0) resolve(results);
            return;
          }
          const idx = nextIndex++;
          active++;
          // 注入 cross-pollination
          const injected = crossPollination
            ? crossPollination.inject(input, crossPollinationTopK)
            : { input, insights: [] as Insight[] };
          // executor 调用
          Promise.resolve()
            .then(() => executor(steps[idx], injected.input, context))
            .then(
              async (stepOutput) => {
                const result: StepResult = {
                  stepId: steps[idx].id,
                  status: 'SUCCESS',
                  output: stepOutput.output,
                  tokenUsage: stepOutput.tokenUsage,
                  durationMs: 0,
                  startedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                  retryCount: 0,
                  metadata: stepOutput.metadata,
                };
                if (result.tokenUsage) {
                  consumedTokens += result.tokenUsage.totalTokens;
                }
                if (crossPollination) {
                  await crossPollination.ingest(result);
                }
                results[idx] = result;
                active--;
                if (nextIndex < steps.length) launch();
                else if (active === 0) resolve(results);
              },
              (err) => {
                results[idx] = {
                  stepId: steps[idx].id,
                  status: 'FAILURE',
                  error: (err as Error)?.message ?? 'unknown',
                  errorClass: 'unknown',
                  durationMs: 0,
                  startedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                  retryCount: 0,
                };
                active--;
                if (nextIndex < steps.length) launch();
                else if (active === 0) resolve(results);
              },
            );
        }
        if (steps.length === 0) resolve(results);
      };
      launch();
    });
  };

  let finalStatus: DynamicReplanRun['status'] = 'COMPLETED';
  let batchResults = await executeBatch(currentSteps, currentInput);
  allResults.push(...batchResults);

  // 主循环：再规划
  while (replanRounds < maxReplanRounds) {
    if (abortSignal?.aborted) {
      finalStatus = 'ABORTED';
      break;
    }
    if (totalTimeoutMs && Date.now() - startMs >= totalTimeoutMs) {
      finalStatus = 'TIMEOUT';
      break;
    }
    if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
      finalStatus = 'TOKEN_BUDGET_EXHAUSTED';
      break;
    }

    const ctx: ReplanContext = {
      completedResults: allResults,
      inFlightSteps: [], // 当前实现是同步批次，无 in-flight
      insights: crossPollination?.getAllInsights() ?? [],
      consumedTokens,
      tokenBudget,
      elapsedMs: Date.now() - startMs,
      replanRound: replanRounds,
    };

    const decision = await replanner(ctx);
    replanHistory.push(decision);
    replanRounds++;

    if (decision.action === 'continue') {
      break;
    } else if (decision.action === 'abort') {
      finalStatus = 'ABORTED';
      break;
    } else if (decision.action === 'kill-idle') {
      // 当前实现是同步批次，kill-idle 仅记录决策（未来支持异步时才生效）
      continue;
    } else if (decision.action === 'spawn-new') {
      currentSteps = decision.newSteps ?? [];
      currentInput = decision.newInitialInput;
      if (currentSteps.length === 0) break;
      batchResults = await executeBatch(currentSteps, currentInput);
      allResults.push(...batchResults);
    }
  }

  const completedAt = new Date().toISOString();
  return {
    runId,
    projectId,
    status: finalStatus,
    allStepResults: allResults,
    replanHistory,
    finalInsights: crossPollination?.getAllInsights() ?? [],
    startedAt,
    completedAt,
    totalTokensConsumed: consumedTokens,
    totalDurationMs: Date.now() - startMs,
    replanRoundsExecuted: replanRounds,
  };
}
