/**
 * Deterministic Task Allocator
 * 
 * 防止多个 Agent 争抢同一任务的关键组件。
 * 使用 Task ID + Owner + Release 协议确保任务分配的唯一性。
 * 
 * 来源: Galileo AI "10 Multi-Agent Coordination Strategies" (2025)
 * 核心问题: Agent 争抢同一任务 → 解决方案: 明确任务所有权
 */

// ==================== 类型定义 ====================

/**
 * 任务分配记录
 */
export interface TaskAllocation {
  taskId: string;
  ownerId: string;           // Agent ID
  ownerRole: string;         // Agent 角色 (planner, executor, reviewer, etc.)
  allocatedAt: Date;
  expiresAt: Date;           // 分配超时时间
  status: AllocationStatus;
  priority: TaskPriority;
  dependencies?: string[];   // 依赖的任务 ID
  metadata?: Record<string, unknown>;
}

/**
 * 分配状态
 */
export type AllocationStatus = 
  | 'pending'     // 等待分配
  | 'allocated'   // 已分配，进行中
  | 'completed'   // 已完成
  | 'failed'      // 失败
  | 'released';   // 已释放

/**
 * 任务优先级
 */
export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * 分配请求
 */
export interface AllocationRequest {
  taskId: string;
  agentId: string;
  agentRole: string;
  priority?: TaskPriority;
  timeoutMs?: number;        // 分配超时（默认 30 分钟）
  dependencies?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * 分配结果
 */
export interface AllocationResult {
  success: boolean;
  allocation?: TaskAllocation;
  error?: string;
  retryAfter?: number;       // 如果被占用，建议重试时间
}

/**
 * 释放请求
 */
export interface ReleaseRequest {
  taskId: string;
  ownerId: string;
  reason: 'completed' | 'failed' | 'timeout' | 'manual';
  result?: unknown;
}

/**
 * 释放结果
 */
export interface ReleaseResult {
  success: boolean;
  error?: string;
}

/**
 * 任务队列状态
 */
export interface TaskQueueStatus {
  totalAllocations: number;
  activeAllocations: number;
  pendingAllocations: number;
  completedAllocations: number;
  failedAllocations: number;
  agentWorkloads: Map<string, number>;
}

// ==================== 配置 ====================

export interface TaskAllocatorConfig {
  defaultTimeoutMs: number;      // 默认分配超时
  maxAllocationsPerAgent: number; // 单个 Agent 最大任务数
  cleanupIntervalMs: number;      // 清理过期分配的间隔
  enablePriorityQueue: boolean;   // 是否启用优先级队列
}

const DEFAULT_CONFIG: TaskAllocatorConfig = {
  defaultTimeoutMs: 30 * 60 * 1000, // 30 分钟
  maxAllocationsPerAgent: 5,
  cleanupIntervalMs: 60 * 1000,      // 1 分钟
  enablePriorityQueue: true,
};

// ==================== 主类 ====================

/**
 * 确定性任务分配器
 * 
 * 核心机制:
 * 1. Task ID 唯一性 - 每个任务有全局唯一 ID
 * 2. Owner 声明 - 分配时明确指定 owner
 * 3. Release 协议 - 完成后必须显式释放
 * 4. 超时保护 - 自动释放过期的分配
 */
export class DeterministicTaskAllocator {
  private allocations: Map<string, TaskAllocation> = new Map();
  private agentAllocations: Map<string, Set<string>> = new Map();
  private config: TaskAllocatorConfig;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: Partial<TaskAllocatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTimer();
  }

  // ==================== 核心操作 ====================

  /**
   * 尝试分配任务
   * 
   * @returns AllocationResult - 分配结果（成功或失败原因）
   */
  allocate(request: AllocationRequest): AllocationResult {
    const { taskId, agentId, agentRole, priority = 'normal', timeoutMs, dependencies, metadata } = request;

    // 1. 检查任务是否已被分配
    const existing = this.allocations.get(taskId);
    if (existing && existing.status === 'allocated') {
      return {
        success: false,
        error: 'TASK_ALREADY_ALLOCATED',
        retryAfter: this.getTimeUntilExpiry(existing),
      };
    }

    // 2. 检查 Agent 是否已达到最大任务数
    const agentTasks = this.agentAllocations.get(agentId);
    if (agentTasks && agentTasks.size >= this.config.maxAllocationsPerAgent) {
      return {
        success: false,
        error: 'AGENT_AT_CAPACITY',
        retryAfter: this.getShortestExpiryTime(agentId),
      };
    }

    // 3. 检查依赖是否满足
    if (dependencies && dependencies.length > 0) {
      const unsatisfiedDeps = this.checkDependencies(dependencies);
      if (unsatisfiedDeps.length > 0) {
        return {
          success: false,
          error: 'DEPENDENCIES_NOT_MET',
          allocation: {
            taskId,
            ownerId: agentId,
            ownerRole: agentRole,
            allocatedAt: new Date(),
            expiresAt: new Date(Date.now() + (timeoutMs || this.config.defaultTimeoutMs)),
            status: 'pending',
            priority,
            dependencies,
            metadata,
          },
        };
      }
    }

    // 4. 创建分配记录
    const now = new Date();
    const allocation: TaskAllocation = {
      taskId,
      ownerId: agentId,
      ownerRole: agentRole,
      allocatedAt: now,
      expiresAt: new Date(now.getTime() + (timeoutMs || this.config.defaultTimeoutMs)),
      status: 'allocated',
      priority,
      dependencies,
      metadata,
    };

    // 5. 记录分配
    this.allocations.set(taskId, allocation);
    
    // 6. 更新 Agent 任务集合
    if (!this.agentAllocations.has(agentId)) {
      this.agentAllocations.set(agentId, new Set());
    }
    this.agentAllocations.get(agentId)!.add(taskId);

    return { success: true, allocation };
  }

  /**
   * 释放任务
   */
  release(request: ReleaseRequest): ReleaseResult {
    const { taskId, ownerId, reason, result } = request;

    // 1. 检查任务是否存在
    const allocation = this.allocations.get(taskId);
    if (!allocation) {
      return { success: false, error: 'TASK_NOT_FOUND' };
    }

    // 2. 检查所有权
    if (allocation.ownerId !== ownerId) {
      return { success: false, error: 'NOT_OWNER' };
    }

    // 3. 更新状态
    allocation.status = reason === 'completed' ? 'completed' : 
                         reason === 'failed' ? 'failed' : 'released';
    (allocation as any).releasedAt = new Date();
    (allocation as any).releaseReason = reason;
    if (result !== undefined) {
      (allocation as any).result = result;
    }

    // 4. 从 Agent 任务集合中移除
    const agentTasks = this.agentAllocations.get(ownerId);
    if (agentTasks) {
      agentTasks.delete(taskId);
      if (agentTasks.size === 0) {
        this.agentAllocations.delete(ownerId);
      }
    }

    return { success: true };
  }

  /**
   * 强制释放任务（管理员操作）
   */
  forceRelease(taskId: string, reason: string = 'forced'): ReleaseResult {
    const allocation = this.allocations.get(taskId);
    if (!allocation) {
      return { success: false, error: 'TASK_NOT_FOUND' };
    }

    const agentTasks = this.agentAllocations.get(allocation.ownerId);
    if (agentTasks) {
      agentTasks.delete(taskId);
      if (agentTasks.size === 0) {
        this.agentAllocations.delete(allocation.ownerId);
      }
    }

    allocation.status = 'released';
    (allocation as any).releasedAt = new Date();
    (allocation as any).releaseReason = reason;

    return { success: true };
  }

  // ==================== 查询操作 ====================

  /**
   * 获取任务分配信息
   */
  getAllocation(taskId: string): TaskAllocation | undefined {
    return this.allocations.get(taskId);
  }

  /**
   * 检查任务是否可分配
   */
  isAllocatable(taskId: string): boolean {
    const allocation = this.allocations.get(taskId);
    if (!allocation) return true;
    return allocation.status !== 'allocated';
  }

  /**
   * 获取 Agent 的所有活跃任务
   */
  getAgentTasks(agentId: string): TaskAllocation[] {
    const taskIds = this.agentAllocations.get(agentId);
    if (!taskIds) return [];
    
    return Array.from(taskIds)
      .map(id => this.allocations.get(id))
      .filter((a): a is TaskAllocation => a !== undefined && a.status === 'allocated');
  }

  /**
   * 获取 Agent 的工作负载
   */
  getAgentWorkload(agentId: string): number {
    const tasks = this.agentAllocations.get(agentId);
    return tasks ? tasks.size : 0;
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): TaskQueueStatus {
    let activeAllocations = 0;
    let pendingAllocations = 0;
    let completedAllocations = 0;
    let failedAllocations = 0;
    const agentWorkloads = new Map<string, number>();

    for (const allocation of this.allocations.values()) {
      switch (allocation.status) {
        case 'allocated': activeAllocations++; break;
        case 'pending': pendingAllocations++; break;
        case 'completed': completedAllocations++; break;
        case 'failed': failedAllocations++; break;
      }
      agentWorkloads.set(allocation.ownerId, 
        (agentWorkloads.get(allocation.ownerId) || 0) + 1);
    }

    return {
      totalAllocations: this.allocations.size,
      activeAllocations,
      pendingAllocations,
      completedAllocations,
      failedAllocations,
      agentWorkloads,
    };
  }

  /**
   * 获取待分配任务（依赖已满足）
   */
  getPendingTasks(): TaskAllocation[] {
    return Array.from(this.allocations.values())
      .filter(a => a.status === 'pending')
      .filter(a => {
        if (!a.dependencies || a.dependencies.length === 0) return true;
        return this.checkDependencies(a.dependencies).length === 0;
      });
  }

  // ==================== 辅助方法 ====================

  /**
   * 检查依赖是否满足
   * @returns 未满足的依赖列表
   */
  private checkDependencies(dependencies: string[]): string[] {
    return dependencies.filter(depId => {
      const dep = this.allocations.get(depId);
      return !dep || dep.status !== 'completed';
    });
  }

  /**
   * 获取分配剩余时间
   */
  private getTimeUntilExpiry(allocation: TaskAllocation): number {
    const remaining = allocation.expiresAt.getTime() - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * 获取 Agent 最短任务剩余时间
   */
  private getShortestExpiryTime(agentId: string): number {
    const tasks = this.getAgentTasks(agentId);
    if (tasks.length === 0) return 0;
    
    const expiryTimes = tasks.map(t => this.getTimeUntilExpiry(t));
    return Math.min(...expiryTimes);
  }

  /**
   * 清理过期分配
   */
  private cleanupExpiredAllocations(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [taskId, allocation] of this.allocations) {
      if (allocation.status === 'allocated' && allocation.expiresAt.getTime() < now) {
        expired.push(taskId);
      }
    }

    for (const taskId of expired) {
      this.forceRelease(taskId, 'timeout');
    }

    if (expired.length > 0) {
      console.log(`[DeterministicTaskAllocator] Cleaned up ${expired.length} expired allocations`);
    }
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredAllocations();
    }, this.config.cleanupIntervalMs);
  }

  /**
   * 停止清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 销毁分配器
   */
  destroy(): void {
    this.stopCleanupTimer();
    this.allocations.clear();
    this.agentAllocations.clear();
  }
}

// ==================== 导出单例 ====================

let globalAllocator: DeterministicTaskAllocator | null = null;

/**
 * 获取全局任务分配器实例
 */
export function getTaskAllocator(config?: Partial<TaskAllocatorConfig>): DeterministicTaskAllocator {
  if (!globalAllocator) {
    globalAllocator = new DeterministicTaskAllocator(config);
  }
  return globalAllocator;
}

/**
 * 重置全局分配器（用于测试）
 */
export function resetTaskAllocator(): void {
  if (globalAllocator) {
    globalAllocator.destroy();
    globalAllocator = null;
  }
}
