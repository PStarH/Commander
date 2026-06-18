/** Approval level applied to a tool invocation. */
export type ApprovalLevel = 'auto' | 'semi_auto' | 'manual';
/** Compare two risk levels. Returns positive if a > b, negative if a < b, 0 if equal. */
export declare function riskPriorityCompare(a: string, b: string): number;
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
export declare const DANGEROUS_ARG_PATTERNS: ArgRiskRule[];
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
export declare const DEFAULT_ARG_WHITELIST: ArgWhitelistRule[];
export interface ArgRiskAssessment {
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    reasons: string[];
    whitelisted: string[];
}
export declare function assessArgRisk(args: Record<string, unknown>, toolArgRiskRules?: ArgRiskRule[], toolArgWhitelist?: ArgWhitelistRule[]): ArgRiskAssessment;
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
export declare const DEFAULT_APPROVAL_POLICIES: ApprovalPolicy[];
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
export type ApprovalCallback = (request: ApprovalRequest) => Promise<ApprovalResult> | ApprovalResult;
export declare class ToolApproval {
    private policies;
    private pendingApprovals;
    private approvalCallback;
    private autoApproveCallback?;
    private decisionHistory;
    constructor(approvalCallback: ApprovalCallback, autoApproveCallback?: ApprovalCallback);
    /**
     * 初始化默认审批策略
     */
    private initializeDefaultPolicies;
    /**
     * 添加自定义审批策略
     */
    addPolicy(policy: ApprovalPolicy): void;
    /**
     * 移除审批策略
     */
    removePolicy(pattern: string | RegExp): void;
    /**
     * 查找匹配的审批策略
     */
    private findPolicy;
    /**
     * 检查参数是否匹配自动审批条件
     */
    private checkAutoApproveConditions;
    /**
     * 请求审批 — 核心方法
     * 在工具执行前调用
     */
    requestApproval(toolName: string, args: Record<string, unknown>, context?: {
        agentId?: string;
        runId?: string;
        reason?: string;
    }): Promise<ApprovalResult>;
    private recordDecision;
    /**
     * 获取审批统计
     */
    getStats(): {
        total: number;
        approved: number;
        rejected: number;
        approvalRate: number;
        byLevel?: undefined;
    } | {
        total: number;
        approved: number;
        rejected: number;
        approvalRate: number;
        byLevel: Record<ApprovalLevel, {
            total: number;
            approved: number;
        }>;
    };
    private groupByLevel;
    /**
     * 获取待处理的审批请求
     */
    getPendingApprovals(): ApprovalRequest[];
    /**
     * 手动批准待处理的请求
     */
    approvePending(requestId: string): Promise<boolean>;
    /**
     * 手动拒绝待处理的请求
     */
    rejectPending(requestId: string, reason?: string): Promise<boolean>;
    private static readonly MAX_PENDING;
    private pruneStaleApprovals;
    /**
     * 清空所有状态
     */
    clear(): void;
}
//# sourceMappingURL=toolApproval.d.ts.map