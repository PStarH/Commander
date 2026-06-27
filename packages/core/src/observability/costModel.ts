import type { CostBreakdown, ModelPricing, TokenBreakdown } from './types';
import { getLiteLLMPricing } from '../security/litellmPricing';

export const DEFAULT_PRICING: ModelPricing[] = [
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
  { provider: 'google', model: 'gemini-2.0-flash', inputPer1k: 0.0001, outputPer1k: 0.0004, cachedInputPer1k: 0.000025 },
  {
    provider: 'deepseek',
    model: 'deepseek-chat',
    inputPer1k: 0.00014,
    outputPer1k: 0.00028,
    cachedInputPer1k: 0.000014,
  },
  { provider: 'deepseek', model: 'deepseek-reasoner', inputPer1k: 0.00014, outputPer1k: 0.00219, cachedInputPer1k: 0.000014 },
  // xAI Grok
  { provider: 'xai', model: 'grok-2-latest', inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.001 },
  { provider: 'xai', model: 'grok-3-latest', inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0015 },
  // Mistral
  { provider: 'mistral', model: 'mistral-large-latest', inputPer1k: 0.002, outputPer1k: 0.006, cachedInputPer1k: 0.001 },
  { provider: 'mistral', model: 'mistral-small-latest', inputPer1k: 0.0002, outputPer1k: 0.0006, cachedInputPer1k: 0.0001 },
  // Cohere
  { provider: 'cohere', model: 'command-a-plus', inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 },
  { provider: 'cohere', model: 'command-r-plus', inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 },
  // MiniMax
  { provider: 'minimax', model: 'MiniMax-M3', inputPer1k: 0.001, outputPer1k: 0.004, cachedInputPer1k: 0.0001 },
  // GLM (Zhipu AI)
  { provider: 'glm', model: 'glm-4.7', inputPer1k: 0.0007, outputPer1k: 0.0028, cachedInputPer1k: 0.00007 },
  { provider: 'glm', model: 'glm-4.6', inputPer1k: 0.0007, outputPer1k: 0.0028, cachedInputPer1k: 0.00007 },
  // Xiaomi MiMo
  { provider: 'xiaomi', model: 'mimo-v2-flash', inputPer1k: 0.00018, outputPer1k: 0.00018, cachedInputPer1k: 0.000018 },
  { provider: 'xiaomi', model: 'mimo-v2-pro', inputPer1k: 0.0007, outputPer1k: 0.0028, cachedInputPer1k: 0.00007 },
  // MiMo (token-plan endpoint)
  { provider: 'mimo', model: 'mimo-v2.5', inputPer1k: 0.0007, outputPer1k: 0.0028, cachedInputPer1k: 0.00007 },
  // StepFun
  { provider: 'stepfun', model: 'step-3.7-flash', inputPer1k: 0.0003, outputPer1k: 0.0009, cachedInputPer1k: 0.00003 },
];

const FALLBACK_PRICING: ModelPricing = {
  provider: 'unknown',
  model: 'unknown',
  inputPer1k: 0.001,
  outputPer1k: 0.002,
};

export class CostModel {
  private readonly pricing: Map<string, ModelPricing> = new Map();
  private readonly fallback: ModelPricing;
  private litellmSynced = false;

  constructor(customPricing?: ModelPricing[], fallback?: ModelPricing) {
    for (const p of DEFAULT_PRICING) {
      this.pricing.set(this.key(p.provider, p.model), p);
    }
    if (customPricing) {
      for (const p of customPricing) {
        this.pricing.set(this.key(p.provider, p.model), p);
      }
    }
    this.fallback = fallback ?? FALLBACK_PRICING;
  }

  addPricing(p: ModelPricing): void {
    this.pricing.set(this.key(p.provider, p.model), p);
  }

  /**
   * Sync pricing from LiteLLM's real-time pricing data.
   * For each hardcoded model, if LiteLLM has updated pricing, override it.
   * Also adds models that exist in LiteLLM but not in our hardcoded list.
   * Safe to call multiple times — only syncs once per instance.
   */
  syncFromLiteLLM(): void {
    if (this.litellmSynced) return;
    const litellm = getLiteLLMPricing();
    if (!litellm.isLoaded()) return; // data not yet fetched

    // Override existing entries with LiteLLM real-time data
    for (const [key, existing] of this.pricing) {
      const modelId = existing.model;
      const litellmInput = litellm.getCostPer1MTokens(modelId);
      const litellmCacheRead = litellm.getCacheReadCostPer1MTokens(modelId);

      if (litellmInput != null) {
        // LiteLLM returns blended per-1M; split into input/output using ratio
        // from existing entry ( LiteLLM's blended = (input + output) / 2 per 1M)
        const existingRatio = existing.inputPer1k / (existing.inputPer1k + existing.outputPer1k);
        const per1k = litellmInput / 1000; // convert per-1M to per-1K
        const newInput = per1k * existingRatio * 2;
        const newOutput = per1k * (1 - existingRatio) * 2;

        this.pricing.set(key, {
          ...existing,
          inputPer1k: newInput,
          outputPer1k: newOutput,
          cachedInputPer1k: litellmCacheRead != null ? litellmCacheRead / 1000 : existing.cachedInputPer1k,
          batchInputPer1k: newInput * 0.5,
          batchOutputPer1k: newOutput * 0.5,
        });
      }
    }

    this.litellmSynced = true;
  }

  /**
   * Try to get pricing from LiteLLM for an unknown model.
   * Returns undefined if LiteLLM has no data.
   */
  private tryLiteLLM(provider: string, model: string): ModelPricing | undefined {
    const litellm = getLiteLLMPricing();
    if (!litellm.isLoaded()) return undefined;

    // Try exact model ID, then provider-prefixed variants
    const candidates = [model, `${provider}/${model}`, model.replace(/-/g, '.')];
    for (const candidate of candidates) {
      const per1M = litellm.getCostPer1MTokens(candidate);
      if (per1M != null) {
        const per1k = per1M / 1000;
        const cacheRead1M = litellm.getCacheReadCostPer1MTokens(candidate);
        return {
          provider,
          model,
          inputPer1k: per1k * 0.4, // estimate: 40% of blended is input
          outputPer1k: per1k * 0.6, // estimate: 60% of blended is output
          cachedInputPer1k: cacheRead1M != null ? cacheRead1M / 1000 : undefined,
          batchInputPer1k: per1k * 0.4 * 0.5,
          batchOutputPer1k: per1k * 0.6 * 0.5,
        };
      }
    }
    return undefined;
  }

  getPricing(provider: string, model: string): ModelPricing {
    const stripped = this.stripTierSuffix(model);
    const exact = this.pricing.get(this.key(provider, stripped));
    if (exact) return exact;
    const prefixMatch = Array.from(this.pricing.values()).find(
      (p) => p.provider === provider && stripped.startsWith(p.model),
    );
    if (prefixMatch) return prefixMatch;
    // Try LiteLLM real-time pricing for unknown models
    const litellmPricing = this.tryLiteLLM(provider, stripped);
    if (litellmPricing) return litellmPricing;
    return this.fallback;
  }

  /**
   * Calculate cost with optional batch discount.
   * When isBatch is true, uses batch pricing (50% discount on input + output).
   * Returns batchSavingsUsd = (standardCost - batchCost).
   */
  calculate(provider: string, model: string, tokens: TokenBreakdown, isBatch = false): CostBreakdown {
    const p = this.getPricing(provider, model);
    const cachedClamped = Math.min(tokens.cached, tokens.input);
    const billableInput = Math.max(0, tokens.input - cachedClamped);

    const inputRate = isBatch ? (p.batchInputPer1k ?? p.inputPer1k * 0.5) : p.inputPer1k;
    const outputRate = isBatch ? (p.batchOutputPer1k ?? p.outputPer1k * 0.5) : p.outputPer1k;

    const inputCost = (billableInput / 1000) * inputRate;
    const outputCost = (tokens.output / 1000) * outputRate;
    const cachedCost = p.cachedInputPer1k ? (cachedClamped / 1000) * p.cachedInputPer1k : 0;
    const reasoningCost = p.reasoningPer1k ? (tokens.reasoning / 1000) * p.reasoningPer1k : 0;

    let batchSavingsUsd: number | undefined;
    if (isBatch) {
      const standardInputCost = (billableInput / 1000) * p.inputPer1k;
      const standardOutputCost = (tokens.output / 1000) * p.outputPer1k;
      batchSavingsUsd = (standardInputCost - inputCost) + (standardOutputCost - outputCost);
      if (batchSavingsUsd <= 0) batchSavingsUsd = undefined;
    }

    return {
      totalCostUsd: inputCost + outputCost + cachedCost + reasoningCost,
      inputCostUsd: inputCost,
      outputCostUsd: outputCost,
      cachedCostUsd: cachedCost > 0 ? cachedCost : undefined,
      reasoningCostUsd: reasoningCost > 0 ? reasoningCost : undefined,
      batchSavingsUsd,
    };
  }

  emptyCost(): CostBreakdown {
    return { totalCostUsd: 0, inputCostUsd: 0, outputCostUsd: 0 };
  }

  emptyTokens(): TokenBreakdown {
    return { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 };
  }

  addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
    return {
      input: a.input + b.input,
      output: a.output + b.output,
      cached: a.cached + b.cached,
      reasoning: a.reasoning + b.reasoning,
      total: a.total + b.total,
    };
  }

  addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
    const batchA = a.batchSavingsUsd ?? 0;
    const batchB = b.batchSavingsUsd ?? 0;
    return {
      totalCostUsd: a.totalCostUsd + b.totalCostUsd,
      inputCostUsd: a.inputCostUsd + b.inputCostUsd,
      outputCostUsd: a.outputCostUsd + b.outputCostUsd,
      cachedCostUsd: (a.cachedCostUsd ?? 0) + (b.cachedCostUsd ?? 0) || undefined,
      reasoningCostUsd: (a.reasoningCostUsd ?? 0) + (b.reasoningCostUsd ?? 0) || undefined,
      batchSavingsUsd: (batchA + batchB) || undefined,
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
  getSavingsForCachedReads(
    provider: string,
    model: string,
    cachedTokens: number,
    inputTokens: number,
  ): { cachedClamped: number; dollarsSaved: number; dollarsUncachedEquivalent: number } {
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
   * Compute batch savings for a given model and token count.
   * Returns the dollar amount saved by using batch API (50% discount).
   */
  getBatchSavings(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): { batchCostUsd: number; standardCostUsd: number; savingsUsd: number } {
    const p = this.getPricing(provider, this.stripTierSuffix(model));
    const batchInputRate = p.batchInputPer1k ?? p.inputPer1k * 0.5;
    const batchOutputRate = p.batchOutputPer1k ?? p.outputPer1k * 0.5;
    const standardCost = (inputTokens / 1000) * p.inputPer1k + (outputTokens / 1000) * p.outputPer1k;
    const batchCost = (inputTokens / 1000) * batchInputRate + (outputTokens / 1000) * batchOutputRate;
    return {
      batchCostUsd: batchCost,
      standardCostUsd: standardCost,
      savingsUsd: Math.max(0, standardCost - batchCost),
    };
  }

  /**
   * Strip the @tier suffix from modelId before looking up pricing.
   * e.g. 'claude-3-5-sonnet@eco' → 'claude-3-5-sonnet'
   */
  private stripTierSuffix(model: string): string {
    const atIdx = model.indexOf('@');
    return atIdx > 0 ? model.slice(0, atIdx) : model;
  }

  private key(provider: string, model: string): string {
    return `${provider.toLowerCase()}:${model.toLowerCase()}`;
  }
}

let _default: CostModel | null = null;
export function getCostModel(): CostModel {
  if (!_default) {
    _default = new CostModel();
    // Trigger background sync from LiteLLM (non-blocking)
    // syncFromLiteLLM is a no-op if LiteLLM data hasn't loaded yet;
    // LiteLLM's ensureLoaded() fires a background fetch, and the next
    // getCostModel() call (after data arrives) will pick it up.
    try {
      _default.syncFromLiteLLM();
    } catch {
      // LiteLLM not available yet — hardcoded pricing is used as fallback
    }
  }
  return _default;
}
export function resetCostModel(): void {
  _default = null;
}
