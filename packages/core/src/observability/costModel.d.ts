import type { CostBreakdown, ModelPricing, TokenBreakdown } from './types';
export declare const DEFAULT_PRICING: ModelPricing[];
export declare class CostModel {
    private readonly pricing;
    private readonly fallback;
    constructor(customPricing?: ModelPricing[], fallback?: ModelPricing);
    addPricing(p: ModelPricing): void;
    getPricing(provider: string, model: string): ModelPricing;
    calculate(provider: string, model: string, tokens: TokenBreakdown): CostBreakdown;
    emptyCost(): CostBreakdown;
    emptyTokens(): TokenBreakdown;
    addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown;
    addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown;
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
    getSavingsForCachedReads(provider: string, model: string, cachedTokens: number, inputTokens: number): {
        cachedClamped: number;
        dollarsSaved: number;
        dollarsUncachedEquivalent: number;
    };
    /**
     * Strip the @tier suffix from modelId before looking up pricing.
     * e.g. 'claude-3-5-sonnet@eco' → 'claude-3-5-sonnet'
     */
    private stripTierSuffix;
    private key;
}
export declare function getCostModel(): CostModel;
export declare function resetCostModel(): void;
//# sourceMappingURL=costModel.d.ts.map