import type { TokenUsage } from '../runtime/types';
import type { TELOSBudget, TokenCheckResult, CostRecord, CostSummary, BudgetAlert } from './types';
declare function estimateTokenCount(text: string, modelId: string): number;
declare function estimateMessagesTokens(messages: Array<{
    role: string;
    content: string;
}>, modelId: string): number;
/** Per-provider cache pricing multipliers (applied to costPer1KInput). */
declare const CACHE_MULTIPLIERS: Record<string, {
    read: number;
    write: number;
}>;
export interface CostBreakdown {
    inputCostUsd: number;
    outputCostUsd: number;
    cacheReadCostUsd: number;
    cacheWriteCostUsd: number;
    totalUsd: number;
    /** Tokens that were served from cache (saved money) */
    cacheSavingsUsd: number;
}
export declare function calculateCostBreakdown(modelId: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number): CostBreakdown;
declare function calculateCost(modelId: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number): number;
export declare class TokenSentinel {
    private costRecords;
    private budgetAlerts;
    private maxRecords;
    private maxAlerts;
    private monthlyCostLimitUsd;
    private monthlyCostUsd;
    private monthlyResetDate;
    constructor(maxRecords?: number, maxAlerts?: number, monthlyCostLimitUsd?: number);
    /** Ensure monthly cost counter is current (auto-reset on month boundary). */
    private ensureCurrentMonth;
    private trimAlerts;
    estimatePromptTokens(messages: Array<{
        role: string;
        content: string;
    }>, modelId: string): number;
    estimateOutputTokens(goal: string, modelId: string): number;
    check(messages: Array<{
        role: string;
        content: string;
    }>, modelId: string, budget: TELOSBudget): TokenCheckResult;
    recordCost(record: CostRecord): void;
    recordCostFromUsage(runId: string, agentId: string, modelId: string, usage: TokenUsage): CostRecord;
    getCosts(runId?: string): CostRecord[];
    getCostSummary(): CostSummary;
    checkBudget(runId: string, currentTokens: number, budget: TELOSBudget): BudgetAlert | null;
    checkCostBudget(runId: string): BudgetAlert | null;
    getAlerts(): BudgetAlert[];
    getMonthlyCostUsd(): number;
    getMonthlyLimitUsd(): number;
    resetMonthly(): void;
}
export declare function getTokenSentinel(): TokenSentinel;
export declare function resetTokenSentinel(): void;
export { estimateTokenCount, estimateMessagesTokens, calculateCost, CACHE_MULTIPLIERS };
//# sourceMappingURL=tokenSentinel.d.ts.map