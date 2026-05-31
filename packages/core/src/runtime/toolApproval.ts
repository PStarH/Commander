/**
 * ToolApproval — tool approval system.
 *
 * Inspired by OpenClaw's tool approval flow and Hermes's approval.py
 * dangerous-command interception, but Commander goes further:
 * 1. Multi-level approval (auto / semi-auto / manual)
 * 2. Risk-based dynamic approval policies
 * 3. Approval context is passed to the model so it understands why it must wait
 */

import { getGlobalLogger } from '../logging';

// ============================================================================
// Approval levels
// ============================================================================

/** Approval level applied to a tool invocation. */
export type ApprovalLevel = 'auto' | 'semi_auto' | 'manual';

/**
 * Approval policy for matching tool names and deciding whether approval is needed.
 */
export interface ApprovalPolicy {
  /** Tool name or pattern (supports wildcard *). */
  pattern: string | RegExp;
  /** Approval level. */
  level: ApprovalLevel;
  /** Risk level. */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Description. */
  description: string;
  /** Auto-approval conditions (used only for semi_auto). */
  autoApproveIf?: {
    /** Argument matching conditions. */
    argsMatch?: Record<string, unknown>;
    /** User roles. */
    userRole?: string[];
    /** Environment conditions. */
    env?: Record<string, string>;
  };
  /** Timeout in milliseconds (manual only), default 60s. */
  timeoutMs?: number;
  /** Maximum wait count. */
  maxWaitCount?: number;
}

// ============================================================================
// Default approval policies
// ============================================================================

export const DEFAULT_APPROVAL_POLICIES: ApprovalPolicy[] = [
  // 危险命令 — 总是需要手动审批
  {
    pattern: 'shell_execute',
    level: 'manual',
    riskLevel: 'critical',
    description: 'Shell command execution requires manual approval',
  },
  {
    pattern: 'python_execute',
    level: 'semi_auto',
    riskLevel: 'high',
    description: 'Python code execution',
    autoApproveIf: {
      argsMatch: { timeout: { $lte: 10000 } },
    },
  },
  {
    pattern: 'file_write',
    level: 'semi_auto',
    riskLevel: 'medium',
    description: 'File modification requires approval for system paths',
    autoApproveIf: {
      argsMatch: { path: { $not: /^\/(etc|usr|var|system)/ } },
    },
  },
  {
    pattern: 'file_edit',
    level: 'semi_auto',
    riskLevel: 'medium',
    description: 'File editing requires approval',
  },
  // 安全工具 — 自动审批
  {
    pattern: 'web_search',
    level: 'auto',
    riskLevel: 'low',
    description: 'Web search is safe to auto-approve',
  },
  {
    pattern: 'web_fetch',
    level: 'auto',
    riskLevel: 'low',
    description: 'Web fetch is safe to auto-approve',
  },
  {
    pattern: 'browser_search',
    level: 'auto',
    riskLevel: 'low',
    description: 'Browser search is safe to auto-approve',
  },
  {
    pattern: 'memory_*',
    level: 'auto',
    riskLevel: 'low',
    description: 'Memory operations are safe',
  },
  // 代理工具 — 半自动
  {
    pattern: 'agent',
    level: 'semi_auto',
    riskLevel: 'high',
    description: 'Sub-agent spawning requires approval',
    autoApproveIf: {
      argsMatch: { tools: { $length: { $lte: 5 } } },
    },
  },
  // Git 操作 — 根据类型分级
  {
    pattern: 'git_push',
    level: 'manual',
    riskLevel: 'critical',
    description: 'Git push requires explicit approval',
  },
  {
    pattern: 'git_commit',
    level: 'semi_auto',
    riskLevel: 'medium',
    description: 'Git commit is semi-automatic',
  },
  {
    pattern: 'git',
    level: 'auto',
    riskLevel: 'low',
    description: 'Git read operations are auto-approved',
  },
];

// ============================================================================
// Approval requests & results
// ============================================================================

export interface ApprovalRequest {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  policy: ApprovalPolicy;
  requestTime: string;
  timeoutAt?: string;
  reason?: string;
  /** 审批等待次数 */
  waitCount: number;
}

/** Result returned after an approval decision is made. */
export interface ApprovalResult {
  approved: boolean;
  requestId: string;
  approvedAt: string;
  reason?: string;
  alternativeAction?: string;
}

// ============================================================================
// 审批管理器
// ============================================================================

export type ApprovalCallback = (
  request: ApprovalRequest,
) => Promise<ApprovalResult> | ApprovalResult;

export class ToolApproval {
  private policies: Map<string, ApprovalPolicy> = new Map();
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private approvalCallback: ApprovalCallback;
  private autoApproveCallback?: ApprovalCallback;
  private decisionHistory: Array<{
    requestId: string;
    toolName: string;
    approved: boolean;
    level: ApprovalLevel;
    timestamp: string;
  }> = [];

  constructor(
    approvalCallback: ApprovalCallback,
    autoApproveCallback?: ApprovalCallback,
  ) {
    this.approvalCallback = approvalCallback;
    this.autoApproveCallback = autoApproveCallback;
    this.initializeDefaultPolicies();
  }

  /**
   * 初始化默认审批策略
   */
  private initializeDefaultPolicies(): void {
    for (const policy of DEFAULT_APPROVAL_POLICIES) {
      this.addPolicy(policy);
    }
  }

  /**
   * 添加自定义审批策略
   */
  addPolicy(policy: ApprovalPolicy): void {
    const key = typeof policy.pattern === 'string' ? policy.pattern : policy.pattern.toString();
    this.policies.set(key, policy);
  }

  /**
   * 移除审批策略
   */
  removePolicy(pattern: string | RegExp): void {
    const key = typeof pattern === 'string' ? pattern : pattern.toString();
    this.policies.delete(key);
  }

  /**
   * 查找匹配的审批策略
   */
  private findPolicy(toolName: string): ApprovalPolicy | undefined {
    for (const [, policy] of this.policies) {
      if (typeof policy.pattern === 'string') {
        // 支持通配符
        if (policy.pattern.endsWith('*')) {
          if (toolName.startsWith(policy.pattern.slice(0, -1))) {
            return policy;
          }
        } else if (toolName === policy.pattern) {
          return policy;
        }
      } else {
        // RegExp
        if (policy.pattern.test(toolName)) {
          return policy;
        }
      }
    }
    return undefined;
  }

  /**
   * 检查参数是否匹配自动审批条件
   */
  private checkAutoApproveConditions(
    policy: ApprovalPolicy,
    args: Record<string, unknown>,
  ): boolean {
    if (!policy.autoApproveIf) return false;
    if (policy.level !== 'semi_auto') return false;

    const conditions = policy.autoApproveIf;

    // 检查参数匹配
    if (conditions.argsMatch) {
      for (const [key, expected] of Object.entries(conditions.argsMatch)) {
        const actual = args[key];
        if (typeof expected === 'object' && expected !== null) {
          const opArgs = expected as { $lte?: number; $not?: RegExp; $length?: number };
          // 处理操作符条件
          if ('$lte' in expected) {
            if (typeof actual !== 'number' || actual > opArgs.$lte!) {
              return false;
            }
          }
          if ('$not' in expected) {
            if (typeof actual === 'string' && opArgs.$not instanceof RegExp) {
              if (opArgs.$not.test(actual)) return false;
            }
          }
          if ('$length' in expected) {
            if (Array.isArray(actual) && actual.length > opArgs.$length!) {
              return false;
            }
          }
        } else if (actual !== expected) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * 请求审批 — 核心方法
   * 在工具执行前调用
   */
async requestApproval(
     toolName: string,
     args: Record<string, unknown>,
     context?: {
       agentId?: string;
       runId?: string;
       reason?: string;
     },
   ): Promise<ApprovalResult> {
     const policy = this.findPolicy(toolName);

     // 没有匹配的策略 — 默认自动通过
     if (!policy) {
       return {
         approved: true,
         requestId: `auto-${Date.now()}-${toolName}`,
         approvedAt: new Date().toISOString(),
         reason: 'No policy found, auto-approved',
       };
     }

     // 自动审批级别
     if (policy.level === 'auto') {
       this.recordDecision(toolName, true, policy.level);
       return {
         approved: true,
         requestId: `auto-${Date.now()}-${toolName}`,
         approvedAt: new Date().toISOString(),
         reason: 'Auto-approved by policy',
       };
     }

     const requestId = `req-${Date.now()}-${toolName}-${Math.random().toString(36).slice(2, 6)}`;
     const now = new Date().toISOString();

     // 半自动审批 — 先检查自动条件
     if (policy.level === 'semi_auto') {
       const autoApproved = this.checkAutoApproveConditions(policy, args);
       if (autoApproved) {
         this.recordDecision(toolName, true, policy.level);
         return {
           approved: true,
           requestId,
           approvedAt: now,
           reason: 'Auto-approved: conditions met',
         };
       }

       // 检查等待次数是否超限
       const existingRequest = this.pendingApprovals.get(
         `${toolName}:${context?.runId ?? 'global'}`
       );
       if (existingRequest && existingRequest.waitCount >= (policy.maxWaitCount ?? 3)) {
         this.recordDecision(toolName, false, policy.level);
         return {
           approved: false,
           requestId,
           approvedAt: now,
           reason: `Max wait count (${policy.maxWaitCount ?? 3}) exceeded`,
           alternativeAction: 'Try a different approach or simplify the operation',
         };
       }
     }

    // 手动审批或半自动审批需要人工确认
    if (policy.level === 'manual' || policy.level === 'semi_auto') {
      const pendingKey = `${toolName}:${context?.runId ?? 'global'}`;
      const existingRequest = this.pendingApprovals.get(pendingKey);
      const waitCount = existingRequest ? existingRequest.waitCount + 1 : 0;

      const approvalRequest: ApprovalRequest = {
        id: requestId,
        toolName,
        arguments: args,
        policy,
        requestTime: now,
        timeoutAt: policy.timeoutMs
          ? new Date(Date.now() + policy.timeoutMs).toISOString()
          : undefined,
        reason: context?.reason,
        waitCount,
      };

      // For non-interactive mode with a callback that always approves, call it directly
      try {
        const result = await this.approvalCallback(approvalRequest);
        this.pendingApprovals.set(pendingKey, approvalRequest);
        this.pruneStaleApprovals();
        this.recordDecision(toolName, result.approved, policy.level);
        return result;
      } catch (e) {
        getGlobalLogger().warn('ToolApproval', 'Approval callback failed', { error: (e as Error)?.message, toolName });
        // If callback fails, store as pending and return approval_failed
        this.pendingApprovals.set(pendingKey, approvalRequest);
        this.pruneStaleApprovals();
        this.recordDecision(toolName, false, policy.level);
        return {
          approved: false,
          requestId,
          approvedAt: new Date().toISOString(),
          reason: `Approval callback error for ${toolName}`,
        };
      }
    }

    // 默认拒绝（fallback for unrecognized levels）
    this.recordDecision(toolName, false, policy.level);
    return {
      approved: false,
      requestId,
      approvedAt: now,
      reason: 'No matching approval policy configuration',
    };
  }

  /**
   * 记录审批决策
   */
  private recordDecision(toolName: string, approved: boolean, level: ApprovalLevel): void {
    this.decisionHistory.push({
      requestId: `decision-${Date.now()}-${toolName}`,
      toolName,
      approved,
      level,
      timestamp: new Date().toISOString(),
    });

    // 限制历史记录大小
    if (this.decisionHistory.length > 1000) {
      this.decisionHistory = this.decisionHistory.slice(-500);
    }
  }

  /**
   * 获取审批统计
   */
  getStats() {
    const total = this.decisionHistory.length;
    if (total === 0) return { total: 0, approved: 0, rejected: 0, approvalRate: 0 };

    let approved = 0;
    for (const d of this.decisionHistory) {
      if (d.approved) approved++;
    }
    return {
      total,
      approved,
      rejected: total - approved,
      approvalRate: approved / total,
      byLevel: this.groupByLevel(),
    };
  }

  private groupByLevel() {
    const groups: Record<ApprovalLevel, { total: number; approved: number }> = {
      auto: { total: 0, approved: 0 },
      semi_auto: { total: 0, approved: 0 },
      manual: { total: 0, approved: 0 },
    };
    for (const d of this.decisionHistory) {
      groups[d.level].total++;
      if (d.approved) groups[d.level].approved++;
    }
    return groups;
  }

  /**
   * 获取待处理的审批请求
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * 手动批准待处理的请求
   */
  async approvePending(requestId: string): Promise<boolean> {
    for (const [key, request] of this.pendingApprovals) {
      if (request.id === requestId) {
        this.pendingApprovals.delete(key);
        this.recordDecision(request.toolName, true, request.policy.level);
        return true;
      }
    }
    return false;
  }

  /**
   * 手动拒绝待处理的请求
   */
  async rejectPending(requestId: string, reason?: string): Promise<boolean> {
    for (const [key, request] of this.pendingApprovals) {
      if (request.id === requestId) {
        this.pendingApprovals.delete(key);
        this.recordDecision(request.toolName, false, request.policy.level);
        return true;
      }
    }
    return false;
  }

  private static readonly MAX_PENDING = 200;

  private pruneStaleApprovals(): void {
    if (this.pendingApprovals.size <= ToolApproval.MAX_PENDING) return;
    const now = Date.now();
    // Remove expired entries first
    for (const [key, req] of this.pendingApprovals) {
      if (req.timeoutAt && new Date(req.timeoutAt).getTime() < now) {
        this.pendingApprovals.delete(key);
      }
    }
    // If still over cap, remove oldest entries
    if (this.pendingApprovals.size > ToolApproval.MAX_PENDING) {
      const entries = Array.from(this.pendingApprovals.entries());
      entries.sort((a, b) => a[1].requestTime.localeCompare(b[1].requestTime));
      const removeCount = this.pendingApprovals.size - ToolApproval.MAX_PENDING;
      for (let i = 0; i < removeCount; i++) {
        this.pendingApprovals.delete(entries[i][0]);
      }
    }
  }

  /**
   * 清空所有状态
   */
  clear(): void {
    this.pendingApprovals.clear();
    this.decisionHistory = [];
  }
}
