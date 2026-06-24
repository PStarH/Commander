import { getGlobalLogger } from '../logging';
import type { CapabilityTokenVerifier, CapabilityRejectReason } from '../security/capabilityToken';
import { getMetricsCollector } from './metricsCollector';
import { getToolTrustTier } from '../tools/toolRegistry';

// ============================================================================
// Approval levels
// ============================================================================

/** Approval level applied to a tool invocation. */
export type ApprovalLevel = 'auto' | 'semi_auto' | 'manual';

/** Risk level priority for comparison. Higher number = higher risk. */
const RISK_PRIORITY: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Compare two risk levels. Returns positive if a > b, negative if a < b, 0 if equal. */
export function riskPriorityCompare(a: string, b: string): number {
  return (RISK_PRIORITY[a] ?? 0) - (RISK_PRIORITY[b] ?? 0);
}

// ============================================================================
// Argument risk rules
// ============================================================================

export interface ArgRiskRule {
  /** Parameter name to check. */
  param: string;
  /** Regex pattern to match against the parameter value. */
  pattern: RegExp;
  /** Risk level if pattern matches. */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Human-readable description of the risk. */
  description: string;
}

/** Global dangerous argument patterns for parameter-level risk assessment. */
export const DANGEROUS_ARG_PATTERNS: ArgRiskRule[] = [
  // Destructive shell commands
  {
    param: 'command',
    pattern: /\b(rm\s+-rf|mkfs|dd\s+if=|chmod\s+777|wget.*\|\s*sh|curl.*\|\s*bash)\b/i,
    riskLevel: 'critical',
    description: 'Destructive shell command detected',
  },
  // Privilege escalation
  {
    param: 'command',
    pattern: /\b(sudo|su\s+-|chown|passwd|shadow)\b/i,
    riskLevel: 'critical',
    description: 'Privilege escalation command detected',
  },
  // System/sensitive path access
  {
    param: 'path',
    pattern: /^\/(etc|usr|var|system|private|secret|root)/,
    riskLevel: 'high',
    description: 'System/sensitive path access detected',
  },
  // Dynamic code execution
  {
    param: 'code',
    pattern: /\b(exec|eval|subprocess|os\.system|__import__)\b/i,
    riskLevel: 'high',
    description: 'Dynamic code execution detected',
  },
  // Network exfiltration patterns
  {
    param: 'command',
    pattern: /\b(curl|wget|nc|netcat|socat)\b.*\b(POST|PUT|PATCH)\b/i,
    riskLevel: 'high',
    description: 'Potential data exfiltration command detected',
  },
];

/**
 * Whitelist rules for parameter-level risk assessment.
 * Patterns matching these rules will have their risk level downgraded.
 */
export interface ArgWhitelistRule {
  /** Parameter name to check. */
  param: string;
  /** Regex pattern to match against the parameter value. */
  pattern: RegExp;
  /** Risk level to downgrade to (e.g., 'low' to bypass critical). */
  downgradeTo: 'low' | 'medium';
  /** Description of the whitelist rule. */
  description: string;
}

/** Default whitelist rules (e.g., test directories, CI sandboxes). */
export const DEFAULT_ARG_WHITELIST: ArgWhitelistRule[] = [
  {
    param: 'command',
    pattern: /\brm\s+-rf\s+.*\/(test|tests|__tests__|spec|\.tmp|node_modules)\//i,
    downgradeTo: 'low',
    description: 'Cleaning test/temp directories is safe',
  },
  {
    param: 'path',
    pattern: /^\/(tmp|temp|\.tmp|\.temp|test_output)\//,
    downgradeTo: 'low',
    description: 'Temporary/test path access is safe',
  },
  {
    param: 'command',
    pattern: /\b(pip\s+install|npm\s+install|yarn\s+add)\s+--save-dev\b/i,
    downgradeTo: 'medium',
    description: 'Dev dependency installation is low risk',
  },
];

export interface ArgRiskAssessment {
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  whitelisted: string[];
}

export function assessArgRisk(
  args: Record<string, unknown>,
  toolArgRiskRules?: ArgRiskRule[],
  toolArgWhitelist?: ArgWhitelistRule[],
): ArgRiskAssessment {
  const reasons: string[] = [];
  const whitelisted: string[] = [];
  let maxRisk: 'low' | 'medium' | 'high' | 'critical' = 'low';

  const allRules = [...DANGEROUS_ARG_PATTERNS, ...(toolArgRiskRules ?? [])];
  const allWhitelist = [...DEFAULT_ARG_WHITELIST, ...(toolArgWhitelist ?? [])];

  for (const rule of allRules) {
    const value = args[rule.param];
    if (value === undefined || value === null) continue;
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);

    if (rule.pattern.test(strValue)) {
      const matchedWhitelist = allWhitelist.find(
        (w) => w.param === rule.param && w.pattern.test(strValue),
      );

      if (matchedWhitelist) {
        whitelisted.push(matchedWhitelist.description);
        if (riskPriorityCompare(matchedWhitelist.downgradeTo, maxRisk) > 0) {
          maxRisk = matchedWhitelist.downgradeTo;
        }
        reasons.push(`${rule.description} (whitelisted → ${matchedWhitelist.downgradeTo})`);
      } else {
        reasons.push(rule.description);
        if (riskPriorityCompare(rule.riskLevel, maxRisk) > 0) {
          maxRisk = rule.riskLevel;
        }
      }
    }
  }

  return { riskLevel: maxRisk, reasons, whitelisted };
}

// ============================================================================
// Approval policy
// ============================================================================

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
  /** Argument-level risk rules for dynamic approval escalation. */
  argRiskRules?: ArgRiskRule[];
  /** Argument whitelist rules for risk downgrading. */
  argWhitelist?: ArgWhitelistRule[];
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

/**
 * Opt-in observability event fired when a capability token was supplied
 * alongside a configured verifier but the verifier rejected the token.
 * Distinct from the verifier-level `auditLogger` because ToolApproval has
 * richer runtime context (agentId, runId) and because emission is opt-in,
 * so middleware that doesn't want failed-token noise can keep wiring silent.
 */
export interface TokenRejectedEvent {
  type: 'token_rejected';
  toolName: string;
  /** Reason from {@link CapabilityTokenVerifier.verify}'s reject taxonomy. */
  reason: CapabilityRejectReason;
  agentId?: string;
  runId?: string;
  timestamp: string;
}

export type TokenRejectedLogger = (event: TokenRejectedEvent) => void;

/**
 * Increment a monotonic failure counter for any audit/observability sink
 * whose throw was swallowed. Uses the {@link MetricsCollector} so future
 * operators see a visible dashboard alert on `audit_sink_failures_total`
 * instead of just one orphaned stderr line per call.
 *
 * Wrapped in defensive try/catch because a metrics-collector failure must
 * NEVER break the underlying approval flow.
 */
function recordSinkFailure(sink: string): void {
  try {
    getMetricsCollector().incrementCounter(
      'audit_sink_failures_total',
      'Audit/observability sink failures (silent swallows)',
      1,
      [{ name: 'sink', value: sink }],
    );
  } catch (err) {
    console.warn('[Catch]', err);
    /* metrics collector unavailable — last-resort swallow */
  }
}

export class ToolApproval {
  private policies: Map<string, ApprovalPolicy> = new Map();
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private approvalCallback: ApprovalCallback;
  private autoApproveCallback?: ApprovalCallback;
  private tokenVerifier?: CapabilityTokenVerifier;
  private tokenRejectedLogger?: TokenRejectedLogger;
  private decisionHistory: Array<{
    requestId: string;
    toolName: string;
    approved: boolean;
    level: ApprovalLevel;
    timestamp: string;
  }> = [];

  constructor(
    approvalCallback?: ApprovalCallback,
    autoApproveCallback?: ApprovalCallback,
    tokenVerifier?: CapabilityTokenVerifier,
  ) {
    this.approvalCallback =
      approvalCallback ??
      (async () => ({
        approved: true,
        requestId: `auto-${Date.now()}`,
        approvedAt: new Date().toISOString(),
        reason: 'Default auto-approve',
      }));
    this.autoApproveCallback = autoApproveCallback;
    this.tokenVerifier = tokenVerifier;
    this.initializeDefaultPolicies();
  }

  /**
   * Late-bound runtime injection of a token verifier (e.g. after tenant
   * resolution or hot-reload of the capability-token issuer). Removes any
   * previously-set verifier when called with `undefined`.
   */
  setTokenVerifier(verifier: CapabilityTokenVerifier | undefined): void {
    this.tokenVerifier = verifier;
  }

  /**
   * Opt-in observability for failed token verdicts at the ToolApproval
   * runtime boundary. Default unwired — verify() itself is intentionally
   * silent so high-volume middleware is not flooded. Soft-wired here so
   * tenants who want failed-token visibility can capture it without
   * inheriting every successful token in the audit chain.
   */
  setTokenRejectedLogger(logger: TokenRejectedLogger | undefined): void {
    this.tokenRejectedLogger = logger;
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
      /** Short-lived capability token; presence + verifier triggers fast-path. */
      token?: string;
    },
  ): Promise<ApprovalResult> {
    // Capability-token fast path: a valid token short-circuits the entire
    // policy / arg-risk / trust-tier / approval flow. Without this, the
    // original "auto-approves every subsequent call after one human
    // approval" gap would persist even after per-call tokens are introduced
    // (Phase 2.1 design). Invalid tokens fall through to the normal
    // approval pathway so a stale or expired token cannot block legitimate
    // approvals; we also fire an opt-in observability event so tenants can
    // detect supply-with-bad-token hammering without flooding middleware.
    if (context?.token && this.tokenVerifier) {
      const v = this.tokenVerifier.verify(context.token, { tool: toolName, args });
      if (v.ok) {
        this.recordDecision(toolName, true, 'auto');
        return {
          approved: true,
          requestId: `capability-token-${v.jti}`,
          approvedAt: new Date().toISOString(),
          reason: `capability-token: jti=${v.jti.slice(0, 12)}… sub=${v.sub} tools=[${v.scope.tools.join(',')}] risk=${v.risk}`,
        };
      }
      if (this.tokenRejectedLogger) {
        try {
          this.tokenRejectedLogger({
            type: 'token_rejected',
            toolName,
            reason: v.reason,
            agentId: context?.agentId,
            runId: context?.runId,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          recordSinkFailure('tokenRejectedLogger');
          try {
            getGlobalLogger().warn('ToolApproval', 'tokenRejectedLogger threw', {
              error: (err as Error)?.message,
              toolName,
            });
          } catch (err) {
            console.warn('[Catch]', err);
            /* logger inaccessible, swallow */
          }
        }
      }
    }
    const policy = this.findPolicy(toolName);

    if (!policy) {
      return {
        approved: true,
        requestId: `auto-${Date.now()}-${toolName}`,
        approvedAt: new Date().toISOString(),
        reason: 'No policy found, auto-approved',
      };
    }

    const argRisk = assessArgRisk(args, policy.argRiskRules, policy.argWhitelist);
    const escalatedByArgRisk = riskPriorityCompare(argRisk.riskLevel, 'high') > 0;

    let effectiveLevel = policy.level;
    if (escalatedByArgRisk && effectiveLevel !== 'manual') {
      effectiveLevel = 'manual';
    }

    // Trust-tier escalation: untrusted tools at 'auto' level are escalated to
    // semi_auto so the callback is invoked rather than silently approving.
    const tier = getToolTrustTier(toolName);
    const escalatedByTier = effectiveLevel === 'auto' && tier === 'untrusted';
    if (escalatedByTier) {
      effectiveLevel = 'semi_auto';
    }

    if (effectiveLevel === 'auto') {
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

    if (effectiveLevel === 'semi_auto') {
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

      const existingRequest = this.pendingApprovals.get(
        `${toolName}:${context?.runId ?? 'global'}`,
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

    if (effectiveLevel === 'manual' || effectiveLevel === 'semi_auto') {
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
        reason: escalatedByArgRisk
          ? `Escalated to manual: argument risk "${argRisk.reasons.join(', ')}"`
          : escalatedByTier
            ? `Escalated to semi_auto: tier=untrusted for "${toolName}"`
            : context?.reason,
        waitCount,
      };

      try {
        const result = await this.approvalCallback(approvalRequest);
        this.pendingApprovals.set(pendingKey, approvalRequest);
        this.pruneStaleApprovals();
        this.recordDecision(toolName, result.approved, effectiveLevel);
        return result;
      } catch (e) {
        try {
          getGlobalLogger().warn('ToolApproval', 'Approval callback failed', {
            error: (e as Error)?.message,
            toolName,
          });
        } catch (err) {
          console.warn('[Catch]', err);
          /* logger inaccessible, swallow */
        }
        this.pendingApprovals.set(pendingKey, approvalRequest);
        this.pruneStaleApprovals();
        this.recordDecision(toolName, false, effectiveLevel);
        return {
          approved: false,
          requestId,
          approvedAt: now,
          reason: `Approval callback error for ${toolName}`,
        };
      }
    }

    this.recordDecision(toolName, false, policy.level);
    return {
      approved: false,
      requestId,
      approvedAt: now,
      reason: 'No matching approval policy configuration',
    };
  }

  private recordDecision(toolName: string, approved: boolean, level: ApprovalLevel): void {
    this.decisionHistory.push({
      requestId: `decision-${Date.now()}-${toolName}`,
      toolName,
      approved,
      level,
      timestamp: new Date().toISOString(),
    });

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
