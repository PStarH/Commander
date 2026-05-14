/**
 * Model Router — Routes tasks to the optimal model based on complexity, cost, and capability needs.
 *
 * Tiers:
 *   eco:      cheapest, trivial tasks (Haiku, GPT-4o-mini, Gemini Flash)
 *   standard: balanced, most tasks (Sonnet, GPT-4o, Gemini Pro)
 *   power:    strongest reasoning, complex tasks (Opus, GPT-5, Gemini Ultra)
 *   consensus: multi-model voting for critical decisions
 */

import type {
  ModelConfig,
  ModelTier,
  RoutingDecision,
  TokenUsage,
  AgentExecutionContext,
} from './types';

// ============================================================================
// Default model registry
// ============================================================================

const DEFAULT_MODELS: ModelConfig[] = [
  // Eco tier — cheap & fast
  { id: 'claude-3-5-haiku', provider: 'anthropic', tier: 'eco', costPer1KInput: 0.0008, costPer1KOutput: 0.004, capabilities: ['code', 'analysis'], contextWindow: 200000, priority: 0 },
  { id: 'gpt-4o-mini', provider: 'openai', tier: 'eco', costPer1KInput: 0.00015, costPer1KOutput: 0.0006, capabilities: ['code', 'analysis'], contextWindow: 128000, priority: 1 },
  { id: 'gemini-2-flash', provider: 'google', tier: 'eco', costPer1KInput: 0.0001, costPer1KOutput: 0.0004, capabilities: ['analysis'], contextWindow: 1000000, priority: 2 },

  // Standard tier — balanced quality/cost
  { id: 'claude-3-5-sonnet', provider: 'anthropic', tier: 'standard', costPer1KInput: 0.003, costPer1KOutput: 0.015, capabilities: ['code', 'reasoning', 'analysis', 'creative'], contextWindow: 200000, priority: 0 },
  { id: 'gpt-4o', provider: 'openai', tier: 'standard', costPer1KInput: 0.0025, costPer1KOutput: 0.01, capabilities: ['code', 'reasoning', 'analysis', 'creative'], contextWindow: 128000, priority: 1 },
  { id: 'gemini-2-pro', provider: 'google', tier: 'standard', costPer1KInput: 0.0015, costPer1KOutput: 0.0075, capabilities: ['reasoning', 'analysis'], contextWindow: 1000000, priority: 2 },

  // Power tier — strongest reasoning
  { id: 'claude-3-opus', provider: 'anthropic', tier: 'power', costPer1KInput: 0.015, costPer1KOutput: 0.075, capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'], contextWindow: 200000, priority: 0 },
  { id: 'gpt-5', provider: 'openai', tier: 'power', costPer1KInput: 0.01, costPer1KOutput: 0.04, capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'], contextWindow: 256000, priority: 0 },
];

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
  if (ctx.goal.length > 500) { score += 2; factors.push({ name: 'long_goal', contribution: 2 }); }
  else if (ctx.goal.length > 200) { score += 1; factors.push({ name: 'medium_goal', contribution: 1 }); }

  // Number of tools suggests breadth
  if (ctx.availableTools.length > 5) { score += 2; factors.push({ name: 'many_tools', contribution: 2 }); }
  else if (ctx.availableTools.length > 3) { score += 1; factors.push({ name: 'several_tools', contribution: 1 }); }

  // Token budget indicates expected effort
  if (ctx.tokenBudget > 32000) { score += 2; factors.push({ name: 'large_budget', contribution: 2 }); }
  else if (ctx.tokenBudget > 8000) { score += 1; factors.push({ name: 'medium_budget', contribution: 1 }); }

  // Complexity from context data presence of governance constraints
  const gov = ctx.contextData.governanceProfile as { riskLevel?: string } | undefined;
  if (gov?.riskLevel === 'CRITICAL') { score += 3; factors.push({ name: 'critical_risk', contribution: 3 }); }
  else if (gov?.riskLevel === 'HIGH') { score += 2; factors.push({ name: 'high_risk', contribution: 2 }); }

  return { score: Math.min(score, 10), factors };
}

// ============================================================================
// Model Router
// ============================================================================

export class ModelRouter {
  private models: Map<string, ModelConfig> = new Map();

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
   */
  route(ctx: AgentExecutionContext): RoutingDecision {
    const complexity = scoreComplexity(ctx);
    const tier = this.selectTier(complexity, ctx);
    const candidates = this.selectCandidates(tier, ctx);
    const model = candidates[0];

    const reasoning: string[] = [
      `complexity: ${complexity.score}/10 (${complexity.factors.map(f => f.name).join(', ')})`,
      `selected_tier: ${tier}`,
      `available_in_tier: ${candidates.length}`,
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
      maxTokens: Math.min(estimatedOutputTokens, 16384),
    };
  }

  private selectTier(complexity: ComplexityScore, ctx: AgentExecutionContext): ModelTier {
    const gov = ctx.contextData.governanceProfile as { riskLevel?: string } | undefined;

    // Critical risk → always use power tier
    if (gov?.riskLevel === 'CRITICAL') return 'consensus';

    // High risk → power tier
    if (gov?.riskLevel === 'HIGH') return 'power';

    // High complexity → power tier
    if (complexity.score >= 7) return 'power';

    // Medium-high complexity
    if (complexity.score >= 4) return 'standard';

    // Low complexity → eco
    return 'eco';
  }

  private selectCandidates(tier: ModelTier, ctx: AgentExecutionContext): ModelConfig[] {
    let candidates = Array.from(this.models.values())
      .filter(m => m.tier === tier)
      .sort((a, b) => a.priority - b.priority);

    // If no candidates in tier, fall back to adjacent tier
    if (candidates.length === 0 && tier === 'consensus') {
      candidates = this.selectCandidates('power', ctx);
    }
    if (candidates.length === 0 && tier === 'power') {
      candidates = this.selectCandidates('standard', ctx);
    }
    if (candidates.length === 0) {
      candidates = this.selectCandidates('eco', ctx);
    }

    return candidates;
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
