"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolApproval = exports.DEFAULT_APPROVAL_POLICIES = exports.DEFAULT_ARG_WHITELIST = exports.DANGEROUS_ARG_PATTERNS = void 0;
exports.riskPriorityCompare = riskPriorityCompare;
exports.assessArgRisk = assessArgRisk;
const logging_1 = require("../logging");
/** Risk level priority for comparison. Higher number = higher risk. */
const RISK_PRIORITY = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
};
/** Compare two risk levels. Returns positive if a > b, negative if a < b, 0 if equal. */
function riskPriorityCompare(a, b) {
    var _a, _b;
    return ((_a = RISK_PRIORITY[a]) !== null && _a !== void 0 ? _a : 0) - ((_b = RISK_PRIORITY[b]) !== null && _b !== void 0 ? _b : 0);
}
/** Global dangerous argument patterns for parameter-level risk assessment. */
exports.DANGEROUS_ARG_PATTERNS = [
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
/** Default whitelist rules (e.g., test directories, CI sandboxes). */
exports.DEFAULT_ARG_WHITELIST = [
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
function assessArgRisk(args, toolArgRiskRules, toolArgWhitelist) {
    const reasons = [];
    const whitelisted = [];
    let maxRisk = 'low';
    const allRules = [...exports.DANGEROUS_ARG_PATTERNS, ...(toolArgRiskRules !== null && toolArgRiskRules !== void 0 ? toolArgRiskRules : [])];
    const allWhitelist = [...exports.DEFAULT_ARG_WHITELIST, ...(toolArgWhitelist !== null && toolArgWhitelist !== void 0 ? toolArgWhitelist : [])];
    for (const rule of allRules) {
        const value = args[rule.param];
        if (value === undefined || value === null)
            continue;
        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
        if (rule.pattern.test(strValue)) {
            const matchedWhitelist = allWhitelist.find((w) => w.param === rule.param && w.pattern.test(strValue));
            if (matchedWhitelist) {
                whitelisted.push(matchedWhitelist.description);
                if (riskPriorityCompare(matchedWhitelist.downgradeTo, maxRisk) > 0) {
                    maxRisk = matchedWhitelist.downgradeTo;
                }
                reasons.push(`${rule.description} (whitelisted → ${matchedWhitelist.downgradeTo})`);
            }
            else {
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
// Default approval policies
// ============================================================================
exports.DEFAULT_APPROVAL_POLICIES = [
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
class ToolApproval {
    constructor(approvalCallback, autoApproveCallback) {
        this.policies = new Map();
        this.pendingApprovals = new Map();
        this.decisionHistory = [];
        this.approvalCallback = approvalCallback;
        this.autoApproveCallback = autoApproveCallback;
        this.initializeDefaultPolicies();
    }
    /**
     * 初始化默认审批策略
     */
    initializeDefaultPolicies() {
        for (const policy of exports.DEFAULT_APPROVAL_POLICIES) {
            this.addPolicy(policy);
        }
    }
    /**
     * 添加自定义审批策略
     */
    addPolicy(policy) {
        const key = typeof policy.pattern === 'string' ? policy.pattern : policy.pattern.toString();
        this.policies.set(key, policy);
    }
    /**
     * 移除审批策略
     */
    removePolicy(pattern) {
        const key = typeof pattern === 'string' ? pattern : pattern.toString();
        this.policies.delete(key);
    }
    /**
     * 查找匹配的审批策略
     */
    findPolicy(toolName) {
        for (const [, policy] of this.policies) {
            if (typeof policy.pattern === 'string') {
                // 支持通配符
                if (policy.pattern.endsWith('*')) {
                    if (toolName.startsWith(policy.pattern.slice(0, -1))) {
                        return policy;
                    }
                }
                else if (toolName === policy.pattern) {
                    return policy;
                }
            }
            else {
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
    checkAutoApproveConditions(policy, args) {
        if (!policy.autoApproveIf)
            return false;
        if (policy.level !== 'semi_auto')
            return false;
        const conditions = policy.autoApproveIf;
        // 检查参数匹配
        if (conditions.argsMatch) {
            for (const [key, expected] of Object.entries(conditions.argsMatch)) {
                const actual = args[key];
                if (typeof expected === 'object' && expected !== null) {
                    const opArgs = expected;
                    // 处理操作符条件
                    if ('$lte' in expected) {
                        if (typeof actual !== 'number' || actual > opArgs.$lte) {
                            return false;
                        }
                    }
                    if ('$not' in expected) {
                        if (typeof actual === 'string' && opArgs.$not instanceof RegExp) {
                            if (opArgs.$not.test(actual))
                                return false;
                        }
                    }
                    if ('$length' in expected) {
                        if (Array.isArray(actual) && actual.length > opArgs.$length) {
                            return false;
                        }
                    }
                }
                else if (actual !== expected) {
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
    async requestApproval(toolName, args, context) {
        var _a, _b, _c, _d;
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
            const existingRequest = this.pendingApprovals.get(`${toolName}:${(_a = context === null || context === void 0 ? void 0 : context.runId) !== null && _a !== void 0 ? _a : 'global'}`);
            if (existingRequest && existingRequest.waitCount >= ((_b = policy.maxWaitCount) !== null && _b !== void 0 ? _b : 3)) {
                this.recordDecision(toolName, false, policy.level);
                return {
                    approved: false,
                    requestId,
                    approvedAt: now,
                    reason: `Max wait count (${(_c = policy.maxWaitCount) !== null && _c !== void 0 ? _c : 3}) exceeded`,
                    alternativeAction: 'Try a different approach or simplify the operation',
                };
            }
        }
        if (effectiveLevel === 'manual' || effectiveLevel === 'semi_auto') {
            const pendingKey = `${toolName}:${(_d = context === null || context === void 0 ? void 0 : context.runId) !== null && _d !== void 0 ? _d : 'global'}`;
            const existingRequest = this.pendingApprovals.get(pendingKey);
            const waitCount = existingRequest ? existingRequest.waitCount + 1 : 0;
            const approvalRequest = {
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
                    : context === null || context === void 0 ? void 0 : context.reason,
                waitCount,
            };
            try {
                const result = await this.approvalCallback(approvalRequest);
                this.pendingApprovals.set(pendingKey, approvalRequest);
                this.pruneStaleApprovals();
                this.recordDecision(toolName, result.approved, effectiveLevel);
                return result;
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('ToolApproval', 'Approval callback failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    toolName,
                });
                this.pendingApprovals.set(pendingKey, approvalRequest);
                this.pruneStaleApprovals();
                this.recordDecision(toolName, false, effectiveLevel);
                return {
                    approved: false,
                    requestId,
                    approvedAt: new Date().toISOString(),
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
    recordDecision(toolName, approved, level) {
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
        if (total === 0)
            return { total: 0, approved: 0, rejected: 0, approvalRate: 0 };
        let approved = 0;
        for (const d of this.decisionHistory) {
            if (d.approved)
                approved++;
        }
        return {
            total,
            approved,
            rejected: total - approved,
            approvalRate: approved / total,
            byLevel: this.groupByLevel(),
        };
    }
    groupByLevel() {
        const groups = {
            auto: { total: 0, approved: 0 },
            semi_auto: { total: 0, approved: 0 },
            manual: { total: 0, approved: 0 },
        };
        for (const d of this.decisionHistory) {
            groups[d.level].total++;
            if (d.approved)
                groups[d.level].approved++;
        }
        return groups;
    }
    /**
     * 获取待处理的审批请求
     */
    getPendingApprovals() {
        return Array.from(this.pendingApprovals.values());
    }
    /**
     * 手动批准待处理的请求
     */
    async approvePending(requestId) {
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
    async rejectPending(requestId, reason) {
        for (const [key, request] of this.pendingApprovals) {
            if (request.id === requestId) {
                this.pendingApprovals.delete(key);
                this.recordDecision(request.toolName, false, request.policy.level);
                return true;
            }
        }
        return false;
    }
    pruneStaleApprovals() {
        if (this.pendingApprovals.size <= ToolApproval.MAX_PENDING)
            return;
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
    clear() {
        this.pendingApprovals.clear();
        this.decisionHistory = [];
    }
}
exports.ToolApproval = ToolApproval;
ToolApproval.MAX_PENDING = 200;
