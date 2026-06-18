/**
 * Smart Model Router — User-configurable, capability-based model selection.
 *
 * Features:
 * 1. User-defined model pools with capability tags (multimodal, vision, long_context, etc.)
 * 2. Auto mode: routes tasks to best model based on capability matching
 * 3. Manual mode: user selects specific model
 * 4. Cascade mode: tries cheap first, escalates on failure (FrugalGPT)
 * 5. Cost-aware: respects budget constraints
 * 6. Learning: tracks success rates per model per task type
 *
 * Config file: commander.config.json or COMMANDER_MODELS env var (JSON)
 */
import type { ModelTier, RoutingDecision, AgentExecutionContext } from './types';
export type ModelCapability = 'code' | 'reasoning' | 'analysis' | 'creative' | 'math' | 'multimodal' | 'vision' | 'image_generation' | 'long_context' | 'low_cost' | 'fast' | 'high_quality' | 'function_calling' | 'json_mode' | 'streaming' | 'translation' | 'summarization' | 'extraction';
export interface UserModelConfig {
    id: string;
    provider: string;
    capabilities: ModelCapability[];
    costPer1KInput: number;
    costPer1KOutput: number;
    contextWindow: number;
    maxOutputTokens?: number;
    displayName?: string;
    description?: string;
    tags?: string[];
    tier?: ModelTier;
}
export interface RoutingRule {
    taskType: string;
    requiredCapabilities: ModelCapability[];
    preferredTier?: ModelTier;
    maxCostPer1K?: number;
}
export interface ModelRouterUserConfig {
    mode: 'auto' | 'manual' | 'cascade';
    defaultModel?: string;
    modelPool: UserModelConfig[];
    routingRules?: RoutingRule[];
    budget?: {
        maxCostPerTask?: number;
        dailyBudget?: number;
    };
}
export declare class SmartModelRouter {
    private config;
    private models;
    private outcomes;
    private readonly maxOutcomes;
    private readonly decayHalfLifeMs;
    constructor(config?: Partial<ModelRouterUserConfig>);
    /**
     * Load configuration from JSON file or env var.
     */
    static fromConfig(config: ModelRouterUserConfig): SmartModelRouter;
    /**
     * Load from COMMANDER_MODELS env var (JSON string).
     */
    static fromEnv(): SmartModelRouter | null;
    /**
     * Main routing entry point.
     * In 'auto' mode: analyzes task, matches capabilities, picks best model.
     * In 'manual' mode: returns the user-specified default model.
     * In 'cascade' mode: returns cheapest capable model + escalation chain.
     */
    route(ctx: AgentExecutionContext, options?: {
        preferredModel?: string;
        preferredTier?: ModelTier;
        governorPhase?: string;
        registeredProviders?: Set<string>;
    }): RoutingDecision & {
        escalationChain?: string[];
    };
    /**
     * Get the next escalation model after a failure.
     */
    getNextEscalation(currentModelId: string, escalationChain: string[]): UserModelConfig | null;
    /**
     * Record execution outcome for learning.
     */
    recordOutcome(modelId: string, taskType: string, success: boolean, durationMs: number): void;
    /**
     * Get success rate for a model on a task type.
     */
    getSuccessRate(modelId: string, taskType: string): number;
    /**
     * List all models, optionally filtered by capability.
     */
    listModels(filter?: {
        capability?: ModelCapability;
        tier?: ModelTier;
    }): UserModelConfig[];
    /**
     * Get model by ID.
     */
    getModel(modelId: string): UserModelConfig | undefined;
    /**
     * Add a model to the pool at runtime.
     */
    addModel(config: UserModelConfig): void;
    /**
     * Remove a model from the pool.
     */
    removeModel(modelId: string): boolean;
    /**
     * Get routing stats for debugging.
     */
    getStats(): {
        totalModels: number;
        mode: string;
        capabilities: Record<string, number>;
        successRates: {
            modelId: string;
            taskType: string;
            rate: number;
            count: number;
        }[];
    };
    private detectCapabilities;
    private rankCandidates;
    private scoreModel;
    private buildDecision;
    private buildCascadeChain;
    private fallbackDecision;
    private getDefaultModelPool;
    private getDefaultRoutingRules;
}
export declare function getSmartModelRouter(): SmartModelRouter;
export declare function setSmartModelRouter(router: SmartModelRouter): void;
//# sourceMappingURL=smartModelRouter.d.ts.map