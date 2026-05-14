import type { TokenUsage } from '../runtime/types';
import type {
  TELOSBudget,
  TokenCheckResult,
  CostRecord,
  CostSummary,
  BudgetAlert,
} from './types';
import { getModelRouter } from '../runtime/modelRouter';

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
      (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified
      (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
      (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
      (code >= 0xAC00 && code <= 0xD7AF)      // Hangul
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
// Cost Calculator
// ============================================================================

function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const router = getModelRouter();
  const model = router.getModel(modelId);
  if (!model) {
    // Fallback: default rates
    return ((inputTokens + outputTokens) / 1000) * 0.002;
  }
  return (
    (inputTokens / 1000) * model.costPer1KInput +
    (outputTokens / 1000) * model.costPer1KOutput
  );
}

// ============================================================================
// Token Sentinel — unified guard
// ============================================================================

export class TokenSentinel {
  private costRecords: CostRecord[] = [];
  private budgetAlerts: BudgetAlert[] = [];
  private maxRecords: number;
  private monthlyCostLimitUsd: number;
  private monthlyCostUsd: number = 0;
  private monthlyResetDate: string;

  constructor(
    maxRecords = 10000,
    monthlyCostLimitUsd = 50.00,
  ) {
    this.maxRecords = maxRecords;
    this.monthlyCostLimitUsd = monthlyCostLimitUsd;
    this.monthlyResetDate = new Date().toISOString().slice(0, 7); // YYYY-MM
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
      messages.find(m => m.role === 'user')?.content ?? '',
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

    const remaining = budget.hardCapTokens > 0
      ? Math.max(0, budget.hardCapTokens - totalEstimated)
      : totalEstimated;

    // Soft cap warning — log but allow
    if (budget.softCapTokens > 0 && totalEstimated > budget.softCapTokens) {
      this.budgetAlerts.push({
        type: 'soft_cap_warning',
        runId: 'preflight',
        current: totalEstimated,
        limit: budget.softCapTokens,
        message: `Estimated ${totalEstimated} tokens exceeds soft cap of ${budget.softCapTokens}`,
      });
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

  recordCost(record: CostRecord): void {
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
    }
  }

  recordCostFromUsage(
    runId: string,
    agentId: string,
    modelId: string,
    usage: TokenUsage,
  ): CostRecord {
    const router = getModelRouter();
    const model = router.getModel(modelId);
    const costUsd = calculateCost(modelId, usage.promptTokens, usage.completionTokens);

    const record: CostRecord = {
      runId,
      modelId,
      provider: model?.provider ?? 'unknown',
      tier: model?.tier ?? 'standard',
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      costUsd: Math.round(costUsd * 100000) / 100000,
      timestamp: new Date().toISOString(),
      agentId,
    };

    this.recordCost(record);
    return record;
  }

  getCosts(runId?: string): CostRecord[] {
    if (runId) {
      return this.costRecords.filter(r => r.runId === runId);
    }
    return [...this.costRecords];
  }

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

  checkBudget(
    runId: string,
    currentTokens: number,
    budget: TELOSBudget,
  ): BudgetAlert | null {
    if (budget.hardCapTokens > 0 && currentTokens >= budget.hardCapTokens) {
      const alert: BudgetAlert = {
        type: 'hard_cap_reached',
        runId,
        current: currentTokens,
        limit: budget.hardCapTokens,
        message: `Hard cap of ${budget.hardCapTokens} tokens reached (${currentTokens})`,
      };
      this.budgetAlerts.push(alert);
      return alert;
    }
    return null;
  }

  checkCostBudget(runId: string): BudgetAlert | null {
    if (this.monthlyCostLimitUsd > 0 && this.monthlyCostUsd >= this.monthlyCostLimitUsd) {
      const alert: BudgetAlert = {
        type: 'budget_exhausted',
        runId,
        current: this.monthlyCostUsd,
        limit: this.monthlyCostLimitUsd,
        message: `Monthly budget exhausted: $${this.monthlyCostUsd.toFixed(2)} >= $${this.monthlyCostLimitUsd}`,
      };
      this.budgetAlerts.push(alert);
      return alert;
    }
    return null;
  }

  getAlerts(): BudgetAlert[] {
    return [...this.budgetAlerts];
  }

  getMonthlyCostUsd(): number {
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

let globalSentinel: TokenSentinel | null = null;

export function getTokenSentinel(): TokenSentinel {
  if (!globalSentinel) {
    globalSentinel = new TokenSentinel();
  }
  return globalSentinel;
}

export function resetTokenSentinel(): void {
  globalSentinel = null;
}

export { estimateTokenCount, estimateMessagesTokens, calculateCost };
