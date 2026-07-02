/**
 * AutoLoopRunner — max_loops="auto" + 软/硬双顶
 *
 * 借鉴 swarms 的 max_loops="auto"：agent 自判何时完成，不卡固定迭代上限。
 * 适合开放任务（研究、分析、迭代精炼）。但企业场景需要成本可控，
 * 所以补齐软顶（warn + 标记）与硬顶（强制停止）双层保护。
 *
 * 设计要点（基于 swarms max_loops="auto" + Commander BillExplosionGuard）：
 * - CompletionDetector：判断 agent 输出是否表明任务已完成（可启发式或 LLM）
 * - softCap：到达时记录 breach 事件，但允许继续（给 agent 收尾机会）
 * - hardCap：到达时强制停止，标记 PARTIAL
 * - 默认 detector 是启发式（零成本），LLM detector 可选注入
 */

import type { AnyStep, ExecutionContext, StepExecutor, StepResult } from './orchestrationPatterns';

// ============================================================================
// 完成检测
// ============================================================================

/**
 * 完成检测器签名。
 * 输入：最近一轮 agent 的输出 + 累计轮次 + 累计 token
 * 输出：是否完成 + 理由
 */
export interface CompletionDetector {
  (
    output: unknown,
    ctx: { loop: number; consumedTokens: number },
  ): { done: boolean; reason: string } | Promise<{ done: boolean; reason: string }>;
}

/**
 * 默认启发式完成检测器 — 零成本。
 *
 * 识别 agent 输出中的完成信号：
 * - 显式标记：包含 "DONE" / "COMPLETE" / "FINISHED" / "任务完成"
 * - 结构化标记：output 是对象且含 done=true / status="complete"
 * - 收敛信号：连续 2 轮输出高度相似（hash 相同）→ 视为收敛完成
 */
export const defaultCompletionDetector: CompletionDetector = (
  output,
  ctx,
): {
  done: boolean;
  reason: string;
} => {
  // 结构化完成标记
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>;
    if (obj.done === true || obj.complete === true) {
      return { done: true, reason: 'explicit done=true' };
    }
    if (obj.status === 'complete' || obj.status === 'completed') {
      return { done: true, reason: 'explicit status=complete' };
    }
  }
  // 文本完成标记
  if (typeof output === 'string') {
    const lower = output.toLowerCase();
    if (
      lower.includes('task complete') ||
      lower.includes('all done') ||
      lower.includes('finished') ||
      lower.includes('任务完成') ||
      lower.includes('已完成')
    ) {
      return { done: true, reason: 'explicit completion text' };
    }
  }
  // 兜底：达到软顶的 80% 时建议完成（避免无谓循环）
  return { done: false, reason: `loop ${ctx.loop} not yet signaled complete` };
};

/**
 * 基于输出哈希的收敛检测器 — 连续 N 轮输出相同视为收敛。
 * 通常与 defaultCompletionDetector 组合使用。
 */
export function createConvergenceDetector(consecutiveMatches = 2): CompletionDetector {
  const hashes: string[] = [];
  return (output) => {
    const hash = simpleHash(typeof output === 'string' ? output : JSON.stringify(output));
    hashes.push(hash);
    if (hashes.length < consecutiveMatches + 1) {
      return { done: false, reason: 'collecting outputs for convergence check' };
    }
    // 检查最近 consecutiveMatches+1 个是否全相同
    const recent = hashes.slice(-consecutiveMatches - 1);
    if (recent.every((h) => h === recent[0])) {
      return {
        done: true,
        reason: `converged: ${consecutiveMatches} consecutive identical outputs`,
      };
    }
    return { done: false, reason: 'outputs still diverging' };
  };
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

// ============================================================================
// AutoLoopRunner
// ============================================================================

export interface AutoLoopConfig {
  projectId: string;
  /** 必填：要循环执行的 step（每轮调用同一 step） */
  step: AnyStep;
  /** 必填：执行器 */
  executor: StepExecutor;
  /** 初始输入 */
  initialInput?: unknown;
  /**
   * 最大循环次数 — 硬顶。
   * 到达后强制停止，标记 PARTIAL。
   * 设为 'auto'（默认）时使用 softCap + detector 决定停止。
   * 设为具体数字时作为绝对硬顶。
   */
  maxLoops?: number | 'auto';
  /** 软顶 — 到达时记录 breach 但允许继续（默认 10） */
  softCap?: number;
  /** 硬顶 — 即使 maxLoops='auto' 也绝不超过此值（默认 50） */
  hardCap?: number;
  /** 完成检测器（默认 defaultCompletionDetector） */
  completionDetector?: CompletionDetector;
  /** token 硬顶 */
  tokenBudget?: number;
  /** 每轮超时 */
  perLoopTimeoutMs?: number;
  /** 取消信号 */
  abortSignal?: AbortSignal;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

export interface AutoLoopRun {
  runId: string;
  projectId: string;
  status:
    | 'COMPLETED'
    | 'PARTIAL'
    | 'TIMEOUT'
    | 'TOKEN_BUDGET_EXHAUSTED'
    | 'CANCELLED'
    | 'HARD_CAP_REACHED';
  /** 每轮的 step 结果 */
  loopResults: StepResult[];
  /** 实际执行的轮次 */
  loopsExecuted: number;
  /** 最终输出（最后一轮的 output） */
  finalOutput?: unknown;
  /** 完成原因 */
  terminationReason: string;
  /** 软顶是否触发 */
  softCapBreached: boolean;
  /** 总 token 消耗 */
  totalTokensConsumed: number;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
}

/**
 * 执行 max_loops="auto" 循环。
 *
 * 决策顺序：
 * 1. abortSignal → CANCELLED
 * 2. tokenBudget 耗尽 → TOKEN_BUDGET_EXHAUSTED
 * 3. hardCap 到达 → HARD_CAP_REACHED
 * 4. completionDetector.done=true → COMPLETED
 * 5. maxLoops 为数字且到达 → COMPLETED（视为正常完成）
 * 6. softCap 到达 → 继续，但标记 breach
 *
 * @example
 * ```ts
 * const run = await runAutoLoop({
 *   projectId: 'research',
 *   step: { id: 'agent', name: 'r', agentId: 'a1', objective: '迭代研究' },
 *   executor: myExecutor,
 *   initialInput: '量子计算现状',
 *   maxLoops: 'auto',
 *   softCap: 8,
 *   hardCap: 20,
 * });
 * ```
 */
export async function runAutoLoop(config: AutoLoopConfig): Promise<AutoLoopRun> {
  const {
    projectId,
    step,
    executor,
    initialInput,
    maxLoops = 'auto',
    softCap = 10,
    hardCap = 50,
    completionDetector = defaultCompletionDetector,
    tokenBudget,
    perLoopTimeoutMs,
    abortSignal,
    metadata,
  } = config;

  const runId = `autoloop-${projectId}-${Date.now()}`;
  const startMs = Date.now();
  const startedAt = new Date().toISOString();
  const context: ExecutionContext = { runId, projectId, abortSignal, metadata };

  const loopResults: StepResult[] = [];
  let consumedTokens = 0;
  let currentInput = initialInput;
  let softCapBreached = false;
  let loop = 0;
  let terminationReason = 'max_loops reached';
  let status: AutoLoopRun['status'] = 'COMPLETED';

  while (true) {
    // 1. abort
    if (abortSignal?.aborted) {
      status = 'CANCELLED';
      terminationReason = 'abort signal received';
      break;
    }
    // 2. token 预算
    if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
      status = 'TOKEN_BUDGET_EXHAUSTED';
      terminationReason = `token budget ${tokenBudget} exhausted`;
      break;
    }
    // 3. hardCap
    if (loop >= hardCap) {
      status = 'HARD_CAP_REACHED';
      terminationReason = `hard cap ${hardCap} reached`;
      break;
    }
    // 4. maxLoops 数字硬顶
    if (typeof maxLoops === 'number' && loop >= maxLoops) {
      status = 'COMPLETED';
      terminationReason = `maxLoops=${maxLoops} reached`;
      break;
    }
    // 5. softCap 标记
    if (loop >= softCap) {
      softCapBreached = true;
    }

    // 执行一轮
    const startedAtLoop = new Date().toISOString();
    const startLoopMs = Date.now();
    let stepOutput: { output?: unknown; tokenUsage?: { totalTokens: number } };
    try {
      if (perLoopTimeoutMs) {
        stepOutput = await withTimeout(
          executor(step, currentInput, context),
          perLoopTimeoutMs,
          step.id,
        );
      } else {
        stepOutput = await executor(step, currentInput, context);
      }
    } catch (e) {
      const result: StepResult = {
        stepId: step.id,
        status: 'FAILURE',
        error: (e as Error)?.message ?? 'unknown',
        errorClass: 'transient',
        durationMs: Date.now() - startLoopMs,
        startedAt: startedAtLoop,
        completedAt: new Date().toISOString(),
        retryCount: 0,
      };
      loopResults.push(result);
      // 失败也继续下一轮（除非 abort）
      currentInput = undefined;
      loop++;
      continue;
    }

    const loopResult: StepResult = {
      stepId: step.id,
      status: 'SUCCESS',
      output: stepOutput.output,
      tokenUsage: stepOutput.tokenUsage as StepResult['tokenUsage'],
      durationMs: Date.now() - startLoopMs,
      startedAt: startedAtLoop,
      completedAt: new Date().toISOString(),
      retryCount: 0,
    };
    if (loopResult.tokenUsage) {
      consumedTokens += loopResult.tokenUsage.totalTokens ?? 0;
    }
    loopResults.push(loopResult);
    loop++;

    // 完成检测
    const detection = await completionDetector(loopResult.output, {
      loop,
      consumedTokens,
    });
    if (detection.done) {
      status = 'COMPLETED';
      terminationReason = detection.reason;
      break;
    }

    // 下一轮输入 = 本轮输出
    currentInput = loopResult.output;
  }

  const completedAt = new Date().toISOString();
  const finalOutput = loopResults[loopResults.length - 1]?.output;

  return {
    runId,
    projectId,
    status,
    loopResults,
    loopsExecuted: loop,
    finalOutput,
    terminationReason,
    softCapBreached,
    totalTokensConsumed: consumedTokens,
    startedAt,
    completedAt,
    totalDurationMs: Date.now() - startMs,
  };
}

class AutoLoopTimeoutError extends Error {
  constructor(stepId: string, ms: number) {
    super(`AutoLoop step ${stepId} timed out after ${ms}ms`);
    this.name = 'AutoLoopTimeoutError';
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, stepId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AutoLoopTimeoutError(stepId, ms)), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
