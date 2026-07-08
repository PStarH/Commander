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

import type { AgentExecutionContext, RoutingDecision, ModelConfig } from './types';
import type { TaskCategory } from './tokenGovernor';
import { detectTaskType } from './unifiedVerification';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface CostEstimate {
  /** Predicted input tokens (system prompt + context + history) */
  predictedInputTokens: number;
  /** Predicted output tokens (LLM response + tool calls) */
  predictedOutputTokens: number;
  /** Predicted total tokens */
  predictedTotalTokens: number;
  /** Predicted cost in USD for the selected model */
  predictedCostUsd: number;
  /** Recommended token budget (includes 1.5x safety margin) */
  recommendedBudget: number;
  /** Confidence level [0-1]: 1 = high confidence (many historical samples) */
  confidence: number;
  /** Number of historical samples used for this prediction */
  sampleCount: number;
  /** Task category detected from goal */
  taskCategory: TaskCategory;
  /** Model tier selected */
  modelTier: string;
  /** Breakdown of cost factors */
  factors: CostFactor[];
}

export interface CostFactor {
  name: string;
  contribution: number; // token estimate
  reason: string;
}

export interface HistoricalTaskCost {
  taskCategory: TaskCategory;
  modelTier: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  success: boolean;
  timestamp: number;
}

export interface CostEstimatorConfig {
  /** Safety margin multiplier for recommended budget (default: 1.5) */
  safetyMargin: number;
  /** Maximum historical samples to retain per category (default: 200) */
  maxSamplesPerCategory: number;
  /** Decay half-life for historical weights in ms (default: 7 days) */
  decayHalfLifeMs: number;
  /** Default cost when no history available (USD) */
  defaultCostFallback: number;
}

const DEFAULT_CONFIG: CostEstimatorConfig = {
  safetyMargin: 1.5,
  maxSamplesPerCategory: 200,
  decayHalfLifeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  defaultCostFallback: 0.01,
};

// ============================================================================
// Baseline token estimates by task category (from empirical observation)
// ============================================================================

const BASELINE_TOKENS: Record<TaskCategory, { input: number; output: number }> = {
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
// Model pricing table (per 1M tokens, in USD)
//
// Single source of truth for CostEstimator-aligned pricing. The values mirror
// `packages/core/src/observability/costModel.ts` DEFAULT_PRICING (which is
// per-1K), and are spelt out as per-1M here to match CostEstimator's existing
// `costPer1MInput` / `costPer1MOutput` convention.
//
// We intentionally inline this table rather than importing from `costModel.ts`:
//   1. CostEstimator must do synchronous lookups (no LiteLLM fetch latency).
//   2. Avoid runtime → observability cross-import that the layering has not
//      yet declared safe.
//   3. Keep bench-cost-prediction.ts (which only passes bare model names
//      like 'gpt-4o-mini', not 'openai:gpt-4o-mini') working without a
//      provider prefix.
//
// When updated, mirror changes in `costModel.ts`. Drift here will surface as
// cost-prediction bench regressions.
// ============================================================================

export interface PricingEntry {
  /** USD per 1M input tokens (uncached). */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** Optional USD per 1M cached input tokens (prompt-cache discount). */
  cachedInputPer1M?: number;
  /** Optional provider tag (informational; not used as primary lookup key). */
  provider?: string;
  /** Tier classification (informational; not used for lookup). */
  tier?: string;
}

/**
 * Source-of-truth pricing table. Exported (read-only) so external benchmarks
 * and audits can iterate the full set without poking the private `pricingTable`
 * Map. Mutations should still go through `CostEstimator.addPricing()` so the
 * live instance stays in sync; this export is for inspection/parity-check
 * tooling only. See scripts/bench-cost-model-drift.ts for the parity
 * cross-check vs `packages/core/src/observability/costModel.ts` `DEFAULT_PRICING`.
 *
 * Mirror additions to `packages/core/src/observability/costModel.ts`
 * `DEFAULT_PRICING` (per-1K = per-1M / 1000). Drift detected by
 * `scripts/bench-cost-model-drift.ts` (`doc/baselines/cost-model-drift.*.json`).
 */
export const DEFAULT_PRICING: Array<[string, PricingEntry]> = [
  // ── OpenAI ──────────────────────────────────────────────────────────────
  [
    'gpt-4o',
    {
      inputPer1M: 2.5,
      outputPer1M: 10.0,
      cachedInputPer1M: 1.25,
      provider: 'openai',
      tier: 'standard',
    },
  ],
  [
    'gpt-4o-mini',
    {
      inputPer1M: 0.15,
      outputPer1M: 0.6,
      cachedInputPer1M: 0.075,
      provider: 'openai',
      tier: 'eco',
    },
  ],
  ['gpt-4-turbo', { inputPer1M: 10, outputPer1M: 30, provider: 'openai', tier: 'standard' }],
  ['gpt-3.5-turbo', { inputPer1M: 0.5, outputPer1M: 1.5, provider: 'openai', tier: 'eco' }],
  ['o1', { inputPer1M: 15, outputPer1M: 60, provider: 'openai', tier: 'power' }],
  ['o1-mini', { inputPer1M: 3, outputPer1M: 12, provider: 'openai', tier: 'standard' }],
  ['o3-mini', { inputPer1M: 1.1, outputPer1M: 4.4, provider: 'openai', tier: 'standard' }],
  // ── Anthropic ────────────────────────────────────────────────────────────
  [
    'claude-3-5-sonnet',
    {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cachedInputPer1M: 0.3,
      provider: 'anthropic',
      tier: 'standard',
    },
  ],
  [
    'claude-sonnet-4-6',
    {
      inputPer1M: 3,
      outputPer1M: 15,
      cachedInputPer1M: 0.3,
      provider: 'anthropic',
      tier: 'standard',
    },
  ],
  [
    'claude-3-5-haiku',
    {
      inputPer1M: 0.8,
      outputPer1M: 4.0,
      cachedInputPer1M: 0.08,
      provider: 'anthropic',
      tier: 'eco',
    },
  ],
  [
    'claude-haiku-4-5',
    { inputPer1M: 0.8, outputPer1M: 4, cachedInputPer1M: 0.08, provider: 'anthropic', tier: 'eco' },
  ],
  ['claude-3-opus', { inputPer1M: 15, outputPer1M: 75, provider: 'anthropic', tier: 'power' }],
  [
    'claude-opus-4-8',
    {
      inputPer1M: 15,
      outputPer1M: 75,
      cachedInputPer1M: 1.5,
      provider: 'anthropic',
      tier: 'power',
    },
  ],
  // ── Google ───────────────────────────────────────────────────────────────
  [
    'gemini-1.5-pro',
    {
      inputPer1M: 1.25,
      outputPer1M: 5.0,
      cachedInputPer1M: 0.31,
      provider: 'google',
      tier: 'standard',
    },
  ],
  [
    'gemini-2-pro',
    {
      inputPer1M: 1.5,
      outputPer1M: 7.5,
      cachedInputPer1M: 0.375,
      provider: 'google',
      tier: 'standard',
    },
  ],
  [
    'gemini-1.5-flash',
    {
      inputPer1M: 0.075,
      outputPer1M: 0.3,
      cachedInputPer1M: 0.01875,
      provider: 'google',
      tier: 'eco',
    },
  ],
  [
    'gemini-2-flash',
    { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.025, provider: 'google', tier: 'eco' },
  ],
  [
    'gemini-2.0-flash',
    { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.025, provider: 'google', tier: 'eco' },
  ],
  // ── Deepseek ─────────────────────────────────────────────────────────────
  [
    'deepseek-chat',
    {
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      cachedInputPer1M: 0.014,
      provider: 'deepseek',
      tier: 'eco',
    },
  ],
  [
    'deepseek-reasoner',
    {
      inputPer1M: 0.14,
      outputPer1M: 2.19,
      cachedInputPer1M: 0.014,
      provider: 'deepseek',
      tier: 'standard',
    },
  ],
  [
    'deepseek-v4-pro',
    { inputPer1M: 2, outputPer1M: 8, cachedInputPer1M: 0.02, provider: 'deepseek', tier: 'power' },
  ],
  // ── xAI Grok ─────────────────────────────────────────────────────────────
  [
    'grok-2-latest',
    {
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cachedInputPer1M: 1.0,
      provider: 'xai',
      tier: 'standard',
    },
  ],
  [
    'grok-3-latest',
    {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cachedInputPer1M: 1.5,
      provider: 'xai',
      tier: 'standard',
    },
  ],
  ['grok-3', { inputPer1M: 3, outputPer1M: 15, provider: 'xai', tier: 'standard' }],
  // ── Mistral ──────────────────────────────────────────────────────────────
  [
    'mistral-large-latest',
    {
      inputPer1M: 2.0,
      outputPer1M: 6.0,
      cachedInputPer1M: 1.0,
      provider: 'mistral',
      tier: 'standard',
    },
  ],
  [
    'mistral-small-latest',
    { inputPer1M: 0.2, outputPer1M: 0.6, cachedInputPer1M: 0.1, provider: 'mistral', tier: 'eco' },
  ],
  // ── Cohere ───────────────────────────────────────────────────────────────
  [
    'command-a-plus',
    {
      inputPer1M: 2.5,
      outputPer1M: 10.0,
      cachedInputPer1M: 1.25,
      provider: 'cohere',
      tier: 'standard',
    },
  ],
  [
    'command-r-plus',
    {
      inputPer1M: 2.5,
      outputPer1M: 10.0,
      cachedInputPer1M: 1.25,
      provider: 'cohere',
      tier: 'standard',
    },
  ],
  // ── MiniMax / GLM / Xiaomi / MiMo / StepFun ─────────────────────────────
  [
    'minimax-m3',
    { inputPer1M: 1, outputPer1M: 4, cachedInputPer1M: 0.1, provider: 'minimax', tier: 'standard' },
  ],
  [
    'glm-4.7',
    {
      inputPer1M: 0.7,
      outputPer1M: 2.8,
      cachedInputPer1M: 0.07,
      provider: 'glm',
      tier: 'standard',
    },
  ],
  [
    'glm-4.6',
    {
      inputPer1M: 0.7,
      outputPer1M: 2.8,
      cachedInputPer1M: 0.07,
      provider: 'glm',
      tier: 'standard',
    },
  ],
  ['glm-5.1', { inputPer1M: 2, outputPer1M: 8, provider: 'glm', tier: 'power' }],
  [
    'mimo-v2-flash',
    {
      inputPer1M: 0.18,
      outputPer1M: 0.18,
      cachedInputPer1M: 0.018,
      provider: 'xiaomi',
      tier: 'eco',
    },
  ],
  [
    'mimo-v2-pro',
    {
      inputPer1M: 0.7,
      outputPer1M: 2.8,
      cachedInputPer1M: 0.07,
      provider: 'xiaomi',
      tier: 'standard',
    },
  ],
  [
    'mimo-v2.5',
    {
      inputPer1M: 0.7,
      outputPer1M: 2.8,
      cachedInputPer1M: 0.07,
      provider: 'mimo',
      tier: 'standard',
    },
  ],
  ['mimo-v2.5-pro', { inputPer1M: 4, outputPer1M: 12, provider: 'mimo', tier: 'power' }],
  [
    'step-3.7-flash',
    { inputPer1M: 0.3, outputPer1M: 0.9, cachedInputPer1M: 0.03, provider: 'stepfun', tier: 'eco' },
  ],
  [
    'step-3.5-flash',
    { inputPer1M: 0.5, outputPer1M: 2, cachedInputPer1M: 0.25, provider: 'stepfun', tier: 'eco' },
  ],
];

// Freeze the exported table so the docstring's "read-only" claim is enforced
// at runtime. A push/pop on a frozen array throws in strict mode (ES2022+).
// Each tuple's entry object is also frozen so a caller cannot mutate
// `DEFAULT_PRICING[i][1].inputPer1M` without breaking the live `pricingTable`
// Map invariant (the Map is built once at construction from this array).
Object.freeze(DEFAULT_PRICING);
for (const tuple of DEFAULT_PRICING) {
  Object.freeze(tuple);
  Object.freeze(tuple[1]);
}

// ============================================================================
// CostEstimator
// ============================================================================

export class CostEstimator {
  private config: CostEstimatorConfig;
  private history: Map<string, HistoricalTaskCost[]> = new Map();
  private readonly pricingTable: Map<string, PricingEntry>;

  constructor(config?: Partial<CostEstimatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pricingTable = new Map();
    for (const [key, value] of DEFAULT_PRICING) {
      this.pricingTable.set(key, value);
    }
  }

  // --------------------------------------------------------------------------
  // Core estimation
  // --------------------------------------------------------------------------

  /**
   * Estimate cost before run. Call from agentRuntime.execute() before the
   * LLM call loop begins. Returns a full estimate with confidence interval.
   */
  estimateBeforeRun(
    ctx: AgentExecutionContext,
    routing: RoutingDecision,
    modelConfig?: ModelConfig,
  ): CostEstimate {
    const taskCategory = detectTaskType(ctx.goal) as TaskCategory;
    const complexityScore = this.scoreComplexity(ctx);

    // Base estimate from task category
    const baseline = BASELINE_TOKENS[taskCategory] ?? BASELINE_TOKENS.general;

    // Complexity adjustment
    const complexityMultiplier = this.computeComplexityMultiplier(ctx, complexityScore);

    // Historical adjustment (if we have data)
    const historyKey = `${taskCategory}:${routing.tier}`;
    const samples = this.history.get(historyKey) ?? [];
    const historicalAdjustment = this.computeHistoricalAdjustment(samples);

    // Compute predictions
    const predictedInputTokens = Math.round(
      baseline.input * complexityMultiplier * historicalAdjustment.inputFactor,
    );
    const predictedOutputTokens = Math.round(
      baseline.output * complexityMultiplier * historicalAdjustment.outputFactor,
    );
    const predictedTotalTokens = predictedInputTokens + predictedOutputTokens;

    // Cost prediction using model pricing (per 1M tokens)
    // Pre-run estimate uses uncached input rate (worst case — we don't know actual cache hits yet)
    const costPerMInput =
      modelConfig?.costPer1MInput ?? this.estimateCostPerM(routing.tier, 'input');
    const costPerMOutput =
      modelConfig?.costPer1MOutput ?? this.estimateCostPerM(routing.tier, 'output');
    const predictedCostUsd =
      (predictedInputTokens / 1_000_000) * costPerMInput +
      (predictedOutputTokens / 1_000_000) * costPerMOutput;

    // Recommended budget with safety margin
    const recommendedBudget = Math.round(predictedTotalTokens * this.config.safetyMargin);

    // Confidence from sample count
    const confidence = this.computeConfidence(samples);

    // Build factor breakdown
    const factors = this.buildFactors(
      ctx,
      complexityScore,
      complexityMultiplier,
      historicalAdjustment,
    );

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
   *
   * Pricing precedence:
   *   1. If the caller passes explicit `costPer1MInput` / `costPer1MOutput`
   *      on the `model` argument, those rates are authoritative (back-compat).
   *   2. Otherwise, look up `model.id` in `pricingTable` (with @tier suffix
   *      stripping and provider-prefix matching). This is the new path that
   *      makes `bench-cost-prediction` produce non-zero predictions for
   *      `{ model: 'gpt-4o-mini', tier: 'eco' }` shape inputs.
   *   3. If nothing matches, fall back to the per-tier blended rates (old
   *      behavior so callers never regress to $0).
   */
  estimateForModel(
    ctx: AgentExecutionContext,
    model: ModelConfig,
  ): { costUsd: number; inputTokens: number; outputTokens: number } {
    const taskCategory = detectTaskType(ctx.goal) as TaskCategory;
    const baseline = BASELINE_TOKENS[taskCategory] ?? BASELINE_TOKENS.general;
    const multiplier = this.computeComplexityMultiplier(ctx, this.scoreComplexity(ctx));

    const inputTokens = Math.round(baseline.input * multiplier);
    const outputTokens = Math.round(baseline.output * multiplier);

    const { inputPer1M, outputPer1M } = this.resolveModelRates(model);

    return {
      inputTokens,
      outputTokens,
      costUsd: (inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M,
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
  allocateBudgetsAcrossAgents(
    totalBudget: number,
    subtasks: Array<{ goal: string; complexity: number; modelTier: string }>,
    safetyMargin: number = 0.15,
  ): Array<{ goal: string; budget: number; reason: string }> {
    // Reserve safety margin from total budget
    const availableBudget = Math.round(totalBudget * (1 - safetyMargin));

    if (subtasks.length === 0) return [];
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
   *
   * Unlike the pre-run estimate (which assumes worst-case uncached pricing),
   * this uses actual token breakdown to compute the real cost:
   *
   *   cost = cacheCost + uncachedInputCost + outputCost
   *
   * where:
   *   cacheCost       = cacheReadTokens × costPer1MCachedInput (or costPer1MInput if no cached rate)
   *   uncachedInput   = (inputTokens - cacheReadTokens) × costPer1MInput
   *   outputCost      = outputTokens × costPer1MOutput
   */
  recordActualCost(
    taskCategory: TaskCategory,
    modelTier: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    costPer1MInput: number,
    costPer1MOutput: number,
    costPer1MCachedInput: number | undefined,
    durationMs: number,
    success: boolean,
  ): void {
    const actualOutputCost = (outputTokens / 1_000_000) * costPer1MOutput;
    const cacheTokens = Math.min(cacheReadTokens, inputTokens);
    const uncachedInputTokens = inputTokens - cacheTokens;
    const cacheInputRate = costPer1MCachedInput ?? costPer1MInput;
    const actualCost =
      (uncachedInputTokens / 1_000_000) * costPer1MInput +
      (cacheTokens / 1_000_000) * cacheInputRate +
      actualOutputCost;

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
      costUsd: actualCost,
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
  loadFromRecords(
    records: Array<{
      model: string;
      promptTokens: number;
      completionTokens: number;
      costUsd?: number;
      timestamp: string;
      error?: string;
    }>,
  ): void {
    for (const r of records) {
      // Prefer actual pricing-table rates over per-tier blended rates when
      // the historical record names a known model. This makes the per-tier
      // history blocks more accurate for the actual cost-attribution curve.
      const tableRate = this.getPricingForModel(r.model);
      const tier = this.inferModelTier(r.model);
      if (!tier && !tableRate) continue;

      const inputRate = tableRate?.inputPer1M ?? this.estimateCostPerM(tier ?? 'standard', 'input');
      const outputRate =
        tableRate?.outputPer1M ?? this.estimateCostPerM(tier ?? 'standard', 'output');
      const tierKey = tableRate?.tier ?? tier ?? 'standard';

      this.recordActualCost(
        'general', // default — we don't have task category from raw records
        tierKey,
        r.promptTokens,
        r.completionTokens,
        0, // no cache info in historical records
        inputRate,
        outputRate,
        tableRate?.cachedInputPer1M,
        0,
        !r.error,
      );
    }
  }

  /**
   * Tier 4.4: Estimate cost for a concrete token usage. Useful when attributing
   * cost to a specific failure mode without re-running the full estimate pipeline.
   */
  estimateCostFromUsage(model: string, promptTokens: number, completionTokens: number): number {
    return this.estimateCostFromTokens(model, promptTokens, completionTokens);
  }

  /**
   * Export history for persistence (e.g., writing to disk between sessions).
   */
  exportHistory(): HistoricalTaskCost[][] {
    return Array.from(this.history.values());
  }

  /**
   * Import history from persistence.
   */
  importHistory(data: HistoricalTaskCost[][]): void {
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

  private static missingFieldsWarned = false;

  private scoreComplexity(ctx: AgentExecutionContext): number {
    let score = 0;
    // Defensive: callers may pass partial contexts (e.g. bench scripts with
    // `{ goal, taskCategory } as any` cast). Treat missing fields as the
    // cheapest/shortest case so we never throw on the complexity path.
    const goalLen = ctx.goal?.length ?? 0;
    const toolsLen = ctx.availableTools?.length ?? 0;
    const budget = ctx.tokenBudget ?? 0;
    if (
      !CostEstimator.missingFieldsWarned &&
      (ctx.availableTools === undefined || ctx.tokenBudget === undefined)
    ) {
      CostEstimator.missingFieldsWarned = true;
      getGlobalLogger().warn(
        'CostEstimator',
        'ctx missing availableTools / tokenBudget — using cheapest-case estimate. ' +
          'Production callers should pass a complete AgentExecutionContext.',
      );
    }

    if (goalLen > 400) score += 3;
    else if (goalLen > 150) score += 2;
    else if (goalLen > 50) score += 1;

    if (toolsLen > 5) score += 2;
    else if (toolsLen > 3) score += 1;

    if (budget > 20000) score += 2;
    else if (budget > 6000) score += 1;

    return Math.min(score, 10);
  }

  private computeComplexityMultiplier(
    ctx: AgentExecutionContext,
    _complexityScore: number,
  ): number {
    let multiplier = 1.0;

    // Defensive against missing optional fields — see scoreComplexity note.
    const goalLen = ctx.goal?.length ?? 0;
    const toolsLen = ctx.availableTools?.length ?? 0;
    const budget = ctx.tokenBudget ?? 0;

    // Goal length
    if (goalLen > 400) multiplier *= COMPLEXITY_MULTIPLIERS.longGoal;
    else if (goalLen < 50) multiplier *= COMPLEXITY_MULTIPLIERS.shortGoal;

    // Tool count
    if (toolsLen > 5) multiplier *= COMPLEXITY_MULTIPLIERS.manyTools;
    else if (toolsLen <= 2) multiplier *= COMPLEXITY_MULTIPLIERS.fewTools;

    // Budget signal
    if (budget > 20000) multiplier *= COMPLEXITY_MULTIPLIERS.largeBudget;
    else if (budget < 3000) multiplier *= COMPLEXITY_MULTIPLIERS.smallBudget;

    return multiplier;
  }

  private computeHistoricalAdjustment(samples: HistoricalTaskCost[]): {
    inputFactor: number;
    outputFactor: number;
  } {
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

    if (totalWeight === 0) return { inputFactor: 1.0, outputFactor: 1.0 };

    const avgInput = weightedInputSum / totalWeight;
    const avgOutput = weightedOutputSum / totalWeight;

    // Use ratio against baseline to adjust future estimates
    const baseline = BASELINE_TOKENS.general;
    return {
      inputFactor: Math.max(0.3, Math.min(3.0, avgInput / baseline.input)),
      outputFactor: Math.max(0.3, Math.min(3.0, avgOutput / baseline.output)),
    };
  }

  private computeConfidence(samples: HistoricalTaskCost[]): number {
    if (samples.length === 0) return 0;
    if (samples.length >= 50) return 0.95;
    if (samples.length >= 20) return 0.85;
    if (samples.length >= 10) return 0.7;
    if (samples.length >= 5) return 0.5;
    return 0.3;
  }

  private estimateCostPerM(tier: string, type: 'input' | 'output'): number {
    // Blended rates by tier (USD per 1M tokens). Used as a last-resort fallback
    // when neither an explicit rate nor a pricingTable lookup resolves.
    const rates: Record<string, { input: number; output: number }> = {
      eco: { input: 0.5, output: 1.5 },
      standard: { input: 3.0, output: 10.0 },
      power: { input: 10.0, output: 40.0 },
      consensus: { input: 15.0, output: 60.0 },
    };
    return rates[tier]?.[type] ?? rates.standard[type];
  }

  private estimateCostFromTokens(model: string, inputTokens: number, outputTokens: number): number {
    // Try pricingTable first. The caller may pass model="gpt-4o", "gpt-4o@standard",
    // "openai/gpt-4o-mini" or a bare name — getPricingForModel normalizes all of these.
    const tableRate = this.getPricingForModel(model);
    if (tableRate) {
      return (
        (inputTokens / 1_000_000) * tableRate.inputPer1M +
        (outputTokens / 1_000_000) * tableRate.outputPer1M
      );
    }
    // Fall back to per-tier blended rates.
    const tier = this.inferModelTier(model);
    if (!tier) return 0;
    const inputRate = this.estimateCostPerM(tier, 'input');
    const outputRate = this.estimateCostPerM(tier, 'output');
    return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
  }

  // --------------------------------------------------------------------------
  // PricingTable API (public methods)
  // --------------------------------------------------------------------------

  /**
   * Add (or override) a pricing entry for `model` at runtime. Useful for
   * tests and for callers that want to inject enterprise-contract pricing
   * without rebuilding the estimator.
   *
   * Keys are normalized: lowercased and `@tier` suffix stripped, so callers
   * can pass any common shape ('gpt-4o', 'gpt-4o@standard', 'openai/gpt-4o-mini').
   */
  addPricing(model: string, entry: PricingEntry): void {
    const key = this.normalizeModelKey(model);
    if (key === null) {
      // Don't throw — callers may pass config-derived values that happen to
      // be empty — but warn so a misconfigured enterprise-contract override
      // doesn't get silently dropped into the void.
      getGlobalLogger().warn('CostEstimator', 'addPricing ignored: empty model key', { model });
      return;
    }
    this.pricingTable.set(key, entry);
  }

  /**
   * Number of pricing entries currently registered. Useful for tests and
   * health probes that want to verify the table is wired correctly.
   */
  getPricingTableSize(): number {
    return this.pricingTable.size;
  }

  /**
   * Resolve per-1M input / output rates for a `ModelConfig` argument.
   * - Explicit rates on the config always win (back-compat).
   * - Otherwise, look up the model identifier (preferring `id`, falling back
   *   to `model` or `name` to support callers like scripts/bench-cost-prediction.ts
   *   that pass `{ model: '...', tier: '...' } as any` instead of full
   *   ModelConfig).
   * - Fall back to per-tier blended rates when no entry is found.
   */
  private resolveModelRates(model: ModelConfig): { inputPer1M: number; outputPer1M: number } {
    if (
      typeof model.costPer1MInput === 'number' &&
      Number.isFinite(model.costPer1MInput) &&
      typeof model.costPer1MOutput === 'number' &&
      Number.isFinite(model.costPer1MOutput)
    ) {
      return { inputPer1M: model.costPer1MInput, outputPer1M: model.costPer1MOutput };
    }
    // Probe the two identifier shapes we actively support:
    //   - ModelConfig canonical: `{ id: 'gpt-4o-mini', tier: 'eco', ... }`
    //   - Bench / lightweight shape: `{ model: 'gpt-4o-mini', tier: 'eco' } as any`
    // First non-empty string wins. We deliberately do NOT probe `name` (collides
    // with provider display names) or `modelId` (lives on `RoutingDecision`,
    // not `ModelConfig` — including it would make this function look like a
    // polymorphic RoutingDecision bridge that it isn't).
    const candidates = [(model as { id?: unknown }).id, (model as { model?: unknown }).model];
    let tableRate: PricingEntry | null = null;
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        tableRate = this.getPricingForModel(candidate, model.provider);
        if (tableRate) break;
      }
    }
    if (tableRate) return { inputPer1M: tableRate.inputPer1M, outputPer1M: tableRate.outputPer1M };
    const tier = model.tier ?? 'standard';
    return {
      inputPer1M: this.estimateCostPerM(tier, 'input'),
      outputPer1M: this.estimateCostPerM(tier, 'output'),
    };
  }

  /**
   * Normalize a model identifier for pricing-table lookup. Strips an
   * optional `@tier` suffix (`gpt-4o@eco` -> `gpt-4o`), trims an optional
   * `provider/` prefix (`openai/gpt-4o-mini` -> `gpt-4o-mini`), and
   * lowercases the result. Returns null when the input has no usable model
   * portion.
   */
  private normalizeModelKey(rawModel: string): string | null {
    if (typeof rawModel !== 'string') return null;
    let model = rawModel.trim();
    if (model.length === 0) return null;
    // Strip @tier suffix (e.g. 'gpt-4o@eco', 'claude-3-5-sonnet@standard').
    const atIdx = model.indexOf('@');
    if (atIdx > 0) model = model.slice(0, atIdx);
    // Strip optional provider/ prefix.
    const slashIdx = model.indexOf('/');
    if (slashIdx > 0 && slashIdx < model.length - 1) {
      model = model.slice(slashIdx + 1);
    }
    return model.toLowerCase();
  }

  /**
   * Look up pricing for `model`. Strips any `@tier` suffix, trims an
   * optional provider prefix, and tries:
   *   1. exact match (after normalization)
   *   2. longest prefix match (so `gpt-4o-2024-08-06` resolves to `gpt-4o`)
   *   3. provider-scoped prefix match when `provider` is given
   * Returns null when nothing in the table matches.
   */
  getPricingForModel(model: string, provider?: string): PricingEntry | null {
    const normalized = this.normalizeModelKey(model);
    if (!normalized) return null;

    // 1. Exact match.
    const exact = this.pricingTable.get(normalized);
    if (exact) return exact;

    // 2. Provider-scoped prefix match.
    if (provider) {
      const providerLower = provider.toLowerCase();
      for (const [key, value] of this.pricingTable) {
        if (value.provider?.toLowerCase() === providerLower && normalized.startsWith(key)) {
          return value;
        }
      }
    }

    // 3. Longest-prefix fallback (skip 'gpt-4o' before 'gpt-4-turbo' precedence).
    let bestMatch: { key: string; entry: PricingEntry } | null = null;
    for (const [key, entry] of this.pricingTable) {
      if (normalized.startsWith(key) && (!bestMatch || key.length > bestMatch.key.length)) {
        // Disambiguate similar prefixes: 'gpt-4-turbo' must not match 'gpt-4o'.
        // Require prefix to be at a token boundary (followed by '-' or end).
        const after = normalized[key.length];
        if (after === '' || after === '-') {
          bestMatch = { key, entry };
        }
      }
    }
    return bestMatch ? bestMatch.entry : null;
  }

  private inferModelTier(model: string): string | null {
    const m = model.toLowerCase();
    if (m.includes('haiku') || m.includes('mini') || m.includes('flash') || m.includes('small'))
      return 'eco';
    if (m.includes('opus') || m.includes('gpt-5') || m.includes('o3') || m.includes('o4'))
      return 'power';
    if (m.includes('sonnet') || m.includes('gpt-4o') || m.includes('pro') || m.includes('large'))
      return 'standard';
    return 'standard'; // default
  }

  private buildFactors(
    ctx: AgentExecutionContext,
    complexityScore: number,
    complexityMultiplier: number,
    historicalAdjustment: { inputFactor: number; outputFactor: number },
  ): CostFactor[] {
    const factors: CostFactor[] = [];

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

// ============================================================================
// Singleton
// ============================================================================

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const estimatorSingleton = createTenantAwareSingleton(() => new CostEstimator(), {});

/** Get the global CostEstimator (single-tenant) or tenant-scoped (multi-tenant). */
export function getCostEstimator(): CostEstimator {
  return estimatorSingleton.get();
}

/** Reset the cost estimator singleton (for test isolation). */
export function resetCostEstimator(): void {
  estimatorSingleton.reset();
}
