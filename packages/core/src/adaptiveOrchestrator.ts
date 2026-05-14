/**
 * Adaptive Orchestrator
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 * 
 * Core insight: 根据任务复杂度动态选择最优编排策略
 * - 实时监控执行状态
 * - 动态调整 agent 数量和资源分配
 * - 异常自动恢复和重试
 */

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ========================================
// Types
// ========================================

export type OrchestrationMode = 
  | 'SEQUENTIAL'      // 简单任务，单线程
  | 'PARALLEL'        // 独立子任务
  | 'HANDOFF'         // 需要专家
  | 'MAGENTIC'        // 开放式探索
  | 'CONSENSUS';      // 高风险决策

export interface Agent {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  load: number;         // 0-1, 当前负载
  successRate: number;  // 历史成功率
  isAvailable: boolean;
}

export interface Task {
  id: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  complexity: number;   // 0-100
  dependencies: string[]; // 依赖的 task IDs
  assignedAgent?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: any;
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
  estimatedDuration: number;  // seconds
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
  throughput: number;      // tasks per minute
  latency: number;         // average completion time
  successRate: number;
}

// ========================================
// Orchestrator Core
// ========================================

export class AdaptiveOrchestrator {
  private agents: Map<string, Agent> = new Map();
  private tasks: Map<string, Task> = new Map();
  private executionHistory: ExecutionMetrics[] = [];
  private mode: OrchestrationMode = 'SEQUENTIAL';
  
  // Configuration
  private readonly MAX_CONCURRENT_TASKS = 5;
  private readonly TASK_TIMEOUT_MS = 300000; // 5 minutes
  private readonly ADAPTIVE_THRESHOLD = 0.8;

  /**
   * 注册 agent
   */
  registerAgent(agent: Omit<Agent, 'load' | 'successRate' | 'isAvailable'>): string {
    const id = agent.id || generateUUID();
    this.agents.set(id, {
      ...agent,
      load: 0,
      successRate: 1.0,
      isAvailable: true
    });
    return id;
  }

  /**
   * 创建编排计划
   */
  createPlan(tasks: Task[], suggestedMode?: OrchestrationMode): OrchestrationPlan {
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
    tasks.forEach(task => {
      if (!task.id) task.id = generateUUID();
      this.tasks.set(task.id, { ...task, status: 'pending' });
    });

    return {
      id: generateUUID(),
      mode,
      tasks: Array.from(this.tasks.values()),
      agents: selectedAgents,
      resourceAllocation,
      estimatedDuration,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 确定编排模式
   */
  private determineMode(tasks: Task[]): OrchestrationMode {
    if (tasks.length === 0) return 'SEQUENTIAL';

    const avgComplexity = tasks.reduce((sum, t) => sum + t.complexity, 0) / tasks.length;
    const hasDependencies = tasks.some(t => t.dependencies.length > 0);
    const highPriorityCount = tasks.filter(t => t.priority === 'critical' || t.priority === 'high').length;

    // 高风险决策
    if (avgComplexity > 80) return 'CONSENSUS';
    
    // 开放式探索
    if (avgComplexity > 60 && !hasDependencies) return 'MAGENTIC';
    
    // 需要专家
    if (avgComplexity > 50 && tasks.some(t => t.complexity > 70)) return 'HANDOFF';
    
    // 有依赖关系
    if (hasDependencies && avgComplexity > 30) return 'HANDOFF';
    
    // 高优先级且复杂
    if (highPriorityCount > tasks.length * 0.3 && avgComplexity > 40) return 'PARALLEL';
    
    // 简单并行
    if (!hasDependencies && avgComplexity < 30) return 'PARALLEL';
    
    // 默认顺序
    return 'SEQUENTIAL';
  }

  /**
   * 选择合适的 agents
   */
  private selectAgents(tasks: Task[], mode: OrchestrationMode): Agent[] {
    const availableAgents = Array.from(this.agents.values())
      .filter(a => a.isAvailable && a.load < 0.9)
      .sort((a, b) => b.successRate - a.successRate);

    if (availableAgents.length === 0) {
      // 创建虚拟 agent 用于演示
      return [{
        id: 'default-agent',
        name: 'Default Agent',
        role: 'generalist',
        capabilities: ['coding', 'analysis', 'writing'],
        load: 0.5,
        successRate: 0.8,
        isAvailable: true
      }];
    }

    const agentCount = this.calculateAgentCount(tasks.length, mode);
    return availableAgents.slice(0, agentCount);
  }

  /**
   * 计算需要的 agent 数量
   */
  private calculateAgentCount(taskCount: number, mode: OrchestrationMode): number {
    switch (mode) {
      case 'CONSENSUS': return Math.min(3, Math.max(2, Math.ceil(taskCount / 2)));
      case 'MAGENTIC': return Math.min(5, Math.max(2, Math.ceil(taskCount / 3)));
      case 'PARALLEL': return Math.min(this.MAX_CONCURRENT_TASKS, Math.max(2, Math.ceil(taskCount / 2)));
      case 'HANDOFF': return Math.min(4, Math.max(2, Math.ceil(taskCount / 3)));
      case 'SEQUENTIAL': return 1;
      default: return 1;
    }
  }

  /**
   * 分配资源
   */
  private allocateResources(mode: OrchestrationMode, agentCount: number): ResourceAllocation {
    const baseBudget = 100000; // 基础 token 预算

    switch (mode) {
      case 'SEQUENTIAL':
        return {
          leadAgentId: this.agents.values().next().value?.id,
          specialistAgentIds: [],
          maxConcurrent: 1,
          tokenBudget: { lead: baseBudget, specialists: 0, evaluation: 5000, overhead: 2000 }
        };

      case 'PARALLEL':
        return {
          leadAgentId: this.agents.values().next().value?.id,
          specialistAgentIds: Array.from(this.agents.values()).slice(1, agentCount).map(a => a.id),
          maxConcurrent: Math.min(this.MAX_CONCURRENT_TASKS, agentCount),
          tokenBudget: {
            lead: baseBudget * 0.3,
            specialists: baseBudget * 0.5,
            evaluation: baseBudget * 0.15,
            overhead: baseBudget * 0.05
          }
        };

      case 'HANDOFF':
        return {
          leadAgentId: this.agents.values().next().value?.id,
          specialistAgentIds: Array.from(this.agents.values()).slice(1, agentCount).map(a => a.id),
          maxConcurrent: Math.min(3, agentCount),
          tokenBudget: {
            lead: baseBudget * 0.35,
            specialists: baseBudget * 0.45,
            evaluation: baseBudget * 0.15,
            overhead: baseBudget * 0.05
          }
        };

      case 'MAGENTIC':
        return {
          leadAgentId: this.agents.values().next().value?.id,
          specialistAgentIds: Array.from(this.agents.values()).slice(1, agentCount).map(a => a.id),
          maxConcurrent: Math.min(4, agentCount),
          tokenBudget: {
            lead: baseBudget * 0.4,
            specialists: baseBudget * 0.35,
            evaluation: baseBudget * 0.15,
            overhead: baseBudget * 0.1
          }
        };

      case 'CONSENSUS':
        return {
          leadAgentId: this.agents.values().next().value?.id,
          specialistAgentIds: Array.from(this.agents.values()).slice(1, agentCount).map(a => a.id),
          maxConcurrent: 1, // 顺序执行但多模型投票
          tokenBudget: {
            lead: baseBudget * 0.3,
            specialists: baseBudget * 0.3,
            evaluation: baseBudget * 0.35,
            overhead: baseBudget * 0.05
          }
        };
    }
  }

  /**
   * 估算执行时间
   */
  private estimateDuration(tasks: Task[], mode: OrchestrationMode): number {
    const avgTaskDuration = 60000; // 1 minute base
    const complexityFactor = tasks.reduce((sum, t) => sum + t.complexity, 0) / tasks.length / 50;
    
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
  async execute(plan: OrchestrationPlan): Promise<Map<string, Task>> {
    const results = new Map<string, Task>();

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

    return results;
  }

  private async executeSequential(tasks: Task[], results: Map<string, Task>): Promise<void> {
    for (const task of tasks) {
      await this.executeTask(task, results);
    }
  }

  private async executeParallel(
    tasks: Task[],
    results: Map<string, Task>,
    maxConcurrent: number
  ): Promise<void> {
    const batches: Task[][] = [];
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      batches.push(tasks.slice(i, i + maxConcurrent));
    }

    for (const batch of batches) {
      await Promise.all(batch.map(task => this.executeTask(task, results)));
    }
  }

  private async executeHandoff(
    tasks: Task[],
    results: Map<string, Task>,
    agents: Agent[]
  ): Promise<void> {
    // 按依赖顺序 handoff
    const sorted = this.topologicalSort(tasks);
    
    for (const task of sorted) {
      const agent = agents.find(a => a.id === task.assignedAgent) || agents[0];
      await this.executeTaskWithAgent(task, agent, results);
    }
  }

  private async executeMagentic(
    tasks: Task[],
    results: Map<string, Task>,
    agents: Agent[]
  ): Promise<void> {
    // 自适应探索：先快速扫描，再深入
    const quickScan = tasks.slice(0, Math.ceil(tasks.length * 0.3));
    const deepDive = tasks.slice(Math.ceil(tasks.length * 0.3));

    // 快速扫描阶段
    await Promise.all(quickScan.map(task => this.executeTask(task, results)));

    // 深入阶段
    for (const task of deepDive) {
      const agent = agents[Math.floor(Math.random() * agents.length)];
      await this.executeTaskWithAgent(task, agent, results);
    }
  }

  private async executeConsensus(
    tasks: Task[],
    results: Map<string, Task>,
    agents: Agent[]
  ): Promise<void> {
    // 多模型投票
    for (const task of tasks) {
      const votes: any[] = [];
      
      // 并行让多个 agent 处理
      const votePromises = agents.slice(0, 3).map(agent => 
        this.getAgentVote(task, agent)
      );
      
      const voteResults = await Promise.all(votePromises);
      
      // 统计投票结果
      task.result = this.aggregateVotes(voteResults);
      task.status = 'completed';
      results.set(task.id, task);
    }
  }

  private async executeTask(task: Task, results: Map<string, Task>): Promise<void> {
    const defaultAgent: Agent = {
      id: 'default-agent',
      name: 'Default Agent',
      role: 'generalist',
      capabilities: ['coding', 'analysis', 'writing'],
      load: 0.5,
      successRate: 0.8,
      isAvailable: true
    };
    const agent = this.agents.values().next().value || defaultAgent;
    await this.executeTaskWithAgent(task, agent, results);
  }

  private async executeTaskWithAgent(
    task: Task,
    agent: Agent,
    results: Map<string, Task>
  ): Promise<void> {
    try {
      // 更新 agent 负载
      agent.load = Math.min(1, agent.load + 0.2);
      
      task.status = 'running';
      task.assignedAgent = agent.id;
      
      // 模拟执行（实际会调用 LLM）
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 检查是否需要重试
      if (task.retryCount > 0 && !task.result) {
        throw new Error('Task failed, retrying...');
      }

      task.status = 'completed';
      results.set(task.id, task);
    } catch (error) {
      if (task.retryCount < task.maxRetries) {
        task.retryCount++;
        task.status = 'pending';
        await this.executeTaskWithAgent(task, agent, results);
      } else {
        task.status = 'failed';
        task.error = (error as Error).message;
        results.set(task.id, task);
      }
    } finally {
      agent.load = Math.max(0, agent.load - 0.2);
    }
  }

  private async getAgentVote(task: Task, agent: Agent): Promise<any> {
    // 模拟获取 agent 投票
    return { agentId: agent.id, vote: 'approve', confidence: 0.8 };
  }

  private aggregateVotes(votes: any[]): any {
    const approves = votes.filter(v => v.vote === 'approve').length;
    const disapproves = votes.filter(v => v.vote === 'disapprove').length;
    
    return {
      decision: approves > disapproves ? 'approved' : 'rejected',
      votes: votes,
      confidence: approves / votes.length
    };
  }

  private topologicalSort(tasks: Task[]): Task[] {
    const sorted: Task[] = [];
    const visited = new Set<string>();
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    const visit = (taskId: string) => {
      if (visited.has(taskId)) return;
      visited.add(taskId);
      
      const task = taskMap.get(taskId);
      if (task) {
        task.dependencies.forEach(depId => visit(depId));
        sorted.push(task);
      }
    };

    tasks.forEach(t => visit(t.id));
    return sorted;
  }

  /**
   * 获取执行指标
   */
  getMetrics(): ExecutionMetrics {
    const tasks = Array.from(this.tasks.values());
    
    return {
      activeTasks: tasks.filter(t => t.status === 'running').length,
      completedTasks: tasks.filter(t => t.status === 'completed').length,
      failedTasks: tasks.filter(t => t.status === 'failed').length,
      averageLoad: Array.from(this.agents.values()).reduce((sum, a) => sum + a.load, 0) / Math.max(1, this.agents.size),
      throughput: this.calculateThroughput(),
      latency: this.calculateAverageLatency(),
      successRate: this.calculateSuccessRate()
    };
  }

  private calculateThroughput(): number {
    // 简化的吞吐量计算
    const recent = this.executionHistory.slice(-10);
    if (recent.length === 0) return 0;
    return recent.reduce((sum, m) => sum + m.throughput, 0) / recent.length;
  }

  private calculateAverageLatency(): number {
    const completed = Array.from(this.tasks.values()).filter(t => t.status === 'completed');
    if (completed.length === 0) return 0;
    return 1000; // 简化：1秒
  }

  private calculateSuccessRate(): number {
    const completed = Array.from(this.tasks.values()).filter(t => 
      t.status === 'completed' || t.status === 'failed'
    );
    if (completed.length === 0) return 1;
    return completed.filter(t => t.status === 'completed').length / completed.length;
  }

  /**
   * 自适应调整
   */
  adapt(plan: OrchestrationPlan): OrchestrationPlan {
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
  getCurrentMode(): OrchestrationMode {
    return this.mode;
  }

  /**
   * 获取 agent 列表
   */
  getAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * 获取任务列表
   */
  getTasks(): Task[] {
    return Array.from(this.tasks.values());
  }
}

// ========================================
// Factory
// ========================================

export function createOrchestrator(mode?: OrchestrationMode): AdaptiveOrchestrator {
  return new AdaptiveOrchestrator();
}