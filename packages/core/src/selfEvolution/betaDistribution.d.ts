export declare class BetaDistribution {
    alpha: number;
    beta: number;
    constructor(alpha?: number, beta?: number);
    /**
     * Sample from the Beta distribution using Gamma sampling.
     * Improved: uses Marsaglia & Tsang method correctly (the previous
     * Box-Muller approximation was inaccurate for small shape values).
     */
    sample(): number;
    private sampleGamma;
    /**
     * Update the distribution with an observation.
     * taskDifficulty (0-1) scales the update magnitude — harder tasks
     * contribute less to avoid penalizing strategies for difficult work.
     */
    update(success: boolean, taskDifficulty?: number): void;
    get mean(): number;
    get totalTrials(): number;
    /**
     * UCB1-style exploration bonus.
     * Encourages trying strategies with fewer samples.
     * Returns a bonus value to add to the Thompson sample.
     */
    explorationBonus(totalSamples: number): number;
}
//# sourceMappingURL=betaDistribution.d.ts.map