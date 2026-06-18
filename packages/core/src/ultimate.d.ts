/**
 * 终极 Multi-Agent 框架 - 核心组件
 *
 * 目标：全方位碾压现有所有 agent 框架
 *
 * 核心创新：
 * 1. 自适应多范式编排 - 根据任务复杂度自动选择最优模式
 * 2. Token 最优分配 - 大模型决策 + 小模型执行
 * 3. 强制质量门控 - 每个步骤都有验证
 */
import { TaskComplexity, TaskNode, TaskComplexityOptions, measureTaskComplexity, shouldDecompose } from './index';
/**
 * 编排模式 - 基于 ACONIC + Microsoft Orchestration Patterns 研究
 */
export type OrchestrationMode = 'SEQUENTIAL' | 'PARALLEL' | 'HANDOFF' | 'MAGNETIC' | 'CONSENSUS';
/**
 * 编排决策 - 包含选择理由和执行计划
 */
export interface OrchestrationDecision {
    mode: OrchestrationMode;
    complexity: TaskComplexity;
    reasoning: string[];
    tokenBudget: TokenBudgetAllocation;
    qualityGates: QualityGate[];
    estimatedDuration: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}
/**
 * 自适应编排器 - 核心组件
 *
 * 根据任务特征自动选择最优编排模式：
 * - LOW complexity → SEQUENTIAL (单 agent 直接执行)
 * - MEDIUM + independent subtasks → PARALLEL (多 agent 并行)
 * - MEDIUM + needs expertise → HANDOFF (专家委托)
 * - HIGH + open-ended → MAGNETIC (动态规划)
 * - CRITICAL + high risk → CONSENSUS (多模型投票)
 */
export declare class AdaptiveOrchestrator {
    private options;
    constructor(options?: TaskComplexityOptions);
    /**
     * 分析任务并选择最优编排模式
     */
    analyze(task: TaskNode, allTasks: TaskNode[]): OrchestrationDecision;
    private selectMode;
    private allocateTokens;
    private setupQualityGates;
    private estimateDuration;
}
/**
 * Token 预算分配
 */
export interface TokenBudgetAllocation {
    /** Lead agent (大模型决策) 占比 */
    leadAgent: number;
    /** Specialist agents (小模型执行) 占比 */
    specialistAgents: number;
    /** 协调开销占比 */
    overhead: number;
}
/**
 * 模型配置 - 大小模型分工
 */
export interface ModelTierConfig {
    /** 大模型 - 用于决策、分析、审核 */
    leadModel: {
        name: string;
        minTokens: number;
        maxTokens: number;
        costPerToken: number;
    };
    /** 小模型 - 用于执行、生成、简单任务 */
    specialistModel: {
        name: string;
        minTokens: number;
        maxTokens: number;
        costPerToken: number;
    };
}
/**
 * 默认模型配置
 * 基于 Anthropic Research: Lead + Subagent 模式
 * 成本节省 70-90%，效果不降
 */
export declare const DEFAULT_MODEL_CONFIG: ModelTierConfig;
/**
 * Token 预算分配器
 *
 * 核心思想：
 * - 大模型只做决策（40% token）
 * - 小模型做执行（50% token）
 * - 协调开销（10% token）
 *
 * 这样可以实现 70-90% 成本节省，同时保持效果
 */
export declare class TokenBudgetAllocator {
    private config;
    private totalBudget;
    constructor(totalBudget?: number, // 默认 100k tokens
    config?: ModelTierConfig);
    /**
     * 分配 Token 预算
     */
    allocate(allocation: TokenBudgetAllocation): AllocatedBudget;
    /**
     * 获取推荐的总预算
     */
    getRecommendedBudget(complexity: TaskComplexity): number;
}
export interface AllocatedBudget {
    leadAgent: {
        model: string;
        tokens: number;
        cost: number;
    };
    specialistAgents: {
        model: string;
        tokens: number;
        cost: number;
    };
    overhead: {
        tokens: number;
    };
    total: {
        tokens: number;
        cost: number;
    };
    savings: {
        pureLeadCost: number;
        actualCost: number;
        savingsPercent: number;
    };
}
/**
 * 质量门控定义
 */
export interface QualityGate {
    name: string;
    required: boolean;
    description: string;
    config?: Record<string, unknown>;
}
/**
 * 质量门控执行器
 */
export declare class QualityGateExecutor {
    /**
     * 执行质量门控检查
     */
    execute(gates: QualityGate[], input: unknown, output: unknown): Promise<QualityGateResult[]>;
    private executeGate;
    private validateOutput;
    private checkHallucination;
    private consensusVote;
    private verifyHandoff;
}
export interface QualityGateResult {
    gate: string;
    passed: boolean;
    details: string;
    metadata?: Record<string, unknown>;
}
export { TaskComplexity, TaskNode, measureTaskComplexity, shouldDecompose };
//# sourceMappingURL=ultimate.d.ts.map