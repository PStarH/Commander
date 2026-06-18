import type { ModelTier } from './shared';
/**
 * Configuration for a single model in the router.
 */
export interface ModelConfig {
    id: string;
    provider: string;
    tier: ModelTier;
    costPer1KInput: number;
    costPer1KOutput: number;
    capabilities: string[];
    contextWindow: number;
    /** Priority within tier (lower = preferred first) */
    priority: number;
    /** Whether the model/provider supports OpenAI-style json_object response_format. */
    supportsJSONMode?: boolean;
    /** Whether the model/provider supports strict json_schema / native structured output. */
    supportsStructuredOutput?: boolean;
    /** Whether the model/provider supports batch API (async, 50% discount, 24h turnaround). */
    supportsBatchAPI?: boolean;
    /** Maximum batch size for this model's batch API (0 = no limit / unknown). */
    maxBatchSize?: number;
}
/**
 * Result of a routing decision.
 */
export interface RoutingDecision {
    modelId: string;
    tier: ModelTier;
    provider: string;
    reasoning: string[];
    estimatedCost: number;
    maxTokens: number;
}
//# sourceMappingURL=routing.d.ts.map