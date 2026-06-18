export interface IntentScoreboardEntry {
    topology: string;
    score: number;
    reasoning?: string;
}
export interface IntentEscalation {
    from: string;
    to: string;
    reason: string;
    timestamp: string;
}
/**
 * Persisted intent record. Most fields are optional so callers can emit
 * partial records (e.g. a cascade escalation record that only knows
 * `routingReasoning`) without a full DeliberationPlan. Schema version is
 * bumped if the layout changes incompatibly.
 */
export interface IntentRecord {
    schemaVersion: 1;
    runId: string;
    agentId?: string;
    tenantId?: string;
    missionId?: string;
    parentRunId?: string;
    goal?: string;
    taskType?: string;
    effortLevel?: string;
    estimatedAgentCount?: number;
    estimatedSteps?: number;
    estimatedTokens?: number;
    estimatedDurationMs?: number;
    estimatedCostUsd?: number;
    confidence?: number;
    chosenTopology?: string;
    topologyScoreboard?: Record<string, unknown> | IntentScoreboardEntry[];
    chosenModel?: {
        id: string;
        provider: string;
        tier: string;
    };
    routingReasoning?: string[];
    escalations?: IntentEscalation[];
    capabilitiesNeeded?: string[];
    decompositionStrategy?: string;
    taskNature?: string;
    suitableForSpeculation?: boolean;
    /** Full LLM-prompt-less deliberation plan — for replay analysis */
    deliberation?: Record<string, unknown>;
    /** Runtime stage (e.g., 'agentRuntime.execute', 'agentRuntime.cascade') */
    stage?: string;
    /** Decision taken at this stage */
    decision?: string;
    /** Reason for the decision */
    reason?: string;
    /** Stage-specific structured payload */
    payload?: Record<string, unknown>;
    /** Captured timestamp */
    capturedAt: string;
    /** Source label: e.g. 'keyword', 'llm', 'agentRuntime', 'agentRuntime.cascade', 'ultimateOrchestrator' */
    source?: string;
}
export declare class IntentLog {
    private baseDir;
    private tenantId?;
    private writeQueue;
    private flushing;
    constructor(baseDir?: string, tenantId?: string);
    /**
     * Append an IntentRecord to disk. Serialised through a write queue to
     * avoid interleaving partial lines on concurrent calls.
     */
    write(record: IntentRecord): Promise<void>;
    /** Read the most recent intent record for a run, or null if none exists. */
    readIntent(runId: string): IntentRecord | null;
    /** List all run ids with captured intent. */
    listRuns(): string[];
    /** Drain pending writes. Call before shutdown. */
    flush(): Promise<void>;
    getBaseDir(): string;
    private enqueueWrite;
}
export declare function getIntentLog(tenantId?: string): IntentLog;
export declare function resetIntentLog(): void;
//# sourceMappingURL=intentLog.d.ts.map