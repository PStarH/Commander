/**
 * Token Budget Allocator
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 根据任务复杂度智能分配 token 预算
 * - 阶段化预算分配
 * - 实时预算监控
 * - 超预算自动截断
 */
import { OrchestrationMode } from './adaptiveOrchestrator';
export interface TokenBudget {
    total: number;
    leadAgent: number;
    specialistAgents: number;
    evaluation: number;
    overhead: number;
    reserved: number;
}
export interface BudgetAllocation {
    phase: 'planning' | 'execution' | 'evaluation' | 'reporting';
    allocated: number;
    used: number;
    remaining: number;
    efficiency: number;
}
export interface BudgetSnapshot {
    timestamp: string;
    totalBudget: number;
    totalUsed: number;
    totalRemaining: number;
    byPhase: BudgetAllocation[];
    byAgent: Map<string, number>;
}
export interface BudgetConfig {
    baseBudget: number;
    maxBudget: number;
    efficiencyTarget: number;
    reserveRatio: number;
    warnThreshold: number;
    cutoffThreshold: number;
}
export declare class TokenBudgetAllocator {
    private config;
    private totalBudget;
    private usedBudget;
    private agentBudgets;
    private agentUsage;
    private phaseAllocations;
    private history;
    constructor(config?: Partial<BudgetConfig>);
    /**
     * 初始化预算
     */
    initialize(totalBudget: number): void;
    /**
     * 根据编排模式和任务复杂度分配预算
     */
    allocate(mode: OrchestrationMode, complexity: number, agentCount: number): TokenBudget;
    /**
     * 获取各部分分配比例
     */
    private getAllocationRatios;
    /**
     * 分配预算给各 agent
     */
    private distributeToAgents;
    /**
     * 初始化阶段分配
     */
    private initializePhaseAllocations;
    /**
     * 记录 token 使用
     */
    recordUsage(agentId: string, tokens: number, phase?: string): void;
    /**
     * 获取剩余预算
     */
    getRemaining(): number;
    /**
     * 获取使用率
     */
    getUsageRate(): number;
    /**
     * 检查是否超过阈值
     */
    isWarningThreshold(): boolean;
    isCutoffThreshold(): boolean;
    /**
     * 获取 agent 剩余预算
     */
    getAgentRemaining(agentId: string): number;
    /**
     * 获取预算警告
     */
    getWarnings(): string[];
    /**
     * 获取快照
     */
    getSnapshot(): BudgetSnapshot;
    /**
     * 记录历史快照
     */
    private recordSnapshot;
    /**
     * 获取效率分析
     */
    getEfficiencyAnalysis(): {
        overall: number;
        byPhase: Record<string, number>;
        trend: 'improving' | 'declining' | 'stable';
        recommendations: string[];
    };
    /**
     * 重置分配器
     */
    reset(): void;
    /**
     * 获取配置
     */
    getConfig(): BudgetConfig;
}
export declare function getGlobalBudgetAllocator(): TokenBudgetAllocator;
export declare function createBudgetAllocator(config?: Partial<BudgetConfig>): TokenBudgetAllocator;
export declare function resetBudgetAllocator(): void;
//# sourceMappingURL=tokenBudgetAllocator.d.ts.map