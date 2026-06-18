import type { ExecutionExperience, RegressionEvent } from '../runtime/types';
export declare class RegressionGate {
    private regressionEvents;
    /** Rolling success rate history per strategy: Map<strategyName, number[]> */
    private successRateHistory;
    private threshold;
    static readonly MAX_SUCCESS_RATE_ENTRIES = 200;
    constructor(threshold?: number);
    recordExperience(exp: ExecutionExperience): void;
    getRegressionEvents(limit?: number): RegressionEvent[];
    getRegressionEventsList(): RegressionEvent[];
    getSuccessRateHistory(): Map<string, number[]>;
    setRegressionEvents(events: RegressionEvent[]): void;
    setSuccessRateHistory(history: Map<string, number[]>): void;
    setThreshold(threshold: number): void;
}
//# sourceMappingURL=regressionGate.d.ts.map