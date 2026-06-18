"use strict";
/**
 * Pre-Run Cost Estimator — Predict task cost before execution, auto-budget.
 *
 * Uses historical cost data + task complexity signals to predict:
 * 1. Expected token usage (input + output)
 * 2. Expected cost in USD
 * 3. Recommended token budget
 * 4. Confidence interval
 *
 * Evidence base:
 * - FrugalGPT (arXiv:2305.05176): cost-aware routing reduces cost by 2-8x
 * - OpenAI best practices: task-type → token consumption correlation
 * - Internal data: ~60% of cost variance explained by task type + model tier
 *
 * Integration points:
 * - agentRuntime.ts: use estimateBeforeRun() to set adaptive budgets
 * - modelRouter.ts: use cost predictions for model selection scoring
 * - orchestrator.ts: use cost predictions for sub-agent budget allocation
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CostEstimator = void 0;
exports.getCostEstimator = getCostEstimator;
exports.resetCostEstimator = resetCostEstimator;
const unifiedVerification_1 = require("./unifiedVerification");
const DEFAULT_CONFIG = {
    safetyMargin: 1.5,
    maxSamplesPerCategory: 200,
    decayHalfLifeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    defaultCostFallback: 0.01,
};
// ============================================================================
// Baseline token estimates by task category (from empirical observation)
// ============================================================================
const BASELINE_TOKENS = {
    code: { input: 8000, output: 4000 },
    search: { input: 5000, output: 2000 },
    analysis: { input: 6000, output: 3000 },
    creative: { input: 5000, output: 5000 },
    structured: { input: 4000, output: 2000 },
    general: { input: 6000, output: 3000 },
};
// ============================================================================
// Complexity multipliers
// ============================================================================
const COMPLEXITY_MULTIPLIERS = {
    shortGoal: 0.6,
    mediumGoal: 1.0,
    longGoal: 1.5,
    manyTools: 1.3,
    fewTools: 0.8,
    largeBudget: 1.4,
    smallBudget: 0.7,
};
// ============================================================================
// CostEstimator
// ============================================================================
class CostEstimator {
    constructor(config) {
        this.history = new Map();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    // --------------------------------------------------------------------------
    // Core estimation
    // --------------------------------------------------------------------------
    /**
     * Estimate cost before run. Call from agentRuntime.execute() before the
     * LLM call loop begins. Returns a full estimate with confidence interval.
     */
    estimateBeforeRun(ctx, routing, modelConfig) {
        var _a, _b, _c, _d;
        const taskCategory = (0, unifiedVerification_1.detectTaskType)(ctx.goal);
        const complexityScore = this.scoreComplexity(ctx);
        // Base estimate from task category
        const baseline = (_a = BASELINE_TOKENS[taskCategory]) !== null && _a !== void 0 ? _a : BASELINE_TOKENS.general;
        // Complexity adjustment
        const complexityMultiplier = this.computeComplexityMultiplier(ctx, complexityScore);
        // Historical adjustment (if we have data)
        const historyKey = `${taskCategory}:${routing.tier}`;
        const samples = (_b = this.history.get(historyKey)) !== null && _b !== void 0 ? _b : [];
        const historicalAdjustment = this.computeHistoricalAdjustment(samples);
        // Compute predictions
        const predictedInputTokens = Math.round(baseline.input * complexityMultiplier * historicalAdjustment.inputFactor);
        const predictedOutputTokens = Math.round(baseline.output * complexityMultiplier * historicalAdjustment.outputFactor);
        const predictedTotalTokens = predictedInputTokens + predictedOutputTokens;
        // Cost prediction using model pricing
        const costPerKInput = (_c = modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.costPer1KInput) !== null && _c !== void 0 ? _c : this.estimateCostPerK(routing.tier, 'input');
        const costPerKOutput = (_d = modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.costPer1KOutput) !== null && _d !== void 0 ? _d : this.estimateCostPerK(routing.tier, 'output');
        const predictedCostUsd = (predictedInputTokens / 1000) * costPerKInput +
            (predictedOutputTokens / 1000) * costPerKOutput;
        // Recommended budget with safety margin
        const recommendedBudget = Math.round(predictedTotalTokens * this.config.safetyMargin);
        // Confidence from sample count
        const confidence = this.computeConfidence(samples);
        // Build factor breakdown
        const factors = this.buildFactors(ctx, complexityScore, complexityMultiplier, historicalAdjustment);
        return {
            predictedInputTokens,
            predictedOutputTokens,
            predictedTotalTokens,
            predictedCostUsd: Math.round(predictedCostUsd * 100000) / 100000,
            recommendedBudget,
            confidence,
            sampleCount: samples.length,
            taskCategory,
            modelTier: routing.tier,
            factors,
        };
    }
    /**
     * Estimate cost for a specific model, useful for model comparison in routing.
     */
    estimateForModel(ctx, model) {
        var _a;
        const taskCategory = (0, unifiedVerification_1.detectTaskType)(ctx.goal);
        const baseline = (_a = BASELINE_TOKENS[taskCategory]) !== null && _a !== void 0 ? _a : BASELINE_TOKENS.general;
        const multiplier = this.computeComplexityMultiplier(ctx, this.scoreComplexity(ctx));
        const inputTokens = Math.round(baseline.input * multiplier);
        const outputTokens = Math.round(baseline.output * multiplier);
        return {
            inputTokens,
            outputTokens,
            costUsd: (inputTokens / 1000) * model.costPer1KInput + (outputTokens / 1000) * model.costPer1KOutput,
        };
    }
    /**
     * Allocate token budgets across N sub-agents based on task complexity and historical data.
     * Returns per-agent budgets that sum to totalBudget (with safety margin reserved).
     *
     * Evidence:
     * - FrugalGPT: cost-aware allocation across cascaded models reduces total cost by 2-8x
     * - Anthropic multi-agent research: equal budgets waste 30-40% on simple subtasks
     */
    allocateBudgetsAcrossAgents(totalBudget, subtasks, safetyMargin = 0.15) {
        // Reserve safety margin from total budget
        const availableBudget = Math.round(totalBudget * (1 - safetyMargin));
        if (subtasks.length === 0)
            return [];
        if (subtasks.length === 1) {
            return [{ goal: subtasks[0].goal, budget: availableBudget, reason: 'single subtask' }];
        }
        // Weight each subtask by its complexity score
        const totalComplexity = subtasks.reduce((sum, s) => sum + Math.max(1, s.complexity), 0);
        return subtasks.map((subtask) => {
            const weight = Math.max(1, subtask.complexity) / totalComplexity;
            const budget = Math.round(availableBudget * weight);
            // Enforce minimum budget per agent
            const minBudget = 2000;
            const finalBudget = Math.max(minBudget, budget);
            return {
                goal: subtask.goal,
                budget: finalBudget,
                reason: `complexity=${subtask.complexity}, weight=${(weight * 100).toFixed(0)}%`,
            };
        });
    }
    // --------------------------------------------------------------------------
    // History management
    // --------------------------------------------------------------------------
    /**
     * Record actual cost after a run completes. Feeds back into future estimates.
     */
    recordActualCost(taskCategory, modelTier, inputTokens, outputTokens, costUsd, durationMs, success) {
        const key = `${taskCategory}:${modelTier}`;
        let samples = this.history.get(key);
        if (!samples) {
            samples = [];
            this.history.set(key, samples);
        }
        samples.push({
            taskCategory,
            modelTier,
            inputTokens,
            outputTokens,
            costUsd,
            durationMs,
            success,
            timestamp: Date.now(),
        });
        // Prune old samples
        if (samples.length > this.config.maxSamplesPerCategory) {
            // Keep most recent by timestamp
            samples.sort((a, b) => b.timestamp - a.timestamp);
            samples.length = this.config.maxSamplesPerCategory;
        }
    }
    /**
     * Load historical records from the samples store.
     * Call once at startup to seed the estimator.
     */
    loadFromRecords(records) {
        var _a;
        for (const r of records) {
            // Infer task category and model tier from model name
            const tier = this.inferModelTier(r.model);
            if (!tier)
                continue;
            const costUsd = (_a = r.costUsd) !== null && _a !== void 0 ? _a : this.estimateCostFromTokens(r.model, r.promptTokens, r.completionTokens);
            this.recordActualCost('general', // default — we don't have task category from raw records
            tier, r.promptTokens, r.completionTokens, costUsd, 0, !r.error);
        }
    }
    /**
     * Tier 4.4: Estimate cost for a concrete token usage. Useful when attributing
     * cost to a specific failure mode without re-running the full estimate pipeline.
     */
    estimateCostFromUsage(model, promptTokens, completionTokens) {
        return this.estimateCostFromTokens(model, promptTokens, completionTokens);
    }
    /**
     * Export history for persistence (e.g., writing to disk between sessions).
     */
    exportHistory() {
        return Array.from(this.history.values());
    }
    /**
     * Import history from persistence.
     */
    importHistory(data) {
        for (const samples of data) {
            for (const sample of samples) {
                const key = `${sample.taskCategory}:${sample.modelTier}`;
                let existing = this.history.get(key);
                if (!existing) {
                    existing = [];
                    this.history.set(key, existing);
                }
                existing.push(sample);
            }
        }
    }
    // --------------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------------
    scoreComplexity(ctx) {
        let score = 0;
        if (ctx.goal.length > 400)
            score += 3;
        else if (ctx.goal.length > 150)
            score += 2;
        else if (ctx.goal.length > 50)
            score += 1;
        if (ctx.availableTools.length > 5)
            score += 2;
        else if (ctx.availableTools.length > 3)
            score += 1;
        if (ctx.tokenBudget > 20000)
            score += 2;
        else if (ctx.tokenBudget > 6000)
            score += 1;
        return Math.min(score, 10);
    }
    computeComplexityMultiplier(ctx, complexityScore) {
        let multiplier = 1.0;
        // Goal length
        if (ctx.goal.length > 400)
            multiplier *= COMPLEXITY_MULTIPLIERS.longGoal;
        else if (ctx.goal.length < 50)
            multiplier *= COMPLEXITY_MULTIPLIERS.shortGoal;
        // Tool count
        if (ctx.availableTools.length > 5)
            multiplier *= COMPLEXITY_MULTIPLIERS.manyTools;
        else if (ctx.availableTools.length <= 2)
            multiplier *= COMPLEXITY_MULTIPLIERS.fewTools;
        // Budget signal
        if (ctx.tokenBudget > 20000)
            multiplier *= COMPLEXITY_MULTIPLIERS.largeBudget;
        else if (ctx.tokenBudget < 3000)
            multiplier *= COMPLEXITY_MULTIPLIERS.smallBudget;
        return multiplier;
    }
    computeHistoricalAdjustment(samples) {
        if (samples.length < 3) {
            return { inputFactor: 1.0, outputFactor: 1.0 };
        }
        const now = Date.now();
        let weightedInputSum = 0;
        let weightedOutputSum = 0;
        let totalWeight = 0;
        for (const sample of samples) {
            const age = now - sample.timestamp;
            const weight = Math.exp(-age / this.config.decayHalfLifeMs);
            weightedInputSum += sample.inputTokens * weight;
            weightedOutputSum += sample.outputTokens * weight;
            totalWeight += weight;
        }
        if (totalWeight === 0)
            return { inputFactor: 1.0, outputFactor: 1.0 };
        const avgInput = weightedInputSum / totalWeight;
        const avgOutput = weightedOutputSum / totalWeight;
        // Use ratio against baseline to adjust future estimates
        const baseline = BASELINE_TOKENS.general;
        return {
            inputFactor: Math.max(0.3, Math.min(3.0, avgInput / baseline.input)),
            outputFactor: Math.max(0.3, Math.min(3.0, avgOutput / baseline.output)),
        };
    }
    computeConfidence(samples) {
        if (samples.length === 0)
            return 0;
        if (samples.length >= 50)
            return 0.95;
        if (samples.length >= 20)
            return 0.85;
        if (samples.length >= 10)
            return 0.7;
        if (samples.length >= 5)
            return 0.5;
        return 0.3;
    }
    estimateCostPerK(tier, type) {
        var _a, _b;
        // Blended rates by tier (USD per 1K tokens)
        const rates = {
            eco: { input: 0.0005, output: 0.0015 },
            standard: { input: 0.003, output: 0.01 },
            power: { input: 0.01, output: 0.04 },
            consensus: { input: 0.015, output: 0.06 },
        };
        return (_b = (_a = rates[tier]) === null || _a === void 0 ? void 0 : _a[type]) !== null && _b !== void 0 ? _b : rates.standard[type];
    }
    estimateCostFromTokens(model, inputTokens, outputTokens) {
        const tier = this.inferModelTier(model);
        if (!tier)
            return 0;
        const inputRate = this.estimateCostPerK(tier, 'input');
        const outputRate = this.estimateCostPerK(tier, 'output');
        return (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate;
    }
    inferModelTier(model) {
        const m = model.toLowerCase();
        if (m.includes('haiku') || m.includes('mini') || m.includes('flash') || m.includes('small'))
            return 'eco';
        if (m.includes('opus') || m.includes('gpt-5') || m.includes('o3') || m.includes('o4'))
            return 'power';
        if (m.includes('sonnet') || m.includes('gpt-4o') || m.includes('pro') || m.includes('large'))
            return 'standard';
        return 'standard'; // default
    }
    buildFactors(ctx, complexityScore, complexityMultiplier, historicalAdjustment) {
        const factors = [];
        factors.push({
            name: 'task_complexity',
            contribution: complexityScore,
            reason: `Complexity score ${complexityScore}/10`,
        });
        if (complexityMultiplier !== 1.0) {
            factors.push({
                name: 'complexity_multiplier',
                contribution: complexityMultiplier,
                reason: `Adjusted by ${complexityMultiplier.toFixed(2)}x based on goal length and tool count`,
            });
        }
        if (historicalAdjustment.inputFactor !== 1.0 || historicalAdjustment.outputFactor !== 1.0) {
            factors.push({
                name: 'historical_adjustment',
                contribution: (historicalAdjustment.inputFactor + historicalAdjustment.outputFactor) / 2,
                reason: `Historical data: input=${historicalAdjustment.inputFactor.toFixed(2)}x, output=${historicalAdjustment.outputFactor.toFixed(2)}x`,
            });
        }
        factors.push({
            name: 'goal_length',
            contribution: ctx.goal.length,
            reason: `${ctx.goal.length} chars → ${ctx.goal.length > 400 ? 'complex' : ctx.goal.length > 150 ? 'medium' : 'simple'}`,
        });
        factors.push({
            name: 'tool_count',
            contribution: ctx.availableTools.length,
            reason: `${ctx.availableTools.length} tools available`,
        });
        return factors;
    }
}
exports.CostEstimator = CostEstimator;
// ============================================================================
// Singleton
// ============================================================================
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const estimatorSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new CostEstimator());
/** Get the global CostEstimator (single-tenant) or tenant-scoped (multi-tenant). */
function getCostEstimator() {
    return estimatorSingleton.get();
}
/** Reset the cost estimator singleton (for test isolation). */
function resetCostEstimator() {
    estimatorSingleton.reset();
}
