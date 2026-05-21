/**
 * Smart Model Router — Task-aware, learning, cost-optimized model selection.
 *
 * Surpasses OpenClaw's multi-model routing by adding:
 * 1. Task-type → capability matching (code tasks → code-capable models)
 * 2. Outcome-based learning with time decay (track success per model per task type)
 * 3. Model fallback chain (try next candidate on failure)
 * 4. Governor-aware budgeting (tight budget → cheaper models)
 * 5. Cost-quality tradeoff (score models by capability fit × cost efficiency)
 *
 * Backward compatible: same class name, same route() interface.
 */

import type {
  ModelConfig,
  ModelTier,
  RoutingDecision,
  AgentExecutionContext,
} from './types';
import { detectTaskType } from './unifiedVerification';

// ============================================================================
// Default model registry
// ============================================================================

const DEFAULT_MODELS: ModelConfig[] = [
  { id: 'grok-2-latest', provider: 'xai', tier: 'eco', costPer1KInput: 0.002, costPer1KOutput: 0.01, capabilities: ['code', 'analysis'], contextWindow: 131072, priority: 9 },
  { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', provider: 'anyscale', tier: 'eco', costPer1KInput: 0.0005, costPer1KOutput: 0.0005, capabilities: ['analysis'], contextWindow: 32768, priority: 10 },
  { id: 'mistralai/Mistral-7B-Instruct-v0.3', provider: 'deepinfra', tier: 'eco', costPer1KInput: 0.00013, costPer1KOutput: 0.00013, capabilities: ['analysis'], contextWindow: 32768, priority: 11 },

  // ===== Eco tier — cheap & fast =====
  { id: 'claude-3-5-haiku', provider: 'anthropic', tier: 'eco', costPer1KInput: 0.0008, costPer1KOutput: 0.004, capabilities: ['code', 'analysis'], contextWindow: 200000, priority: 0 },
  { id: 'gpt-4o-mini', provider: 'openai', tier: 'eco', costPer1KInput: 0.00015, costPer1KOutput: 0.0006, capabilities: ['code', 'analysis'], contextWindow: 128000, priority: 1 },
  { id: 'gemini-2-flash', provider: 'google', tier: 'eco', costPer1KInput: 0.0001, costPer1KOutput: 0.0004, capabilities: ['analysis'], contextWindow: 1000000, priority: 2 },
  { id: 'llama-3.3-70b-versatile', provider: 'groq', tier: 'eco', costPer1KInput: 0.00059, costPer1KOutput: 0.00079, capabilities: ['code', 'analysis'], contextWindow: 128000, priority: 3 },
  { id: 'mistral-small-latest', provider: 'mistral', tier: 'eco', costPer1KInput: 0.001, costPer1KOutput: 0.001, capabilities: ['code', 'analysis'], contextWindow: 32000, priority: 4 },
  { id: 'command-r-08-2024', provider: 'cohere', tier: 'eco', costPer1KInput: 0.0005, costPer1KOutput: 0.0015, capabilities: ['analysis'], contextWindow: 128000, priority: 5 },
  { id: 'sonar', provider: 'perplexity', tier: 'eco', costPer1KInput: 0.001, costPer1KOutput: 0.001, capabilities: ['analysis'], contextWindow: 128000, priority: 6 },
  // Local providers — effectively free
  { id: 'llama3.2', provider: 'ollama', tier: 'eco', costPer1KInput: 0, costPer1KOutput: 0, capabilities: ['code', 'analysis'], contextWindow: 128000, priority: 7 },
  { id: 'meta-llama/Llama-3.2-3B-Instruct', provider: 'vllm', tier: 'eco', costPer1KInput: 0, costPer1KOutput: 0, capabilities: ['code', 'analysis'], contextWindow: 128000, priority: 8 },

  // ===== Standard tier — balanced quality/cost =====
  { id: 'claude-3-5-sonnet', provider: 'anthropic', tier: 'standard', costPer1KInput: 0.003, costPer1KOutput: 0.015, capabilities: ['code', 'reasoning', 'analysis', 'creative'], contextWindow: 200000, priority: 0 },
  { id: 'gpt-4o', provider: 'openai', tier: 'standard', costPer1KInput: 0.0025, costPer1KOutput: 0.01, capabilities: ['code', 'reasoning', 'analysis', 'creative'], contextWindow: 128000, priority: 1 },
  { id: 'gemini-2-pro', provider: 'google', tier: 'standard', costPer1KInput: 0.0015, costPer1KOutput: 0.0075, capabilities: ['reasoning', 'analysis'], contextWindow: 1000000, priority: 2 },
  { id: 'mistral-large-latest', provider: 'mistral', tier: 'standard', costPer1KInput: 0.002, costPer1KOutput: 0.006, capabilities: ['code', 'reasoning', 'analysis'], contextWindow: 128000, priority: 3 },
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', provider: 'together', tier: 'standard', costPer1KInput: 0.0009, costPer1KOutput: 0.0009, capabilities: ['code', 'reasoning', 'analysis'], contextWindow: 131072, priority: 4 },
  { id: 'grok-3', provider: 'xai', tier: 'standard', costPer1KInput: 0.003, costPer1KOutput: 0.015, capabilities: ['code', 'reasoning', 'analysis'], contextWindow: 131072, priority: 11 },
  { id: 'meta-llama/Llama-3.3-70B-Instruct', provider: 'anyscale', tier: 'standard', costPer1KInput: 0.0009, costPer1KOutput: 0.0009, capabilities: ['code', 'reasoning', 'analysis'], contextWindow: 128000, priority: 12 },
  { id: 'meta-llama/Llama-3.3-70B-Instruct', provider: 'deepinfra', tier: 'standard', costPer1KInput: 0.0009, costPer1KOutput: 0.0009, capabilities: ['code', 'reasoning', 'analysis'], contextWindow: 128000, priority: 13 },
  { id: 'sonar-pro', provider: 'perplexity', tier: 'standard', costPer1KInput: 0.003, costPer1KOutput: 0.015, capabilities: ['reasoning', 'analysis'], contextWindow: 128000, priority: 5 },
  { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', provider: 'fireworks', tier: 'standard', costPer1KInput: 0.0009, costPer1KOutput: 0.0009, capabilities: ['code', 'reasoning', 'analysis'], contextWindow: 128000, priority: 6 },
  { id: 'llama3-70b-8192', provider: 'groq', tier: 'standard', costPer1KInput: 0.00059, costPer1KOutput: 0.00079, capabilities: ['code', 'reasoning', 'analysis'], contextWindow: 8192, priority: 7 },
  { id: 'command-r-plus-08-2024', provider: 'cohere', tier: 'standard', costPer1KInput: 0.003, costPer1KOutput: 0.015, capabilities: ['reasoning', 'analysis'], contextWindow: 128000, priority: 8 },
  { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', provider: 'bedrock', tier: 'standard', costPer1KInput: 0.003, costPer1KOutput: 0.015, capabilities: ['code', 'reasoning', 'analysis', 'creative'], contextWindow: 200000, priority: 9 },
  { id: 'meta/meta-llama-3.3-70b-instruct', provider: 'replicate', tier: 'standard', costPer1KInput: 0.00065, costPer1KOutput: 0.00275, capabilities: ['code', 'reasoning', 'analysis'], contextWindow: 128000, priority: 10 },

  // ===== Power tier — strongest reasoning =====
  { id: 'claude-3-opus', provider: 'anthropic', tier: 'power', costPer1KInput: 0.015, costPer1KOutput: 0.075, capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'], contextWindow: 200000, priority: 0 },
  { id: 'gpt-5', provider: 'openai', tier: 'power', costPer1KInput: 0.01, costPer1KOutput: 0.04, capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'], contextWindow: 256000, priority: 1 },
  { id: 'claude-3-5-sonnet', provider: 'bedrock', tier: 'power', costPer1KInput: 0.003, costPer1KOutput: 0.015, capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'], contextWindow: 200000, priority: 2 },
  { id: 'deepseek-v4-pro', provider: 'deepseek', tier: 'power', costPer1KInput: 0.002, costPer1KOutput: 0.008, capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'], contextWindow: 128000, priority: 3 },
  { id: 'mimo-v2.5-pro', provider: 'mimo', tier: 'power', costPer1KInput: 0.004, costPer1KOutput: 0.012, capabilities: ['code', 'reasoning', 'analysis', 'creative'], contextWindow: 128000, priority: 4 },
  { id: 'glm-5.1', provider: 'glm', tier: 'power', costPer1KInput: 0.002, costPer1KOutput: 0.008, capabilities: ['code', 'reasoning', 'analysis', 'creative'], contextWindow: 128000, priority: 5 },
];

// ============================================================================
// Task type → required capabilities mapping
// ============================================================================

const TASK_CAPABILITY_MAP: Record<string, string[]> = {
  code: ['code'],
  search: ['analysis'],
  analysis: ['analysis'],
  creative: ['creative'],
  structured: ['code'],
  general: [],
};

// ============================================================================
// Outcome tracking for learning
// ============================================================================

interface ModelOutcome {
  modelId: string;
  taskType: string;
  success: boolean;
  durationMs: number;
  tokensUsed: number;
  timestamp: number;
}

// ============================================================================
// Complexity scoring
// ============================================================================

interface ComplexityScore {
  score: number;
  factors: { name: string; contribution: number }[];
}

function scoreComplexity(ctx: AgentExecutionContext): ComplexityScore {
  const factors: { name: string; contribution: number }[] = [];
  let score = 0;

  // Goal length as a proxy for complexity
  if (ctx.goal.length > 400) { score += 3; factors.push({ name: 'long_goal', contribution: 3 }); }
  else if (ctx.goal.length > 150) { score += 2; factors.push({ name: 'medium_goal', contribution: 2 }); }
  else if (ctx.goal.length > 50) { score += 1; factors.push({ name: 'short_goal', contribution: 1 }); }

  // Number of tools suggests breadth
  if (ctx.availableTools.length > 5) { score += 3; factors.push({ name: 'many_tools', contribution: 3 }); }
  else if (ctx.availableTools.length > 3) { score += 2; factors.push({ name: 'several_tools', contribution: 2 }); }
  else if (ctx.availableTools.length > 1) { score += 1; factors.push({ name: 'few_tools', contribution: 1 }); }

  // Token budget indicates expected effort
  if (ctx.tokenBudget > 20000) { score += 3; factors.push({ name: 'large_budget', contribution: 3 }); }
  else if (ctx.tokenBudget > 6000) { score += 2; factors.push({ name: 'medium_budget', contribution: 2 }); }
  else if (ctx.tokenBudget > 3000) { score += 1; factors.push({ name: 'small_budget', contribution: 1 }); }

  // Complexity from context data presence of governance constraints
  const gov = ctx.contextData.governanceProfile as { riskLevel?: string } | undefined;
  if (gov?.riskLevel === 'CRITICAL') { score += 4; factors.push({ name: 'critical_risk', contribution: 4 }); }
  else if (gov?.riskLevel === 'HIGH') { score += 3; factors.push({ name: 'high_risk', contribution: 3 }); }

  return { score: Math.min(score, 10), factors };
}

// ============================================================================
// Smart Model Router
// ============================================================================

export class ModelRouter {
  private models: Map<string, ModelConfig> = new Map();
  private outcomes: ModelOutcome[] = [];
  private readonly maxOutcomes = 500;
  private readonly decayHalfLifeMs = 20 * 60 * 1000; // 20 minutes

  constructor(customModels?: ModelConfig[]) {
    const allModels = customModels ?? DEFAULT_MODELS;
    for (const m of allModels) {
      this.models.set(m.id, m);
    }
  }

  registerModel(config: ModelConfig): void {
    this.models.set(config.id, config);
  }

  getModel(modelId: string): ModelConfig | undefined {
    return this.models.get(modelId);
  }

  listModels(tier?: ModelTier): ModelConfig[] {
    const all = Array.from(this.models.values());
    return tier ? all.filter(m => m.tier === tier) : all;
  }

  /**
   * Route an execution context to the optimal model.
   * Now task-type-aware with capability matching and governor integration.
   * @param governorPhase - Current budget governor phase ('relaxed'|'moderate'|'tight'|'critical').
   *   Callers should pass their per-run governor state instead of relying on global singleton.
   */
  route(ctx: AgentExecutionContext, governorPhase?: string): RoutingDecision {
    const complexity = scoreComplexity(ctx);
    const taskType = detectTaskType(ctx.goal);
    const requiredCaps = TASK_CAPABILITY_MAP[taskType] ?? [];

    // Governor-aware tier adjustment: tight/critical budget → prefer cheaper tier
    const governor = governorPhase ?? 'relaxed';
    let tier = this.selectTier(complexity, ctx, governor);

    // Capability-aware tier bump: if selected tier has no model with required caps, go higher
    if (requiredCaps.length > 0) {
      tier = this.bumpTierForCapabilities(tier, requiredCaps);
    }

    // Score and rank candidates by capability fit + cost efficiency + learning
    const candidates = this.rankCandidates(tier, requiredCaps, taskType, ctx);
    const model = candidates[0];

    const reasoning: string[] = [
      `complexity: ${complexity.score}/10 (${complexity.factors.map(f => f.name).join(', ')})`,
      `task_type: ${taskType}`,
      `required_capabilities: ${requiredCaps.join(', ') || 'none'}`,
      `selected_tier: ${tier}`,
      `governor_phase: ${governor}`,
      `candidates_ranked: ${candidates.length}`,
      `selected_model: ${model?.id ?? 'none'}`,
    ];

    if (!model) {
      return {
        modelId: 'fallback',
        tier: 'standard',
        provider: 'mock',
        reasoning: [...reasoning, 'NO_MODEL_AVAILABLE_IN_TIER'],
        estimatedCost: 0,
        maxTokens: 4000,
      };
    }

    const estimatedInputTokens = Math.ceil(ctx.goal.length / 4) + 2048;
    const estimatedOutputTokens = Math.min(ctx.tokenBudget, model.contextWindow - estimatedInputTokens);
    const estimatedCost = (estimatedInputTokens / 1000) * model.costPer1KInput
      + (estimatedOutputTokens / 1000) * model.costPer1KOutput;

    return {
      modelId: model.id,
      tier: model.tier,
      provider: model.provider,
      reasoning,
      estimatedCost: Math.round(estimatedCost * 100000) / 100000,
      maxTokens: Math.min(estimatedOutputTokens, 64000),
    };
  }

  /**
   * Record a model execution outcome for learning.
   * Call this after each successful or failed model execution.
   */
  recordOutcome(modelId: string, taskType: string, success: boolean, durationMs: number, tokensUsed: number): void {
    this.outcomes.push({
      modelId,
      taskType,
      success,
      durationMs,
      tokensUsed,
      timestamp: Date.now(),
    });

    // Prune old outcomes
    if (this.outcomes.length > this.maxOutcomes) {
      this.outcomes = this.outcomes.slice(-this.maxOutcomes);
    }
  }

  /**
   * Get the next fallback model for a given model (for retry-with-fallback).
   * Returns the next model in the same tier by priority, or steps down a tier.
   */
  getFallbackModel(failedModelId: string, taskType?: string): ModelConfig | undefined {
    const failed = this.models.get(failedModelId);
    if (!failed) return undefined;

    const requiredCaps = TASK_CAPABILITY_MAP[taskType ?? 'general'] ?? [];

    // Try same tier, next priority
    const sameTier = Array.from(this.models.values())
      .filter(m => m.tier === failed.tier && m.id !== failedModelId)
      .sort((a, b) => a.priority - b.priority);

    for (const candidate of sameTier) {
      if (this.hasCapabilities(candidate, requiredCaps)) return candidate;
    }

    // Step down tier
    const tierOrder: ModelTier[] = ['power', 'standard', 'eco'];
    const currentIdx = tierOrder.indexOf(failed.tier);
    for (let i = currentIdx + 1; i < tierOrder.length; i++) {
      const lowerTier = Array.from(this.models.values())
        .filter(m => m.tier === tierOrder[i])
        .sort((a, b) => a.priority - b.priority);
      for (const candidate of lowerTier) {
        if (this.hasCapabilities(candidate, requiredCaps)) return candidate;
      }
    }

    return undefined;
  }

  /**
   * Estimate cost for a given context and expected output length.
   */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const model = this.models.get(modelId);
    if (!model) return 0;
    return (inputTokens / 1000) * model.costPer1KInput
      + (outputTokens / 1000) * model.costPer1KOutput;
  }

  /**
   * Get learning stats for debugging.
   */
  getLearningStats(): { modelId: string; taskType: string; successRate: string; avgDuration: number; count: number }[] {
    const groups = new Map<string, ModelOutcome[]>();
    for (const o of this.outcomes) {
      const key = `${o.modelId}:${o.taskType}`;
      const arr = groups.get(key) ?? [];
      arr.push(o);
      groups.set(key, arr);
    }

    return Array.from(groups.entries()).map(([key, outcomes]) => {
      const [modelId, taskType] = key.split(':');
      const successes = outcomes.filter(o => o.success).length;
      const avgDuration = outcomes.reduce((s, o) => s + o.durationMs, 0) / outcomes.length;
      return {
        modelId,
        taskType,
        successRate: `${successes}/${outcomes.length}`,
        avgDuration: Math.round(avgDuration),
        count: outcomes.length,
      };
    });
  }

  // ============================================================================
  // Internal
  // ============================================================================

  /**
   * Select tier based on complexity, governance, and governor phase.
   */
  private selectTier(complexity: ComplexityScore, ctx: AgentExecutionContext, governor: string): ModelTier {
    const gov = ctx.contextData.governanceProfile as { riskLevel?: string } | undefined;

    // Critical risk → always use power tier
    if (gov?.riskLevel === 'CRITICAL') return 'consensus';
    if (gov?.riskLevel === 'HIGH') return 'power';

    // Governor-aware: tight/critical budget → demote one tier (save cost)
    if (governor === 'critical') {
      if (complexity.score >= 7) return 'standard'; // would be power, demoted
      return 'eco';
    }
    if (governor === 'tight') {
      if (complexity.score >= 7) return 'standard';
      if (complexity.score >= 4) return 'eco';
      return 'eco';
    }

    // Normal routing
    if (complexity.score >= 7) return 'power';
    if (complexity.score >= 4) return 'standard';
    return 'eco';
  }

  /**
   * Rank candidates by: capability fit → cost efficiency → learning score.
   * Returns sorted array (best first).
   */
  private rankCandidates(
    tier: ModelTier,
    requiredCaps: string[],
    taskType: string,
    ctx: AgentExecutionContext,
  ): ModelConfig[] {
    let candidates = Array.from(this.models.values())
      .filter(m => m.tier === tier);

    // Fallback chain if tier is empty
    if (candidates.length === 0) {
      const tierOrder: ModelTier[] = ['consensus', 'power', 'standard', 'eco'];
      const startIdx = tierOrder.indexOf(tier);
      for (let i = startIdx + 1; i < tierOrder.length; i++) {
        candidates = Array.from(this.models.values()).filter(m => m.tier === tierOrder[i]);
        if (candidates.length > 0) break;
      }
    }

    // Score each candidate
    const scored = candidates.map(m => ({
      model: m,
      score: this.scoreCandidate(m, requiredCaps, taskType, ctx),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.model);
  }

  /**
   * Score a model candidate: capability fit (0-1) × cost efficiency × learning bonus.
   */
  private scoreCandidate(
    model: ModelConfig,
    requiredCaps: string[],
    taskType: string,
    _ctx: AgentExecutionContext,
  ): number {
    // 1. Capability fit: what fraction of required caps does this model have?
    const capFit = requiredCaps.length === 0
      ? 1.0
      : requiredCaps.filter(c => model.capabilities.includes(c)).length / requiredCaps.length;

    // 2. Cost efficiency: cheaper is better (normalized against most expensive in same tier)
    const tierModels = Array.from(this.models.values()).filter(m => m.tier === model.tier);
    const maxCost = Math.max(...tierModels.map(m => m.costPer1KOutput), 0.001);
    const costEfficiency = 1 - (model.costPer1KOutput / maxCost) * 0.3; // 0.7-1.0 range

    // 3. Learning bonus: models that succeeded for this task type get a boost
    const learningBonus = this.getLearningBonus(model.id, taskType);

    // 4. Priority penalty (lower priority number = preferred)
    const priorityFactor = 1 / (1 + model.priority * 0.1);

    return capFit * costEfficiency * learningBonus * priorityFactor;
  }

  /**
   * Calculate learning bonus from historical outcomes.
   * Uses time-decayed success rate. Returns 0.8-1.2 multiplier.
   */
  private getLearningBonus(modelId: string, taskType: string): number {
    const relevant = this.outcomes.filter(o =>
      o.modelId === modelId && o.taskType === taskType,
    );

    if (relevant.length === 0) return 1.0; // No data → neutral

    const now = Date.now();
    let weightedSuccess = 0;
    let totalWeight = 0;

    for (const o of relevant) {
      const age = now - o.timestamp;
      const weight = Math.exp(-age / this.decayHalfLifeMs);
      weightedSuccess += (o.success ? 1 : 0) * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 1.0;

    const successRate = weightedSuccess / totalWeight;
    // Map 0-1 success rate to 0.8-1.2 bonus
    return 0.8 + successRate * 0.4;
  }

  /**
   * Check if a model has the required capabilities.
   */
  private hasCapabilities(model: ModelConfig, requiredCaps: string[]): boolean {
    if (requiredCaps.length === 0) return true;
    return requiredCaps.every(c => model.capabilities.includes(c));
  }

  /**
   * If the selected tier has no model with all required capabilities, bump to next higher tier.
   */
  private bumpTierForCapabilities(tier: ModelTier, requiredCaps: string[]): ModelTier {
    const tierOrder: ModelTier[] = ['eco', 'standard', 'power', 'consensus'];
    let currentIdx = tierOrder.indexOf(tier);

    while (currentIdx < tierOrder.length) {
      const tierModels = Array.from(this.models.values()).filter(m => m.tier === tierOrder[currentIdx]);
      const hasCapableModel = tierModels.some(m => this.hasCapabilities(m, requiredCaps));
      if (hasCapableModel) return tierOrder[currentIdx];
      currentIdx++;
    }

    return tier; // fallback to original
  }

}

// Singleton
let globalRouter: ModelRouter | null = null;

export function getModelRouter(): ModelRouter {
  if (!globalRouter) {
    globalRouter = new ModelRouter();
  }
  return globalRouter;
}

export function resetModelRouter(): void {
  globalRouter = null;
}
