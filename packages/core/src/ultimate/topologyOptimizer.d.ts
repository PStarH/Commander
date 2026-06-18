/**
 * ReflexionTopologicalOptimizer — Reflexion驱动的工作流拓扑自优化
 *
 * 基于 Reflexion 框架 (arXiv 2303.11366) 和 Polymath (arXiv 2508.02959) 的混合方法：
 * 1. 在每次执行后，通过Reflexion分析执行轨迹
 * 2. 识别拓扑瓶颈（关键路径过长、并行度不足、负载不均衡）
 * 3. 生成拓扑优化建议（重连边、拆/合节点、调整层级）
 * 4. 通过MetaLearner验证优化效果
 *
 * 与传统方法不同：
 * - 不是静态的"一次优化"，而是持续演化的拓扑
 * - 结合了反思（定性分析）和量化指标（执行时间、token消耗、质量评分）
 * - 支持"软迁移"：逐步将流量切换到新拓扑，而非直接替换
 */
import type { OrchestrationTopology, TaskTreeNode, UltimateExecutionContext } from './types';
import type { ExecutionExperience } from '../runtime/types';
export interface TopologyDiagnostics {
    /** 关键路径长度（从根到最深叶节点的步数） */
    criticalPathLength: number;
    /** 最大并行度（任意时刻最大并发子任务数） */
    maxParallelism: number;
    /** 实际并行度利用率（0-1） */
    parallelismUtilization: number;
    /** 负载均衡度（0-1，越高越均衡） */
    loadBalanceScore: number;
    /** 瓶颈节点列表 */
    bottlenecks: BottleneckNode[];
    /** 冗余边（可以被移除而不影响可达性） */
    redundantEdges: EdgeRef[];
    /** 建议的拓扑类型 */
    recommendedTopology: OrchestrationTopology;
    /** 整体健康度（0-1） */
    healthScore: number;
    /** 详细的诊断文本 */
    diagnosis: string;
}
export interface BottleneckNode {
    nodeId: string;
    goal: string;
    issue: 'too_slow' | 'too_many_deps' | 'sequential_when_parallel' | 'resource_hog';
    impact: number;
    suggestion: string;
}
export interface EdgeRef {
    from: string;
    to: string;
    reason: string;
}
export type OptimizationAction = {
    type: 'split_node';
    nodeId: string;
    into: string[];
    rationale: string;
} | {
    type: 'merge_nodes';
    nodeIds: string[];
    into: string;
    rationale: string;
} | {
    type: 'add_edge';
    from: string;
    to: string;
    rationale: string;
} | {
    type: 'remove_edge';
    from: string;
    to: string;
    rationale: string;
} | {
    type: 'change_topology';
    from: OrchestrationTopology;
    to: OrchestrationTopology;
    rationale: string;
} | {
    type: 'reorder_nodes';
    nodeIds: string[];
    rationale: string;
} | {
    type: 'upgrade_model_tier';
    nodeId: string;
    fromTier: string;
    toTier: string;
    rationale: string;
};
export interface OptimizationProposal {
    id: string;
    timestamp: string;
    actions: OptimizationAction[];
    expectedImprovement: number;
    confidence: number;
    rationale: string;
    priority: 'high' | 'medium' | 'low';
    source: 'reflexion' | 'quantitative' | 'hybrid';
    /** 基于历史数据的证据 */
    evidence: string[];
}
export interface OptimizationResult {
    proposal: OptimizationProposal;
    newTree: TaskTreeNode;
    predictedImprovement: number;
    applied: boolean;
}
export declare class ReflexionTopologicalOptimizer {
    private analyzer;
    private history;
    private static readonly MAX_HISTORY;
    private reflectionEngine;
    /**
     * 基于执行经验执行一次完整的优化周期
     */
    optimize(experience: ExecutionExperience, originalTree: TaskTreeNode, context: UltimateExecutionContext): Promise<OptimizationResult>;
    /**
     * 构建执行快照
     */
    private buildSnapshot;
    /**
     * 基于诊断生成优化建议
     */
    private generateProposal;
    /**
     * 应用优化操作到任务树
     */
    private applyActions;
    /**
     * 使用Reflexion反思优化决策
     */
    private reflectOnOptimization;
    private findNodeById;
    private splitNode;
    private mergeNodes;
    private addEdge;
    private removeEdge;
    private reorderNodes;
    /**
     * 获取优化历史
     */
    getHistory(): OptimizationResult[];
    /**
     * 重置优化器状态
     */
    reset(): void;
}
//# sourceMappingURL=topologyOptimizer.d.ts.map