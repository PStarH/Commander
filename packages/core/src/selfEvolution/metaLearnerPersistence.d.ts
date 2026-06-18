import { BetaDistribution } from './betaDistribution';
import type { ExecutionExperience, EvolutionPrediction, MetaLearnerConfig, PredictionVerdict, RegressionEvent, StrategyPerformance } from '../runtime/types';
export interface MetaLearnerState {
    experiences: ExecutionExperience[];
    reflections: string[];
    strategyPerformance: Map<string, StrategyPerformance>;
    thompsonPriors: Map<string, BetaDistribution[]>;
    predictions: EvolutionPrediction[];
    verdicts: PredictionVerdict[];
    regressionEvents: RegressionEvent[];
    successRateHistory: Map<string, number[]>;
    perModelPriors: Map<string, Map<string, BetaDistribution>>;
    config: MetaLearnerConfig;
}
export declare function persist(state: MetaLearnerState, persistPath: string | null): void;
export declare function load(state: MetaLearnerState, persistPath: string | null): void;
//# sourceMappingURL=metaLearnerPersistence.d.ts.map