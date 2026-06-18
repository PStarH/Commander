"use strict";
/**
 * Adaptive Orchestrator
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 根据任务复杂度动态选择最优编排策略
 * - 实时监控执行状态
 * - 动态调整 agent 数量和资源分配
 * - 异常自动恢复和重试
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdaptiveOrchestrator = void 0;
exports.createOrchestrator = createOrchestrator;
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
// ========================================
// Orchestrator Core
// ========================================
class AdaptiveOrchestrator {
    constructor() {
        this.agents = new Map();
        this.tasks = new Map();
        this.executionHistory = [];
        this.mode = 'SEQUENTIAL';
        // Configuration
        this.MAX_CONCURRENT_TASKS = 5;
        this.TASK_TIMEOUT_MS = 300000; // 5 minutes
        this.ADAPTIVE_THRESHOLD = 0.8;
    }
    /**
     * 注册 agent
     */
    registerAgent(agent) {
        const id = agent.id || generateUUID();
        this.agents.set(id, {
            ...agent,
            load: 0,
            successRate: 1.0,
            isAvailable: true,
        });
        return id;
    }
    /** Unregister an agent to prevent unbounded growth in long sessions */
    unregisterAgent(agentId) {
        return this.agents.delete(agentId);
    }
    /**
     * 创建编排计划
     */
    createPlan(tasks, suggestedMode) {
        // 确定编排模式
        const mode = suggestedMode || this.determineMode(tasks);
        this.mode = mode;
        // 选择 agent
        const selectedAgents = this.selectAgents(tasks, mode);
        // 分配资源
        const resourceAllocation = this.allocateResources(mode, selectedAgents.length);
        // 估算执行时间
        const estimatedDuration = this.estimateDuration(tasks, mode);
        // 保存任务
        tasks.forEach((task) => {
            if (!task.id)
                task.id = generateUUID();
            this.tasks.set(task.id, { ...task, status: 'pending' });
        });
        return {
            id: generateUUID(),
            mode,
            tasks: Array.from(this.tasks.values()),
            agents: selectedAgents,
            resourceAllocation,
            estimatedDuration,
            createdAt: new Date().toISOString(),
        };
    }
    /**
     * 确定编排模式
     */
    determineMode(tasks) {
        if (tasks.length === 0)
            return 'SEQUENTIAL';
        const avgComplexity = tasks.reduce((sum, t) => sum + t.complexity, 0) / tasks.length;
        const hasDependencies = tasks.some((t) => t.dependencies.length > 0);
        const highPriorityCount = tasks.filter((t) => t.priority === 'critical' || t.priority === 'high').length;
        // 高风险决策
        if (avgComplexity > 80)
            return 'CONSENSUS';
        // 开放式探索
        if (avgComplexity > 60 && !hasDependencies)
            return 'MAGENTIC';
        // 需要专家
        if (avgComplexity > 50 && tasks.some((t) => t.complexity > 70))
            return 'HANDOFF';
        // 有依赖关系
        if (hasDependencies && avgComplexity > 30)
            return 'HANDOFF';
        // 高优先级且复杂 (must not have dependencies to run in parallel)
        if (!hasDependencies && highPriorityCount > tasks.length * 0.3 && avgComplexity > 40)
            return 'PARALLEL';
        // 简单并行
        if (!hasDependencies && avgComplexity < 30)
            return 'PARALLEL';
        // 默认顺序
        return 'SEQUENTIAL';
    }
    /**
     * 选择合适的 agents
     */
    selectAgents(tasks, mode) {
        const availableAgents = Array.from(this.agents.values())
            .filter((a) => a.isAvailable && a.load < 0.9)
            .sort((a, b) => b.successRate - a.successRate);
        if (availableAgents.length === 0) {
            // 创建虚拟 agent 用于演示
            return [
                {
                    id: 'default-agent',
                    name: 'Default Agent',
                    role: 'generalist',
                    capabilities: ['coding', 'analysis', 'writing'],
                    load: 0.5,
                    successRate: 0.8,
                    isAvailable: true,
                },
            ];
        }
        const agentCount = this.calculateAgentCount(tasks.length, mode);
        return availableAgents.slice(0, agentCount);
    }
    /**
     * 计算需要的 agent 数量
     */
    calculateAgentCount(taskCount, mode) {
        switch (mode) {
            case 'CONSENSUS':
                return Math.min(3, Math.max(2, Math.ceil(taskCount / 2)));
            case 'MAGENTIC':
                return Math.min(5, Math.max(2, Math.ceil(taskCount / 3)));
            case 'PARALLEL':
                return Math.min(this.MAX_CONCURRENT_TASKS, Math.max(2, Math.ceil(taskCount / 2)));
            case 'HANDOFF':
                return Math.min(4, Math.max(2, Math.ceil(taskCount / 3)));
            case 'SEQUENTIAL':
                return 1;
            default:
                return 1;
        }
    }
    /**
     * 分配资源
     */
    allocateResources(mode, agentCount) {
        var _a, _b, _c, _d, _e;
        const baseBudget = 100000; // 基础 token 预算
        switch (mode) {
            case 'SEQUENTIAL':
                return {
                    leadAgentId: (_a = this.agents.values().next().value) === null || _a === void 0 ? void 0 : _a.id,
                    specialistAgentIds: [],
                    maxConcurrent: 1,
                    tokenBudget: { lead: baseBudget, specialists: 0, evaluation: 5000, overhead: 2000 },
                };
            case 'PARALLEL':
                return {
                    leadAgentId: (_b = this.agents.values().next().value) === null || _b === void 0 ? void 0 : _b.id,
                    specialistAgentIds: Array.from(this.agents.values())
                        .slice(1, agentCount)
                        .map((a) => a.id),
                    maxConcurrent: Math.min(this.MAX_CONCURRENT_TASKS, agentCount),
                    tokenBudget: {
                        lead: baseBudget * 0.3,
                        specialists: baseBudget * 0.5,
                        evaluation: baseBudget * 0.15,
                        overhead: baseBudget * 0.05,
                    },
                };
            case 'HANDOFF':
                return {
                    leadAgentId: (_c = this.agents.values().next().value) === null || _c === void 0 ? void 0 : _c.id,
                    specialistAgentIds: Array.from(this.agents.values())
                        .slice(1, agentCount)
                        .map((a) => a.id),
                    maxConcurrent: Math.min(3, agentCount),
                    tokenBudget: {
                        lead: baseBudget * 0.35,
                        specialists: baseBudget * 0.45,
                        evaluation: baseBudget * 0.15,
                        overhead: baseBudget * 0.05,
                    },
                };
            case 'MAGENTIC':
                return {
                    leadAgentId: (_d = this.agents.values().next().value) === null || _d === void 0 ? void 0 : _d.id,
                    specialistAgentIds: Array.from(this.agents.values())
                        .slice(1, agentCount)
                        .map((a) => a.id),
                    maxConcurrent: Math.min(4, agentCount),
                    tokenBudget: {
                        lead: baseBudget * 0.4,
                        specialists: baseBudget * 0.35,
                        evaluation: baseBudget * 0.15,
                        overhead: baseBudget * 0.1,
                    },
                };
            case 'CONSENSUS':
                return {
                    leadAgentId: (_e = this.agents.values().next().value) === null || _e === void 0 ? void 0 : _e.id,
                    specialistAgentIds: Array.from(this.agents.values())
                        .slice(1, agentCount)
                        .map((a) => a.id),
                    maxConcurrent: 1, // 顺序执行但多模型投票
                    tokenBudget: {
                        lead: baseBudget * 0.3,
                        specialists: baseBudget * 0.3,
                        evaluation: baseBudget * 0.35,
                        overhead: baseBudget * 0.05,
                    },
                };
        }
    }
    /**
     * 估算执行时间
     */
    estimateDuration(tasks, mode) {
        const avgTaskDuration = 60000; // 1 minute base
        const complexityFactor = tasks.length > 0 ? tasks.reduce((sum, t) => sum + t.complexity, 0) / tasks.length / 50 : 1;
        let duration = avgTaskDuration * tasks.length * complexityFactor;
        switch (mode) {
            case 'PARALLEL':
                duration = duration * 0.3; // 大幅缩短
                break;
            case 'HANDOFF':
                duration = duration * 0.6;
                break;
            case 'MAGENTIC':
                duration = duration * 1.5; // 探索需要更多时间
                break;
            case 'CONSENSUS':
                duration = duration * 2; // 投票需要更多时间
                break;
        }
        return Math.ceil(duration / 1000); // 转换为秒
    }
    /**
     * 执行编排计划
     */
    async execute(plan) {
        const results = new Map();
        switch (plan.mode) {
            case 'SEQUENTIAL':
                await this.executeSequential(plan.tasks, results);
                break;
            case 'PARALLEL':
                await this.executeParallel(plan.tasks, results, plan.resourceAllocation.maxConcurrent);
                break;
            case 'HANDOFF':
                await this.executeHandoff(plan.tasks, results, plan.agents);
                break;
            case 'MAGENTIC':
                await this.executeMagentic(plan.tasks, results, plan.agents);
                break;
            case 'CONSENSUS':
                await this.executeConsensus(plan.tasks, results, plan.agents);
                break;
        }
        // Evict completed tasks from the tasks Map to prevent unbounded growth
        for (const [id, task] of this.tasks) {
            if (task.status === 'completed' || task.status === 'failed') {
                this.tasks.delete(id);
            }
        }
        // Record execution metrics for throughput calculation
        this.executionHistory.push(this.getMetrics());
        if (this.executionHistory.length > 100) {
            this.executionHistory.splice(0, this.executionHistory.length - 100);
        }
        return results;
    }
    async executeSequential(tasks, results) {
        for (const task of tasks) {
            await this.executeTask(task, results);
        }
    }
    async executeParallel(tasks, results, maxConcurrent) {
        const batches = [];
        for (let i = 0; i < tasks.length; i += maxConcurrent) {
            batches.push(tasks.slice(i, i + maxConcurrent));
        }
        for (const batch of batches) {
            await Promise.all(batch.map((task) => this.executeTask(task, results)));
        }
    }
    async executeHandoff(tasks, results, agents) {
        // 按依赖顺序 handoff
        const sorted = this.topologicalSort(tasks);
        for (const task of sorted) {
            const agent = agents.find((a) => a.id === task.assignedAgent) || agents[0];
            await this.executeTaskWithAgent(task, agent, results);
        }
    }
    async executeMagentic(tasks, results, agents) {
        // 自适应探索：先快速扫描，再深入
        const quickScan = tasks.slice(0, Math.ceil(tasks.length * 0.3));
        const deepDive = tasks.slice(Math.ceil(tasks.length * 0.3));
        // 快速扫描阶段
        await Promise.all(quickScan.map((task) => this.executeTask(task, results)));
        // 深入阶段
        for (const task of deepDive) {
            const agent = agents[Math.floor(Math.random() * agents.length)];
            await this.executeTaskWithAgent(task, agent, results);
        }
    }
    async executeConsensus(tasks, results, agents) {
        // 多模型投票
        for (const task of tasks) {
            const votes = [];
            // 并行让多个 agent 处理
            const votePromises = agents.slice(0, 3).map((agent) => this.getAgentVote(task, agent));
            const voteResults = await Promise.all(votePromises);
            // 统计投票结果
            task.result = this.aggregateVotes(voteResults);
            task.status = 'completed';
            results.set(task.id, task);
        }
    }
    async executeTask(task, results) {
        const defaultAgent = {
            id: 'default-agent',
            name: 'Default Agent',
            role: 'generalist',
            capabilities: ['coding', 'analysis', 'writing'],
            load: 0.5,
            successRate: 0.8,
            isAvailable: true,
        };
        const agent = this.agents.values().next().value || defaultAgent;
        await this.executeTaskWithAgent(task, agent, results);
    }
    async executeTaskWithAgent(task, agent, results) {
        try {
            // 更新 agent 负载 (ref-counted by max concurrent tasks)
            agent.load = Math.min(1, agent.load + 1 / Math.max(1, this.MAX_CONCURRENT_TASKS));
            task.status = 'running';
            task.assignedAgent = agent.id;
            // 模拟执行（实际会调用 LLM）
            await new Promise((resolve) => setTimeout(resolve, 100));
            // 检查是否需要重试
            if (task.retryCount > 0 && !task.result) {
                throw new Error('Task failed, retrying...');
            }
            task.status = 'completed';
            results.set(task.id, task);
        }
        catch (error) {
            if (task.retryCount < task.maxRetries) {
                task.retryCount++;
                task.status = 'pending';
                await this.executeTaskWithAgent(task, agent, results);
            }
            else {
                task.status = 'failed';
                task.error = error.message;
                results.set(task.id, task);
            }
        }
        finally {
            agent.load = Math.max(0, agent.load - 1 / Math.max(1, this.MAX_CONCURRENT_TASKS));
        }
    }
    async getAgentVote(task, agent) {
        // 模拟获取 agent 投票
        return { agentId: agent.id, vote: 'approve', confidence: 0.8 };
    }
    aggregateVotes(votes) {
        const approves = votes.filter((v) => v.vote === 'approve').length;
        const disapproves = votes.filter((v) => v.vote === 'disapprove').length;
        return {
            decision: approves > disapproves ? 'approved' : 'rejected',
            votes: votes,
            confidence: approves / votes.length,
        };
    }
    topologicalSort(tasks) {
        const sorted = [];
        const visited = new Set();
        const visiting = new Set();
        const taskMap = new Map(tasks.map((t) => [t.id, t]));
        const visit = (taskId) => {
            if (visited.has(taskId))
                return;
            if (visiting.has(taskId))
                throw new Error(`Circular dependency detected involving task: ${taskId}`);
            visiting.add(taskId);
            const task = taskMap.get(taskId);
            if (task) {
                task.dependencies.forEach((depId) => visit(depId));
                sorted.push(task);
            }
            visiting.delete(taskId);
            visited.add(taskId);
        };
        tasks.forEach((t) => visit(t.id));
        return sorted;
    }
    /**
     * 获取执行指标
     */
    getMetrics() {
        const tasks = Array.from(this.tasks.values());
        return {
            activeTasks: tasks.filter((t) => t.status === 'running').length,
            completedTasks: tasks.filter((t) => t.status === 'completed').length,
            failedTasks: tasks.filter((t) => t.status === 'failed').length,
            averageLoad: Array.from(this.agents.values()).reduce((sum, a) => sum + a.load, 0) /
                Math.max(1, this.agents.size),
            throughput: this.calculateThroughput(),
            latency: this.calculateAverageLatency(),
            successRate: this.calculateSuccessRate(),
        };
    }
    calculateThroughput() {
        // 简化的吞吐量计算
        const recent = this.executionHistory.slice(-10);
        if (recent.length === 0)
            return 0;
        return recent.reduce((sum, m) => sum + m.throughput, 0) / recent.length;
    }
    calculateAverageLatency() {
        const completed = Array.from(this.tasks.values()).filter((t) => t.status === 'completed');
        if (completed.length === 0)
            return 0;
        return 1000; // 简化：1秒
    }
    calculateSuccessRate() {
        const completed = Array.from(this.tasks.values()).filter((t) => t.status === 'completed' || t.status === 'failed');
        if (completed.length === 0)
            return 1;
        return completed.filter((t) => t.status === 'completed').length / completed.length;
    }
    /**
     * 自适应调整
     */
    adapt(plan) {
        const metrics = this.getMetrics();
        // 如果失败率高，降低并发
        if (metrics.successRate < this.ADAPTIVE_THRESHOLD) {
            plan.resourceAllocation.maxConcurrent = Math.max(1, plan.resourceAllocation.maxConcurrent - 1);
        }
        // 如果负载高，减少并发
        if (metrics.averageLoad > this.ADAPTIVE_THRESHOLD) {
            plan.resourceAllocation.maxConcurrent = Math.max(1, plan.resourceAllocation.maxConcurrent - 1);
        }
        return plan;
    }
    /**
     * 获取当前编排模式
     */
    getCurrentMode() {
        return this.mode;
    }
    /**
     * 获取 agent 列表
     */
    getAgents() {
        return Array.from(this.agents.values());
    }
    /**
     * 获取任务列表
     */
    getTasks() {
        return Array.from(this.tasks.values());
    }
}
exports.AdaptiveOrchestrator = AdaptiveOrchestrator;
// ========================================
// Factory
// ========================================
function createOrchestrator(mode) {
    return new AdaptiveOrchestrator();
}
