import type { TokenUsage } from '../runtime/types';
import type { TELOSBudget, TokenCheckResult, CostRecord, CostSummary, BudgetAlert } from './types';
import { getModelRouter } from '../runtime/modelRouter';
import { getCostModel } from '../observability/costModel';
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
 * TokenSentinel — pre-flight token estimation + cost tracking.
 *
 * The cost-tracking portion (recordCost, recordCostFromUsage, checkCostBudget,
 * getCostSummary, getMonthlyCostUsd) is @deprecated and superseded by
 * {@link UnifiedCostAuthority} (UCA). UCA is now the single source of truth
 * for per-request / per-run / per-tenant / global budget enforcement and
 * melt triggering.
 *
 * The token-estimation portion (estimatePromptTokens, estimateOutputTokens,
 * check) remains non-deprecated — it provides pre-flight token counting that
 * UCA does not replicate (UCA consumes estimatedTokens as input rather than
 * computing it from messages).
 *
 * Migration map (TokenSentinel cost → UCA):
 *   recordCostFromUsage()  → UCA.postCall({ model }, { costUsd, promptTokens, completionTokens })
 *   checkCostBudget()      → UCA.getSnapshot().perTenantMonthly (MELT auto-triggered in postCall)
 *   getCostSummary()       → UCA.readLedger() (aggregated by kind/modelOrTool)
 *   getMonthlyCostUsd()    → UCA.getSnapshot(runId, tenantId).perTenantMonthly.used
 *   monthlyCostLimitUsd    → UCA DEFAULT_UCA_CONFIG.perTenantMonthlyUsd
 */
export class TokenSentinel {
  private costRecords: CostRecord[] = [];
  private budgetAlerts: BudgetAlert[] = [];
  private maxRecords: number;
  private maxAlerts: number;
  private monthlyCostLimitUsd: number;
  private monthlyCostUsd: number = 0;
  private monthlyResetDate: string;

  constructor(maxRecords = 10000, maxAlerts = 1000, monthlyCostLimitUsd = 50.0) {
    this.maxRecords = maxRecords;
    this.maxAlerts = maxAlerts;
    this.monthlyCostLimitUsd = monthlyCostLimitUsd;
    this.monthlyResetDate = new Date().toISOString().slice(0, 7); // YYYY-MM
    emitTokenSentinelDeprecationWarning();
  }

  /** Ensure monthly cost counter is current (auto-reset on month boundary). */
  private ensureCurrentMonth(): void {
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (currentMonth !== this.monthlyResetDate) {
      this.monthlyCostUsd = 0;
      this.monthlyResetDate = currentMonth;
    }
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
    this.ensureCurrentMonth();
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
  // Cost Tracking (DEPRECATED — use UnifiedCostAuthority instead)
  // ========================================================================

  /** @deprecated Use UnifiedCostAuthority.postCall() for cost recording. */
  recordCost(record: CostRecord): void {
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

  /** @deprecated Use UnifiedCostAuthority.postCall() with actual token counts. */
  recordCostFromUsage(
    runId: string,
    agentId: string,
    modelId: string,
    usage: TokenUsage,
  ): CostRecord {
    const router = getModelRouter();
    const model = router.getModel(modelId);
    const breakdown = calculateCostBreakdown(
      modelId,
      usage.promptTokens,
      usage.completionTokens,
      usage.cacheReadTokens ?? 0,
      usage.cacheWriteTokens ?? 0,
    );

    const record: CostRecord = {
      runId,
      modelId,
      provider: model?.provider ?? 'unknown',
      tier: model?.tier ?? 'standard',
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costUsd: Math.round(breakdown.totalUsd * 100000) / 100000,
      cacheSavingsUsd: Math.round(breakdown.cacheSavingsUsd * 100000) / 100000,
      timestamp: new Date().toISOString(),
      agentId,
    };

    this.recordCost(record);
    return record;
  }

  getCosts(runId?: string): CostRecord[] {
    if (runId) {
      return this.costRecords.filter((r) => r.runId === runId);
    }
    return [...this.costRecords];
  }

  /** @deprecated Use UnifiedCostAuthority.readLedger() for cost aggregation. */
  getCostSummary(): CostSummary {
    const summary: CostSummary = {
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

  /** @deprecated Use UnifiedCostAuthority.postCall() — MELT auto-triggers on budget breach. */
  checkCostBudget(runId: string): BudgetAlert | null {
    this.ensureCurrentMonth();
    if (this.monthlyCostLimitUsd > 0 && this.monthlyCostUsd >= this.monthlyCostLimitUsd) {
      const alert: BudgetAlert = {
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

  getAlerts(): BudgetAlert[] {
    return [...this.budgetAlerts];
  }

  /** @deprecated Use UnifiedCostAuthority.getSnapshot().perTenantMonthly.used. */
  getMonthlyCostUsd(): number {
    this.ensureCurrentMonth();
    return Math.round(this.monthlyCostUsd * 100000) / 100000;
  }

  getMonthlyLimitUsd(): number {
    return this.monthlyCostLimitUsd;
  }

  resetMonthly(): void {
    this.monthlyCostUsd = 0;
    this.monthlyResetDate = new Date().toISOString().slice(0, 7);
    this.costRecords = [];
    this.budgetAlerts = [];
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

/**
 * Emit a one-time deprecation warning when TokenSentinel is instantiated.
 * The cost-tracking portion is deprecated in favor of UnifiedCostAuthority;
 * token estimation remains supported.
 */
let tokenSentinelDeprecationWarned = false;
function emitTokenSentinelDeprecationWarning(): void {
  if (tokenSentinelDeprecationWarned) return;
  tokenSentinelDeprecationWarned = true;
  try {
    if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
      process.emitWarning(
        'TokenSentinel cost-tracking is deprecated — use UnifiedCostAuthority ' +
          '(getUnifiedCostAuthority) for budget enforcement. Token estimation ' +
          '(estimatePromptTokens/estimateOutputTokens) remains supported.',
        { type: 'DeprecationWarning', code: 'COMMANDER_TOKENSENTINEL_DEPRECATED' },
      );
    }
  } catch {
    /* emitWarning must never throw */
  }
}

const sentinelSingleton = createTenantAwareSingleton(() => new TokenSentinel());

/**
 * Get the global TokenSentinel singleton.
 *
 * Note: cost-tracking methods are @deprecated — see class JSDoc.
 * Token estimation methods remain supported.
 */
export function getTokenSentinel(): TokenSentinel {
  return sentinelSingleton.get();
}

export function resetTokenSentinel(): void {
  sentinelSingleton.reset();
}

export { estimateTokenCount, estimateMessagesTokens, calculateCost };
