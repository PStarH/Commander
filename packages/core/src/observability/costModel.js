"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CostModel = exports.DEFAULT_PRICING = void 0;
exports.getCostModel = getCostModel;
exports.resetCostModel = resetCostModel;
exports.DEFAULT_PRICING = [
    {
        provider: 'openai',
        model: 'gpt-4o',
        inputPer1k: 0.0025,
        outputPer1k: 0.01,
        cachedInputPer1k: 0.00125,
    },
    {
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputPer1k: 0.00015,
        outputPer1k: 0.0006,
        cachedInputPer1k: 0.000075,
    },
    { provider: 'openai', model: 'gpt-4-turbo', inputPer1k: 0.01, outputPer1k: 0.03 },
    { provider: 'openai', model: 'gpt-3.5-turbo', inputPer1k: 0.0005, outputPer1k: 0.0015 },
    { provider: 'openai', model: 'o1', inputPer1k: 0.015, outputPer1k: 0.06, reasoningPer1k: 0.06 },
    {
        provider: 'openai',
        model: 'o1-mini',
        inputPer1k: 0.003,
        outputPer1k: 0.012,
        reasoningPer1k: 0.012,
    },
    {
        provider: 'openai',
        model: 'o3-mini',
        inputPer1k: 0.0011,
        outputPer1k: 0.0044,
        reasoningPer1k: 0.0044,
    },
    {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        inputPer1k: 0.003,
        outputPer1k: 0.015,
        cachedInputPer1k: 0.0003,
    },
    {
        provider: 'anthropic',
        model: 'claude-3-5-haiku',
        inputPer1k: 0.0008,
        outputPer1k: 0.004,
        cachedInputPer1k: 0.00008,
    },
    { provider: 'anthropic', model: 'claude-3-opus', inputPer1k: 0.015, outputPer1k: 0.075 },
    {
        provider: 'google',
        model: 'gemini-1.5-pro',
        inputPer1k: 0.00125,
        outputPer1k: 0.005,
        cachedInputPer1k: 0.00031,
    },
    {
        provider: 'google',
        model: 'gemini-1.5-flash',
        inputPer1k: 0.000075,
        outputPer1k: 0.0003,
        cachedInputPer1k: 0.00001875,
    },
    { provider: 'google', model: 'gemini-2.0-flash', inputPer1k: 0.0001, outputPer1k: 0.0004 },
    {
        provider: 'deepseek',
        model: 'deepseek-chat',
        inputPer1k: 0.00014,
        outputPer1k: 0.00028,
        cachedInputPer1k: 0.000014,
    },
    { provider: 'deepseek', model: 'deepseek-reasoner', inputPer1k: 0.00014, outputPer1k: 0.00219 },
];
const FALLBACK_PRICING = {
    provider: 'unknown',
    model: 'unknown',
    inputPer1k: 0.001,
    outputPer1k: 0.002,
};
class CostModel {
    constructor(customPricing, fallback) {
        this.pricing = new Map();
        for (const p of exports.DEFAULT_PRICING) {
            this.pricing.set(this.key(p.provider, p.model), p);
        }
        if (customPricing) {
            for (const p of customPricing) {
                this.pricing.set(this.key(p.provider, p.model), p);
            }
        }
        this.fallback = fallback !== null && fallback !== void 0 ? fallback : FALLBACK_PRICING;
    }
    addPricing(p) {
        this.pricing.set(this.key(p.provider, p.model), p);
    }
    getPricing(provider, model) {
        const exact = this.pricing.get(this.key(provider, model));
        if (exact)
            return exact;
        const prefixMatch = Array.from(this.pricing.values()).find((p) => p.provider === provider && model.startsWith(p.model));
        if (prefixMatch)
            return prefixMatch;
        return this.fallback;
    }
    calculate(provider, model, tokens) {
        const p = this.getPricing(provider, model);
        const cachedClamped = Math.min(tokens.cached, tokens.input);
        const billableInput = Math.max(0, tokens.input - cachedClamped);
        const inputCost = (billableInput / 1000) * p.inputPer1k;
        const outputCost = (tokens.output / 1000) * p.outputPer1k;
        const cachedCost = p.cachedInputPer1k ? (cachedClamped / 1000) * p.cachedInputPer1k : 0;
        const reasoningCost = p.reasoningPer1k ? (tokens.reasoning / 1000) * p.reasoningPer1k : 0;
        return {
            totalCostUsd: inputCost + outputCost + cachedCost + reasoningCost,
            inputCostUsd: inputCost,
            outputCostUsd: outputCost,
            cachedCostUsd: cachedCost > 0 ? cachedCost : undefined,
            reasoningCostUsd: reasoningCost > 0 ? reasoningCost : undefined,
        };
    }
    emptyCost() {
        return { totalCostUsd: 0, inputCostUsd: 0, outputCostUsd: 0 };
    }
    emptyTokens() {
        return { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 };
    }
    addTokens(a, b) {
        return {
            input: a.input + b.input,
            output: a.output + b.output,
            cached: a.cached + b.cached,
            reasoning: a.reasoning + b.reasoning,
            total: a.total + b.total,
        };
    }
    addCost(a, b) {
        var _a, _b, _c, _d;
        return {
            totalCostUsd: a.totalCostUsd + b.totalCostUsd,
            inputCostUsd: a.inputCostUsd + b.inputCostUsd,
            outputCostUsd: a.outputCostUsd + b.outputCostUsd,
            cachedCostUsd: ((_a = a.cachedCostUsd) !== null && _a !== void 0 ? _a : 0) + ((_b = b.cachedCostUsd) !== null && _b !== void 0 ? _b : 0) || undefined,
            reasoningCostUsd: ((_c = a.reasoningCostUsd) !== null && _c !== void 0 ? _c : 0) + ((_d = b.reasoningCostUsd) !== null && _d !== void 0 ? _d : 0) || undefined,
        };
    }
    /**
     * Pure function: compute the dollar savings from cached tokens.
     * Returns clamped count + uncached equivalent + dollars saved.
     * Used by tests and the promptCacheSavings metric recording path.
     *
     * @param provider - provider name (e.g. 'anthropic')
     * @param model - model name (e.g. 'claude-3-5-sonnet')
     * @param cachedTokens - number of tokens reported as cache reads
     * @param inputTokens - total input tokens (used to clamp over-reports)
     */
    getSavingsForCachedReads(provider, model, cachedTokens, inputTokens) {
        if (cachedTokens <= 0) {
            return { cachedClamped: 0, dollarsSaved: 0, dollarsUncachedEquivalent: 0 };
        }
        const pricing = this.getPricing(provider, this.stripTierSuffix(model));
        const clamped = Math.min(cachedTokens, inputTokens);
        const uncachedEquivalent = (clamped / 1000) * pricing.inputPer1k;
        const cachedCost = pricing.cachedInputPer1k ? (clamped / 1000) * pricing.cachedInputPer1k : 0;
        const dollarsSaved = uncachedEquivalent - cachedCost;
        return { cachedClamped: clamped, dollarsSaved, dollarsUncachedEquivalent: uncachedEquivalent };
    }
    /**
     * Strip the @tier suffix from modelId before looking up pricing.
     * e.g. 'claude-3-5-sonnet@eco' → 'claude-3-5-sonnet'
     */
    stripTierSuffix(model) {
        const atIdx = model.indexOf('@');
        return atIdx > 0 ? model.slice(0, atIdx) : model;
    }
    key(provider, model) {
        return `${provider.toLowerCase()}:${model.toLowerCase()}`;
    }
}
exports.CostModel = CostModel;
let _default = null;
function getCostModel() {
    if (!_default)
        _default = new CostModel();
    return _default;
}
function resetCostModel() {
    _default = null;
}
