interface TokenUsageHistory {
    mean: number;
    stdDev: number;
    samples: number;
}
interface AnomalyAlert {
    timestamp: string;
    runId: string;
    agentId: string;
    stepNumber: number;
    tokenUsage: number;
    baseline: number;
    zScore: number;
    severity: 'info' | 'warning' | 'critical';
}
export declare class TokenUsageAnomalyDetector {
    private history;
    private alerts;
    private readonly windowSize;
    private readonly zScoreThreshold;
    private readonly criticalZScore;
    recordUsage(agentId: string, tokenUsage: number): void;
    checkForAnomaly(agentId: string, runId: string, stepNumber: number, tokenUsage: number): AnomalyAlert | null;
    getAlerts(agentId?: string): AnomalyAlert[];
    getHistory(agentId: string): TokenUsageHistory | undefined;
    getBaseline(agentId: string): number;
}
export declare function getAnomalyDetector(): TokenUsageAnomalyDetector;
export declare function resetAnomalyDetector(): void;
export {};
//# sourceMappingURL=anomalyDetector.d.ts.map