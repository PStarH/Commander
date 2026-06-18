import type { OptimizationSuggestion, RegressionEvent, StrategyPerformance } from '../runtime/types';
export interface SuggestionContext {
    modelPerformance: Map<string, {
        totalRuns: number;
        successRate: number;
        avgTokens: number;
    }>;
    strategyRanking: StrategyPerformance[];
    perModelPriors: Map<string, Map<string, {
        mean: number;
        totalTrials: number;
    }>>;
    regressionEvents: RegressionEvent[];
    reflections: string[];
    minSamplesForSuggestion: number;
    enableCrossModelMemory: boolean;
}
export declare function generateSuggestions(context: SuggestionContext): OptimizationSuggestion[];
export declare function suggestUpgradeModel(currentModelId: string): string;
//# sourceMappingURL=suggestionEngine.d.ts.map