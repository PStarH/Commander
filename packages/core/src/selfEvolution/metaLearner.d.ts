import type { EvolutionPrediction, ExecutionExperience, FailureCategory, MetaLearnerConfig, OptimizationSuggestion, PredictionVerdict, PerModelStrategyStats, RegressionEvent, StrategyPerformance } from '../runtime/types';
export declare class MetaLearner {
    private experiences;
    private reflections;
    private maxExperiences;
    private minSamplesForSuggestion;
    private persistPath;
    private config;
    private shadowComparisons;
    private selector;
    private crossModel;
    private predictionLoop;
    private regressionGate;
    private perfTracker;
    constructor(maxExperiences?: number, minSamplesForSuggestion?: number, persistPath?: string, config?: Partial<MetaLearnerConfig>);
    recordExperience(exp: ExecutionExperience): void;
    selectStrategy(taskType: string, modelId?: string): string;
    /**
     * Select the runner-up (second-best) strategy for shadow mode comparison.
     */
    selectShadowStrategy(taskType: string): string | null;
    /**
     * Record a shadow comparison result.
     */
    recordShadowComparison(params: {
        runId: string;
        taskType: string;
        mainStrategy: string;
        shadowStrategy: string;
        mainSuccess: boolean;
        shadowSuccess: boolean;
        mainDurationMs: number;
        shadowDurationMs: number;
    }): void;
    /**
     * Get recent shadow mode comparisons.
     */
    getShadowComparisons(limit?: number): Array<{
        runId: string;
        taskType: string;
        mainStrategy: string;
        shadowStrategy: string;
        mainSuccess: boolean;
        shadowSuccess: boolean;
        mainDurationMs: number;
        shadowDurationMs: number;
        timestamp: string;
    }>;
    getStrategyScores(taskType: string): Array<{
        strategy: string;
        score: number;
        trials: number;
        avgDurationMs?: number;
        p95DurationMs?: number;
    }>;
    /**
     * Calculate adjusted scores for all strategies on a task type.
     * Mirrors the scoring used by selectStrategy/selectShadowStrategy.
     */
    calculateAdjustedScores(taskType: string): Array<{
        name: string;
        score: number;
        trials: number;
        avgDurationMs?: number;
        p95DurationMs?: number;
    }>;
    getTrackedTaskTypes(): string[];
    getStrategyScoresForModel(modelId: string): Array<{
        strategy: string;
        score: number;
        trials: number;
        avgDurationMs?: number;
        p95DurationMs?: number;
    }>;
    getPerModelStats(): PerModelStrategyStats[];
    createPrediction(editId: string, description: string, targetStrategy: string, sourceStrategy: string, modelId: string, taskTypes: string[], predictedFixes?: FailureCategory[], predictedRegressions?: FailureCategory[]): EvolutionPrediction;
    getPredictions(): EvolutionPrediction[];
    getVerdicts(): PredictionVerdict[];
    getRegressionEvents(limit?: number): RegressionEvent[];
    getStrategyPerformance(): Map<string, StrategyPerformance>;
    getExperiences(taskType?: string): ExecutionExperience[];
    getReflections(limit?: number): string[];
    getSuggestions(): OptimizationSuggestion[];
    setConfig(partial: Partial<MetaLearnerConfig>): void;
    getConfig(): MetaLearnerConfig;
    getStats(): {
        totalExperiences: number;
        trackedStrategies: number;
        avgSuccessRate: number;
        topStrategies: StrategyPerformance[];
        totalReflections: number;
    };
    private analyzeModelPerformance;
    private persist;
    private load;
}
export declare function getMetaLearner(persistPath?: string): MetaLearner;
export declare function resetMetaLearner(): void;
export declare function clearMetaLearnerState(): void;
export { DEFAULT_META_LEARNER_CONFIG } from './strategyConstants';
//# sourceMappingURL=metaLearner.d.ts.map