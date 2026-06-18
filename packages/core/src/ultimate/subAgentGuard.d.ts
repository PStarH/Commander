/**
 * SubAgentGuard — enforce lifetime limits on sub-agent executions.
 *
 * Closes the "runaway sub-agent" gap from the reversibility audit. Sub-agents
 * can recursively spawn; without enforcement a single bad task can spawn N
 * sub-agents that each consume M tokens = NM cost explosion.
 *
 * Limits (all configurable per call):
 *   - maxSteps        → hard cap on internal LLM steps
 *   - maxTokens       → hard cap on token usage
 *   - maxWallClockMs  → hard cap on elapsed time
 *   - onNoProgress(n) → callback fired when N consecutive steps add no new evidence
 *
 * The guard is a thin wrapper; the actual sub-agent loop calls `guard.check()`
 * at each step boundary. Violations throw SubAgentLimitError.
 */
export declare class SubAgentLimitError extends Error {
    readonly reason: 'max_steps' | 'max_tokens' | 'max_wall_clock' | 'no_progress';
    readonly limit: number;
    readonly observed: number;
    constructor(reason: SubAgentLimitError['reason'], limit: number, observed: number);
}
export interface SubAgentLimits {
    maxSteps?: number;
    maxTokens?: number;
    maxWallClockMs?: number;
    noProgressThreshold?: number;
}
export interface SubAgentState {
    steps: number;
    tokens: number;
    startedAt: number;
    evidenceCount: number;
}
export declare class SubAgentGuard {
    private state;
    private limits;
    constructor(limits?: SubAgentLimits);
    check(currentEvidenceCount: number): void;
    recordTokens(used: number): void;
    getState(): Readonly<SubAgentState>;
    getLimits(): Readonly<Required<SubAgentLimits>>;
}
//# sourceMappingURL=subAgentGuard.d.ts.map