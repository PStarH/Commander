import type { ExecutionExperience, PerModelStrategyStats } from '../runtime/types';
import { BetaDistribution } from './betaDistribution';
export declare class CrossModelMemory {
    /** Per-model, per-strategy Thompson Sampling: Map<modelId, Map<strategyName, BetaDistribution>> */
    private perModelPriors;
    static readonly MAX_PER_MODEL_PRIORS = 50;
    recordExperience(exp: ExecutionExperience): void;
    getStrategyScoresForModel(modelId: string, strategyPerformance: Map<string, {
        avgDurationMs?: number;
        p95DurationMs?: number;
    }>): Array<{
        strategy: string;
        score: number;
        trials: number;
        avgDurationMs?: number;
        p95DurationMs?: number;
    }>;
    getPerModelStats(): PerModelStrategyStats[];
    getPerModelPriors(): Map<string, Map<string, BetaDistribution>>;
    setPerModelPriors(priors: Map<string, Map<string, BetaDistribution>>): void;
    private getOrCreatePerModelPriors;
}
//# sourceMappingURL=crossModelMemory.d.ts.map