import type { LLMProvider, LLMRequest, LLMResponse, ModelTier } from '../runtime/types';
import type { ProviderEndpoint, ProviderHealth, ProviderSelection } from './types';
export declare class ProviderPool {
    private endpoints;
    private healthCache;
    private providers;
    private consecutiveFailures;
    private maxRetries;
    private retryDelayMs;
    private recoveryTimer;
    private readonly RECOVERY_CHECK_INTERVAL_MS;
    private readonly RECOVERY_AFTER_FAILURES_MS;
    constructor(maxRetries?: number, retryDelayMs?: number);
    /**
     * Register an LLM provider instance (e.g. OpenAIProvider, AnthropicProvider).
     */
    registerProvider(provider: LLMProvider): void;
    /**
     * Configure endpoints with API keys and routing weights.
     */
    configureEndpoints(endpoints: ProviderEndpoint[]): void;
    /**
     * Select the best provider for a given model and tier.
     * Uses weighted random selection among healthy endpoints.
     */
    select(modelTier?: ModelTier): ProviderSelection;
    /**
     * Get all eligible endpoints for a tier, sorted by weight (descending).
     */
    private getAllEligible;
    /**
     * Execute a request with automatic failover across providers.
     * Cycles through eligible providers deterministically (by weight).
     */
    executeWithFailover(request: LLMRequest, modelTier?: ModelTier): Promise<LLMResponse>;
    /**
     * Execute with provider-native streaming when available, with the same
     * endpoint failover behavior as non-streaming calls.
     */
    executeStreaming(request: LLMRequest, modelTier?: ModelTier, onChunk?: (chunk: string) => void): Promise<LLMResponse>;
    private consumeStream;
    private recordSuccess;
    private recordFailure;
    getHealthStatus(): ProviderHealth[];
    getEndpointCount(): number;
    isProviderRegistered(name: string): boolean;
    recoverProvider(provider: string, modelId: string): void;
    private delay;
    private checkRecovery;
    /** Stop the recovery timer. Call when shutting down. */
    dispose(): void;
}
export declare function getProviderPool(): ProviderPool;
export declare function resetProviderPool(): void;
//# sourceMappingURL=providerPool.d.ts.map