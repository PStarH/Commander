export interface SubAgentAllocation {
    nodeId: string;
    allocatedBudget: number;
    usedTokens: number;
    status: 'pending' | 'running' | 'completed' | 'cancelled';
    hardCapExceeded: boolean;
}
export interface RunBudgetStatus {
    runId: string;
    totalBudget: number;
    softCap: number;
    hardCap: number;
    usedTokens: number;
    remainingTokens: number;
    utilizationPercent: number;
    phase: 'relaxed' | 'moderate' | 'tight' | 'critical' | 'exceeded';
    subAgents: SubAgentAllocation[];
    createdAt: string;
    updatedAt: string;
}
export interface TokenBudgetConfig {
    /** Total token budget for the run (hard cap) */
    hardCap: number;
    /** Soft cap — warning threshold (default 80% of hard cap) */
    softCap?: number;
}
export declare class TokenBudgetManager {
    private budgets;
    private runLookup;
    /**
     * Start tracking a new run's budget.
     */
    startRun(runId: string, config: TokenBudgetConfig): RunBudgetStatus;
    /**
     * Allocate budget proportionally across sub-agents based on their
     * estimated token needs. Returns a Map of nodeId → allocated budget.
     *
     * The allocation formula:
     *   allocated[i] = totalBudget * (estimatedTokens[i] / sum(estimatedTokens))
     *
     * A 10% reserve is kept for synthesis and quality fix overhead.
     */
    allocateToSubAgents(runId: string, subAgentEstimates: Array<{
        nodeId: string;
        estimatedTokens: number;
    }>): Map<string, number>;
    /**
     * Record token usage from a sub-agent. Updates the run-level total
     * and the per-agent allocation tracker.
     */
    recordUsage(runId: string, nodeId: string, tokens: number): {
        warning: boolean;
        exceeded: boolean;
    };
    /**
     * Mark a sub-agent as completed and record its final token usage.
     */
    markSubAgentComplete(runId: string, nodeId: string, finalTokens: number): void;
    /**
     * Get the budget status for a run.
     */
    getRunStatus(runId: string): RunBudgetStatus | null;
    /**
     * Check if a run's budget is exceeded (hard cap).
     */
    isBudgetExceeded(runId: string): boolean;
    /**
     * Get all active budget statuses, most recent first.
     */
    getActiveBudgets(): RunBudgetStatus[];
    /**
     * Get remaining budget for a run.
     */
    getRemainingBudget(runId: string): number;
    /**
     * Clean up a completed run's budget tracking.
     */
    completeRun(runId: string): void;
    /**
     * Number of active budgets being tracked.
     */
    getActiveBudgetCount(): number;
    private emitMetrics;
}
/**
 * Get the global TokenBudgetManager (single-tenant) or tenant-scoped (multi-tenant).
 */
export declare function getTokenBudgetManager(): TokenBudgetManager;
/** Reset for test isolation. */
export declare function resetTokenBudgetManager(): void;
//# sourceMappingURL=tokenBudgetManager.d.ts.map