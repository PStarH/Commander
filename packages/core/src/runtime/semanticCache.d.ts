import type { EmbeddingFunction } from './embedding';
import type { LLMRequest, LLMResponse } from './types';
export interface SemanticCacheConfig {
    /** Enable the cache. Default: false (opt-in, like ToolResultCache). */
    enabled: boolean;
    /** Cosine threshold for cache hit. Range [0, 1]. Default: 0.92. */
    similarityThreshold: number;
    /** Max cache entries before LRU eviction. Default: 10000. */
    maxEntries: number;
    /** Default TTL in ms. Default: 86_400_000 (24h). */
    defaultTtlMs: number;
    /** Per-bucket cap to bound search cost. Default: 64. */
    maxBucketSize: number;
    /** Cache responses with temperature > 0. Default: false. */
    cacheStochastic: boolean;
    /** Cache responses that include tool_calls. Default: false (safety first). */
    cacheToolCalls: boolean;
    /** Auto-prune interval in ms. 0 disables. Default: 60_000. */
    pruneIntervalMs: number;
}
export interface SemanticCacheStats {
    totalEntries: number;
    totalBuckets: number;
    totalHits: number;
    totalMisses: number;
    totalStores: number;
    totalEvictions: number;
    hitRate: number;
    embeddingCalls: number;
    estimatedCostSavedUsd: number;
    memoryEstimateBytes: number;
}
/**
 * Bucket key from request fields that affect output distribution. Two requests
 * with the same signature can plausibly share a response; different signatures
 * must not.
 */
export declare function computeRequestSignature(request: LLMRequest): string;
export declare class SemanticCache {
    private config;
    private buckets;
    private embeddingFn;
    private pruneTimer;
    private accessCounter;
    private memoryEstimateBytes;
    private stats;
    constructor(embeddingFn: EmbeddingFunction, config?: Partial<SemanticCacheConfig>);
    /** Look up a cached response for the given request. Returns null on miss. */
    lookup(request: LLMRequest, tenantId?: string): Promise<LLMResponse | null>;
    /**
     * Store a response in the cache. Embeds the query in the background; never
     * blocks the call site. Embedding failures are silently dropped — the caller
     * has already received the response.
     */
    store(request: LLMRequest, response: LLMResponse, tenantId?: string): void;
    /** Prune expired entries from all buckets. Returns the number removed. */
    prune(): number;
    /** Invalidate all entries for a tenant. */
    invalidateTenant(tenantId: string): number;
    /** Invalidate all entries for a model (e.g., after a model update). */
    invalidateModel(modelName: string): number;
    /** Clear all entries. */
    clear(): void;
    /** Get cache statistics. */
    getStats(): SemanticCacheStats;
    /** Stop the auto-prune timer. Call when shutting down. */
    dispose(): void;
    private shouldSkip;
    private bucketKey;
    private totalEntries;
    private evictGlobalLRU;
}
//# sourceMappingURL=semanticCache.d.ts.map