"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenBudgetManager = void 0;
exports.getTokenBudgetManager = getTokenBudgetManager;
exports.resetTokenBudgetManager = resetTokenBudgetManager;
/**
 * TokenBudgetManager — Centralized token budget tracking and proportional
 * allocation across sub-agents.
 *
 * The orchestrator creates one instance per run. As tasks are decomposed,
 * the total budget is split proportionally across sub-agents based on their
 * estimated token needs. Actual usage is tracked in real-time, and hard/soft
 * cap enforcement triggers warnings or abort signals.
 */
const metricsCollector_1 = require("./metricsCollector");
const messageBus_1 = require("./messageBus");
const logging_1 = require("../logging");
const DEFAULT_SOFT_CAP_RATIO = 0.8;
const MAX_ACTIVE_BUDGETS = 200;
// ============================================================================
// TokenBudgetManager
// ============================================================================
class TokenBudgetManager {
    constructor() {
        this.budgets = new Map();
        this.runLookup = new Map(); // agentId → runId
    }
    /**
     * Start tracking a new run's budget.
     */
    startRun(runId, config) {
        var _a;
        const softCap = (_a = config.softCap) !== null && _a !== void 0 ? _a : Math.round(config.hardCap * DEFAULT_SOFT_CAP_RATIO);
        const status = {
            runId,
            totalBudget: config.hardCap,
            softCap,
            hardCap: config.hardCap,
            usedTokens: 0,
            remainingTokens: config.hardCap,
            utilizationPercent: 0,
            phase: 'relaxed',
            subAgents: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        // Evict oldest if over capacity
        if (this.budgets.size >= MAX_ACTIVE_BUDGETS) {
            const oldest = this.budgets.keys().next().value;
            if (oldest)
                this.budgets.delete(oldest);
        }
        this.budgets.set(runId, status);
        this.emitMetrics(runId);
        return status;
    }
    /**
     * Allocate budget proportionally across sub-agents based on their
     * estimated token needs. Returns a Map of nodeId → allocated budget.
     *
     * The allocation formula:
     *   allocated[i] = totalBudget * (estimatedTokens[i] / sum(estimatedTokens))
     *
     * A 10% reserve is kept for synthesis and quality fix overhead.
     */
    allocateToSubAgents(runId, subAgentEstimates) {
        const status = this.budgets.get(runId);
        if (!status) {
            (0, logging_1.getGlobalLogger)().warn('TokenBudgetManager', 'Allocation on unknown run', { runId });
            return new Map();
        }
        const totalEstimated = subAgentEstimates.reduce((s, e) => s + e.estimatedTokens, 0);
        if (totalEstimated === 0) {
            // Equal split when no estimates available
            const equalShare = Math.floor(status.remainingTokens / subAgentEstimates.length);
            return new Map(subAgentEstimates.map((e) => [e.nodeId, equalShare]));
        }
        // 10% reserve for synthesis + quality fix overhead
        const allocatable = Math.floor(status.totalBudget * 0.9);
        const result = new Map();
        const allocations = [];
        let allocatedSum = 0;
        const entries = subAgentEstimates.map((e, i) => {
            // Last entry gets the remainder to avoid rounding losses
            const isLast = i === subAgentEstimates.length - 1;
            const share = isLast
                ? allocatable - allocatedSum
                : Math.floor(allocatable * (e.estimatedTokens / totalEstimated));
            allocatedSum += share;
            return { ...e, share };
        });
        for (const entry of entries) {
            result.set(entry.nodeId, entry.share);
            allocations.push({
                nodeId: entry.nodeId,
                allocatedBudget: entry.share,
                usedTokens: 0,
                status: 'pending',
                hardCapExceeded: false,
            });
        }
        status.subAgents = allocations;
        status.updatedAt = new Date().toISOString();
        this.budgets.set(runId, status);
        return result;
    }
    /**
     * Record token usage from a sub-agent. Updates the run-level total
     * and the per-agent allocation tracker.
     */
    recordUsage(runId, nodeId, tokens) {
        const status = this.budgets.get(runId);
        if (!status)
            return { warning: false, exceeded: false };
        status.usedTokens += tokens;
        status.remainingTokens = Math.max(0, status.totalBudget - status.usedTokens);
        status.utilizationPercent =
            status.totalBudget > 0 ? Math.round((status.usedTokens / status.totalBudget) * 100) : 0;
        status.updatedAt = new Date().toISOString();
        // Update phase
        if (status.usedTokens >= status.hardCap) {
            status.phase = 'exceeded';
        }
        else if (status.usedTokens >= status.hardCap * 0.95) {
            status.phase = 'critical';
        }
        else if (status.usedTokens >= status.softCap) {
            status.phase = 'tight';
        }
        else if (status.usedTokens >= status.softCap * 0.65) {
            status.phase = 'moderate';
        }
        // Update per-agent tracker
        const agent = status.subAgents.find((a) => a.nodeId === nodeId);
        if (agent) {
            agent.usedTokens += tokens;
            agent.status = 'running';
            if (agent.usedTokens >= agent.allocatedBudget && agent.allocatedBudget > 0) {
                agent.hardCapExceeded = true;
            }
        }
        this.budgets.set(runId, status);
        // Emit warnings
        const warning = status.phase === 'tight' || status.phase === 'critical';
        const exceeded = status.phase === 'exceeded';
        if (warning && !exceeded) {
            (0, messageBus_1.getMessageBus)().publish('system.alert', 'budget-manager', {
                type: 'token_budget_warning',
                runId,
                phase: status.phase,
                utilizationPercent: status.utilizationPercent,
                usedTokens: status.usedTokens,
                remainingTokens: status.remainingTokens,
            });
        }
        if (exceeded) {
            (0, messageBus_1.getMessageBus)().publish('system.alert', 'budget-manager', {
                type: 'token_budget_exceeded',
                runId,
                usedTokens: status.usedTokens,
                hardCap: status.hardCap,
            });
        }
        this.emitMetrics(runId);
        return { warning, exceeded };
    }
    /**
     * Mark a sub-agent as completed and record its final token usage.
     */
    markSubAgentComplete(runId, nodeId, finalTokens) {
        const status = this.budgets.get(runId);
        if (!status)
            return;
        const agent = status.subAgents.find((a) => a.nodeId === nodeId);
        if (agent) {
            agent.usedTokens = finalTokens;
            agent.status = 'completed';
            agent.hardCapExceeded = agent.usedTokens >= agent.allocatedBudget;
        }
        status.updatedAt = new Date().toISOString();
        this.budgets.set(runId, status);
    }
    /**
     * Get the budget status for a run.
     */
    getRunStatus(runId) {
        var _a;
        return (_a = this.budgets.get(runId)) !== null && _a !== void 0 ? _a : null;
    }
    /**
     * Check if a run's budget is exceeded (hard cap).
     */
    isBudgetExceeded(runId) {
        const status = this.budgets.get(runId);
        return status ? status.phase === 'exceeded' : false;
    }
    /**
     * Get all active budget statuses, most recent first.
     */
    getActiveBudgets() {
        return Array.from(this.budgets.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    /**
     * Get remaining budget for a run.
     */
    getRemainingBudget(runId) {
        var _a, _b;
        return (_b = (_a = this.budgets.get(runId)) === null || _a === void 0 ? void 0 : _a.remainingTokens) !== null && _b !== void 0 ? _b : 0;
    }
    /**
     * Clean up a completed run's budget tracking.
     */
    completeRun(runId) {
        this.budgets.delete(runId);
    }
    /**
     * Number of active budgets being tracked.
     */
    getActiveBudgetCount() {
        return this.budgets.size;
    }
    // ---------------------------------------------------------------------------
    // Metrics
    // ---------------------------------------------------------------------------
    emitMetrics(runId) {
        const status = this.budgets.get(runId);
        if (!status)
            return;
        try {
            const mc = (0, metricsCollector_1.getMetricsCollector)();
            mc.setGauge('token_budget_utilization_percent', 'Token budget utilization %', status.utilizationPercent, [
                { name: 'run_id', value: runId },
                { name: 'phase', value: status.phase },
            ]);
            mc.setGauge('token_budget_remaining', 'Remaining token budget', status.remainingTokens, [
                { name: 'run_id', value: runId },
            ]);
        }
        catch {
            /* best-effort */
        }
    }
}
exports.TokenBudgetManager = TokenBudgetManager;
// ============================================================================
// Singleton
// ============================================================================
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const budgetManagerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new TokenBudgetManager());
/**
 * Get the global TokenBudgetManager (single-tenant) or tenant-scoped (multi-tenant).
 */
function getTokenBudgetManager() {
    return budgetManagerSingleton.get();
}
/** Reset for test isolation. */
function resetTokenBudgetManager() {
    budgetManagerSingleton.reset();
}
