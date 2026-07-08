import type { TELOSBudget, TokenCheckResult, BudgetAlert } from './types';
import { getModelRouter } from '../runtime/modelRouter';
import { getCostModel } from '../observability/costModel';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import type { TokenBreakdown as ObservabilityTokenBreakdown } from '../observability/types';

// ============================================================================
// Token Counter — estimate before sending
// ============================================================================

const CHARS_PER_TOKEN: Record<string, number> = {
  claude: 3.5,
  gpt: 4.0,
  gemini: 4.0,
  default: 3.7,
};

function detectModelFamily(modelId: string): string {
  if (modelId.includes('claude')) return 'claude';
  if (modelId.includes('gpt') || modelId.includes('o1') || modelId.includes('o3')) return 'gpt';
  if (modelId.includes('gemini')) return 'gemini';
  return 'default';
}

function estimateTokenCount(text: string, modelId: string): number {
  const family = detectModelFamily(modelId);
  const cpt = CHARS_PER_TOKEN[family] ?? CHARS_PER_TOKEN.default;

  let eastAsianChars = 0;
  let otherChars = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af) // Hangul
    ) {
      eastAsianChars++;
    } else {
      otherChars++;
    }
  }

  // East Asian chars compress differently (~1.5 chars/token for CJK)
  const eastAsianTokens = eastAsianChars / 1.5;
  const otherTokens = otherChars / cpt;

  return Math.ceil(eastAsianTokens + otherTokens);
}

function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>,
  modelId: string,
): number {
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
// Cost Calculator — delegates to the unified CostModel in observability/costModel.ts
//
// The CostModel class maintains the single source of truth for model pricing
// (DEFAULT_PRICING with 18+ models). This module adapts the CostModel output
// to the TokenSentinel's CostBreakdown format (which includes cache savings).
// ============================================================================

/**
 * Per-provider cache pricing multipliers, derived from CostModel's cachedInputPer1k.
 * These express the ratio of cached input price to regular input price.
 * Used to compute cacheSavingsUsd for the CostBreakdown.
 *
 * Backward-compatible: exported as CACHE_MULTIPLIERS for tests and consumers
 * that reference the read/write ratio per provider.
 */
const CACHE_READ_RATIO: Record<string, number> = {
  anthropic: 0.1, // 90% off cache reads
  openai: 0.5, // 50% off cache reads
  google: 0.1, // ~90% off cache reads
  default: 1.0, // No caching benefit assumed
};

/** Per-provider cache write pricing multipliers (applied to input rate). */
const CACHE_WRITE_RATIO: Record<string, number> = {
  anthropic: 1.25, // 1.25x write (5min TTL)
  openai: 1.0, // Automatic (no explicit write cost)
  google: 1.0, // No explicit write cost
  default: 1.0,
};

/**
 * Backward-compatible export for tests that reference the old CACHE_MULTIPLIERS map.
 * Derived from the read/write ratios above.
 */
export const CACHE_MULTIPLIERS: Record<string, { read: number; write: number }> = {
  anthropic: { read: CACHE_READ_RATIO.anthropic, write: CACHE_WRITE_RATIO.anthropic },
  openai: { read: CACHE_READ_RATIO.openai, write: CACHE_WRITE_RATIO.openai },
  google: { read: CACHE_READ_RATIO.google, write: CACHE_WRITE_RATIO.google },
  default: { read: CACHE_READ_RATIO.default, write: CACHE_WRITE_RATIO.default },
};

export interface CostBreakdown {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  totalUsd: number;
  /** Tokens that were served from cache (saved money) */
  cacheSavingsUsd: number;
  /** Savings from batch API (50% discount vs standard pricing) */
  batchSavingsUsd?: number;
}

/**
 * Calculate cost breakdown using the unified CostModel pricing.
 *
 * This delegates to CostModel.calculate() for the core cost computation,
 * then adapts the result to include cache read/write breakdown and savings.
 *
 * The CostModel is the single source of truth for model pricing —
 * no duplicate pricing tables are maintained here.
 */
export function calculateCostBreakdown(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  isBatch: boolean = false,
): CostBreakdown {
  const router = getModelRouter();
  const model = router.getModel(modelId);
  const provider = model?.provider ?? 'unknown';

  // Get the unified CostModel instance
  const costModel = getCostModel();

  // No model in router → use conservative $2/M fallback (split 80/20 input/output)
  if (!model) {
    const fallbackRate = 0.002;
    const inputRate = fallbackRate * 0.8;
    const outputRate = fallbackRate * 0.2;
    const total =
      ((inputTokens + cacheReadTokens + cacheWriteTokens) / 1000) * inputRate +
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

  // Try CostModel first (single source of truth for pricing)
  const tokenBreakdown: ObservabilityTokenBreakdown = {
    input: inputTokens,
    output: outputTokens,
    cached: cacheReadTokens,
    reasoning: 0,
    total: inputTokens + outputTokens + cacheReadTokens,
  };

  const costBreakdown = costModel.calculate(provider, modelId, tokenBreakdown, isBatch);

  // If CostModel didn't find the model (cachedCostUsd undefined but we have cache reads),
  // fall back to router pricing × cache ratio for backward compatibility
  const cacheReadRatio = CACHE_READ_RATIO[provider] ?? CACHE_READ_RATIO.default;
  const cacheWriteRatio = CACHE_WRITE_RATIO[provider] ?? CACHE_WRITE_RATIO.default;
  const inputRatePerToken = model.costPer1MInput / 1_000_000;

  let cacheReadCostUsd = costBreakdown.cachedCostUsd ?? 0;
  if (cacheReadTokens > 0 && cacheReadCostUsd === 0) {
    cacheReadCostUsd = cacheReadTokens * inputRatePerToken * cacheReadRatio;
  }

  // Compute cache write cost (not tracked by CostModel)
  const cacheWriteCostUsd = cacheWriteTokens * inputRatePerToken * cacheWriteRatio;

  // Compute savings: what we would have paid at full input price vs. cache price
  const cacheSavingsUsd = cacheReadTokens * inputRatePerToken * (1 - cacheReadRatio);

  return {
    inputCostUsd: costBreakdown.inputCostUsd,
    outputCostUsd: costBreakdown.outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    totalUsd:
      costBreakdown.inputCostUsd +
      costBreakdown.outputCostUsd +
      cacheReadCostUsd +
      cacheWriteCostUsd,
    cacheSavingsUsd,
    batchSavingsUsd: costBreakdown.batchSavingsUsd,
  };
}

function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  return calculateCostBreakdown(
    modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  ).totalUsd;
}

// ============================================================================
// Token Sentinel — unified guard
// ============================================================================

/**
 * TokenSentinel — pre-flight token estimation and token-budget gate.
 *
 * Cost tracking and budget enforcement have moved to
 * {@link UnifiedCostAuthority} (UCA). TokenSentinel now only provides
 * pre-flight token counting that UCA does not replicate (UCA consumes
 * estimatedTokens as input rather than computing it from messages).
 */
export class TokenSentinel {
  private budgetAlerts: BudgetAlert[] = [];
  private maxAlerts: number;

  constructor(maxAlerts = 1000) {
    this.maxAlerts = maxAlerts;
  }

  private trimAlerts(): void {
    while (this.budgetAlerts.length > this.maxAlerts) {
      this.budgetAlerts.shift();
    }
  }

  // ========================================================================
  // Token Estimation (pre-flight check)
  // ========================================================================

  estimatePromptTokens(
    messages: Array<{ role: string; content: string }>,
    modelId: string,
  ): number {
    return estimateMessagesTokens(messages, modelId);
  }

  estimateOutputTokens(goal: string, modelId: string): number {
    return Math.min(estimateTokenCount(goal, modelId) * 2, 16384);
  }

  check(
    messages: Array<{ role: string; content: string }>,
    modelId: string,
    budget: TELOSBudget,
  ): TokenCheckResult {
    const estimatedInput = estimateMessagesTokens(messages, modelId);
    const estimatedOutput = this.estimateOutputTokens(
      messages.find((m) => m.role === 'user')?.content ?? '',
      modelId,
    );
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

    const remaining =
      budget.hardCapTokens > 0 ? Math.max(0, budget.hardCapTokens - totalEstimated) : Infinity;

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
  // Budget Enforcement
  // ========================================================================

  checkBudget(runId: string, currentTokens: number, budget: TELOSBudget): BudgetAlert | null {
    if (budget.hardCapTokens > 0 && currentTokens > budget.hardCapTokens) {
      const alert: BudgetAlert = {
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

  getAlerts(): BudgetAlert[] {
    return [...this.budgetAlerts];
  }
}

const sentinelSingleton = createTenantAwareSingleton(() => new TokenSentinel(), {});

/** Get the global TokenSentinel singleton (token estimation only). */
export function getTokenSentinel(): TokenSentinel {
  return sentinelSingleton.get();
}

export function resetTokenSentinel(): void {
  sentinelSingleton.reset();
}

export { estimateTokenCount, estimateMessagesTokens, calculateCost };
