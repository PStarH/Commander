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
import type { AgentExecutionContext, AgentExecutionResult } from '../runtime/types';
import type { OrchestrationTopology } from './types';
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
export interface WorkflowDecision {
    subWorkflowId: string;
    topology: OrchestrationTopology;
    priority: number;
    rationale: string;
    alternatives: string[];
}
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
export declare class RuntimeWorkflowAdapter {
    private adapter;
    private taskState;
    private decisions;
    private stagesTraversed;
    private rePlanningCount;
    private stageDurations;
    private stageResults;
    private lastRunId;
    constructor();
    private registerDefaultWorkflows;
    /**
     * 执行一次自适应决策周期
     * 在每个执行步骤后调用，决定下一步策略
     */
    decideNextWorkflow(ctx: AgentExecutionContext, completedStep: StepResult, elapsedMs: number): Promise<WorkflowDecision>;
    /**
     * 选择紧急工作流 — 保守策略
     */
    private selectEmergencyWorkflow;
    /**
     * 获取当前执行摘要
     */
    getExecutionSummary(): string;
    /**
     * 获取完整统计
     */
    getMetrics(): AdaptiveExecutionResult['metrics'];
    /**
     * 重置适配器状态（用于新任务）
     */
    reset(): void;
}
export declare function getRuntimeWorkflowAdapter(): RuntimeWorkflowAdapter;
export declare function resetRuntimeWorkflowAdapter(): void;
//# sourceMappingURL=runtimeWorkflowAdapter.d.ts.map