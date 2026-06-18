/**
 * Pre-Run Cost Estimator — Predict task cost before execution, auto-budget.
 *
 * Uses historical cost data + task complexity signals to predict:
 * 1. Expected token usage (input + output)
 * 2. Expected cost in USD
 * 3. Recommended token budget
 * 4. Confidence interval
 *
 * Evidence base:
 * - FrugalGPT (arXiv:2305.05176): cost-aware routing reduces cost by 2-8x
 * - OpenAI best practices: task-type → token consumption correlation
 * - Internal data: ~60% of cost variance explained by task type + model tier
 *
 * Integration points:
 * - agentRuntime.ts: use estimateBeforeRun() to set adaptive budgets
 * - modelRouter.ts: use cost predictions for model selection scoring
 * - orchestrator.ts: use cost predictions for sub-agent budget allocation
 */
import type { AgentExecutionContext, RoutingDecision, ModelConfig } from './types';
import type { TaskCategory } from './tokenGovernor';
export interface CostEstimate {
    /** Predicted input tokens (system prompt + context + history) */
    predictedInputTokens: number;
    /** Predicted output tokens (LLM response + tool calls) */
    predictedOutputTokens: number;
    /** Predicted total tokens */
    predictedTotalTokens: number;
    /** Predicted cost in USD for the selected model */
    predictedCostUsd: number;
    /** Recommended token budget (includes 1.5x safety margin) */
    recommendedBudget: number;
    /** Confidence level [0-1]: 1 = high confidence (many historical samples) */
    confidence: number;
    /** Number of historical samples used for this prediction */
    sampleCount: number;
    /** Task category detected from goal */
    taskCategory: TaskCategory;
    /** Model tier selected */
    modelTier: string;
    /** Breakdown of cost factors */
    factors: CostFactor[];
}
export interface CostFactor {
    name: string;
    contribution: number;
    reason: string;
}
export interface HistoricalTaskCost {
    taskCategory: TaskCategory;
    modelTier: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    success: boolean;
    timestamp: number;
}
export interface CostEstimatorConfig {
    /** Safety margin multiplier for recommended budget (default: 1.5) */
    safetyMargin: number;
    /** Maximum historical samples to retain per category (default: 200) */
    maxSamplesPerCategory: number;
    /** Decay half-life for historical weights in ms (default: 7 days) */
    decayHalfLifeMs: number;
    /** Default cost when no history available (USD) */
    defaultCostFallback: number;
}
export declare class CostEstimator {
    private config;
    private history;
    constructor(config?: Partial<CostEstimatorConfig>);
    /**
     * Estimate cost before run. Call from agentRuntime.execute() before the
     * LLM call loop begins. Returns a full estimate with confidence interval.
     */
    estimateBeforeRun(ctx: AgentExecutionContext, routing: RoutingDecision, modelConfig?: ModelConfig): CostEstimate;
    /**
     * Estimate cost for a specific model, useful for model comparison in routing.
     */
    estimateForModel(ctx: AgentExecutionContext, model: ModelConfig): {
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
    };
    /**
     * Allocate token budgets across N sub-agents based on task complexity and historical data.
     * Returns per-agent budgets that sum to totalBudget (with safety margin reserved).
     *
     * Evidence:
     * - FrugalGPT: cost-aware allocation across cascaded models reduces total cost by 2-8x
     * - Anthropic multi-agent research: equal budgets waste 30-40% on simple subtasks
     */
    allocateBudgetsAcrossAgents(totalBudget: number, subtasks: Array<{
        goal: string;
        complexity: number;
        modelTier: string;
    }>, safetyMargin?: number): Array<{
        goal: string;
        budget: number;
        reason: string;
    }>;
    /**
     * Record actual cost after a run completes. Feeds back into future estimates.
     */
    recordActualCost(taskCategory: TaskCategory, modelTier: string, inputTokens: number, outputTokens: number, costUsd: number, durationMs: number, success: boolean): void;
    /**
     * Load historical records from the samples store.
     * Call once at startup to seed the estimator.
     */
    loadFromRecords(records: Array<{
        model: string;
        promptTokens: number;
        completionTokens: number;
        costUsd?: number;
        timestamp: string;
        error?: string;
    }>): void;
    /**
     * Tier 4.4: Estimate cost for a concrete token usage. Useful when attributing
     * cost to a specific failure mode without re-running the full estimate pipeline.
     */
    estimateCostFromUsage(model: string, promptTokens: number, completionTokens: number): number;
    /**
     * Export history for persistence (e.g., writing to disk between sessions).
     */
    exportHistory(): HistoricalTaskCost[][];
    /**
     * Import history from persistence.
     */
    importHistory(data: HistoricalTaskCost[][]): void;
    private scoreComplexity;
    private computeComplexityMultiplier;
    private computeHistoricalAdjustment;
    private computeConfidence;
    private estimateCostPerK;
    private estimateCostFromTokens;
    private inferModelTier;
    private buildFactors;
}
/** Get the global CostEstimator (single-tenant) or tenant-scoped (multi-tenant). */
export declare function getCostEstimator(): CostEstimator;
/** Reset the cost estimator singleton (for test isolation). */
export declare function resetCostEstimator(): void;
//# sourceMappingURL=costEstimator.d.ts.map