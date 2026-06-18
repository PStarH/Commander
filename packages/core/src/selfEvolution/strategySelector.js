"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategySelector = void 0;
const betaDistribution_1 = require("./betaDistribution");
const strategyConstants_1 = require("./strategyConstants");
class StrategySelector {
    constructor() {
        this.thompsonPriors = new Map();
    }
    computeAdjustmentFactors(taskType, strategyPerformance) {
        const priors = this.getOrCreatePriors(taskType);
        const totalSamples = priors.reduce((s, p) => s + p.totalTrials, 0);
        // Thompson Sampling: sample from each Beta distribution
        const samples = priors.map((p) => p.sample());
        // UCB1 exploration bonus: encourages trying under-explored strategies
        const explorationBonuses = priors.map((p) => p.explorationBonus(totalSamples));
        // Speed bonus: multiply Thompson sample by a speed factor [0.7, 1.3]
        // Only applied when we have enough data (≥3 runs) to have meaningful duration stats.
        const speedFactors = strategyConstants_1.STRATEGY_NAMES.map((name) => {
            const perf = strategyPerformance.get(name);
            if (!perf || perf.totalRuns < 3)
                return 1.0;
            const allP95 = strategyConstants_1.STRATEGY_NAMES.map((n) => { var _a; return (_a = strategyPerformance.get(n)) === null || _a === void 0 ? void 0 : _a.p95DurationMs; }).filter((d) => d !== undefined && d > 0);
            if (allP95.length < 2)
                return 1.0;
            const medianP95 = allP95.sort((a, b) => a - b)[Math.floor(allP95.length / 2)];
            const ratio = perf.p95DurationMs / medianP95;
            return Math.max(0.7, Math.min(1.3, 2.0 - ratio));
        });
        // Cost-aware bonus (Budgeted Bandits-inspired): penalize expensive strategies
        // Only applied when we have enough data (≥3 runs).
        const costFactors = strategyConstants_1.STRATEGY_NAMES.map((name) => {
            const perf = strategyPerformance.get(name);
            if (!perf || perf.totalRuns < 3)
                return 1.0;
            const allCosts = strategyConstants_1.STRATEGY_NAMES.map((n) => { var _a; return (_a = strategyPerformance.get(n)) === null || _a === void 0 ? void 0 : _a.avgTokenCost; }).filter((c) => c !== undefined && c > 0);
            if (allCosts.length < 2)
                return 1.0;
            const medianCost = allCosts.sort((a, b) => a - b)[Math.floor(allCosts.length / 2)];
            const ratio = perf.avgTokenCost / medianCost;
            return Math.max(0.8, Math.min(1.2, 2.0 - ratio));
        });
        const explorationWeight = totalSamples < 20 ? 0.5 : 0.2;
        return { samples, explorationBonuses, speedFactors, costFactors, explorationWeight };
    }
    selectStrategy(taskType, strategyPerformance, modelId) {
        const { samples, explorationBonuses, speedFactors, costFactors, explorationWeight } = this.computeAdjustmentFactors(taskType, strategyPerformance);
        const adjusted = samples.map((s, i) => (s + explorationWeight * explorationBonuses[i]) * speedFactors[i] * costFactors[i]);
        const bestIdx = adjusted.indexOf(Math.max(...adjusted));
        return strategyConstants_1.STRATEGY_NAMES[bestIdx];
    }
    /**
     * Calculate the adjusted score for every strategy.
     * Mirrors the scoring used by selectStrategy so callers can inspect the ranking.
     */
    calculateAdjustedScores(taskType, strategyPerformance) {
        const { samples, explorationBonuses, speedFactors, costFactors, explorationWeight } = this.computeAdjustmentFactors(taskType, strategyPerformance);
        const adjusted = samples.map((s, i) => (s + explorationWeight * explorationBonuses[i]) * speedFactors[i] * costFactors[i]);
        return strategyConstants_1.STRATEGY_NAMES.map((name, i) => ({ name, score: adjusted[i] })).sort((a, b) => b.score - a.score);
    }
    getStrategyScores(taskType, strategyPerformance) {
        const priors = this.getOrCreatePriors(taskType);
        return strategyConstants_1.STRATEGY_NAMES.map((name, i) => {
            const perf = strategyPerformance.get(name);
            return {
                strategy: name,
                score: priors[i].mean,
                trials: priors[i].totalTrials,
                avgDurationMs: perf === null || perf === void 0 ? void 0 : perf.avgDurationMs,
                p95DurationMs: perf === null || perf === void 0 ? void 0 : perf.p95DurationMs,
            };
        }).sort((a, b) => b.score - a.score);
    }
    /**
     * Select the runner-up (second-best) strategy for shadow mode comparison.
     * Returns null if there aren't at least 2 strategies with data.
     */
    selectShadowStrategy(taskType, strategyPerformance) {
        var _a;
        const priors = this.getOrCreatePriors(taskType);
        const ranked = this.getStrategyScores(taskType, strategyPerformance);
        if (ranked.length < 2)
            return null;
        const runnerUp = ranked.find((r, i) => {
            if (i === 0)
                return false; // skip the winner
            return priors[strategyConstants_1.STRATEGY_NAMES.indexOf(r.strategy)].totalTrials > 0;
        });
        return (_a = runnerUp === null || runnerUp === void 0 ? void 0 : runnerUp.strategy) !== null && _a !== void 0 ? _a : null;
    }
    /**
     * Feed a shadow comparison result into the Thompson priors as a weak signal.
     */
    recordShadowComparison(params) {
        const priors = this.getOrCreatePriors(params.taskType);
        const shadowIdx = strategyConstants_1.STRATEGY_NAMES.indexOf(params.shadowStrategy);
        if (shadowIdx < 0)
            return;
        const weight = 0.5;
        if (params.shadowSuccess) {
            priors[shadowIdx].alpha += weight;
        }
        else {
            priors[shadowIdx].beta += weight;
        }
    }
    getTrackedTaskTypes() {
        return Array.from(this.thompsonPriors.keys());
    }
    recordExperience(exp) {
        const priors = this.getOrCreatePriors(exp.taskType);
        const idx = strategyConstants_1.STRATEGY_NAMES.indexOf(exp.strategyUsed);
        if (idx >= 0) {
            const difficulty = this.estimateTaskDifficulty(exp);
            priors[idx].update(exp.success, difficulty);
        }
    }
    getThompsonPriors() {
        return this.thompsonPriors;
    }
    setThompsonPriors(priors) {
        this.thompsonPriors = priors;
    }
    getOrCreatePriors(taskType) {
        if (!this.thompsonPriors.has(taskType)) {
            if (this.thompsonPriors.size >= StrategySelector.MAX_THOMPSON_PRIORS) {
                const oldest = this.thompsonPriors.keys().next().value;
                if (oldest)
                    this.thompsonPriors.delete(oldest);
            }
            this.thompsonPriors.set(taskType, strategyConstants_1.STRATEGY_NAMES.map(() => new betaDistribution_1.BetaDistribution()));
        }
        return this.thompsonPriors.get(taskType);
    }
    estimateTaskDifficulty(exp) {
        var _a, _b;
        let difficulty = 0.5; // baseline
        // Higher token cost → harder task
        if (exp.tokenCost > 50000)
            difficulty += 0.2;
        else if (exp.tokenCost > 20000)
            difficulty += 0.1;
        // Longer duration → harder task
        if (exp.durationMs > 60000)
            difficulty += 0.15;
        else if (exp.durationMs > 30000)
            difficulty += 0.05;
        // Error patterns suggest complexity
        if (exp.errorPattern) {
            if (/context|overflow|token/i.test(exp.errorPattern))
                difficulty += 0.1;
            if (/timeout|deadline/i.test(exp.errorPattern))
                difficulty += 0.1;
        }
        // Multi-tool tasks are harder
        if (((_b = (_a = exp.toolsUsed) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > 3)
            difficulty += 0.1;
        return Math.min(1, difficulty);
    }
}
exports.StrategySelector = StrategySelector;
StrategySelector.MAX_THOMPSON_PRIORS = 200;
