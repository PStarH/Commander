export type GuardianInterventionType = 'semantic_drift' | 'anomaly' | 'safety_violation' | 'cost_overrun' | 'goal_hijack';
export interface GuardianAction {
    agentId: string;
    runId?: string;
    timestamp: number;
    type: 'llm_call' | 'tool_call' | 'tool_result' | 'state_change';
    content: string;
    metadata?: Record<string, unknown>;
}
export interface GuardianEvidencePack {
    id: string;
    agentId: string;
    runId?: string;
    interventionType: GuardianInterventionType;
    triggerAction: GuardianAction;
    context: GuardianAction[];
    riskScore: number;
    detectedAt: number;
    recommendation: string;
}
export interface GuardianConfig {
    enabled: boolean;
    semanticDriftThreshold: number;
    anomalyWindowSize: number;
    anomalyStddevMultiplier: number;
    maxConsecutiveAnomalies: number;
    costPerTokenUsd: number;
    maxCostPerRunUsd: number;
}
export declare class GuardianAgent {
    private config;
    private actionHistory;
    private interventionCount;
    private pausedAgents;
    private tokenUsage;
    private consecutiveAnomalies;
    constructor(config?: Partial<GuardianConfig>);
    monitor(action: GuardianAction): GuardianInterventionType | null;
    recordTokens(agentId: string, tokens: number): void;
    isPaused(agentId: string): boolean;
    resume(agentId: string): void;
    getEvidencePacks(agentId?: string): GuardianEvidencePack[];
    getStats(): {
        totalActions: number;
        totalInterventions: number;
        pausedAgents: number;
        perAgentTokens: Map<string, number>;
    };
    reset(): void;
    private appendToHistory;
    private detectSemanticDrift;
    private detectAnomaly;
    private detectSafetyViolation;
    private detectCostOverrun;
    private scanForThreats;
    private intervene;
}
export declare function getGuardianAgent(): GuardianAgent;
export declare function resetGuardianAgent(): void;
//# sourceMappingURL=guardianAgent.d.ts.map