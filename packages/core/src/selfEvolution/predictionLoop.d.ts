import type { ExecutionExperience, EvolutionPrediction, FailureCategory, PredictionVerdict } from '../runtime/types';
export declare class PredictionLoop {
    private predictions;
    private verdicts;
    /** Tracks last strategy selected per (modelId, taskType) for change detection */
    private lastPredictedStrategy;
    private enabled;
    constructor(enabled?: boolean);
    createPrediction(editId: string, description: string, targetStrategy: string, sourceStrategy: string, modelId: string, taskTypes: string[], predictedFixes?: FailureCategory[], predictedRegressions?: FailureCategory[]): EvolutionPrediction;
    recordExperience(exp: ExecutionExperience): void;
    getPredictions(): EvolutionPrediction[];
    getVerdicts(): PredictionVerdict[];
    getLastPredictedStrategy(): Map<string, string>;
    setPredictions(predictions: EvolutionPrediction[]): void;
    setVerdicts(verdicts: PredictionVerdict[]): void;
    setLastPredictedStrategy(map: Map<string, string>): void;
    private verifyPrediction;
}
//# sourceMappingURL=predictionLoop.d.ts.map