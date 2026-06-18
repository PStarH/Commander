/**
 * Adaptive Orchestrator
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 根据任务复杂度动态选择最优编排策略
 * - 实时监控执行状态
 * - 动态调整 agent 数量和资源分配
 * - 异常自动恢复和重试
 */
export type OrchestrationMode = 'SEQUENTIAL' | 'PARALLEL' | 'HANDOFF' | 'MAGENTIC' | 'CONSENSUS';
export interface Agent {
    id: string;
    name: string;
    role: string;
    capabilities: string[];
    load: number;
    successRate: number;
    isAvailable: boolean;
}
export interface Task {
    id: string;
    description: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    complexity: number;
    dependencies: string[];
    assignedAgent?: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    result?: unknown;
    error?: string;
    retryCount: number;
    maxRetries: number;
}
export interface OrchestrationPlan {
    id: string;
    mode: OrchestrationMode;
    tasks: Task[];
    agents: Agent[];
    resourceAllocation: ResourceAllocation;
    estimatedDuration: number;
    createdAt: string;
}
export interface ResourceAllocation {
    leadAgentId?: string;
    specialistAgentIds: string[];
    maxConcurrent: number;
    tokenBudget: {
        lead: number;
        specialists: number;
        evaluation: number;
        overhead: number;
    };
}
export interface ExecutionMetrics {
    activeTasks: number;
    completedTasks: number;
    failedTasks: number;
    averageLoad: number;
    throughput: number;
    latency: number;
    successRate: number;
}
export declare class AdaptiveOrchestrator {
    private agents;
    private tasks;
    private executionHistory;
    private mode;
    private readonly MAX_CONCURRENT_TASKS;
    private readonly TASK_TIMEOUT_MS;
    private readonly ADAPTIVE_THRESHOLD;
    /**
     * 注册 agent
     */
    registerAgent(agent: Omit<Agent, 'load' | 'successRate' | 'isAvailable'>): string;
    /** Unregister an agent to prevent unbounded growth in long sessions */
    unregisterAgent(agentId: string): boolean;
    /**
     * 创建编排计划
     */
    createPlan(tasks: Task[], suggestedMode?: OrchestrationMode): OrchestrationPlan;
    /**
     * 确定编排模式
     */
    private determineMode;
    /**
     * 选择合适的 agents
     */
    private selectAgents;
    /**
     * 计算需要的 agent 数量
     */
    private calculateAgentCount;
    /**
     * 分配资源
     */
    private allocateResources;
    /**
     * 估算执行时间
     */
    private estimateDuration;
    /**
     * 执行编排计划
     */
    execute(plan: OrchestrationPlan): Promise<Map<string, Task>>;
    private executeSequential;
    private executeParallel;
    private executeHandoff;
    private executeMagentic;
    private executeConsensus;
    private executeTask;
    private executeTaskWithAgent;
    private getAgentVote;
    private aggregateVotes;
    private topologicalSort;
    /**
     * 获取执行指标
     */
    getMetrics(): ExecutionMetrics;
    private calculateThroughput;
    private calculateAverageLatency;
    private calculateSuccessRate;
    /**
     * 自适应调整
     */
    adapt(plan: OrchestrationPlan): OrchestrationPlan;
    /**
     * 获取当前编排模式
     */
    getCurrentMode(): OrchestrationMode;
    /**
     * 获取 agent 列表
     */
    getAgents(): Agent[];
    /**
     * 获取任务列表
     */
    getTasks(): Task[];
}
export declare function createOrchestrator(mode?: OrchestrationMode): AdaptiveOrchestrator;
//# sourceMappingURL=adaptiveOrchestrator.d.ts.map