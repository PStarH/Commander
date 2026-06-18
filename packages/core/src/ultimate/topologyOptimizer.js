"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReflexionTopologicalOptimizer = void 0;
const metaLearner_1 = require("../selfEvolution/metaLearner");
const reflectionEngine_1 = require("../reflectionEngine");
const executionTrace_1 = require("../runtime/executionTrace");
class ExecutionAnalyzer {
    /**
     * 分析执行轨迹，找出瓶颈和优化点
     */
    analyze(snapshot) {
        const { tree, result, metrics } = snapshot;
        // 1. 计算关键路径
        const criticalPath = this.findCriticalPath(tree);
        // 2. 计算并行度统计
        const parallelism = this.calculateParallelism(tree, metrics.parallelismAtEachStep);
        // 3. 发现瓶颈节点
        const bottlenecks = this.findBottlenecks(tree, metrics);
        // 4. 发现冗余边
        const redundantEdges = this.findRedundantEdges(tree);
        // 5. 计算负载均衡
        const loadBalance = this.calculateLoadBalance(tree, metrics);
        // 6. 综合健康状况
        const healthScore = this.computeHealthScore(criticalPath, parallelism, loadBalance, bottlenecks);
        // 7. 推荐拓扑
        const recommendedTopology = this.recommendTopology(criticalPath, parallelism, loadBalance);
        return {
            criticalPathLength: criticalPath.length,
            maxParallelism: parallelism.max,
            parallelismUtilization: parallelism.utilization,
            loadBalanceScore: loadBalance.score,
            bottlenecks,
            redundantEdges,
            recommendedTopology,
            healthScore,
            diagnosis: this.generateDiagnosis(criticalPath, parallelism, bottlenecks, loadBalance),
        };
    }
    findCriticalPath(node) {
        if (node.subtasks.length === 0) {
            return [node];
        }
        let longestPath = [];
        for (const sub of node.subtasks) {
            const subPath = this.findCriticalPath(sub);
            if (subPath.length > longestPath.length) {
                longestPath = subPath;
            }
        }
        return [node, ...longestPath];
    }
    calculateParallelism(node, parallelismHistory) {
        const maxParallel = node.subtasks.length;
        const avgParallel = parallelismHistory.length > 0
            ? parallelismHistory.reduce((a, b) => a + b, 0) / parallelismHistory.length
            : maxParallel;
        const utilization = maxParallel > 0 ? avgParallel / maxParallel : 1;
        return { max: maxParallel, avg: avgParallel, utilization };
    }
    findBottlenecks(node, metrics) {
        var _a;
        const bottlenecks = [];
        const allNodes = this.flattenTree(node);
        for (const n of allNodes) {
            if (n.subtasks.length > 0)
                continue; // 只分析叶子节点
            const duration = (_a = metrics.nodeDurations.get(n.id)) !== null && _a !== void 0 ? _a : 0;
            const avgDuration = this.computeAvgDuration(allNodes, metrics);
            const deps = n.dependencies.length;
            if (duration > avgDuration * 2 && duration > 10000) {
                bottlenecks.push({
                    nodeId: n.id,
                    goal: n.goal.slice(0, 100),
                    issue: 'too_slow',
                    impact: Math.min(1, duration / (avgDuration * 3)),
                    suggestion: `考虑将此节点拆分为更小的子任务，或升级到更高层级模型`,
                });
            }
            if (deps > 4) {
                bottlenecks.push({
                    nodeId: n.id,
                    goal: n.goal.slice(0, 100),
                    issue: 'too_many_deps',
                    impact: Math.min(1, deps / 10),
                    suggestion: `依赖过多（${deps}个），考虑重新组织任务依赖关系`,
                });
            }
        }
        return bottlenecks.sort((a, b) => b.impact - a.impact);
    }
    findRedundantEdges(node) {
        // 简化的冗余边检测：如果 A→B→C 且 A→C，则 A→C 是冗余的
        const edges = [];
        const edgesList = this.collectEdges(node);
        for (const edge of edgesList) {
            // 检查是否存在间接路径
            if (this.hasIndirectPath(edge.from, edge.to, edgesList, edge)) {
                edges.push({
                    from: edge.from,
                    to: edge.to,
                    reason: `存在间接路径 ${edge.from} → ... → ${edge.to}，直接边可能冗余`,
                });
            }
        }
        return edges;
    }
    calculateLoadBalance(node, metrics) {
        const leafNodes = this.flattenTree(node).filter((n) => n.subtasks.length === 0);
        if (leafNodes.length < 2)
            return { score: 1, details: [] };
        const durations = leafNodes.map((n) => { var _a; return (_a = metrics.nodeDurations.get(n.id)) !== null && _a !== void 0 ? _a : 0; });
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        const variance = durations.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) / durations.length;
        const stdDev = Math.sqrt(variance);
        // 变异系数越小，负载越均衡
        const cv = avg > 0 ? stdDev / avg : 0;
        const balanceScore = Math.max(0, 1 - cv);
        const details = leafNodes.map((n, i) => {
            const ratio = avg > 0 ? durations[i] / avg : 1;
            return `${n.id}: ${ratio.toFixed(1)}x 平均执行时间`;
        });
        return { score: balanceScore, details };
    }
    computeHealthScore(criticalPath, parallelism, loadBalance, bottlenecks) {
        let score = 0.5;
        // 关键路径不宜过长
        if (criticalPath.length <= 3)
            score += 0.2;
        else if (criticalPath.length <= 5)
            score += 0.1;
        else
            score -= 0.1;
        // 并行度利用率
        score += parallelism.utilization * 0.2;
        // 负载均衡
        score += loadBalance.score * 0.15;
        // 瓶颈扣分
        if (bottlenecks.length > 0) {
            score -= bottlenecks.length * 0.05;
        }
        return Math.max(0, Math.min(1, score));
    }
    recommendTopology(criticalPath, parallelism, loadBalance) {
        // 基于分析结果推荐拓扑
        if (parallelism.utilization < 0.5 && parallelism.max > 2) {
            return 'PARALLEL'; // 并行度低，切换到并行
        }
        if (criticalPath.length > 6) {
            return 'HIERARCHICAL'; // 关键路径太长，使用层级架构
        }
        if (loadBalance.score < 0.5) {
            return 'HYBRID'; // 负载不均衡，使用混合架构
        }
        if (parallelism.max <= 2) {
            return 'SEQUENTIAL'; // 任务少，串行即可
        }
        return 'PARALLEL';
    }
    generateDiagnosis(criticalPath, parallelism, bottlenecks, loadBalance) {
        const parts = [];
        parts.push(`关键路径长度: ${criticalPath.length} 个节点`);
        parts.push(`最大并行度: ${parallelism.max}, 实际利用率: ${(parallelism.utilization * 100).toFixed(0)}%`);
        parts.push(`负载均衡度: ${(loadBalance.score * 100).toFixed(0)}%`);
        if (bottlenecks.length > 0) {
            parts.push(`发现 ${bottlenecks.length} 个瓶颈节点:`);
            for (const b of bottlenecks.slice(0, 3)) {
                parts.push(`  - ${b.nodeId}: ${b.issue} (影响度: ${(b.impact * 100).toFixed(0)}%)`);
            }
        }
        return parts.join('\n');
    }
    flattenTree(node) {
        const result = [node];
        for (const sub of node.subtasks) {
            result.push(...this.flattenTree(sub));
        }
        return result;
    }
    collectEdges(node) {
        const edges = [];
        const traverse = (n) => {
            for (const sub of n.subtasks) {
                edges.push({ from: n.id, to: sub.id });
                traverse(sub);
            }
        };
        traverse(node);
        return edges;
    }
    hasIndirectPath(from, to, edges, excludeEdge) {
        var _a, _b;
        // BFS查找间接路径
        const adj = new Map();
        for (const e of edges) {
            if (e.from === excludeEdge.from && e.to === excludeEdge.to)
                continue;
            const neighbors = (_a = adj.get(e.from)) !== null && _a !== void 0 ? _a : [];
            neighbors.push(e.to);
            adj.set(e.from, neighbors);
        }
        const visited = new Set();
        const queue = [from];
        let queueIdx = 0;
        while (queueIdx < queue.length) {
            const current = queue[queueIdx++];
            if (current === to)
                return true;
            if (visited.has(current))
                continue;
            visited.add(current);
            for (const neighbor of (_b = adj.get(current)) !== null && _b !== void 0 ? _b : []) {
                if (!visited.has(neighbor))
                    queue.push(neighbor);
            }
        }
        return false;
    }
    computeAvgDuration(nodes, metrics) {
        const durations = nodes.map((n) => { var _a; return (_a = metrics.nodeDurations.get(n.id)) !== null && _a !== void 0 ? _a : 0; });
        return durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    }
}
class ReflexionTopologicalOptimizer {
    constructor() {
        this.analyzer = new ExecutionAnalyzer();
        this.history = [];
        this.reflectionEngine = (0, reflectionEngine_1.getGlobalReflectionEngine)();
    }
    /**
     * 基于执行经验执行一次完整的优化周期
     */
    async optimize(experience, originalTree, context) {
        // 1. 构建执行快照
        const snapshot = await this.buildSnapshot(originalTree, experience);
        // 2. 诊断拓扑问题
        const diagnostics = this.analyzer.analyze(snapshot);
        // 3. 生成优化建议
        const proposal = this.generateProposal(diagnostics, experience);
        // 4. 生成优化后的任务树
        const newTree = this.applyActions(originalTree, proposal.actions);
        // 5. 使用Reflexion评估优化效果
        const reflection = await this.reflectOnOptimization(diagnostics, proposal, experience);
        proposal.rationale += `\n\nReflexion: ${reflection}`;
        // 6. 记录结果
        const result = {
            proposal,
            newTree,
            predictedImprovement: proposal.expectedImprovement,
            applied: true,
        };
        if (this.history.length >= ReflexionTopologicalOptimizer.MAX_HISTORY)
            this.history.shift();
        this.history.push(result);
        return result;
    }
    /**
     * 构建执行快照
     */
    async buildSnapshot(tree, experience) {
        var _a, _b;
        // 从trace recorder获取详细的执行数据
        const tracer = (0, executionTrace_1.getTraceRecorder)();
        const nodeDurations = new Map();
        const nodeTokenUsage = new Map();
        const parallelismHistory = [];
        // 使用经验数据估算节点指标
        if (experience.lessons && experience.lessons.length > 0) {
            nodeDurations.set('estimated', (_a = experience.durationMs) !== null && _a !== void 0 ? _a : 0);
        }
        return {
            tree,
            result: {
                status: 'SUCCESS',
                summary: '',
                id: '',
                synthesis: '',
                artifacts: [],
                executionTree: [],
                reasoning: [],
                metrics: {
                    totalTokens: 0,
                    totalCostUsd: 0,
                    totalDurationMs: 0,
                    llmCalls: 0,
                    toolCalls: 0,
                    subAgentsSpawned: 0,
                    artifactsCreated: 0,
                    qualityScore: 0,
                    topologyUsed: 'SINGLE',
                    effortLevelUsed: 'COMPLEX',
                },
                errors: [],
            },
            metrics: {
                totalDurationMs: experience.durationMs,
                totalTokens: (_b = experience.tokenCost) !== null && _b !== void 0 ? _b : 0,
                nodeDurations,
                nodeTokenUsage,
                parallelismAtEachStep: parallelismHistory,
            },
        };
    }
    /**
     * 基于诊断生成优化建议
     */
    generateProposal(diagnostics, experience) {
        var _a;
        const actions = [];
        // 1. 如果关键路径太长，考虑拆分关键节点
        if (diagnostics.criticalPathLength > 4) {
            for (const bn of diagnostics.bottlenecks.slice(0, 2)) {
                if (bn.issue === 'too_slow') {
                    actions.push({
                        type: 'split_node',
                        nodeId: bn.nodeId,
                        into: [`${bn.nodeId}-part1`, `${bn.nodeId}-part2`],
                        rationale: `拆分慢节点以缩短关键路径`,
                    });
                }
            }
        }
        // 2. 如果并行度利用率低，考虑改变拓扑
        if (diagnostics.parallelismUtilization < 0.5) {
            actions.push({
                type: 'change_topology',
                from: 'SEQUENTIAL',
                to: diagnostics.recommendedTopology,
                rationale: `当前并行度利用率仅 ${(diagnostics.parallelismUtilization * 100).toFixed(0)}%，切换到 ${diagnostics.recommendedTopology}`,
            });
        }
        // 3. 移除冗余边
        for (const edge of diagnostics.redundantEdges.slice(0, 2)) {
            actions.push({
                type: 'remove_edge',
                from: edge.from,
                to: edge.to,
                rationale: edge.reason,
            });
        }
        // 4. 如果有负载不均衡，考虑重新排序
        if (diagnostics.loadBalanceScore < 0.6) {
            actions.push({
                type: 'reorder_nodes',
                nodeIds: diagnostics.bottlenecks.map((b) => b.nodeId),
                rationale: `重新排序以改善负载均衡（当前评分: ${(diagnostics.loadBalanceScore * 100).toFixed(0)}%）`,
            });
        }
        // 5. 基于历史经验调整模型层级（优先使用跨模型记忆）
        if (experience.modelUsed) {
            const metaLearner = (0, metaLearner_1.getMetaLearner)();
            const modelScores = metaLearner.getStrategyScoresForModel(experience.modelUsed);
            const scores = modelScores.length > 0
                ? modelScores
                : metaLearner.getStrategyScores((_a = experience.taskType) !== null && _a !== void 0 ? _a : 'general');
            if (scores.length > 0 && scores[0].strategy !== 'SEQUENTIAL' && scores[0].score >= 0.4) {
                actions.push({
                    type: 'upgrade_model_tier',
                    nodeId: actions.length > 0 && 'nodeId' in actions[0] ? actions[0].nodeId : 'primary',
                    fromTier: 'standard',
                    toTier: scores[0].strategy.toLowerCase(),
                    rationale: `MetaLearner 建议使用 ${scores[0].strategy} 策略（成功率: ${(scores[0].score * 100).toFixed(0)}%）`,
                });
            }
        }
        // 计算置信度
        const confidence = Math.min(1, actions.length > 0 ? 0.6 + actions.length * 0.1 : 0.3);
        return {
            id: `opt-${Date.now()}`,
            timestamp: new Date().toISOString(),
            actions,
            expectedImprovement: Math.min(1, diagnostics.healthScore < 0.5 ? 0.3 : 0.15),
            confidence,
            rationale: diagnostics.diagnosis,
            priority: diagnostics.healthScore < 0.4 ? 'high' : diagnostics.healthScore < 0.7 ? 'medium' : 'low',
            source: 'hybrid',
            evidence: [
                `关键路径长度: ${diagnostics.criticalPathLength}`,
                `并行度利用率: ${(diagnostics.parallelismUtilization * 100).toFixed(0)}%`,
                `负载均衡度: ${(diagnostics.loadBalanceScore * 100).toFixed(0)}%`,
                `瓶颈数量: ${diagnostics.bottlenecks.length}`,
                `历史成功率: ${experience.success ? '成功' : '失败'}`,
            ],
        };
    }
    /**
     * 应用优化操作到任务树
     */
    applyActions(tree, actions) {
        // Deep clone — structuredClone is faster than JSON.parse(JSON.stringify())
        const newTree = structuredClone(tree);
        for (const action of actions) {
            switch (action.type) {
                case 'split_node':
                    this.splitNode(newTree, action.nodeId, action.into);
                    break;
                case 'merge_nodes':
                    this.mergeNodes(newTree, action.nodeIds, action.into);
                    break;
                case 'add_edge':
                    this.addEdge(newTree, action.from, action.to);
                    break;
                case 'remove_edge':
                    this.removeEdge(newTree, action.from, action.to);
                    break;
                case 'reorder_nodes':
                    this.reorderNodes(newTree, action.nodeIds);
                    break;
                default:
                    break;
            }
        }
        return newTree;
    }
    /**
     * 使用Reflexion反思优化决策
     */
    async reflectOnOptimization(diagnostics, proposal, experience) {
        const sessionId = this.reflectionEngine.startSession(`opt-${Date.now()}`);
        // 记录优化反思
        this.reflectionEngine.addReflection(sessionId, `Topology optimization after execution with ${diagnostics.criticalPathLength} critical path length, ` +
            `${diagnostics.bottlenecks.length} bottlenecks, parallelism utilization ${(diagnostics.parallelismUtilization * 100).toFixed(0)}%`, `Are the proposed ${proposal.actions.length} actions likely to improve performance?`, `Proposed actions: ${proposal.actions.map((a) => a.type).join(', ')}. ` +
            `Expected improvement: ${(proposal.expectedImprovement * 100).toFixed(0)}%. ` +
            `Confidence: ${(proposal.confidence * 100).toFixed(0)}%`);
        const insights = this.reflectionEngine.getRecommendations(sessionId);
        this.reflectionEngine.completeSession(sessionId, experience.success ? 'success' : 'partial');
        return insights.length > 0
            ? insights.slice(0, 3).join('; ')
            : 'Optimization looks reasonable based on current metrics';
    }
    // ---- 树操作辅助方法 ----
    findNodeById(node, id) {
        if (node.id === id)
            return node;
        for (const sub of node.subtasks) {
            const found = this.findNodeById(sub, id);
            if (found)
                return found;
        }
        return null;
    }
    splitNode(tree, nodeId, into) {
        const node = this.findNodeById(tree, nodeId);
        if (!node || node.subtasks.length === 0)
            return;
        // 将现有子任务分配到新节点
        const subtasks = [...node.subtasks];
        node.subtasks = [];
        const chunkSize = Math.ceil(subtasks.length / into.length);
        for (let i = 0; i < into.length; i++) {
            const chunk = subtasks.slice(i * chunkSize, (i + 1) * chunkSize);
            node.subtasks.push({
                id: into[i],
                parentId: node.id,
                goal: `${node.goal} (part ${i + 1})`,
                role: 'EXECUTOR',
                isAtomic: true,
                status: 'PENDING',
                subtasks: chunk,
                dependencies: i === 0 ? node.dependencies : [into[i - 1]],
                context: { ...node.context, splitFrom: nodeId },
            });
        }
    }
    mergeNodes(tree, nodeIds, into) {
        // 简化的合并：将多个子节点合并到一个
        const nodeIdSet = new Set(nodeIds);
        const findParent = (node) => {
            for (const sub of node.subtasks) {
                if (nodeIdSet.has(sub.id))
                    return node;
                const found = findParent(sub);
                if (found)
                    return found;
            }
            return null;
        };
        const parent = findParent(tree);
        if (!parent)
            return;
        const mergedNode = {
            id: into,
            parentId: parent.id,
            goal: `Merged: ${nodeIds.map((id) => { var _a, _b; return (_b = (_a = parent.subtasks.find((s) => s.id === id)) === null || _a === void 0 ? void 0 : _a.goal) !== null && _b !== void 0 ? _b : ''; }).join(' + ')}`,
            role: 'EXECUTOR',
            isAtomic: false,
            status: 'PENDING',
            subtasks: nodeIds
                .map((id) => parent.subtasks.find((s) => s.id === id))
                .filter(Boolean),
            dependencies: [],
            context: { systemPrompt: '', availableTools: [], estimatedTokens: 0, mergedFrom: nodeIds },
        };
        parent.subtasks = [...parent.subtasks.filter((s) => !nodeIdSet.has(s.id)), mergedNode];
    }
    addEdge(tree, fromId, toId) {
        const toNode = this.findNodeById(tree, toId);
        if (toNode && !new Set(toNode.dependencies).has(fromId)) {
            toNode.dependencies.push(fromId);
        }
    }
    removeEdge(tree, fromId, toId) {
        const toNode = this.findNodeById(tree, toId);
        if (toNode) {
            toNode.dependencies = toNode.dependencies.filter((d) => d !== fromId);
        }
    }
    reorderNodes(tree, nodeIds) {
        // 简单实现：调整子任务顺序，让指定节点靠前
        const reorder = (node) => {
            const reordered = [...node.subtasks];
            reordered.sort((a, b) => {
                const aIdx = nodeIds.indexOf(a.id);
                const bIdx = nodeIds.indexOf(b.id);
                if (aIdx === -1 && bIdx === -1)
                    return 0;
                if (aIdx === -1)
                    return 1;
                if (bIdx === -1)
                    return -1;
                return aIdx - bIdx;
            });
            node.subtasks = reordered;
            for (const sub of node.subtasks) {
                reorder(sub);
            }
        };
        reorder(tree);
    }
    /**
     * 获取优化历史
     */
    getHistory() {
        return [...this.history];
    }
    /**
     * 重置优化器状态
     */
    reset() {
        this.history = [];
    }
}
exports.ReflexionTopologicalOptimizer = ReflexionTopologicalOptimizer;
ReflexionTopologicalOptimizer.MAX_HISTORY = 100;
