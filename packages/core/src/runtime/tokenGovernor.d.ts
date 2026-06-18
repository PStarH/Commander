/**
 * Token Budget Governor
 *
 * Central coordinator for token optimization. Tracks usage in real-time,
 * selects optimization strategies based on budget pressure and task type,
 * and learns from historical effectiveness.
 */
export type OptimizationStrategy = 'observation_mask' | 'context_compaction' | 'tool_retrieval' | 'entropy_gating' | 'response_format' | 'prompt_compression' | 'verification_skip' | 'tool_output_truncate' | 'speculative_skip';
export type TaskCategory = 'code' | 'search' | 'analysis' | 'creative' | 'structured' | 'general';
export interface BudgetState {
    totalBudget: number;
    usedTokens: number;
    remainingTokens: number;
    pressure: number;
    phase: 'relaxed' | 'moderate' | 'tight' | 'critical';
}
export interface GovernorDecision {
    strategy: OptimizationStrategy;
    apply: boolean;
    intensity: number;
    reason: string;
}
export interface GovernorConfig {
    totalBudget: number;
    thresholds: {
        relaxed: number;
        moderate: number;
        tight: number;
        critical: number;
    };
    enableLearning: boolean;
}
export declare class TokenGovernor {
    private config;
    private usedTokens;
    private taskCategory;
    private history;
    private historyHead;
    private historyCount;
    private readonly maxHistory;
    private readonly decayHalfLifeMs;
    private strategyIndex;
    private cachedPhase;
    private cachedRecommendations;
    private cachedRecommendationsMap;
    private static readonly CJK_RE;
    constructor(config?: Partial<GovernorConfig>);
    reportUsage(tokens: number): void;
    getState(): BudgetState;
    reset(budget?: number): void;
    /** Set task category for strategy selection. Call before first shouldApply(). */
    setTaskCategory(cat: TaskCategory): void;
    getRecommendations(): GovernorDecision[];
    shouldApply(strategy: OptimizationStrategy): {
        apply: boolean;
        intensity: number;
    };
    recordOutcome(strategy: string, tokensBefore: number, tokensAfter: number): void;
    private strategyEffectiveness;
    private adjustByLearning;
    static estimateTokens(text: string): number;
    remainingForComponent(ratio: number): number;
}
/** Get the global TokenGovernor (single-tenant) or tenant-scoped (multi-tenant). */
export declare function getTokenGovernor(config?: Partial<GovernorConfig>): TokenGovernor;
/** Reset the token governor singleton (for test isolation). */
export declare function resetTokenGovernor(): void;
//# sourceMappingURL=tokenGovernor.d.ts.map