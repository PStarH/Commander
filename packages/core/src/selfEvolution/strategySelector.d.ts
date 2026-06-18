import type { ExecutionExperience } from '../runtime/types';
import { BetaDistribution } from './betaDistribution';
export declare class StrategySelector {
    private thompsonPriors;
    static readonly MAX_THOMPSON_PRIORS = 200;
    private computeAdjustmentFactors;
    selectStrategy(taskType: string, strategyPerformance: Map<string, {
        totalRuns: number;
        p95DurationMs?: number;
        avgTokenCost?: number;
    }>, modelId?: string): string;
    /**
     * Calculate the adjusted score for every strategy.
     * Mirrors the scoring used by selectStrategy so callers can inspect the ranking.
     */
    calculateAdjustedScores(taskType: string, strategyPerformance: Map<string, {
        totalRuns: number;
        p95DurationMs?: number;
        avgTokenCost?: number;
    }>): Array<{
        name: string;
        score: number;
    }>;
    getStrategyScores(taskType: string, strategyPerformance: Map<string, {
        totalRuns?: number;
        avgDurationMs?: number;
        p95DurationMs?: number;
    }>): Array<{
        strategy: string;
        score: number;
        trials: number;
        avgDurationMs?: number;
        p95DurationMs?: number;
    }>;
    /**
     * Select the runner-up (second-best) strategy for shadow mode comparison.
     * Returns null if there aren't at least 2 strategies with data.
     */
    selectShadowStrategy(taskType: string, strategyPerformance: Map<string, {
        totalRuns: number;
    }>): string | null;
    /**
     * Feed a shadow comparison result into the Thompson priors as a weak signal.
     */
    recordShadowComparison(params: {
        taskType: string;
        shadowStrategy: string;
        shadowSuccess: boolean;
    }): void;
    getTrackedTaskTypes(): string[];
    recordExperience(exp: ExecutionExperience): void;
    getThompsonPriors(): Map<string, BetaDistribution[]>;
    setThompsonPriors(priors: Map<string, BetaDistribution[]>): void;
    private getOrCreatePriors;
    private estimateTaskDifficulty;
}
//# sourceMappingURL=strategySelector.d.ts.map