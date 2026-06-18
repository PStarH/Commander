"use strict";
/**
 * Token Budget Governor
 *
 * Central coordinator for token optimization. Tracks usage in real-time,
 * selects optimization strategies based on budget pressure and task type,
 * and learns from historical effectiveness.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenGovernor = void 0;
exports.getTokenGovernor = getTokenGovernor;
exports.resetTokenGovernor = resetTokenGovernor;
const DEFAULT_CONFIG = {
    totalBudget: 200000,
    thresholds: {
        relaxed: 0.4,
        moderate: 0.65,
        tight: 0.85,
        critical: 1.0,
    },
    enableLearning: true,
};
const STRATEGY_DEFS = {
    relaxed: [
        {
            strategy: 'observation_mask',
            baseIntensity: 0.3,
            reason: 'Baseline masking',
            goodFor: [],
            badFor: [],
        },
    ],
    moderate: [
        {
            strategy: 'observation_mask',
            baseIntensity: 0.5,
            reason: 'Moderate masking',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'tool_output_truncate',
            baseIntensity: 0.3,
            reason: 'Truncate verbose outputs',
            goodFor: ['search', 'analysis'],
            badFor: [],
        },
        {
            strategy: 'response_format',
            baseIntensity: 0.3,
            reason: 'Request concise responses',
            goodFor: ['structured'],
            badFor: ['creative'],
        },
    ],
    tight: [
        {
            strategy: 'observation_mask',
            baseIntensity: 0.8,
            reason: 'Aggressive masking',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'context_compaction',
            baseIntensity: 0.5,
            reason: 'Compact conversation',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'tool_output_truncate',
            baseIntensity: 0.6,
            reason: 'Aggressive truncation',
            goodFor: ['search'],
            badFor: [],
        },
        {
            strategy: 'response_format',
            baseIntensity: 0.6,
            reason: 'Force concise',
            goodFor: ['structured'],
            badFor: ['creative'],
        },
        {
            strategy: 'verification_skip',
            baseIntensity: 0.5,
            reason: 'Skip LLM verification',
            goodFor: ['search'],
            badFor: ['code'],
        },
        {
            strategy: 'prompt_compression',
            baseIntensity: 0.4,
            reason: 'Compress prompt',
            goodFor: [],
            badFor: [],
        },
    ],
    critical: [
        {
            strategy: 'observation_mask',
            baseIntensity: 1.0,
            reason: 'Maximum masking',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'context_compaction',
            baseIntensity: 1.0,
            reason: 'Emergency compaction',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'tool_output_truncate',
            baseIntensity: 1.0,
            reason: 'Minimal output',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'response_format',
            baseIntensity: 1.0,
            reason: 'Maximally terse',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'verification_skip',
            baseIntensity: 1.0,
            reason: 'Skip all verification',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'prompt_compression',
            baseIntensity: 1.0,
            reason: 'Minimal prompt',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'speculative_skip',
            baseIntensity: 1.0,
            reason: 'No speculation',
            goodFor: [],
            badFor: [],
        },
        {
            strategy: 'entropy_gating',
            baseIntensity: 1.0,
            reason: 'Skip optional tools',
            goodFor: [],
            badFor: [],
        },
    ],
};
// ============================================================================
// Governor
// ============================================================================
class TokenGovernor {
    constructor(config) {
        this.usedTokens = 0;
        this.taskCategory = 'general';
        this.historyHead = 0;
        this.historyCount = 0;
        this.maxHistory = 500;
        this.decayHalfLifeMs = 20 * 60 * 1000; // 20 minutes
        // Pre-bucketed strategy index for O(1) lookups
        this.strategyIndex = new Map();
        // Cache for recommendations (invalidated on reportUsage or setTaskCategory)
        this.cachedPhase = null;
        this.cachedRecommendations = null;
        this.cachedRecommendationsMap = null;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.history = new Array(this.maxHistory);
    }
    // ---------------------------------------------------------------------------
    // Budget tracking
    // ---------------------------------------------------------------------------
    reportUsage(tokens) {
        this.usedTokens += tokens;
        this.cachedPhase = null; // Invalidate cache
    }
    getState() {
        const remaining = Math.max(0, this.config.totalBudget - this.usedTokens);
        const pressure = this.config.totalBudget > 0 ? Math.min(1, this.usedTokens / this.config.totalBudget) : 1;
        let phase;
        if (pressure < this.config.thresholds.relaxed)
            phase = 'relaxed';
        else if (pressure < this.config.thresholds.moderate)
            phase = 'moderate';
        else if (pressure < this.config.thresholds.tight)
            phase = 'tight';
        else
            phase = 'critical';
        return {
            totalBudget: this.config.totalBudget,
            usedTokens: this.usedTokens,
            remainingTokens: remaining,
            pressure,
            phase,
        };
    }
    reset(budget) {
        this.usedTokens = 0;
        if (budget !== undefined)
            this.config.totalBudget = budget;
        this.cachedPhase = null;
        this.cachedRecommendations = null;
        this.cachedRecommendationsMap = null;
        this.historyHead = 0;
        this.historyCount = 0;
        this.strategyIndex.clear();
    }
    /** Set task category for strategy selection. Call before first shouldApply(). */
    setTaskCategory(cat) {
        this.taskCategory = cat;
        this.cachedPhase = null;
    }
    // ---------------------------------------------------------------------------
    // Strategy decisions (cached)
    // ---------------------------------------------------------------------------
    getRecommendations() {
        var _a;
        const state = this.getState();
        // Return cached if phase hasn't changed
        if (this.cachedPhase === state.phase && this.cachedRecommendations) {
            return this.cachedRecommendations;
        }
        const defs = (_a = STRATEGY_DEFS[state.phase]) !== null && _a !== void 0 ? _a : STRATEGY_DEFS.relaxed;
        let decisions = defs.map((d) => {
            let intensity = d.baseIntensity;
            // Adjust intensity based on task type
            if (d.goodFor.includes(this.taskCategory)) {
                intensity = Math.min(1, intensity + 0.15);
            }
            if (d.badFor.includes(this.taskCategory)) {
                intensity = Math.max(0, intensity - 0.2);
            }
            return {
                strategy: d.strategy,
                apply: true,
                intensity,
                reason: d.reason,
            };
        });
        // Apply learning adjustments
        if (this.config.enableLearning) {
            decisions = this.adjustByLearning(decisions);
        }
        this.cachedPhase = state.phase;
        this.cachedRecommendations = decisions;
        // Build O(1) lookup map
        this.cachedRecommendationsMap = new Map(decisions.map((d) => [d.strategy, d]));
        return decisions;
    }
    shouldApply(strategy) {
        var _a;
        // Ensure recommendations are built
        this.getRecommendations();
        const decision = (_a = this.cachedRecommendationsMap) === null || _a === void 0 ? void 0 : _a.get(strategy);
        return decision
            ? { apply: decision.apply, intensity: decision.intensity }
            : { apply: false, intensity: 0 };
    }
    // ---------------------------------------------------------------------------
    // Learning (with time decay)
    // ---------------------------------------------------------------------------
    recordOutcome(strategy, tokensBefore, tokensAfter) {
        if (!this.config.enableLearning)
            return;
        const now = Date.now();
        const record = { strategy, effective: tokensBefore > tokensAfter, timestamp: now };
        // Ring buffer: O(1) insert
        if (this.historyCount < this.maxHistory) {
            this.history[this.historyHead] = record;
            this.historyHead = (this.historyHead + 1) % this.maxHistory;
            this.historyCount++;
        }
        else {
            // Evict oldest from strategy index
            const evicted = this.history[this.historyHead];
            const evictedList = this.strategyIndex.get(evicted.strategy);
            if (evictedList) {
                const idx = evictedList.indexOf(evicted);
                if (idx !== -1)
                    evictedList.splice(idx, 1);
                if (evictedList.length === 0)
                    this.strategyIndex.delete(evicted.strategy);
            }
            this.history[this.historyHead] = record;
            this.historyHead = (this.historyHead + 1) % this.maxHistory;
        }
        // Update strategy index
        let list = this.strategyIndex.get(strategy);
        if (!list) {
            list = [];
            this.strategyIndex.set(strategy, list);
        }
        list.push(record);
        // Invalidate cache since learning may change decisions
        this.cachedPhase = null;
        this.cachedRecommendationsMap = null;
    }
    strategyEffectiveness(strategy) {
        // O(1) lookup via strategy index instead of linear scan
        const records = this.strategyIndex.get(strategy);
        if (!records || records.length < 3)
            return 0.5;
        const now = Date.now();
        let weightedEffective = 0;
        let totalWeight = 0;
        for (const r of records) {
            const age = now - r.timestamp;
            const weight = Math.exp(-age / this.decayHalfLifeMs);
            totalWeight += weight;
            if (r.effective)
                weightedEffective += weight;
        }
        return totalWeight > 0 ? weightedEffective / totalWeight : 0.5;
    }
    adjustByLearning(decisions) {
        return decisions.map((d) => {
            const effectiveness = this.strategyEffectiveness(d.strategy);
            // Demote strategies that are consistently ineffective, regardless of intensity
            if (effectiveness < 0.3) {
                return {
                    ...d,
                    apply: false,
                    reason: `${d.reason} (demoted: ${(effectiveness * 100).toFixed(0)}% effective)`,
                };
            }
            // Gradually reduce intensity for moderately ineffective strategies
            if (effectiveness < 0.5) {
                return {
                    ...d,
                    intensity: Math.max(0.1, d.intensity * effectiveness * 2),
                    reason: `${d.reason} (reduced: ${(effectiveness * 100).toFixed(0)}% effective)`,
                };
            }
            // Boost consistently effective strategies
            if (effectiveness > 0.8) {
                return { ...d, intensity: Math.min(1, d.intensity + 0.1) };
            }
            return d;
        });
    }
    // ---------------------------------------------------------------------------
    // Budget estimation
    // ---------------------------------------------------------------------------
    static estimateTokens(text) {
        var _a;
        // Use precompiled regex for CJK detection — single pass, much faster than char-by-char
        const cjkCount = ((_a = text.match(TokenGovernor.CJK_RE)) !== null && _a !== void 0 ? _a : []).length;
        return Math.ceil((text.length - cjkCount) / 4 + cjkCount / 1.5);
    }
    remainingForComponent(ratio) {
        return Math.floor(this.getState().remainingTokens * ratio);
    }
}
exports.TokenGovernor = TokenGovernor;
// Precompiled CJK regex for fast token estimation (g flag required for match() to return all occurrences)
TokenGovernor.CJK_RE = /[一-鿿㐀-䶿]/g;
// ============================================================================
// Singleton
// ============================================================================
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
let _governorConfig;
const governorSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new TokenGovernor(_governorConfig));
/** Get the global TokenGovernor (single-tenant) or tenant-scoped (multi-tenant). */
function getTokenGovernor(config) {
    if (config)
        _governorConfig = config;
    return governorSingleton.get();
}
/** Reset the token governor singleton (for test isolation). */
function resetTokenGovernor() {
    governorSingleton.reset();
}
