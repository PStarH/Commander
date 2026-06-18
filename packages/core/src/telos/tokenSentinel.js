"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CACHE_MULTIPLIERS = exports.TokenSentinel = void 0;
exports.calculateCostBreakdown = calculateCostBreakdown;
exports.getTokenSentinel = getTokenSentinel;
exports.resetTokenSentinel = resetTokenSentinel;
exports.estimateTokenCount = estimateTokenCount;
exports.estimateMessagesTokens = estimateMessagesTokens;
exports.calculateCost = calculateCost;
const modelRouter_1 = require("../runtime/modelRouter");
// ============================================================================
// Token Counter — estimate before sending
// ============================================================================
const CHARS_PER_TOKEN = {
    claude: 3.5,
    gpt: 4.0,
    gemini: 4.0,
    default: 3.7,
};
function detectModelFamily(modelId) {
    if (modelId.includes('claude'))
        return 'claude';
    if (modelId.includes('gpt') || modelId.includes('o1') || modelId.includes('o3'))
        return 'gpt';
    if (modelId.includes('gemini'))
        return 'gemini';
    return 'default';
}
function estimateTokenCount(text, modelId) {
    var _a, _b;
    const family = detectModelFamily(modelId);
    const cpt = (_a = CHARS_PER_TOKEN[family]) !== null && _a !== void 0 ? _a : CHARS_PER_TOKEN.default;
    let eastAsianChars = 0;
    let otherChars = 0;
    for (const ch of text) {
        const code = (_b = ch.codePointAt(0)) !== null && _b !== void 0 ? _b : 0;
        if ((code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
            (code >= 0x3040 && code <= 0x309f) || // Hiragana
            (code >= 0x30a0 && code <= 0x30ff) || // Katakana
            (code >= 0xac00 && code <= 0xd7af) // Hangul
        ) {
            eastAsianChars++;
        }
        else {
            otherChars++;
        }
    }
    // East Asian chars compress differently (~1.5 chars/token for CJK)
    const eastAsianTokens = eastAsianChars / 1.5;
    const otherTokens = otherChars / cpt;
    return Math.ceil(eastAsianTokens + otherTokens);
}
function estimateMessagesTokens(messages, modelId) {
    let total = 0;
    // Per-message overhead (role markers, formatting)
    total += messages.length * 4;
    for (const msg of messages) {
        total += estimateTokenCount(msg.content, modelId);
    }
    // System prompt presence overhead
    total += 8;
    return total;
}
// ============================================================================
// Cost Calculator
//
// Single source of truth for cost calculation. All other modules
// (cmdCost, CostPredictor, agentRuntime, etc.) must call into here
// instead of hardcoding rates.
// ============================================================================
/** Per-provider cache pricing multipliers (applied to costPer1KInput). */
const CACHE_MULTIPLIERS = {
    anthropic: { read: 0.1, write: 1.25 }, // 90% off reads, 1.25x write (5min TTL)
    openai: { read: 0.5, write: 1.0 }, // 50% off reads, automatic (no explicit write cost)
    google: { read: 0.1, write: 1.0 }, // Gemini cachedContent ~90% off reads
    default: { read: 1.0, write: 1.0 }, // No caching benefit assumed
};
exports.CACHE_MULTIPLIERS = CACHE_MULTIPLIERS;
function calculateCostBreakdown(modelId, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
    var _a, _b;
    const router = (0, modelRouter_1.getModelRouter)();
    const model = router.getModel(modelId);
    const provider = (_a = model === null || model === void 0 ? void 0 : model.provider) !== null && _a !== void 0 ? _a : 'unknown';
    // No model in router → use conservative $2/M fallback (split 80/20 input/output)
    if (!model) {
        const fallbackRate = 0.002;
        const inputRate = fallbackRate * 0.8;
        const outputRate = fallbackRate * 0.2;
        const total = ((inputTokens + cacheReadTokens + cacheWriteTokens) / 1000) * inputRate +
            (outputTokens / 1000) * outputRate;
        return {
            inputCostUsd: (inputTokens / 1000) * inputRate,
            outputCostUsd: (outputTokens / 1000) * outputRate,
            cacheReadCostUsd: (cacheReadTokens / 1000) * inputRate,
            cacheWriteCostUsd: (cacheWriteTokens / 1000) * inputRate,
            totalUsd: total,
            cacheSavingsUsd: 0,
        };
    }
    const multipliers = (_b = CACHE_MULTIPLIERS[provider]) !== null && _b !== void 0 ? _b : CACHE_MULTIPLIERS.default;
    const inputRate = model.costPer1KInput;
    const outputRate = model.costPer1KOutput;
    const inputCostUsd = (inputTokens / 1000) * inputRate;
    const outputCostUsd = (outputTokens / 1000) * outputRate;
    const cacheReadCostUsd = (cacheReadTokens / 1000) * inputRate * multipliers.read;
    const cacheWriteCostUsd = (cacheWriteTokens / 1000) * inputRate * multipliers.write;
    const totalUsd = inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd;
    // What we WOULD have paid for cache reads at full input price
    const cacheSavingsUsd = (cacheReadTokens / 1000) * inputRate * (1 - multipliers.read);
    return {
        inputCostUsd,
        outputCostUsd,
        cacheReadCostUsd,
        cacheWriteCostUsd,
        totalUsd,
        cacheSavingsUsd,
    };
}
function calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
    return calculateCostBreakdown(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens).totalUsd;
}
// ============================================================================
// Token Sentinel — unified guard
// ============================================================================
class TokenSentinel {
    constructor(maxRecords = 10000, maxAlerts = 1000, monthlyCostLimitUsd = 50.0) {
        this.costRecords = [];
        this.budgetAlerts = [];
        this.monthlyCostUsd = 0;
        this.maxRecords = maxRecords;
        this.maxAlerts = maxAlerts;
        this.monthlyCostLimitUsd = monthlyCostLimitUsd;
        this.monthlyResetDate = new Date().toISOString().slice(0, 7); // YYYY-MM
    }
    /** Ensure monthly cost counter is current (auto-reset on month boundary). */
    ensureCurrentMonth() {
        const currentMonth = new Date().toISOString().slice(0, 7);
        if (currentMonth !== this.monthlyResetDate) {
            this.monthlyCostUsd = 0;
            this.monthlyResetDate = currentMonth;
        }
    }
    trimAlerts() {
        while (this.budgetAlerts.length > this.maxAlerts) {
            this.budgetAlerts.shift();
        }
    }
    // ========================================================================
    // Token Estimation (pre-flight check)
    // ========================================================================
    estimatePromptTokens(messages, modelId) {
        return estimateMessagesTokens(messages, modelId);
    }
    estimateOutputTokens(goal, modelId) {
        return Math.min(estimateTokenCount(goal, modelId) * 2, 16384);
    }
    check(messages, modelId, budget) {
        var _a, _b;
        this.ensureCurrentMonth();
        const estimatedInput = estimateMessagesTokens(messages, modelId);
        const estimatedOutput = this.estimateOutputTokens((_b = (_a = messages.find((m) => m.role === 'user')) === null || _a === void 0 ? void 0 : _a.content) !== null && _b !== void 0 ? _b : '', modelId);
        const totalEstimated = estimatedInput + estimatedOutput;
        // Hard cap check
        if (budget.hardCapTokens > 0 && totalEstimated > budget.hardCapTokens) {
            return {
                allowed: false,
                estimatedInputTokens: estimatedInput,
                estimatedOutputTokens: estimatedOutput,
                totalEstimated,
                budgetRemaining: 0,
                reason: `Estimated ${totalEstimated} tokens exceeds hard cap of ${budget.hardCapTokens}`,
            };
        }
        // Monthly cost check
        if (this.monthlyCostLimitUsd > 0) {
            const estimatedCost = calculateCost(modelId, estimatedInput, estimatedOutput);
            if (this.monthlyCostUsd + estimatedCost > this.monthlyCostLimitUsd) {
                return {
                    allowed: false,
                    estimatedInputTokens: estimatedInput,
                    estimatedOutputTokens: estimatedOutput,
                    totalEstimated,
                    budgetRemaining: budget.hardCapTokens - totalEstimated,
                    reason: `Estimated cost $${estimatedCost.toFixed(4)} would exceed monthly limit $${this.monthlyCostLimitUsd}`,
                };
            }
        }
        const remaining = budget.hardCapTokens > 0 ? Math.max(0, budget.hardCapTokens - totalEstimated) : Infinity;
        // Soft cap warning — log but allow
        if (budget.softCapTokens > 0 && totalEstimated > budget.softCapTokens) {
            this.budgetAlerts.push({
                type: 'soft_cap_warning',
                runId: 'preflight',
                current: totalEstimated,
                limit: budget.softCapTokens,
                message: `Estimated ${totalEstimated} tokens exceeds soft cap of ${budget.softCapTokens}`,
            });
            this.trimAlerts();
        }
        return {
            allowed: true,
            estimatedInputTokens: estimatedInput,
            estimatedOutputTokens: estimatedOutput,
            totalEstimated,
            budgetRemaining: remaining,
        };
    }
    // ========================================================================
    // Cost Tracking
    // ========================================================================
    recordCost(record) {
        this.ensureCurrentMonth();
        this.costRecords.push(record);
        if (this.costRecords.length > this.maxRecords) {
            this.costRecords.shift();
        }
        this.monthlyCostUsd += record.costUsd;
        // Check monthly limit
        if (this.monthlyCostLimitUsd > 0 && this.monthlyCostUsd > this.monthlyCostLimitUsd) {
            this.budgetAlerts.push({
                type: 'cost_cap_reached',
                runId: record.runId,
                current: this.monthlyCostUsd,
                limit: this.monthlyCostLimitUsd,
                message: `Monthly cost $${this.monthlyCostUsd.toFixed(2)} exceeds limit $${this.monthlyCostLimitUsd}`,
            });
            this.trimAlerts();
        }
    }
    recordCostFromUsage(runId, agentId, modelId, usage) {
        var _a, _b, _c, _d, _e, _f;
        const router = (0, modelRouter_1.getModelRouter)();
        const model = router.getModel(modelId);
        const breakdown = calculateCostBreakdown(modelId, usage.promptTokens, usage.completionTokens, (_a = usage.cacheReadTokens) !== null && _a !== void 0 ? _a : 0, (_b = usage.cacheWriteTokens) !== null && _b !== void 0 ? _b : 0);
        const record = {
            runId,
            modelId,
            provider: (_c = model === null || model === void 0 ? void 0 : model.provider) !== null && _c !== void 0 ? _c : 'unknown',
            tier: (_d = model === null || model === void 0 ? void 0 : model.tier) !== null && _d !== void 0 ? _d : 'standard',
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            cacheReadTokens: (_e = usage.cacheReadTokens) !== null && _e !== void 0 ? _e : 0,
            cacheWriteTokens: (_f = usage.cacheWriteTokens) !== null && _f !== void 0 ? _f : 0,
            costUsd: Math.round(breakdown.totalUsd * 100000) / 100000,
            cacheSavingsUsd: Math.round(breakdown.cacheSavingsUsd * 100000) / 100000,
            timestamp: new Date().toISOString(),
            agentId,
        };
        this.recordCost(record);
        return record;
    }
    getCosts(runId) {
        if (runId) {
            return this.costRecords.filter((r) => r.runId === runId);
        }
        return [...this.costRecords];
    }
    getCostSummary() {
        const summary = {
            totalCostUsd: 0,
            totalTokens: 0,
            totalCalls: this.costRecords.length,
            perModel: {},
            perAgent: {},
        };
        for (const r of this.costRecords) {
            summary.totalCostUsd += r.costUsd;
            summary.totalTokens += r.totalTokens;
            if (!summary.perModel[r.modelId]) {
                summary.perModel[r.modelId] = { calls: 0, tokens: 0, costUsd: 0 };
            }
            summary.perModel[r.modelId].calls++;
            summary.perModel[r.modelId].tokens += r.totalTokens;
            summary.perModel[r.modelId].costUsd += r.costUsd;
            if (!summary.perAgent[r.agentId]) {
                summary.perAgent[r.agentId] = { calls: 0, tokens: 0, costUsd: 0 };
            }
            summary.perAgent[r.agentId].calls++;
            summary.perAgent[r.agentId].tokens += r.totalTokens;
            summary.perAgent[r.agentId].costUsd += r.costUsd;
        }
        summary.totalCostUsd = Math.round(summary.totalCostUsd * 100) / 100;
        for (const key of Object.keys(summary.perModel)) {
            summary.perModel[key].costUsd = Math.round(summary.perModel[key].costUsd * 100) / 100;
        }
        for (const key of Object.keys(summary.perAgent)) {
            summary.perAgent[key].costUsd = Math.round(summary.perAgent[key].costUsd * 100) / 100;
        }
        return summary;
    }
    // ========================================================================
    // Budget Enforcement
    // ========================================================================
    checkBudget(runId, currentTokens, budget) {
        if (budget.hardCapTokens > 0 && currentTokens > budget.hardCapTokens) {
            const alert = {
                type: 'hard_cap_reached',
                runId,
                current: currentTokens,
                limit: budget.hardCapTokens,
                message: `Hard cap of ${budget.hardCapTokens} tokens reached (${currentTokens})`,
            };
            this.budgetAlerts.push(alert);
            this.trimAlerts();
            return alert;
        }
        return null;
    }
    checkCostBudget(runId) {
        this.ensureCurrentMonth();
        if (this.monthlyCostLimitUsd > 0 && this.monthlyCostUsd >= this.monthlyCostLimitUsd) {
            const alert = {
                type: 'budget_exhausted',
                runId,
                current: this.monthlyCostUsd,
                limit: this.monthlyCostLimitUsd,
                message: `Monthly budget exhausted: $${this.monthlyCostUsd.toFixed(2)} >= $${this.monthlyCostLimitUsd}`,
            };
            this.budgetAlerts.push(alert);
            this.trimAlerts();
            return alert;
        }
        return null;
    }
    getAlerts() {
        return [...this.budgetAlerts];
    }
    getMonthlyCostUsd() {
        this.ensureCurrentMonth();
        return Math.round(this.monthlyCostUsd * 100000) / 100000;
    }
    getMonthlyLimitUsd() {
        return this.monthlyCostLimitUsd;
    }
    resetMonthly() {
        this.monthlyCostUsd = 0;
        this.monthlyResetDate = new Date().toISOString().slice(0, 7);
        this.costRecords = [];
        this.budgetAlerts = [];
    }
}
exports.TokenSentinel = TokenSentinel;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const sentinelSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new TokenSentinel());
function getTokenSentinel() {
    return sentinelSingleton.get();
}
function resetTokenSentinel() {
    sentinelSingleton.reset();
}
