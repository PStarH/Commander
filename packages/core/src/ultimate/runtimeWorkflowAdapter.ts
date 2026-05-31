/**
 * RuntimeWorkflowAdapter — 执行时工作流动态调整 (EvoMAS风格)
 *
 * 基于 EvoMAS (arXiv 2605.08769) 的核心思想：
 * 在执行时根据任务状态动态调整工作流，而非预先固定。
 *
 * 传统方式：workflow → 一次性执行
 * 本方式：每一步都重新评估当前任务状态，动态选择最优子工作流
 *
 * 核心创新：
 * 1. Planner-Evaluator-Updater 三段式管道
 * 2. 状态感知的workflow adapter
 * 3. 策略梯度优化的workflow policy (placeholder for RL training)
 */

import type {
  AgentExecutionContext,
  AgentExecutionResult,
  ExecutionExperience,
} from '../runtime/types';
import type { OrchestrationTopology, TaskTreeNode } from './types';
import { getMessageBus } from '../runtime/messageBus';
import { getTraceRecorder } from '../runtime/executionTrace';

// ============================================================================
// 任务状态构造器
// ============================================================================

export interface TaskState {
  /** 当前执行阶段 */
  phase: 'discovery' | 'planning' | 'execution' | 'refinement' | 'verification' | 'termination';
  /** 已完成步骤数 */
  completedSteps: number;
  /** 总步骤数估计 */
  estimatedTotalSteps: number;
  /** 已收集的关键信息 */
  gatheredEvidence: EvidenceItem[];
  /** 当前置信度 */
  confidence: number;
  /** 剩余预算（token） */
  remainingBudget: number;
  /** 已用时间 */
  elapsedMs: number;
  /** 上一步结果 */
  lastStepResult?: StepResult;
  /** 是否需要重新规划 */
  needsReplanning: boolean;
  /** 终止原因 */
  terminationReason?: string;
}

export interface EvidenceItem {
  source: string;
  content: string;
  confidence: number;
  timestamp: number;
}

export interface StepResult {
  stepId: string;
  success: boolean;
  output: string;
  durationMs: number;
  tokenCost: number;
  qualityScore?: number;
}

class TaskStateConstructor {
  /**
   * 从执行上下文和已完成的步骤构建任务状态
   */
  static build(
    ctx: AgentExecutionContext,
    completedSteps: StepResult[],
    elapsedMs: number,
  ): TaskState {
    // 分析已完成步骤的结果
    const successfulSteps = completedSteps.filter(s => s.success);
    const failedSteps = completedSteps.filter(s => !s.success);
    const totalTokenCost = completedSteps.reduce((sum, s) => sum + s.tokenCost, 0);

    // 收集的关键证据
    const gatheredEvidence: EvidenceItem[] = completedSteps
      .filter(s => s.success && s.output.length > 10)
      .map(s => ({
        source: s.stepId,
        content: s.output.slice(0, 200),
        confidence: s.qualityScore ?? 0.5,
        timestamp: Date.now(),
      }));

    // 计算置信度
    const confidence = completedSteps.length > 0
      ? successfulSteps.length / completedSteps.length
      : 0;

    // 判断当前阶段
    const phase = this.determinePhase(completedSteps, confidence, totalTokenCost, ctx);

    // 判断是否需要重新规划
    const needsReplanning = this.checkReplanning(phase, failedSteps, confidence);

    const totalBudget = ctx.tokenBudget;
    const remainingBudget = Math.max(0, totalBudget - totalTokenCost);

    return {
      phase,
      completedSteps: completedSteps.length,
      estimatedTotalSteps: this.estimateTotalSteps(phase, completedSteps.length),
      gatheredEvidence,
      confidence,
      remainingBudget,
      elapsedMs,
      lastStepResult: completedSteps[completedSteps.length - 1],
      needsReplanning,
    };
  }

  private static determinePhase(
    completedSteps: StepResult[],
    confidence: number,
    totalTokenCost: number,
    ctx: AgentExecutionContext,
  ): TaskState['phase'] {
    if (completedSteps.length === 0) return 'discovery';
    if (confidence < 0.3 && completedSteps.length < 3) return 'discovery';
    if (totalTokenCost > ctx.tokenBudget * 0.7) return 'verification';
    if (confidence > 0.7 && completedSteps.length > 2) return 'refinement';

    return 'execution';
  }

  private static checkReplanning(
    phase: string,
    failedSteps: StepResult[],
    confidence: number,
  ): boolean {
    // 连续失败需要重新规划
    if (failedSteps.length >= 2) return true;
    // 低置信度且在执行阶段
    if (confidence < 0.3 && phase === 'execution') return true;
    return false;
  }

  private static estimateTotalSteps(currentPhase: string, completed: number): number {
    const phaseMultipliers: Record<string, number> = {
      discovery: 3,
      planning: 2,
      execution: 1.5,
      refinement: 1.5,
      verification: 2,
      termination: 0,
    };
    return Math.ceil(completed * (phaseMultipliers[currentPhase] ?? 2));
  }
}

// ============================================================================
// Workflow Adapter — 状态感知的子工作流选择
// ============================================================================

interface SubWorkflow {
  id: string;
  topology: OrchestrationTopology;
  steps: string[];          // 目标步骤描述
  estimatedCost: number;    // 预估token消耗
  estimatedDuration: number; // 预估耗时(ms)
  successRate: number;       // 历史成功率
}

export interface WorkflowDecision {
  subWorkflowId: string;
  topology: OrchestrationTopology;
  priority: number;
  rationale: string;
  alternatives: string[];
}

class WorkflowAdapter {
  private subWorkflows: Map<string, SubWorkflow> = new Map();
  private workflowHistory: Map<string, ExecutionExperience[]> = new Map();

  /**
   * 注册候选子工作流
   */
  registerSubWorkflow(workflow: SubWorkflow): void {
    this.subWorkflows.set(workflow.id, workflow);
  }

  /**
   * 基于任务状态选择最优子工作流
   */
  selectWorkflow(state: TaskState): WorkflowDecision {
    const candidates = Array.from(this.subWorkflows.values());

    if (candidates.length === 0) {
      return {
        subWorkflowId: 'default',
        topology: 'SEQUENTIAL',
        priority: 0,
        rationale: 'No sub-workflows registered, using default sequential',
        alternatives: [],
      };
    }

    // 根据任务状态评分
    const scored = candidates.map(wf => ({
      wf,
      score: this.scoreWorkflow(wf, state),
    }));

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    return {
      subWorkflowId: best.wf.id,
      topology: best.wf.topology,
      priority: best.score,
      rationale: this.generateRationale(best.wf, state),
      alternatives: scored.slice(1, 4).map(s => `${s.wf.id} (score: ${s.score.toFixed(2)})`),
    };
  }

  /**
   * 记录子工作流执行结果
   */
  recordWorkflowResult(workflowId: string, result: ExecutionExperience): void {
    const history = this.workflowHistory.get(workflowId) ?? [];
    history.push(result);

    // 只保留最近50条
    if (history.length > 50) {
      this.workflowHistory.set(workflowId, history.slice(-50));
    }
  }

  private scoreWorkflow(wf: SubWorkflow, state: TaskState): number {
    let score = 0;

    // 1. 成本适配性（剩余预算是否够用）
    if (state.remainingBudget > 0) {
      const costRatio = wf.estimatedCost / state.remainingBudget;
      if (costRatio < 0.5) score += 0.3;
      else if (costRatio < 0.8) score += 0.1;
      else score -= 0.2; // 预算紧张时避免高成本子工作流
    }

    // 2. 时间适配性
    if (state.elapsedMs > 0) {
      const timeRatio = wf.estimatedDuration / state.elapsedMs;
      if (timeRatio < 1.5) score += 0.2; // 能在合理时间内完成
    }

    // 3. 历史成功率
    score += wf.successRate * 0.3;

    // 4. 阶段匹配
const topologyBonus: Record<OrchestrationTopology, Record<string, number>> = {
       SEQUENTIAL: { discovery: 0.1, planning: 0.3, verification: 0.2 },
       PARALLEL: { execution: 0.3, discovery: 0.2 },
       HIERARCHICAL: { planning: 0.2, execution: 0.1, refinement: 0.2 },
       HYBRID: { execution: 0.2, refinement: 0.3 },
       HANDOFF: { verification: 0.3, termination: 0.2 },
       CONSENSUS: { verification: 0.4 },
       SINGLE: { discovery: 0.2, planning: 0.2 },
       DEBATE: { discovery: 0.15, planning: 0.2 },
       ENSEMBLE: { execution: 0.25, verification: 0.3 },
       EVALUATOR_OPTIMIZER: { planning: 0.2, verification: 0.35 },
     };

    const bonus = topologyBonus[wf.topology]?.[state.phase];
    if (bonus) score += bonus;

    // 5. 置信度影响 — 低置信度时倾向于更保守的工作流
    if (state.confidence < 0.4) {
      if (wf.topology === 'SEQUENTIAL' || wf.topology === 'SINGLE') score += 0.15;
    }

    return Math.max(0, score);
  }

  private generateRationale(wf: SubWorkflow, state: TaskState): string {
    const reasons: string[] = [];
    reasons.push(`Phase: ${state.phase}, selecting ${wf.topology} topology`);
    reasons.push(`Estimated cost: ${wf.estimatedCost} tokens vs ${state.remainingBudget} remaining`);
    reasons.push(`Historical success rate: ${(wf.successRate * 100).toFixed(0)}%`);

    if (state.needsReplanning) {
      reasons.push('Replanning triggered due to previous failures or low confidence');
    }

    return reasons.join('; ');
  }
}

// ============================================================================
// 执行时管道
// ============================================================================

interface StageConfig {
  /** 阶段名称 */
  name: string;
  /** 阶段超时时间 */
  timeoutMs: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 最小成功率阈值，低于此则触发重新规划 */
  minSuccessRate: number;
}

const DEFAULT_STAGES: StageConfig[] = [
  { name: 'discovery', timeoutMs: 30000, maxRetries: 2, minSuccessRate: 0.3 },
  { name: 'planning', timeoutMs: 60000, maxRetries: 2, minSuccessRate: 0.5 },
  { name: 'execution', timeoutMs: 120000, maxRetries: 3, minSuccessRate: 0.4 },
  { name: 'refinement', timeoutMs: 60000, maxRetries: 2, minSuccessRate: 0.6 },
  { name: 'verification', timeoutMs: 30000, maxRetries: 1, minSuccessRate: 0.7 },
  { name: 'termination', timeoutMs: 10000, maxRetries: 0, minSuccessRate: 0.8 },
];

export interface AdaptiveExecutionResult {
  finalResult: AgentExecutionResult;
  taskState: TaskState;
  decisions: WorkflowDecision[];
  stagesTraversed: string[];
  rePlanningCount: number;
  metrics: {
    totalDurationMs: number;
    totalTokens: number;
    stageDurations: Map<string, number>;
    adaptationCount: number;
  };
}

export class RuntimeWorkflowAdapter {
  private adapter: WorkflowAdapter;
  private taskState: TaskState | null = null;
  private decisions: WorkflowDecision[] = [];
  private stagesTraversed: string[] = [];
  private rePlanningCount = 0;
  private stageDurations = new Map<string, number>();
  private stageResults: StepResult[] = [];
  private lastRunId: string | null = null;

  constructor() {
    this.adapter = new WorkflowAdapter();
    this.registerDefaultWorkflows();
  }

  private registerDefaultWorkflows(): void {
    // 注册默认候选子工作流
    const defaultWorkflows: SubWorkflow[] = [
      {
        id: 'deep-research',
        topology: 'HIERARCHICAL',
        steps: ['research', 'analyze', 'synthesize', 'verify'],
        estimatedCost: 8000,
        estimatedDuration: 30000,
        successRate: 0.7,
      },
      {
        id: 'quick-answer',
        topology: 'SEQUENTIAL',
        steps: ['search', 'verify', 'respond'],
        estimatedCost: 2000,
        estimatedDuration: 10000,
        successRate: 0.8,
      },
      {
        id: 'parallel-exploration',
        topology: 'PARALLEL',
        steps: ['search-branch-1', 'search-branch-2', 'merge', 'verify'],
        estimatedCost: 12000,
        estimatedDuration: 25000,
        successRate: 0.6,
      },
      {
        id: 'code-generation',
        topology: 'HYBRID',
        steps: ['understand', 'design', 'implement', 'test', 'refine'],
        estimatedCost: 15000,
        estimatedDuration: 45000,
        successRate: 0.5,
      },
      {
        id: 'verification-focused',
        topology: 'CONSENSUS',
        steps: ['generate', 'verify-1', 'verify-2', 'consensus'],
        estimatedCost: 10000,
        estimatedDuration: 35000,
        successRate: 0.75,
      },
    ];

    for (const wf of defaultWorkflows) {
      this.adapter.registerSubWorkflow(wf);
    }
  }

  /**
   * 执行一次自适应决策周期
   * 在每个执行步骤后调用，决定下一步策略
   */
  async decideNextWorkflow(
    ctx: AgentExecutionContext,
    completedStep: StepResult,
    elapsedMs: number,
  ): Promise<WorkflowDecision> {
    // Reset stage results when starting a new execution
    if (ctx.runId && ctx.runId !== this.lastRunId) {
      this.stageResults = [];
      this.decisions = [];
      this.stagesTraversed = [];
      this.rePlanningCount = 0;
      this.stageDurations.clear();
      this.lastRunId = ctx.runId;
    }

    // 更新任务状态
    this.stageResults.push(completedStep);
    this.taskState = TaskStateConstructor.build(ctx, this.stageResults, elapsedMs);

    // 记录之前的决策结果
    if (completedStep.stepId && this.decisions.length > 0) {
      const prevDecision = this.decisions[this.decisions.length - 1];
this.adapter.recordWorkflowResult(prevDecision.subWorkflowId, {
         ...completedStep,
         id: `exp-${Date.now()}`,
         runId: ctx.runId ?? 'unknown',
         agentId: ctx.agentId,
         taskType: ctx.goal.slice(0, 50),
         success: completedStep.success,
         durationMs: completedStep.durationMs,
         tokenCost: completedStep.tokenCost,
         modelUsed: 'current',
         strategyUsed: prevDecision.subWorkflowId,
         lessons: completedStep.success ? [] : [`Step failed: ${completedStep.output}`],
         timestamp: new Date().toISOString(),
       } as ExecutionExperience);
    }

    // 如果需要重新规划
    if (this.taskState.needsReplanning) {
      this.rePlanningCount++;

      // 发布重新规划事件
      const bus = getMessageBus();
      bus.publish('workflow.replan', ctx.agentId, {
        runId: ctx.missionId,
        reason: `Replanning triggered after ${this.rePlanningCount} adaptations`,
        currentPhase: this.taskState.phase,
        confidence: this.taskState.confidence,
      });

      // 选择紧急工作流（更保守的策略）
      return this.selectEmergencyWorkflow();
    }

    // 正常决策
    const decision = this.adapter.selectWorkflow(this.taskState);
    this.decisions.push(decision);

    if (!this.stagesTraversed.includes(this.taskState.phase)) {
      this.stagesTraversed.push(this.taskState.phase);
    }

    return decision;
  }

  /**
   * 选择紧急工作流 — 保守策略
   */
  private selectEmergencyWorkflow(): WorkflowDecision {
    return {
      subWorkflowId: 'quick-answer',
      topology: 'SEQUENTIAL',
      priority: 1,
      rationale: 'Emergency replan: switching to sequential conservative approach',
      alternatives: ['verification-focused', 'deep-research'],
    };
  }

  /**
   * 获取当前执行摘要
   */
  getExecutionSummary(): string {
    if (!this.taskState) return 'No execution started yet';

    const parts = [
      `Phase: ${this.taskState.phase}`,
      `Confidence: ${(this.taskState.confidence * 100).toFixed(0)}%`,
      `Steps completed: ${this.taskState.completedSteps}`,
      `Budget remaining: ${this.taskState.remainingBudget} tokens`,
      `Adaptations: ${this.rePlanningCount}`,
      `Stages: ${this.stagesTraversed.join(' → ')}`,
    ];

    if (this.taskState.needsReplanning) {
      parts.push('⚠️ Replanning triggered');
    }

    if (this.taskState.terminationReason) {
      parts.push(`Termination: ${this.taskState.terminationReason}`);
    }

    return parts.join('\n');
  }

  /**
   * 获取完整统计
   */
  getMetrics(): AdaptiveExecutionResult['metrics'] {
    return {
      totalDurationMs: this.taskState?.elapsedMs ?? 0,
      totalTokens: this.stageResults.reduce((sum, r) => sum + r.tokenCost, 0),
      stageDurations: new Map(this.stageDurations),
      adaptationCount: this.rePlanningCount,
    };
  }

  /**
   * 重置适配器状态（用于新任务）
   */
  reset(): void {
    this.taskState = null;
    this.decisions = [];
    this.stagesTraversed = [];
    this.rePlanningCount = 0;
    this.stageDurations.clear();
    this.stageResults = [];
  }
}

// ============================================================================
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const workflowAdapterSingleton = createTenantAwareSingleton(() => new RuntimeWorkflowAdapter());

export function getRuntimeWorkflowAdapter(): RuntimeWorkflowAdapter {
  return workflowAdapterSingleton.get();
}

export function resetRuntimeWorkflowAdapter(): void {
  workflowAdapterSingleton.reset();
}