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
const DEFAULT_CONFIG = {
    priorAlpha: 1,
    priorBeta: 1,
    evictionThreshold: 0.2,
    minRetrievalsForEviction: 10,
    surpriseWeight: 0.3,
};
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
export class ThompsonMemoryScorer {
    usefulnessMap = new Map();
    config;
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Update memory usefulness based on whether it was helpful
     *
     * Token cost: 0 (pure computation)
     */
    updateUsefulness(memoryId, wasUseful) {
        let entry = this.usefulnessMap.get(memoryId);
        if (!entry) {
            entry = {
                alpha: this.config.priorAlpha,
                beta: this.config.priorBeta,
                lastUpdated: Date.now(),
                retrievalCount: 0,
            };
        }
        if (wasUseful) {
            entry.alpha += 1;
        }
        else {
            entry.beta += 1;
        }
        entry.retrievalCount += 1;
        entry.lastUpdated = Date.now();
        this.usefulnessMap.set(memoryId, entry);
    }
    /**
     * Sample usefulness score from Beta distribution
     *
     * Returns a value between 0 and 1.
     * Higher values indicate more useful memories.
     *
     * Token cost: 0 (pure computation)
     */
    sampleUsefulness(memoryId) {
        const entry = this.usefulnessMap.get(memoryId);
        if (!entry)
            return 0.5; // Default for untracked memories
        return this.betaSample(entry.alpha, entry.beta);
    }
    /**
     * Get the mean usefulness (expected value of Beta distribution)
     *
     * Token cost: 0 (pure computation)
     */
    getMeanUsefulness(memoryId) {
        const entry = this.usefulnessMap.get(memoryId);
        if (!entry)
            return 0.5;
        return entry.alpha / (entry.alpha + entry.beta);
    }
    /**
     * Calculate surprise score - how unexpected was the outcome
     *
     * High surprise = outcome was very different from expected
     * Used to boost initial importance of surprising memories
     *
     * Token cost: 0 (pure computation)
     */
    calculateSurprise(memoryId, actualOutcome) {
        const entry = this.usefulnessMap.get(memoryId);
        if (!entry)
            return 0.5; // Maximum surprise for unknown memories
        const expected = entry.alpha / (entry.alpha + entry.beta);
        const actual = actualOutcome ? 1 : 0;
        return Math.abs(actual - expected);
    }
    /**
     * Get initial importance boost based on surprise
     *
     * Memories representing unexpected outcomes get higher initial importance.
     *
     * Token cost: 0 (pure computation)
     */
    getSurpriseBoost(memoryId, actualOutcome) {
        const surprise = this.calculateSurprise(memoryId, actualOutcome);
        return surprise * this.config.surpriseWeight;
    }
    /**
     * Get eviction candidates - memories with low usefulness
     *
     * Token cost: 0 (pure computation)
     */
    getEvictionCandidates() {
        const candidates = [];
        for (const [id, entry] of this.usefulnessMap) {
            const mean = entry.alpha / (entry.alpha + entry.beta);
            // Only evict if we have enough data and the score is low
            if (mean < this.config.evictionThreshold &&
                entry.retrievalCount >= this.config.minRetrievalsForEviction) {
                candidates.push(id);
            }
        }
        return candidates;
    }
    /**
     * Get usefulness statistics for a memory
     *
     * Token cost: 0 (pure computation)
     */
    getStats(memoryId) {
        const entry = this.usefulnessMap.get(memoryId);
        if (!entry)
            return null;
        const mean = entry.alpha / (entry.alpha + entry.beta);
        const variance = (entry.alpha * entry.beta) /
            ((entry.alpha + entry.beta) ** 2 * (entry.alpha + entry.beta + 1));
        const confidence = Math.min(entry.retrievalCount / 20, 1); // 20 retrievals = full confidence
        return {
            mean,
            variance,
            retrievalCount: entry.retrievalCount,
            confidence,
        };
    }
    /**
     * Get all tracked memory IDs
     */
    getTrackedIds() {
        return Array.from(this.usefulnessMap.keys());
    }
    /**
     * Remove a memory from tracking
     */
    remove(memoryId) {
        return this.usefulnessMap.delete(memoryId);
    }
    /**
     * Clear all tracking data
     */
    clear() {
        this.usefulnessMap.clear();
    }
    /**
     * Get the number of tracked memories
     */
    get size() {
        return this.usefulnessMap.size;
    }
    /**
     * Persist to JSON for cross-session learning
     */
    toJSON() {
        return Object.fromEntries(this.usefulnessMap);
    }
    /**
     * Load from JSON
     */
    fromJSON(data) {
        this.usefulnessMap.clear();
        for (const [id, entry] of Object.entries(data)) {
            this.usefulnessMap.set(id, entry);
        }
    }
    /**
     * Beta distribution sampling using Marsaglia and Tsang's method
     *
     * Same implementation as MetaLearner's BetaDistribution.sample()
     */
    betaSample(alpha, beta) {
        const x = this.gammaSample(alpha);
        const y = this.gammaSample(beta);
        return x / (x + y);
    }
    /**
     * Gamma distribution sampling (Marsaglia and Tsang's method)
     */
    gammaSample(shape) {
        if (shape < 1) {
            return this.gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
        }
        const d = shape - 1 / 3;
        const c = 1 / Math.sqrt(9 * d);
        while (true) {
            let x;
            let v;
            do {
                x = this.normalRandom();
                v = 1 + c * x;
            } while (v <= 0);
            v = v * v * v;
            const u = Math.random();
            if (u < 1 - 0.0331 * x * x * x * x)
                return d * v;
            if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
                return d * v;
        }
    }
    /**
     * Standard normal random variable (Box-Muller transform)
     */
    normalRandom() {
        const u = 1 - Math.random();
        const v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }
}
