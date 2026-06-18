/**
 * Smart Model Router — User-configurable, capability-based model selection.
 *
 * Features:
 * 1. User-defined model pools with capability tags (multimodal, vision, long_context, etc.)
 * 2. Auto mode: routes tasks to best model based on capability matching
 * 3. Manual mode: user selects specific model
 * 4. Cascade mode: tries cheap first, escalates on failure (FrugalGPT)
 * 5. Cost-aware: respects budget constraints
 * 6. Learning: tracks success rates per model per task type
 *
 * Config file: commander.config.json or COMMANDER_MODELS env var (JSON)
 */
import type { ModelTier, RoutingDecision, AgentExecutionContext } from './types';
import { detectTaskType } from './unifiedVerification';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Capability types
// ============================================================================

export type ModelCapability =
  | 'code'
  | 'reasoning'
  | 'analysis'
  | 'creative'
  | 'math'
  | 'multimodal'
  | 'vision'
  | 'image_generation'
  | 'long_context'
  | 'low_cost'
  | 'fast'
  | 'high_quality'
  | 'function_calling'
  | 'json_mode'
  | 'streaming'
  | 'translation'
  | 'summarization'
  | 'extraction';

// ============================================================================
// User-configurable model definition
// ============================================================================

export interface UserModelConfig {
  id: string;
  provider: string;
  capabilities: ModelCapability[];
  costPer1KInput: number;
  costPer1KOutput: number;
  contextWindow: number;
  maxOutputTokens?: number;
  displayName?: string;
  description?: string;
  tags?: string[];
  tier?: ModelTier;
}

// ============================================================================
// Router configuration
// ============================================================================

export interface RoutingRule {
  taskType: string;
  requiredCapabilities: ModelCapability[];
  preferredTier?: ModelTier;
  maxCostPer1K?: number;
}

export interface ModelRouterUserConfig {
  mode: 'auto' | 'manual' | 'cascade';
  defaultModel?: string;
  modelPool: UserModelConfig[];
  routingRules?: RoutingRule[];
  budget?: {
    maxCostPerTask?: number;
    dailyBudget?: number;
  };
}

// ============================================================================
// Task type → capability mapping (enhanced)
// ============================================================================

const TASK_CAPABILITY_MAP: Record<string, ModelCapability[]> = {
  code: ['code'],
  search: ['analysis'],
  analysis: ['analysis'],
  creative: ['creative'],
  structured: ['code', 'json_mode'],
  general: [],
  multimodal: ['multimodal', 'vision'],
  image: ['image_generation'],
  long_context: ['long_context'],
  translation: ['translation'],
  summarization: ['summarization'],
  extraction: ['extraction'],
  math: ['math', 'reasoning'],
  reasoning: ['reasoning'],
};

// ============================================================================
// Capability scoring
// ============================================================================

function scoreCapabilityFit(modelCaps: ModelCapability[], requiredCaps: ModelCapability[]): number {
  if (requiredCaps.length === 0) return 1.0;
  const matched = requiredCaps.filter((c) => modelCaps.includes(c)).length;
  return matched / requiredCaps.length;
}

function detectRequiredCapabilities(goal: string): ModelCapability[] {
  const lower = goal.toLowerCase();
  const caps: ModelCapability[] = [];

  if (/\b(image|screenshot|photo|picture|visual|diagram|chart|graph)\b/i.test(lower)) {
    caps.push('multimodal', 'vision');
  }
  if (
    /\b(generate|create|draw|paint|design|illustration)\b.*\b(image|picture|art|logo)\b/i.test(
      lower,
    )
  ) {
    caps.push('image_generation');
  }
  if (
    /\b(code|function|class|implement|refactor|debug|fix|typescript|javascript|python)\b/i.test(
      lower,
    )
  ) {
    caps.push('code');
  }
  if (/\b(reason|logic|proof|deduce|infer|analyze|evaluate|critique)\b/i.test(lower)) {
    caps.push('reasoning');
  }
  if (/\b(math|calculate|equation|formula|algebra|calculus|statistics)\b/i.test(lower)) {
    caps.push('math');
  }
  if (/\b(translate|translation|localize|language)\b/i.test(lower)) {
    caps.push('translation');
  }
  if (/\b(summarize|summary|tldr|brief|overview)\b/i.test(lower)) {
    caps.push('summarization');
  }
  if (/\b(extract|parse|scrape|data)\b.*\b(from|out of|structured)\b/i.test(lower)) {
    caps.push('extraction');
  }
  if (/\b(creative|story|poem|novel|script|creative writing)\b/i.test(lower)) {
    caps.push('creative');
  }
  if (/\b(analyze|analysis|research|compare|evaluate|assess)\b/i.test(lower)) {
    caps.push('analysis');
  }
  if (
    /\b(long|entire|whole|full|complete|exhaustive)\b.*\b(document|file|codebase|repo)\b/i.test(
      lower,
    )
  ) {
    caps.push('long_context');
  }

  return caps;
}

// ============================================================================
// Smart Model Router
// ============================================================================

export class SmartModelRouter {
  private config: ModelRouterUserConfig;
  private models: Map<string, UserModelConfig> = new Map();
  private outcomes: Map<string, { success: boolean; durationMs: number; timestamp: number }[]> =
    new Map();
  private readonly maxOutcomes = 500;
  private readonly decayHalfLifeMs = 20 * 60 * 1000;

  constructor(config?: Partial<ModelRouterUserConfig>) {
    this.config = {
      mode: config?.mode ?? 'auto',
      defaultModel: config?.defaultModel,
      modelPool: config?.modelPool ?? this.getDefaultModelPool(),
      routingRules: config?.routingRules ?? this.getDefaultRoutingRules(),
      budget: config?.budget,
    };

    for (const m of this.config.modelPool) {
      this.models.set(m.id, m);
    }
  }

  /**
   * Load configuration from JSON file or env var.
   */
  static fromConfig(config: ModelRouterUserConfig): SmartModelRouter {
    return new SmartModelRouter(config);
  }

  /**
   * Load from COMMANDER_MODELS env var (JSON string).
   */
  static fromEnv(): SmartModelRouter | null {
    const env = process.env.COMMANDER_MODELS;
    if (!env) return null;
    try {
      const config = JSON.parse(env) as ModelRouterUserConfig;
      return new SmartModelRouter(config);
    } catch (e) {
      getGlobalLogger().warn('SmartModelRouter', 'Failed to parse COMMANDER_MODELS env var', {
        error: (e as Error).message,
      });
      return null;
    }
  }

  /**
   * Main routing entry point.
   * In 'auto' mode: analyzes task, matches capabilities, picks best model.
   * In 'manual' mode: returns the user-specified default model.
   * In 'cascade' mode: returns cheapest capable model + escalation chain.
   */
  route(
    ctx: AgentExecutionContext,
    options?: {
      preferredModel?: string;
      preferredTier?: ModelTier;
      governorPhase?: string;
      registeredProviders?: Set<string>;
    },
  ): RoutingDecision & { escalationChain?: string[] } {
    const preferredModel = options?.preferredModel ?? this.config.defaultModel;

    if (preferredModel) {
      const model = this.models.get(preferredModel);
      if (model) {
        return this.buildDecision(model, 'user_selected', ctx);
      }
    }

    if (this.config.mode === 'manual') {
      const first = this.config.modelPool[0];
      if (first) return this.buildDecision(first, 'manual_mode_default', ctx);
      return this.fallbackDecision(ctx);
    }

    const requiredCaps = this.detectCapabilities(ctx.goal);
    const taskType = detectTaskType(ctx.goal);
    let candidates = this.rankCandidates(requiredCaps, taskType, ctx, options?.registeredProviders);

    // Prefer a specific tier when the orchestrator requests it (lead/specialist division).
    if (options?.preferredTier) {
      const tierCandidates = candidates.filter((m) => m.tier === options.preferredTier);
      if (tierCandidates.length > 0) {
        candidates = tierCandidates;
      }
    }

    if (candidates.length === 0) {
      return this.fallbackDecision(ctx);
    }

    if (this.config.mode === 'cascade') {
      const chain = this.buildCascadeChain(requiredCaps, taskType);
      return {
        ...this.buildDecision(candidates[0], 'cascade_start', ctx),
        escalationChain: chain.map((m) => m.id),
      };
    }

    return this.buildDecision(candidates[0], 'auto_routing', ctx);
  }

  /**
   * Get the next escalation model after a failure.
   */
  getNextEscalation(currentModelId: string, escalationChain: string[]): UserModelConfig | null {
    const idx = escalationChain.indexOf(currentModelId);
    if (idx === -1 || idx >= escalationChain.length - 1) return null;
    return this.models.get(escalationChain[idx + 1]) ?? null;
  }

  /**
   * Record execution outcome for learning.
   */
  recordOutcome(modelId: string, taskType: string, success: boolean, durationMs: number): void {
    const key = `${modelId}:${taskType}`;
    let list = this.outcomes.get(key);
    if (!list) {
      list = [];
      this.outcomes.set(key, list);
    }
    list.push({ success, durationMs, timestamp: Date.now() });

    if (list.length > this.maxOutcomes) {
      list.splice(0, list.length - this.maxOutcomes);
    }
  }

  /**
   * Get success rate for a model on a task type.
   */
  getSuccessRate(modelId: string, taskType: string): number {
    const key = `${modelId}:${taskType}`;
    const records = this.outcomes.get(key) ?? [];
    if (records.length === 0) return 0.5;

    const now = Date.now();
    let weightedSuccess = 0;
    let totalWeight = 0;

    for (const r of records) {
      const age = now - r.timestamp;
      const weight = Math.exp(-age / this.decayHalfLifeMs);
      weightedSuccess += (r.success ? 1 : 0) * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSuccess / totalWeight : 0.5;
  }

  /**
   * List all models, optionally filtered by capability.
   */
  listModels(filter?: { capability?: ModelCapability; tier?: ModelTier }): UserModelConfig[] {
    let models = Array.from(this.models.values());
    if (filter?.capability) {
      models = models.filter((m) => m.capabilities.includes(filter.capability!));
    }
    if (filter?.tier) {
      models = models.filter((m) => m.tier === filter.tier);
    }
    return models;
  }

  /**
   * Get model by ID.
   */
  getModel(modelId: string): UserModelConfig | undefined {
    return this.models.get(modelId);
  }

  /**
   * Add a model to the pool at runtime.
   */
  addModel(config: UserModelConfig): void {
    this.models.set(config.id, config);
    this.config.modelPool.push(config);
  }

  /**
   * Remove a model from the pool.
   */
  removeModel(modelId: string): boolean {
    const deleted = this.models.delete(modelId);
    this.config.modelPool = this.config.modelPool.filter((m) => m.id !== modelId);
    return deleted;
  }

  /**
   * Get routing stats for debugging.
   */
  getStats(): {
    totalModels: number;
    mode: string;
    capabilities: Record<string, number>;
    successRates: { modelId: string; taskType: string; rate: number; count: number }[];
  } {
    const capCounts: Record<string, number> = {};
    for (const m of this.models.values()) {
      for (const c of m.capabilities) {
        capCounts[c] = (capCounts[c] ?? 0) + 1;
      }
    }

    const successRates: { modelId: string; taskType: string; rate: number; count: number }[] = [];
    for (const [key, records] of this.outcomes) {
      const [modelId, ...taskParts] = key.split(':');
      successRates.push({
        modelId,
        taskType: taskParts.join(':'),
        rate: this.getSuccessRate(modelId, taskParts.join(':')),
        count: records.length,
      });
    }

    return {
      totalModels: this.models.size,
      mode: this.config.mode,
      capabilities: capCounts,
      successRates,
    };
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private detectCapabilities(goal: string): ModelCapability[] {
    const detected = detectRequiredCapabilities(goal);

    const taskType = detectTaskType(goal);
    const taskCaps = TASK_CAPABILITY_MAP[taskType] ?? [];

    const merged = new Set<ModelCapability>([...detected, ...taskCaps]);
    return Array.from(merged);
  }

  private rankCandidates(
    requiredCaps: ModelCapability[],
    taskType: string,
    ctx: AgentExecutionContext,
    registeredProviders?: Set<string>,
  ): UserModelConfig[] {
    let candidates = Array.from(this.models.values());

    if (registeredProviders && registeredProviders.size > 0) {
      candidates = candidates.filter((m) => registeredProviders.has(m.provider));
    }

    const scored = candidates.map((m) => ({
      model: m,
      score: this.scoreModel(m, requiredCaps, taskType),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.model);
  }

  private scoreModel(
    model: UserModelConfig,
    requiredCaps: ModelCapability[],
    taskType: string,
  ): number {
    const capFit = scoreCapabilityFit(model.capabilities, requiredCaps);

    const maxCost = Math.max(
      ...Array.from(this.models.values()).map((m) => m.costPer1KOutput),
      0.001,
    );
    const costRatio = model.costPer1KOutput / maxCost;
    const costEfficiency = 1 - costRatio * 0.3;

    const successRate = this.getSuccessRate(model.id, taskType);
    const effectiveRate = Math.max(0.5, successRate);
    const learningBonus = 0.8 + effectiveRate * 0.4;

    const tierBonus = model.tier === 'power' ? 1.1 : model.tier === 'standard' ? 1.0 : 0.9;

    return capFit * costEfficiency * learningBonus * tierBonus;
  }

  private buildDecision(
    model: UserModelConfig,
    reason: string,
    ctx: AgentExecutionContext,
  ): RoutingDecision {
    const estimatedInputTokens = Math.ceil(ctx.goal.length / 4) + 2048;
    const estimatedOutputTokens = Math.min(
      ctx.tokenBudget,
      model.contextWindow - estimatedInputTokens,
    );
    const estimatedCost =
      (estimatedInputTokens / 1000) * model.costPer1KInput +
      (estimatedOutputTokens / 1000) * model.costPer1KOutput;

    const requiredCaps = this.detectCapabilities(ctx.goal);

    return {
      modelId: model.id,
      tier: model.tier ?? 'standard',
      provider: model.provider,
      reasoning: [
        `routing_mode: ${this.config.mode}`,
        `reason: ${reason}`,
        `required_capabilities: ${requiredCaps.join(', ') || 'none'}`,
        `model_capabilities: ${model.capabilities.join(', ')}`,
        `cost_estimate: $${estimatedCost.toFixed(6)}`,
      ],
      estimatedCost: Math.round(estimatedCost * 100000) / 100000,
      maxTokens: Math.min(estimatedOutputTokens, model.maxOutputTokens ?? 200000),
    };
  }

  private buildCascadeChain(requiredCaps: ModelCapability[], taskType: string): UserModelConfig[] {
    const tierOrder: ModelTier[] = ['eco', 'standard', 'power'];
    const chain: UserModelConfig[] = [];

    for (const tier of tierOrder) {
      const tierModels = Array.from(this.models.values())
        .filter((m) => (m.tier ?? 'standard') === tier)
        .filter((m) => scoreCapabilityFit(m.capabilities, requiredCaps) > 0.5)
        .sort((a, b) => a.costPer1KOutput - b.costPer1KOutput);

      for (const m of tierModels) {
        if (chain.length >= 3) break;
        if (!chain.some((c) => c.id === m.id)) {
          chain.push(m);
        }
      }
      if (chain.length >= 3) break;
    }

    return chain;
  }

  private fallbackDecision(ctx: AgentExecutionContext): RoutingDecision {
    return {
      modelId: 'gpt-4o-mini',
      tier: 'eco',
      provider: 'openai',
      reasoning: ['fallback: no suitable model found in pool'],
      estimatedCost: 0,
      maxTokens: 4000,
    };
  }

  private getDefaultModelPool(): UserModelConfig[] {
    return [
      {
        id: 'gpt-4o-mini',
        provider: 'openai',
        tier: 'eco',
        capabilities: [
          'code',
          'analysis',
          'fast',
          'low_cost',
          'function_calling',
          'json_mode',
          'streaming',
        ],
        costPer1KInput: 0.00015,
        costPer1KOutput: 0.0006,
        contextWindow: 128000,
        displayName: 'GPT-4o Mini',
      },
      {
        id: 'gpt-4o',
        provider: 'openai',
        tier: 'standard',
        capabilities: [
          'code',
          'reasoning',
          'analysis',
          'creative',
          'multimodal',
          'vision',
          'function_calling',
          'json_mode',
          'streaming',
        ],
        costPer1KInput: 0.0025,
        costPer1KOutput: 0.01,
        contextWindow: 128000,
        displayName: 'GPT-4o',
      },
      {
        id: 'claude-haiku-4-5',
        provider: 'anthropic',
        tier: 'eco',
        capabilities: ['code', 'analysis', 'fast', 'low_cost', 'streaming'],
        costPer1KInput: 0.0008,
        costPer1KOutput: 0.004,
        contextWindow: 200000,
        displayName: 'Claude Haiku 4.5',
      },
      {
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        tier: 'standard',
        capabilities: [
          'code',
          'reasoning',
          'analysis',
          'creative',
          'math',
          'multimodal',
          'vision',
          'long_context',
          'streaming',
        ],
        costPer1KInput: 0.003,
        costPer1KOutput: 0.015,
        contextWindow: 200000,
        displayName: 'Claude Sonnet 4.6',
      },
      {
        id: 'claude-opus-4-8',
        provider: 'anthropic',
        tier: 'power',
        capabilities: [
          'code',
          'reasoning',
          'analysis',
          'creative',
          'math',
          'multimodal',
          'vision',
          'long_context',
          'high_quality',
          'streaming',
        ],
        costPer1KInput: 0.015,
        costPer1KOutput: 0.075,
        contextWindow: 200000,
        displayName: 'Claude Opus 4.8',
      },
      {
        id: 'gemini-2-flash',
        provider: 'google',
        tier: 'eco',
        capabilities: ['analysis', 'fast', 'low_cost', 'long_context', 'multimodal', 'vision'],
        costPer1KInput: 0.0001,
        costPer1KOutput: 0.0004,
        contextWindow: 1000000,
        displayName: 'Gemini 2.0 Flash',
      },
      {
        id: 'gemini-2-pro',
        provider: 'google',
        tier: 'standard',
        capabilities: ['reasoning', 'analysis', 'math', 'long_context', 'multimodal', 'vision'],
        costPer1KInput: 0.0015,
        costPer1KOutput: 0.0075,
        contextWindow: 1000000,
        displayName: 'Gemini 2.0 Pro',
      },
      {
        id: 'deepseek-v4-flash',
        provider: 'deepseek',
        tier: 'eco',
        capabilities: ['code', 'reasoning', 'math', 'fast', 'low_cost'],
        costPer1KInput: 0.00014,
        costPer1KOutput: 0.00028,
        contextWindow: 128000,
        displayName: 'DeepSeek V4 Flash',
      },
      {
        id: 'deepseek-v4-pro',
        provider: 'deepseek',
        tier: 'power',
        capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math', 'long_context'],
        costPer1KInput: 0.002,
        costPer1KOutput: 0.008,
        contextWindow: 128000,
        displayName: 'DeepSeek V4 Pro',
      },
      {
        id: 'mimo-v2.5-pro',
        provider: 'mimo',
        tier: 'power',
        capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
        costPer1KInput: 0.004,
        costPer1KOutput: 0.012,
        contextWindow: 128000,
        displayName: 'MiMo V2.5 Pro',
      },
      {
        id: 'agnes-2.0-flash',
        provider: 'agnes',
        tier: 'eco',
        capabilities: ['code', 'reasoning', 'analysis', 'fast', 'low_cost', 'streaming'],
        costPer1KInput: 0,
        costPer1KOutput: 0,
        contextWindow: 128000,
        maxOutputTokens: 65536,
        displayName: 'Agnes 2.0 Flash',
      },
    ];
  }

  private getDefaultRoutingRules(): RoutingRule[] {
    return [
      {
        taskType: 'code',
        requiredCapabilities: ['code'],
        preferredTier: 'standard',
      },
      {
        taskType: 'multimodal',
        requiredCapabilities: ['multimodal', 'vision'],
        preferredTier: 'standard',
      },
      {
        taskType: 'math',
        requiredCapabilities: ['math', 'reasoning'],
        preferredTier: 'power',
      },
      {
        taskType: 'creative',
        requiredCapabilities: ['creative'],
        preferredTier: 'standard',
      },
      {
        taskType: 'long_context',
        requiredCapabilities: ['long_context'],
        preferredTier: 'standard',
      },
    ];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalRouter: SmartModelRouter | null = null;

export function getSmartModelRouter(): SmartModelRouter {
  if (!globalRouter) {
    globalRouter = SmartModelRouter.fromEnv() ?? new SmartModelRouter();
  }
  return globalRouter;
}

export function setSmartModelRouter(router: SmartModelRouter): void {
  globalRouter = router;
}
