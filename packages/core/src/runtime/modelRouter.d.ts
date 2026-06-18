/**
 * Smart Model Router — Task-aware, learning, cost-optimized model selection.
 *
 * Surpasses OpenClaw's multi-model routing by adding:
 * 1. Task-type → capability matching (code tasks → code-capable models)
 * 2. Outcome-based learning with time decay (track success per model per task type)
 * 3. Model fallback chain (try next candidate on failure)
 * 4. Governor-aware budgeting (tight budget → cheaper models)
 * 5. Cost-quality tradeoff (score models by capability fit × cost efficiency)
 *
 * Backward compatible: same class name, same route() interface.
 */
import type { ModelConfig, ModelTier, RoutingDecision, AgentExecutionContext } from './types';
export interface ModelOutcome {
    modelId: string;
    taskType: string;
    success: boolean;
    durationMs: number;
    tokensUsed: number;
    timestamp: number;
}
export declare class ModelRouter {
    private models;
    private tierIndex;
    private outcomesIndex;
    private outcomes;
    private readonly maxOutcomes;
    private readonly decayHalfLifeMs;
    constructor(customModels?: ModelConfig[]);
    /** Pre-index models by tier for O(1) lookups */
    private rebuildTierIndex;
    registerModel(config: ModelConfig): void;
    getModel(modelId: string): ModelConfig | undefined;
    listModels(tier?: ModelTier): ModelConfig[];
    /**
     * Route an execution context to the optimal model.
     * Now task-type-aware with capability matching and governor integration.
     * @param governorPhase - Current budget governor phase ('relaxed'|'moderate'|'tight'|'critical').
     *   Callers should pass their per-run governor state instead of relying on global singleton.
     */
    route(ctx: AgentExecutionContext, governorPhase?: string, preferredTier?: ModelTier): RoutingDecision;
    /**
     * Record a model execution outcome for learning.
     * Call this after each successful or failed model execution.
     */
    recordOutcome(modelId: string, taskType: string, success: boolean, durationMs: number, tokensUsed: number): void;
    /**
     * Get the next fallback model for a given model (for retry-with-fallback).
     * Returns the next model in the same tier by priority, or steps down a tier.
     */
    getFallbackModel(failedModelId: string, taskType?: string): ModelConfig | undefined;
    /**
     * Get a cascade chain: ordered list of models from cheapest to most capable.
     * Implements FrugalGPT's LLM cascade pattern (arXiv:2305.05176):
     * try cheap first, escalate on failure/low-confidence.
     *
     * @param taskType - The task type for capability filtering
     * @param maxModels - Maximum models in the cascade (default: 3)
     * @returns Ordered array of models: cheapest first, most capable last
     */
    getCascadeChain(taskType?: string, maxModels?: number): ModelConfig[];
    /**
     * Route with FrugalGPT cascade: start with the cheapest capable model,
     * escalate on failure. Returns both the initial routing AND the escalation chain.
     *
     * Evidence:
     * - FrugalGPT (arXiv:2305.05176): try cheap first, escalate on failure/low-confidence
     *   achieves 2-8x cost reduction with <1% quality loss
     * - OpenAI: cascade routing reduces cost by 50-70% on easy tasks
     *
     * @param governorPhase - When 'tight' or 'critical', always use cascade (start cheap).
     *   When 'relaxed' or 'moderate', use standard routing (start optimal).
     */
    routeWithCascade(ctx: AgentExecutionContext, governorPhase?: string, preferredTier?: ModelTier): {
        initial: RoutingDecision;
        escalationChain: ModelConfig[];
    };
    /**
     * Get the next escalation model from the chain after a failure.
     * Returns the next more capable model, or undefined if chain is exhausted.
     */
    getNextEscalation(currentModelId: string, escalationChain: ModelConfig[]): ModelConfig | undefined;
    /**
     * Estimate cost for a given context and expected output length.
     */
    estimateCost(modelId: string, inputTokens: number, outputTokens: number): number;
    /**
     * Route a task to batch API processing if eligible.
     * Batch APIs offer 50% cost savings for non-urgent tasks (OpenAI, Anthropic, Google).
     * Returns the best batch-capable model for the task, or undefined if no batch model is suitable.
     *
     * Eligibility criteria:
     * - Task is not time-sensitive (no real-time user waiting)
     * - A batch-capable model exists at the appropriate tier
     * - Task doesn't require immediate tool interaction
     */
    routeBatch(ctx: AgentExecutionContext, tier?: ModelTier): ModelConfig | undefined;
    /**
     * Check if a task is suitable for batch processing.
     * Batch is ideal for: evaluation runs, data labeling, document processing,
     * nightly analysis, embedding backfills — tasks where 24h turnaround is acceptable
     * for 50% cost savings (OpenAI, Anthropic, Google all offer batch at 50% discount).
     * Batch is NOT suitable for: interactive chat, real-time code fixes,
     * sequential multi-turn tool chains requiring immediate feedback.
     *
     * @returns true if the task can be deferred to batch processing
     */
    static isBatchEligible(ctx: AgentExecutionContext): boolean;
    /**
     * Get learning stats for debugging.
     */
    getLearningStats(): {
        modelId: string;
        taskType: string;
        successRate: string;
        avgDuration: number;
        count: number;
    }[];
    /**
     * Select tier based on complexity, governance, and governor phase.
     */
    private selectTier;
    /**
     * Rank candidates by: capability fit → cost efficiency → learning score.
     * Returns sorted array (best first).
     */
    private rankCandidates;
    /**
     * Score a model candidate: capability fit (0-1) × cost efficiency × learning bonus.
     * Now cost-efficiency uses cost-per-successful-task, not just raw cost.
     *
     * Evidence:
     * - FrugalGPT (arXiv:2305.05176): cost-aware routing considers both cost AND quality
     * - OpenAI: cheapest model that succeeds is always best; cheapest model that fails is waste
     * - Cost per successful task = raw cost / success_rate
     */
    private scoreCandidate;
    /**
     * Calculate learning bonus from historical outcomes.
     * Uses time-decayed success rate. Returns 0.8-1.2 multiplier.
     */
    private getLearningBonus;
    /**
     * Get the time-decayed success rate for a model on a task type.
     * Returns 0-1 (0.5 = no data = neutral assumption).
     * Used by cost-per-successful-task calculation.
     */
    private getSuccessRate;
    /**
     * Check if a model has the required capabilities.
     */
    private hasCapabilities;
    /**
     * If the selected tier has no model with all required capabilities, bump to next higher tier.
     */
    private bumpTierForCapabilities;
}
/** Get the global ModelRouter (single-tenant) or tenant-scoped (multi-tenant). */
export declare function getModelRouter(): ModelRouter;
/** Reset the model router singleton (for test isolation). */
export declare function resetModelRouter(): void;
//# sourceMappingURL=modelRouter.d.ts.map