/**
 * Thompson Memory Scorer
 *
 * Uses Beta distributions to track memory usefulness over time.
 * Based on Prioritized Experience Replay (Schaul et al., 2015) and
 * Thompson Sampling for memory prioritization.
 *
 * Token cost: 0 (pure computation, no LLM calls)
 *
 * @module memory/thompsonMemoryScorer
 */
/** Beta distribution parameters for a single memory */
interface MemoryUsefulness {
    alpha: number;
    beta: number;
    lastUpdated: number;
    retrievalCount: number;
}
/** Configuration for ThompsonMemoryScorer */
export interface ThompsonScorerConfig {
    /** Prior alpha for new memories (default: 1) */
    priorAlpha: number;
    /** Prior beta for new memories (default: 1) */
    priorBeta: number;
    /** Threshold below which memories are eviction candidates (default: 0.2) */
    evictionThreshold: number;
    /** Minimum retrievals before a memory can be evicted (default: 10) */
    minRetrievalsForEviction: number;
    /** Surprise weight for initial importance boost (default: 0.3) */
    surpriseWeight: number;
}
/**
 * Thompson Memory Scorer
 *
 * Tracks memory usefulness using Beta distributions.
 * Memories that are frequently retrieved and found useful get higher scores.
 * Memories that are retrieved but not useful get lower scores.
 *
 * Based on:
 * - Thompson Sampling (Agrawal & Goyal, 2013)
 * - Prioritized Experience Replay (Schaul et al., 2015)
 */
export declare class ThompsonMemoryScorer {
    private usefulnessMap;
    private config;
    constructor(config?: Partial<ThompsonScorerConfig>);
    /**
     * Update memory usefulness based on whether it was helpful
     *
     * Token cost: 0 (pure computation)
     */
    updateUsefulness(memoryId: string, wasUseful: boolean): void;
    /**
     * Sample usefulness score from Beta distribution
     *
     * Returns a value between 0 and 1.
     * Higher values indicate more useful memories.
     *
     * Token cost: 0 (pure computation)
     */
    sampleUsefulness(memoryId: string): number;
    /**
     * Get the mean usefulness (expected value of Beta distribution)
     *
     * Token cost: 0 (pure computation)
     */
    getMeanUsefulness(memoryId: string): number;
    /**
     * Calculate surprise score - how unexpected was the outcome
     *
     * High surprise = outcome was very different from expected
     * Used to boost initial importance of surprising memories
     *
     * Token cost: 0 (pure computation)
     */
    calculateSurprise(memoryId: string, actualOutcome: boolean): number;
    /**
     * Get initial importance boost based on surprise
     *
     * Memories representing unexpected outcomes get higher initial importance.
     *
     * Token cost: 0 (pure computation)
     */
    getSurpriseBoost(memoryId: string, actualOutcome: boolean): number;
    /**
     * Get eviction candidates - memories with low usefulness
     *
     * Token cost: 0 (pure computation)
     */
    getEvictionCandidates(): string[];
    /**
     * Get usefulness statistics for a memory
     *
     * Token cost: 0 (pure computation)
     */
    getStats(memoryId: string): {
        mean: number;
        variance: number;
        retrievalCount: number;
        confidence: number;
    } | null;
    /**
     * Get all tracked memory IDs
     */
    getTrackedIds(): string[];
    /**
     * Remove a memory from tracking
     */
    remove(memoryId: string): boolean;
    /**
     * Clear all tracking data
     */
    clear(): void;
    /**
     * Get the number of tracked memories
     */
    get size(): number;
    /**
     * Persist to JSON for cross-session learning
     */
    toJSON(): Record<string, MemoryUsefulness>;
    /**
     * Load from JSON
     */
    fromJSON(data: Record<string, MemoryUsefulness>): void;
    /**
     * Beta distribution sampling using Marsaglia and Tsang's method
     *
     * Same implementation as MetaLearner's BetaDistribution.sample()
     */
    private betaSample;
    /**
     * Gamma distribution sampling (Marsaglia and Tsang's method)
     */
    private gammaSample;
    /**
     * Standard normal random variable (Box-Muller transform)
     */
    private normalRandom;
}
export {};
