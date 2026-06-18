import type { ExecutionExperience, StrategyPerformance } from '../runtime/types';
export declare class StrategyPerformanceTracker {
    private strategyPerformance;
    recordExperience(exp: ExecutionExperience): void;
    getStrategyPerformance(): Map<string, StrategyPerformance>;
    setStrategyPerformance(perf: Map<string, StrategyPerformance>): void;
    rankStrategies(): StrategyPerformance[];
    recommendBestStrategy(): string;
    analyzeModelPerformance(): Map<string, {
        totalRuns: number;
        successRate: number;
        avgTokens: number;
    }>;
    /** Normalize strategy speed to [0, 1] where 1 = fastest. */
    speedScore(perf: StrategyPerformance): number;
    /** Normalize strategy cost to [0, 1] where 1 = cheapest. */
    costScore(perf: StrategyPerformance): number;
}
//# sourceMappingURL=strategyPerformanceTracker.d.ts.map