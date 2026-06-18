"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrossModelMemory = void 0;
const betaDistribution_1 = require("./betaDistribution");
class CrossModelMemory {
    constructor() {
        /** Per-model, per-strategy Thompson Sampling: Map<modelId, Map<strategyName, BetaDistribution>> */
        this.perModelPriors = new Map();
    }
    recordExperience(exp) {
        const prior = this.getOrCreatePerModelPriors(exp.modelUsed, exp.strategyUsed);
        prior.update(exp.success);
    }
    getStrategyScoresForModel(modelId, strategyPerformance) {
        const modelMap = this.perModelPriors.get(modelId);
        if (!modelMap) {
            // No per-model data yet — return empty, caller can fall back to global
            return [];
        }
        return Array.from(modelMap.entries())
            .map(([strategy, prior]) => {
            const perf = strategyPerformance.get(strategy);
            return {
                strategy,
                score: prior.mean,
                trials: prior.totalTrials,
                avgDurationMs: perf === null || perf === void 0 ? void 0 : perf.avgDurationMs,
                p95DurationMs: perf === null || perf === void 0 ? void 0 : perf.p95DurationMs,
            };
        })
            .sort((a, b) => b.score - a.score);
    }
    getPerModelStats() {
        const stats = [];
        for (const [modelId, modelMap] of this.perModelPriors) {
            for (const [strategy, prior] of modelMap) {
                stats.push({
                    modelId,
                    strategy,
                    totalRuns: prior.totalTrials,
                    successCount: prior.alpha - 1,
                    successRate: prior.mean,
                    avgTokenCost: 0,
                    lastUsed: '',
                });
            }
        }
        return stats;
    }
    getPerModelPriors() {
        return this.perModelPriors;
    }
    setPerModelPriors(priors) {
        this.perModelPriors = priors;
    }
    getOrCreatePerModelPriors(modelId, strategy) {
        if (!this.perModelPriors.has(modelId)) {
            if (this.perModelPriors.size >= CrossModelMemory.MAX_PER_MODEL_PRIORS) {
                const oldest = this.perModelPriors.keys().next().value;
                if (oldest)
                    this.perModelPriors.delete(oldest);
            }
            this.perModelPriors.set(modelId, new Map());
        }
        const modelMap = this.perModelPriors.get(modelId);
        if (!modelMap.has(strategy)) {
            modelMap.set(strategy, new betaDistribution_1.BetaDistribution());
        }
        return modelMap.get(strategy);
    }
}
exports.CrossModelMemory = CrossModelMemory;
CrossModelMemory.MAX_PER_MODEL_PRIORS = 50;
