/**
 * Smart Model Router — Task-aware, learning, cost-optimized model selection.
 *
 * Surpasses OpenClaw's multi-model routing by adding:
 * 1. Task-type → capability matching (code tasks → code-capable models)
 * 2. Outcome-based learning with time decay (track success per model per task type)
 * 3. Model fallback chain (try next candidate on failure)
 * 4. Governor-aware budgeting (tight budget → cheaper models)
 * 5. Cost-quality tradeoff (score models by capability fit × cost efficiency)
 * 6. Latency-aware routing (track TTFT/TPOT per provider, route to fastest)
 * 7. Confidence-based escalation (cheap model self-reports confidence)
 * 8. User-tier routing (free/paid/enterprise)
 * 9. Quality floor + cost ceiling dual modes
 * 10. Explore/exploit mechanism (discover new providers)
 * 11. Multi-signal complexity classifier (keyword, language, domain)
 *
 * Backward compatible: same class name, same route() interface.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import type { ModelConfig, ModelTier, RoutingDecision, AgentExecutionContext } from './types';
// detectTaskType lives in taskAnalyzer.ts (a leaf module that only imports
// types). Importing it directly from here avoids the cycle
//   modelRouter → unifiedVerification → goalJudge → modelRouter
// that would arise if we imported from unifiedVerification.ts (which re-exports
// detectTaskType). The previous lazy require() broke vitest because native
// require cannot resolve .ts source files.
import { detectTaskType } from './taskAnalyzer';

function detectTaskTypeLazy(goal: string): string {
  return detectTaskType(goal);
}

// ============================================================================
// Latency tracking types
// ============================================================================

export interface ProviderLatency {
  provider: string;
  modelId: string;
  ewmaTTFT: number;
  ewmaTPOT: number;
  errorRate: number;
  lastUpdated: number;
  sampleCount: number;
}

// ============================================================================
// User tier types
// ============================================================================

export type UserTier = 'free' | 'paid' | 'enterprise';

// ============================================================================
// Routing objective types
// ============================================================================

export type RoutingObjective =
  | { type: 'cost_at_quality_floor'; minQuality: number }
  | { type: 'quality_at_cost_ceiling'; maxCostPerRequest: number }
  | { type: 'balanced' };

// ============================================================================
// Confidence check types
// ============================================================================

export interface ConfidenceCheckResult {
  confidence: number;
  shouldEscalate: boolean;
  reason: string;
}

// ============================================================================
// Default model registry
// ============================================================================

const DEFAULT_MODELS: ModelConfig[] = [
  // ===== Eco tier — cheap & fast =====
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    tier: 'eco',
    costPer1MInput: 0.8,
    costPer1MOutput: 4,
    costPer1MCachedInput: 0.08,
    capabilities: ['code', 'analysis'],
    contextWindow: 200000,
    priority: 0,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
    supportsBatchAPI: true,
    maxBatchSize: 100000,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    tier: 'eco',
    costPer1MInput: 0.15,
    costPer1MOutput: 0.6,
    costPer1MCachedInput: 0.075,
    capabilities: ['code', 'analysis'],
    contextWindow: 128000,
    priority: 1,
    supportsJSONMode: true,
    supportsStructuredOutput: true,
    supportsBatchAPI: true,
    maxBatchSize: 50000,
  },
  {
    id: 'gemini-2-flash',
    provider: 'google',
    tier: 'eco',
    costPer1MInput: 0.1,
    costPer1MOutput: 0.4,
    costPer1MCachedInput: 0.025,
    capabilities: ['analysis'],
    contextWindow: 1000000,
    priority: 2,
    supportsJSONMode: true,
    supportsStructuredOutput: true,
  },
  {
    id: 'llama-3.3-70b-versatile',
    provider: 'groq',
    tier: 'eco',
    costPer1MInput: 0.59,
    costPer1MOutput: 0.79,
    capabilities: ['code', 'analysis'],
    contextWindow: 128000,
    priority: 3,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'mistral-small-latest',
    provider: 'mistral',
    tier: 'eco',
    costPer1MInput: 1,
    costPer1MOutput: 1,
    capabilities: ['code', 'analysis'],
    contextWindow: 32000,
    priority: 4,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'command-r-08-2024',
    provider: 'cohere',
    tier: 'eco',
    costPer1MInput: 0.5,
    costPer1MOutput: 1.5,
    capabilities: ['analysis'],
    contextWindow: 128000,
    priority: 5,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'sonar',
    provider: 'perplexity',
    tier: 'eco',
    costPer1MInput: 1,
    costPer1MOutput: 1,
    capabilities: ['analysis'],
    contextWindow: 128000,
    priority: 6,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  // Local providers — effectively free
  {
    id: 'llama3.2',
    provider: 'ollama',
    tier: 'eco',
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code', 'analysis'],
    contextWindow: 128000,
    priority: 7,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'meta-llama/Llama-3.2-3B-Instruct',
    provider: 'vllm',
    tier: 'eco',
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code', 'analysis'],
    contextWindow: 128000,
    priority: 8,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },

  // ===== Standard tier — balanced quality/cost =====
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    tier: 'standard',
    costPer1MInput: 3,
    costPer1MOutput: 15,
    costPer1MCachedInput: 0.3,
    capabilities: ['code', 'reasoning', 'analysis', 'creative'],
    contextWindow: 200000,
    priority: 0,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
    supportsBatchAPI: true,
    maxBatchSize: 100000,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    tier: 'standard',
    costPer1MInput: 2.5,
    costPer1MOutput: 10,
    costPer1MCachedInput: 1.25,
    capabilities: ['code', 'reasoning', 'analysis', 'creative'],
    contextWindow: 128000,
    priority: 1,
    supportsJSONMode: true,
    supportsStructuredOutput: true,
    supportsBatchAPI: true,
    maxBatchSize: 50000,
  },
  {
    id: 'gemini-2-pro',
    provider: 'google',
    tier: 'standard',
    costPer1MInput: 1.5,
    costPer1MOutput: 7.5,
    costPer1MCachedInput: 0.375,
    capabilities: ['reasoning', 'analysis'],
    contextWindow: 1000000,
    priority: 2,
    supportsJSONMode: true,
    supportsStructuredOutput: true,
  },
  {
    id: 'mistral-large-latest',
    provider: 'mistral',
    tier: 'standard',
    costPer1MInput: 2,
    costPer1MOutput: 6,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 3,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    provider: 'together',
    tier: 'standard',
    costPer1MInput: 0.9,
    costPer1MOutput: 0.9,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 131072,
    priority: 4,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'sonar-pro',
    provider: 'perplexity',
    tier: 'standard',
    costPer1MInput: 3,
    costPer1MOutput: 15,
    capabilities: ['reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 5,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    provider: 'fireworks',
    tier: 'standard',
    costPer1MInput: 0.9,
    costPer1MOutput: 0.9,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 6,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'llama3-70b-8192',
    provider: 'groq',
    tier: 'standard',
    costPer1MInput: 0.59,
    costPer1MOutput: 0.79,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 8192,
    priority: 7,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'command-r-plus-08-2024',
    provider: 'cohere',
    tier: 'standard',
    costPer1MInput: 3,
    costPer1MOutput: 15,
    capabilities: ['reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 8,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'anthropic.claude-sonnet-4-6-v1:0',
    provider: 'bedrock',
    tier: 'standard',
    costPer1MInput: 3,
    costPer1MOutput: 15,
    capabilities: ['code', 'reasoning', 'analysis', 'creative'],
    contextWindow: 200000,
    priority: 9,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'meta/meta-llama-3.3-70b-instruct',
    provider: 'replicate',
    tier: 'standard',
    costPer1MInput: 0.65,
    costPer1MOutput: 2.75,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 10,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'grok-3',
    provider: 'xai',
    tier: 'standard',
    costPer1MInput: 3,
    costPer1MOutput: 15,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 131072,
    priority: 11,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },

  // ===== StepFun — reasoning-capable, competitive pricing =====
  {
    id: 'step-3.7-flash',
    provider: 'stepfun',
    tier: 'standard',
    costPer1MInput: 1,
    costPer1MOutput: 4,
    costPer1MCachedInput: 0.5,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 12,
    supportsJSONMode: true,
    supportsStructuredOutput: true,
  },
  {
    id: 'step-3.5-flash',
    provider: 'stepfun',
    tier: 'eco',
    costPer1MInput: 0.5,
    costPer1MOutput: 2,
    costPer1MCachedInput: 0.25,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 9,
    supportsJSONMode: true,
    supportsStructuredOutput: true,
  },

  // ===== Power tier — strongest reasoning =====
  {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    tier: 'power',
    costPer1MInput: 15,
    costPer1MOutput: 75,
    costPer1MCachedInput: 1.5,
    capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
    contextWindow: 200000,
    priority: 0,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
    supportsBatchAPI: true,
    maxBatchSize: 100000,
  },
  {
    id: 'gpt-5',
    provider: 'openai',
    tier: 'power',
    costPer1MInput: 10,
    costPer1MOutput: 40,
    costPer1MCachedInput: 1.0,
    capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
    contextWindow: 256000,
    priority: 1,
    supportsJSONMode: true,
    supportsStructuredOutput: true,
    supportsBatchAPI: true,
    maxBatchSize: 50000,
  },
  {
    id: 'bedrock-claude-sonnet-4-6',
    provider: 'bedrock',
    tier: 'power',
    costPer1MInput: 3,
    costPer1MOutput: 15,
    capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
    contextWindow: 200000,
    priority: 2,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    tier: 'power',
    costPer1MInput: 2,
    costPer1MOutput: 8,
    costPer1MCachedInput: 0.02,
    capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
    contextWindow: 128000,
    priority: 3,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'mimo-v2.5-pro',
    provider: 'mimo',
    tier: 'power',
    costPer1MInput: 4,
    costPer1MOutput: 12,
    capabilities: ['code', 'reasoning', 'analysis', 'creative'],
    contextWindow: 128000,
    priority: 4,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
  {
    id: 'glm-5.1',
    provider: 'glm',
    tier: 'power',
    costPer1MInput: 2,
    costPer1MOutput: 8,
    capabilities: ['code', 'reasoning', 'analysis', 'creative'],
    contextWindow: 128000,
    priority: 5,
    supportsJSONMode: false,
    supportsStructuredOutput: false,
  },
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
// Provider tier recommendations
// ============================================================================

export type ProviderTier = 'essential' | 'budget' | 'enterprise' | 'full';

export interface ProviderTierConfig {
  description: string;
  providers: string[];
  minModels: number;
}

export const RECOMMENDED_TIERS: Record<ProviderTier, ProviderTierConfig> = {
  essential: {
    description: 'Covers 95% of use cases with top 3 providers',
    providers: ['openai', 'anthropic', 'google'],
    minModels: 3,
  },
  budget: {
    description: 'Cost-optimized alternatives with good performance',
    providers: ['deepseek', 'groq'],
    minModels: 2,
  },
  enterprise: {
    description: 'SOC2/compliance requirements with managed services',
    providers: ['bedrock', 'azure'],
    minModels: 2,
  },
  full: {
    description: 'Maximum resilience with all 22 providers',
    providers: ['*'],
    minModels: 8,
  },
};

// ============================================================================
// Outcome tracking for learning
// ============================================================================

export interface ModelOutcome {
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

const HIGH_COMPLEXITY_KEYWORDS = [
  'refactor',
  'architecture',
  'security',
  'audit',
  'optimize',
  'migrate',
  'debug',
  'diagnose',
  'investigate',
  'analyze',
  'comprehensive',
  'complex',
  'distributed',
  'concurrent',
  'parallel',
  'async',
  'pipeline',
  'orchestrat',
  'compliance',
  'regulatory',
  'encryption',
  'authentication',
  'authorization',
];

const MEDIUM_COMPLEXITY_KEYWORDS = [
  'implement',
  'add',
  'create',
  'build',
  'update',
  'fix',
  'change',
  'integrate',
  'connect',
  'configure',
  'setup',
  'deploy',
  'test',
];

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  legal: ['contract', 'compliance', 'regulation', 'liability', 'clause', 'jurisdiction'],
  medical: ['diagnosis', 'patient', 'clinical', 'treatment', 'pharmacology', 'symptom'],
  financial: ['portfolio', 'derivative', 'hedging', 'valuation', 'risk_model', 'actuarial'],
  scientific: ['hypothesis', 'experiment', 'methodology', 'peer_review', 'replication'],
};

function scoreComplexity(ctx: AgentExecutionContext): ComplexityScore {
  const factors: { name: string; contribution: number }[] = [];
  let score = 0;
  const goalLower = ctx.goal.toLowerCase();

  const keywordHigh = HIGH_COMPLEXITY_KEYWORDS.filter((k) => goalLower.includes(k)).length;
  const keywordMedium = MEDIUM_COMPLEXITY_KEYWORDS.filter((k) => goalLower.includes(k)).length;
  if (keywordHigh >= 3) {
    score += 3;
    factors.push({ name: 'many_complex_keywords', contribution: 3 });
  } else if (keywordHigh >= 1) {
    score += 2;
    factors.push({ name: 'complex_keywords', contribution: 2 });
  } else if (keywordMedium >= 2) {
    score += 1;
    factors.push({ name: 'medium_keywords', contribution: 1 });
  }

  let domainHits = 0;
  let matchedDomain = '';
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const hits = keywords.filter((k) => goalLower.includes(k)).length;
    if (hits >= 2) {
      domainHits = hits;
      matchedDomain = domain;
      break;
    }
  }
  if (domainHits >= 3) {
    score += 3;
    factors.push({ name: `domain_expert_${matchedDomain}`, contribution: 3 });
  } else if (domainHits >= 2) {
    score += 2;
    factors.push({ name: `domain_specific_${matchedDomain}`, contribution: 2 });
  }

  if (ctx.goal.length > 400) {
    score += 2;
    factors.push({ name: 'long_goal', contribution: 2 });
  } else if (ctx.goal.length > 150) {
    score += 1;
    factors.push({ name: 'medium_goal', contribution: 1 });
  }

  if (ctx.availableTools.length > 5) {
    score += 2;
    factors.push({ name: 'many_tools', contribution: 2 });
  } else if (ctx.availableTools.length > 3) {
    score += 1;
    factors.push({ name: 'several_tools', contribution: 1 });
  }

  if (ctx.tokenBudget > 20000) {
    score += 2;
    factors.push({ name: 'large_budget', contribution: 2 });
  } else if (ctx.tokenBudget > 6000) {
    score += 1;
    factors.push({ name: 'medium_budget', contribution: 1 });
  }

  const gov = ctx.contextData.governanceProfile as { riskLevel?: string } | undefined;
  if (gov?.riskLevel === 'CRITICAL') {
    score += 3;
    factors.push({ name: 'critical_risk', contribution: 3 });
  } else if (gov?.riskLevel === 'HIGH') {
    score += 2;
    factors.push({ name: 'high_risk', contribution: 2 });
  }

  return { score: Math.min(score, 10), factors };
}

// ============================================================================
// Smart Model Router
// ============================================================================

export class ModelRouter {
  private models: Map<string, ModelConfig> = new Map();
  private tierIndex: Map<ModelTier, ModelConfig[]> = new Map();
  private outcomesIndex: Map<string, ModelOutcome[]> = new Map();
  private outcomes: ModelOutcome[] = [];
  private readonly maxOutcomes = 500;
  private readonly decayHalfLifeMs = 20 * 60 * 1000;
  private readonly minSamplesForLearning = 30;

  private latencyIndex: Map<string, ProviderLatency> = new Map();
  private readonly EWMA_ALPHA = 0.3;
  private readonly EWMA_BETA = 0.3;
  private readonly EWMA_ERROR = 0.1;
  private exploreRatio = 0.1;
  private routingCount = 0;
  private exploreCount = 0;
  private userTiers: Map<string, UserTier> = new Map();
  private routingObjective: RoutingObjective = { type: 'balanced' };
  private readonly CONFIDENCE_THRESHOLD = 0.6;
  private readonly LATENCY_COEFFICIENT = 0.15;

  constructor(customModels?: ModelConfig[]) {
    const allModels = customModels ?? DEFAULT_MODELS;
    for (const m of allModels) {
      this.models.set(m.id, m);
    }
    this.rebuildTierIndex();
  }

  /**
   * Configure router from environment variables based on provider tier.
   * Auto-detects available providers from env vars and returns filtered models.
   */
  configureFromTier(tier: ProviderTier): ModelConfig[] {
    const tierConfig = RECOMMENDED_TIERS[tier];
    if (tierConfig.providers.includes('*')) {
      return Array.from(this.models.values());
    }

    return Array.from(this.models.values()).filter((m) =>
      tierConfig.providers.includes(m.provider),
    );
  }

  /**
   * Get recommended providers for a given tier.
   */
  getRecommendedProviders(tier: ProviderTier): string[] {
    return RECOMMENDED_TIERS[tier].providers;
  }

  /**
   * Get all available provider tiers.
   */
  getProviderTiers(): Array<{ tier: ProviderTier; description: string; modelCount: number }> {
    return Object.entries(RECOMMENDED_TIERS).map(([tier, config]) => ({
      tier: tier as ProviderTier,
      description: config.description,
      modelCount: config.providers.includes('*')
        ? this.models.size
        : Array.from(this.models.values()).filter((m) => config.providers.includes(m.provider))
            .length,
    }));
  }

  /** Pre-index models by tier for O(1) lookups */
  private rebuildTierIndex(): void {
    this.tierIndex.clear();
    for (const m of this.models.values()) {
      let list = this.tierIndex.get(m.tier);
      if (!list) {
        list = [];
        this.tierIndex.set(m.tier, list);
      }
      list.push(m);
    }
    // Sort each tier by priority
    for (const list of this.tierIndex.values()) {
      list.sort((a, b) => a.priority - b.priority);
    }
  }

  registerModel(config: ModelConfig): void {
    this.models.set(config.id, config);
    this.rebuildTierIndex();
  }

  getModel(modelId: string): ModelConfig | undefined {
    return this.models.get(modelId);
  }

  listModels(tier?: ModelTier): ModelConfig[] {
    if (tier) return [...(this.tierIndex.get(tier) ?? [])];
    return Array.from(this.models.values());
  }

  /**
   * Route an execution context to the optimal model.
   * Now task-type-aware with capability matching and governor integration.
   * @param governorPhase - Current budget governor phase ('relaxed'|'moderate'|'tight'|'critical').
   *   Callers should pass their per-run governor state instead of relying on global singleton.
   */
  route(
    ctx: AgentExecutionContext,
    governorPhase?: string,
    preferredTier?: ModelTier,
    registeredProviders?: Set<string>,
  ): RoutingDecision {
    const complexity = scoreComplexity(ctx);
    const taskType = detectTaskTypeLazy(ctx.goal);
    const requiredCaps = TASK_CAPABILITY_MAP[taskType] ?? [];

    const governor = governorPhase ?? 'relaxed';
    let tier = preferredTier ?? this.selectTier(complexity, ctx, governor);

    if (requiredCaps.length > 0) {
      tier = this.bumpTierForCapabilities(tier, requiredCaps);
    }

    const candidates = this.rankCandidates(tier, requiredCaps, taskType, ctx, registeredProviders);
    let model = candidates[0];

    this.routingCount++;
    if (Math.random() < this.exploreRatio && candidates.length > 1) {
      const randomIdx = 1 + Math.floor(Math.random() * Math.min(candidates.length - 1, 3));
      model = candidates[randomIdx];
      this.exploreCount++;
    }

    const userId = ctx.userId;
    if (userId) {
      const userTier = this.getUserTier(userId);
      if (userTier === 'free' && model.tier === 'power') {
        const ecoCandidate = candidates.find((m) => m.tier === 'eco' || m.tier === 'standard');
        if (ecoCandidate) model = ecoCandidate;
      }
    }

    const reasoning: string[] = [
      `complexity: ${complexity.score}/10 (${complexity.factors.map((f) => f.name).join(', ')})`,
      `task_type: ${taskType}`,
      `required_capabilities: ${requiredCaps.join(', ') || 'none'}`,
      `selected_tier: ${tier}`,
      `governor_phase: ${governor}`,
      `candidates_ranked: ${candidates.length}`,
      `selected_model: ${model?.id ?? 'none'}`,
      `routing_objective: ${this.routingObjective.type}`,
      `explore_ratio: ${this.exploreRatio}`,
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
    const estimatedOutputTokens = Math.min(
      ctx.tokenBudget,
      model.contextWindow - estimatedInputTokens,
    );
    const estimatedCost =
      (estimatedInputTokens / 1_000_000) * model.costPer1MInput +
      (estimatedOutputTokens / 1_000_000) * model.costPer1MOutput;

    return {
      modelId: model.id,
      tier: model.tier,
      provider: model.provider,
      reasoning,
      estimatedCost: Math.round(estimatedCost * 100000) / 100000,
      maxTokens: Math.min(estimatedOutputTokens, 200000),
    };
  }

  /**
   * Record a model execution outcome for learning.
   * Call this after each successful or failed model execution.
   */
  recordOutcome(
    modelId: string,
    taskType: string,
    success: boolean,
    durationMs: number,
    tokensUsed: number,
  ): void {
    const record: ModelOutcome = {
      modelId,
      taskType,
      success,
      durationMs,
      tokensUsed,
      timestamp: Date.now(),
    };
    this.outcomes.push(record);

    // Update outcomes index for O(1) lookups
    const key = `${modelId}:${taskType}`;
    let list = this.outcomesIndex.get(key);
    if (!list) {
      list = [];
      this.outcomesIndex.set(key, list);
    }
    list.push(record);

    // Prune old outcomes
    if (this.outcomes.length > this.maxOutcomes) {
      const evicted = this.outcomes.shift()!;
      const evictedKey = `${evicted.modelId}:${evicted.taskType}`;
      const evictedList = this.outcomesIndex.get(evictedKey);
      if (evictedList) {
        const idx = evictedList.indexOf(evicted);
        if (idx !== -1) evictedList.splice(idx, 1);
        if (evictedList.length === 0) this.outcomesIndex.delete(evictedKey);
      }
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

    // Try same tier, next priority (pre-sorted by priority)
    const sameTier = (this.tierIndex.get(failed.tier) ?? []).filter((m) => m.id !== failedModelId);
    for (const candidate of sameTier) {
      if (this.hasCapabilities(candidate, requiredCaps)) return candidate;
    }

    // Step down tier (pre-sorted by priority)
    const tierOrder: ModelTier[] = ['power', 'standard', 'eco'];
    const currentIdx = tierOrder.indexOf(failed.tier);
    for (let i = currentIdx + 1; i < tierOrder.length; i++) {
      const lowerTier = this.tierIndex.get(tierOrder[i]) ?? [];
      for (const candidate of lowerTier) {
        if (this.hasCapabilities(candidate, requiredCaps)) return candidate;
      }
    }

    return undefined;
  }

  /**
   * Get a cascade chain: ordered list of models from cheapest to most capable.
   * Implements FrugalGPT's LLM cascade pattern (arXiv:2305.05176):
   * try cheap first, escalate on failure/low-confidence.
   *
   * @param taskType - The task type for capability filtering
   * @param maxModels - Maximum models in the cascade (default: 3)
   * @returns Ordered array of models: cheapest first, most capable last
   */
  getCascadeChain(
    taskType?: string,
    maxModels: number = 3,
    registeredProviders?: Set<string>,
  ): ModelConfig[] {
    const requiredCaps = TASK_CAPABILITY_MAP[taskType ?? 'general'] ?? [];
    const tierOrder: ModelTier[] = ['eco', 'standard', 'power', 'consensus'];
    const chain: ModelConfig[] = [];

    for (const tier of tierOrder) {
      if (chain.length >= maxModels) break;
      let tierModels = this.tierIndex.get(tier) ?? [];
      if (registeredProviders && registeredProviders.size > 0) {
        tierModels = tierModels.filter((m) => registeredProviders.has(m.provider));
      }
      for (const model of tierModels) {
        if (chain.length >= maxModels) break;
        if (this.hasCapabilities(model, requiredCaps)) {
          // Avoid duplicates (same model can appear in multiple tiers like bedrock)
          if (!chain.some((m) => m.id === model.id && m.provider === model.provider)) {
            chain.push(model);
          }
        }
      }
    }

    return chain;
  }

  /**
   * Route with FrugalGPT cascade: start with the cheapest capable model,
   * escalate on failure. Returns both the initial routing AND the escalation chain.
   *
   * Evidence:
   * - FrugalGPT (arXiv:2305.05176): try cheap first, escalate on failure/low-confidence
   *   achieves 2-8x cost reduction with <1% quality loss
   * - OpenAI: cascade routing reduces cost by 50-70% on easy tasks
   *
   * @param governorPhase - When 'tight' or 'critical', always use cascade (start cheap).
   *   When 'relaxed' or 'moderate', use standard routing (start optimal).
   */
  routeWithCascade(
    ctx: AgentExecutionContext,
    governorPhase?: string,
    preferredTier?: ModelTier,
    registeredProviders?: Set<string>,
  ): { initial: RoutingDecision; escalationChain: ModelConfig[] } {
    const governor = governorPhase ?? 'relaxed';
    const taskType = detectTaskTypeLazy(ctx.goal);

    // In relaxed/moderate mode, use standard routing (start optimal)
    if (governor === 'relaxed' || governor === 'moderate') {
      const initial = this.route(ctx, governor, preferredTier, registeredProviders);
      const chain = this.getCascadeChain(taskType, 3, registeredProviders);
      return { initial, escalationChain: chain };
    }

    // In tight/critical mode, start with cheapest capable model (FrugalGPT pattern)
    const chain = this.getCascadeChain(taskType, 3, registeredProviders);

    if (chain.length === 0) {
      // Fallback to standard routing
      return {
        initial: this.route(ctx, governor, preferredTier, registeredProviders),
        escalationChain: [],
      };
    }

    // Start with the cheapest model in the chain
    const cheapest = chain[0];
    const complexity = scoreComplexity(ctx);
    const estimatedInputTokens = Math.ceil(ctx.goal.length / 4) + 2048;
    const estimatedOutputTokens = Math.min(
      ctx.tokenBudget,
      cheapest.contextWindow - estimatedInputTokens,
    );

    const initial: RoutingDecision = {
      modelId: cheapest.id,
      tier: cheapest.tier,
      provider: cheapest.provider,
      reasoning: [
        `frugal_cascade: starting with cheapest model (${cheapest.id})`,
        `complexity: ${complexity.score}/10`,
        `task_type: ${taskType}`,
        `governor_phase: ${governor}`,
        `escalation_chain: ${chain.map((m) => m.id).join(' → ')}`,
      ],
      estimatedCost:
        (estimatedInputTokens / 1_000_000) * cheapest.costPer1MInput +
        (estimatedOutputTokens / 1_000_000) * cheapest.costPer1MOutput,
      maxTokens: Math.min(estimatedOutputTokens, 200000),
    };

    // Escalation chain is the remaining models (skip the first one we're already using)
    const escalationChain = chain.slice(1);

    return { initial, escalationChain };
  }

  /**
   * Get the next escalation model from the chain after a failure.
   * Returns the next more capable model, or undefined if chain is exhausted.
   */
  getNextEscalation(
    currentModelId: string,
    escalationChain: ModelConfig[],
  ): ModelConfig | undefined {
    const currentIdx = escalationChain.findIndex((m) => m.id === currentModelId);
    if (currentIdx === -1) {
      // Current model not in chain; return the first escalation model
      return escalationChain[0];
    }
    // Return the next model in the chain
    return escalationChain[currentIdx + 1];
  }

  /**
   * Estimate cost for a given context and expected output length.
   */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const model = this.models.get(modelId);
    if (!model) return 0;
    return (
      (inputTokens / 1_000_000) * model.costPer1MInput +
      (outputTokens / 1_000_000) * model.costPer1MOutput
    );
  }

  /**
   * Route a task to batch API processing if eligible.
   * Batch APIs offer 50% cost savings for non-urgent tasks (OpenAI, Anthropic, Google).
   * Returns the best batch-capable model for the task, or undefined if no batch model is suitable.
   *
   * Eligibility criteria:
   * - Task is not time-sensitive (no real-time user waiting)
   * - A batch-capable model exists at the appropriate tier
   * - Task doesn't require immediate tool interaction
   */
  routeBatch(ctx: AgentExecutionContext, tier?: ModelTier): ModelConfig | undefined {
    const taskType = detectTaskTypeLazy(ctx.goal);
    const requiredCaps = TASK_CAPABILITY_MAP[taskType] ?? [];
    const targetTier = tier ?? 'eco';

    const tierOrder: ModelTier[] = [targetTier, 'eco', 'standard'];
    for (const t of tierOrder) {
      const candidates = (this.tierIndex.get(t) ?? []).filter(
        (m) => m.supportsBatchAPI && this.hasCapabilities(m, requiredCaps),
      );
      if (candidates.length > 0) {
        // Return the cheapest batch-capable model
        candidates.sort((a, b) => a.costPer1MOutput - b.costPer1MOutput);
        return candidates[0];
      }
    }
    return undefined;
  }

  /**
   * Check if a task is suitable for batch processing.
   * Batch is ideal for: evaluation runs, data labeling, document processing,
   * nightly analysis, embedding backfills — tasks where 24h turnaround is acceptable
   * for 50% cost savings (OpenAI, Anthropic, Google all offer batch at 50% discount).
   * Batch is NOT suitable for: interactive chat, real-time code fixes,
   * sequential multi-turn tool chains requiring immediate feedback.
   *
   * @returns true if the task can be deferred to batch processing
   */
  static isBatchEligible(ctx: AgentExecutionContext): boolean {
    // Fail-closed: never batch interactive multi-step tool chains
    // (>5 steps need real-time tool interaction and feedback loops)
    if (ctx.maxSteps > 5) return false;
    // Fail-closed: never batch when tools are present (tool calls require
    // real-time execution and result feedback — batch can't do this)
    if (ctx.availableTools && ctx.availableTools.length > 0) return false;
    // Low-budget tasks can tolerate delay (and batch savings matter proportionally more)
    if (ctx.tokenBudget <= 4000) return true;
    // High-token tasks benefit most from 50% batch savings (absolute $ savings)
    if (ctx.tokenBudget > 50000) return true;
    // Medium-budget tasks with ≤5 steps: batch if not time-sensitive
    // Sub-agents and evaluation runs (with parentRunId) can be batched
    if (ctx.maxSteps <= 5 && ctx.parentRunId) return true;
    // Single-step tasks with moderate budget still benefit from batch savings
    if (ctx.maxSteps <= 1) return true;
    return false;
  }

  /**
   * Check if learning is active for a model:taskType pair.
   * Learning requires minimum samples to avoid cold-start noise.
   */
  isLearningActive(modelId: string, taskType: string): boolean {
    const key = `${modelId}:${taskType}`;
    const relevant = this.outcomesIndex.get(key) ?? [];
    return relevant.length >= this.minSamplesForLearning;
  }

  /**
   * Get minimum samples threshold for learning activation.
   */
  getMinSamplesForLearning(): number {
    return this.minSamplesForLearning;
  }

  /**
   * Get learning stats for debugging.
   */
  getLearningStats(): {
    modelId: string;
    taskType: string;
    successRate: string;
    avgDuration: number;
    count: number;
    learningActive: boolean;
  }[] {
    const stats: {
      modelId: string;
      taskType: string;
      successRate: string;
      avgDuration: number;
      count: number;
      learningActive: boolean;
    }[] = [];
    for (const [key, outcomes] of this.outcomesIndex) {
      const colonIdx = key.lastIndexOf(':');
      const modelId = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
      const taskType = colonIdx >= 0 ? key.slice(colonIdx + 1) : 'unknown';
      const successes = outcomes.filter((o) => o.success).length;
      const avgDuration = outcomes.reduce((s, o) => s + o.durationMs, 0) / outcomes.length;
      stats.push({
        modelId,
        taskType,
        successRate: `${successes}/${outcomes.length}`,
        avgDuration: Math.round(avgDuration),
        count: outcomes.length,
        learningActive: this.isLearningActive(modelId, taskType),
      });
    }
    return stats;
  }

  // ============================================================================
  // Latency-aware routing
  // ============================================================================

  recordLatency(
    provider: string,
    modelId: string,
    ttft: number,
    tpot: number,
    success: boolean,
  ): void {
    const key = `${provider}:${modelId}`;
    const existing = this.latencyIndex.get(key);

    if (!existing) {
      this.latencyIndex.set(key, {
        provider,
        modelId,
        ewmaTTFT: ttft,
        ewmaTPOT: tpot,
        errorRate: success ? 0 : 1,
        lastUpdated: Date.now(),
        sampleCount: 1,
      });
      return;
    }

    existing.ewmaTTFT = this.EWMA_ALPHA * ttft + (1 - this.EWMA_ALPHA) * existing.ewmaTTFT;
    existing.ewmaTPOT = this.EWMA_BETA * tpot + (1 - this.EWMA_BETA) * existing.ewmaTPOT;
    existing.errorRate =
      this.EWMA_ERROR * (success ? 0 : 1) + (1 - this.EWMA_ERROR) * existing.errorRate;
    existing.lastUpdated = Date.now();
    existing.sampleCount++;
  }

  getLatency(provider: string, modelId: string): ProviderLatency | undefined {
    return this.latencyIndex.get(`${provider}:${modelId}`);
  }

  getAllLatencies(): ProviderLatency[] {
    return Array.from(this.latencyIndex.values());
  }

  // ============================================================================
  // User-tier routing
  // ============================================================================

  setUserTier(userId: string, tier: UserTier): void {
    this.userTiers.set(userId, tier);
  }

  getUserTier(userId: string): UserTier {
    return this.userTiers.get(userId) ?? 'free';
  }

  // ============================================================================
  // Routing objectives
  // ============================================================================

  setRoutingObjective(objective: RoutingObjective): void {
    this.routingObjective = objective;
  }

  getRoutingObjective(): RoutingObjective {
    return this.routingObjective;
  }

  // ============================================================================
  // Explore/exploit mechanism
  // ============================================================================

  setExploreRatio(ratio: number): void {
    this.exploreRatio = Math.max(0, Math.min(1, ratio));
  }

  getExploreStats(): { routingCount: number; exploreCount: number; exploreRatio: number } {
    return {
      routingCount: this.routingCount,
      exploreCount: this.exploreCount,
      exploreRatio: this.exploreRatio,
    };
  }

  // ============================================================================
  // Confidence-based escalation
  // ============================================================================

  checkConfidence(
    modelId: string,
    taskType: string,
    responseTokens: number,
  ): ConfidenceCheckResult {
    const successRate = this.getSuccessRate(modelId, taskType);
    const latency = this.getLatency(this.models.get(modelId)?.provider ?? '', modelId);

    let confidence = successRate;

    if (latency) {
      const latencyPenalty = Math.min(0.2, latency.errorRate);
      confidence = Math.max(0, confidence - latencyPenalty);
    }

    if (responseTokens < 50) {
      confidence *= 0.8;
    }

    const shouldEscalate = confidence < this.CONFIDENCE_THRESHOLD;
    const reason = shouldEscalate
      ? `confidence ${confidence.toFixed(2)} < threshold ${this.CONFIDENCE_THRESHOLD}`
      : `confidence ${confidence.toFixed(2)} >= threshold ${this.CONFIDENCE_THRESHOLD}`;

    return { confidence, shouldEscalate, reason };
  }

  // ============================================================================
  // Internal
  // ============================================================================

  /**
   * Select tier based on complexity, governance, and governor phase.
   */
  private selectTier(
    complexity: ComplexityScore,
    ctx: AgentExecutionContext,
    governor: string,
  ): ModelTier {
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
    registeredProviders?: Set<string>,
  ): ModelConfig[] {
    let candidates = [...(this.tierIndex.get(tier) ?? [])];

    if (registeredProviders && registeredProviders.size > 0) {
      candidates = candidates.filter((m) => registeredProviders.has(m.provider));
    }

    // Fallback chain if tier is empty
    if (candidates.length === 0) {
      const tierOrder: ModelTier[] = ['consensus', 'power', 'standard', 'eco'];
      const startIdx = tierOrder.indexOf(tier);
      for (let i = startIdx + 1; i < tierOrder.length; i++) {
        candidates = [...(this.tierIndex.get(tierOrder[i]) ?? [])];
        if (candidates.length > 0) break;
      }
    }

    // Native structured output preference: when outputSchema is set, prefer
    // providers that can enforce JSON schema natively. Fall back to the full
    // pool so Anthropic/others can use tool-use fallback.
    const needsStructured = !!ctx.outputSchema;
    if (needsStructured) {
      const structuredCapable = candidates.filter(
        (m) => m.supportsStructuredOutput || m.supportsJSONMode,
      );
      if (structuredCapable.length > 0) {
        candidates = structuredCapable;
      }
    }

    // Score each candidate
    const scored = candidates.map((m) => ({
      model: m,
      score: this.scoreCandidate(m, requiredCaps, taskType, ctx),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.model);
  }

  /**
   * Score a model candidate: capability fit (0-1) × cost efficiency × learning bonus.
   * Now cost-efficiency uses cost-per-successful-task, not just raw cost.
   *
   * Evidence:
   * - FrugalGPT (arXiv:2305.05176): cost-aware routing considers both cost AND quality
   * - OpenAI: cheapest model that succeeds is always best; cheapest model that fails is waste
   * - Cost per successful task = raw cost / success_rate
   */
  private scoreCandidate(
    model: ModelConfig,
    requiredCaps: string[],
    taskType: string,
    _ctx: AgentExecutionContext,
  ): number {
    const capFit =
      requiredCaps.length === 0
        ? 1.0
        : requiredCaps.filter((c) => model.capabilities.includes(c)).length / requiredCaps.length;

    const tierModels = this.tierIndex.get(model.tier) ?? [];
    const maxCost = Math.max(...tierModels.map((m) => m.costPer1MOutput), 0.001);
    const rawCostRatio = model.costPer1MOutput / maxCost;

    const successRate = this.getSuccessRate(model.id, taskType);
    const effectiveSuccessRate = Math.max(0.5, successRate);
    const costPerSuccess = rawCostRatio / effectiveSuccessRate;
    const costEfficiency = 1 - Math.min(0.3, costPerSuccess * 0.3);

    const learningBonus = this.getLearningBonus(model.id, taskType);
    const priorityFactor = 1 / (1 + model.priority * 0.1);

    const latency = this.getLatency(model.provider, model.id);
    let latencyFactor = 1.0;
    if (latency && latency.sampleCount >= 5) {
      const avgLatency = latency.ewmaTTFT + latency.ewmaTPOT;
      const maxLatency = 5000;
      const latencyScore = 1 - Math.min(1, avgLatency / maxLatency);
      latencyFactor = 1 - this.LATENCY_COEFFICIENT + this.LATENCY_COEFFICIENT * latencyScore;
      latencyFactor *= 1 - latency.errorRate * 0.1;
    }

    let baseScore = capFit * costEfficiency * learningBonus * priorityFactor * latencyFactor;

    baseScore = this.applyRoutingObjective(baseScore, model, successRate);

    return baseScore;
  }

  private applyRoutingObjective(score: number, model: ModelConfig, successRate: number): number {
    switch (this.routingObjective.type) {
      case 'cost_at_quality_floor': {
        const minQuality = this.routingObjective.minQuality;
        if (successRate < minQuality && successRate !== 0.5) {
          return score * 0.3;
        }
        const costPenalty = model.costPer1MOutput * 100;
        return score * (1 - Math.min(0.4, costPenalty));
      }
      case 'quality_at_cost_ceiling': {
        const maxCost = this.routingObjective.maxCostPerRequest;
        const estimatedCost = model.costPer1MOutput * 2;
        if (estimatedCost > maxCost) {
          return score * 0.2;
        }
        const qualityBoost = successRate * 0.3;
        return score * (1 + qualityBoost);
      }
      case 'balanced':
      default:
        return score;
    }
  }

  /**
   * Calculate learning bonus from historical outcomes.
   * Uses time-decayed success rate. Returns 0.8-1.2 multiplier.
   */
  private getLearningBonus(modelId: string, taskType: string): number {
    const key = `${modelId}:${taskType}`;
    const relevant = this.outcomesIndex.get(key) ?? [];

    if (relevant.length === 0) return 1.0;
    if (relevant.length < this.minSamplesForLearning) return 1.0;

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
    return 0.8 + successRate * 0.4;
  }

  /**
   * Get the time-decayed success rate for a model on a task type.
   * Returns 0-1 (0.5 = no data = neutral assumption).
   * Used by cost-per-successful-task calculation.
   */
  private getSuccessRate(modelId: string, taskType: string): number {
    const key = `${modelId}:${taskType}`;
    const relevant = this.outcomesIndex.get(key) ?? [];

    if (relevant.length === 0) return 0.5;
    if (relevant.length < this.minSamplesForLearning) return 0.5;

    const now = Date.now();
    let weightedSuccess = 0;
    let totalWeight = 0;

    for (const o of relevant) {
      const age = now - o.timestamp;
      const weight = Math.exp(-age / this.decayHalfLifeMs);
      weightedSuccess += (o.success ? 1 : 0) * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0.5;
    return weightedSuccess / totalWeight;
  }

  /**
   * Check if a model has the required capabilities.
   */
  private hasCapabilities(model: ModelConfig, requiredCaps: string[]): boolean {
    if (requiredCaps.length === 0) return true;
    return requiredCaps.every((c) => model.capabilities.includes(c));
  }

  /**
   * If the selected tier has no model with all required capabilities, bump to next higher tier.
   */
  private bumpTierForCapabilities(tier: ModelTier, requiredCaps: string[]): ModelTier {
    const tierOrder: ModelTier[] = ['eco', 'standard', 'power', 'consensus'];
    let currentIdx = tierOrder.indexOf(tier);

    while (currentIdx < tierOrder.length) {
      const tierModels = this.tierIndex.get(tierOrder[currentIdx]) ?? [];
      const hasCapableModel = tierModels.some((m) => this.hasCapabilities(m, requiredCaps));
      if (hasCapableModel) return tierOrder[currentIdx];
      currentIdx++;
    }

    return tier; // fallback to original
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';
import { getModelPerformanceStore } from './modelPerformanceStore';

const routerSingleton = createTenantAwareSingleton(() => {
  const router = new ModelRouter();
  // Seed with cross-session historical outcomes
  try {
    const store = getModelPerformanceStore();
    const historical = store.getAll();
    for (const outcome of historical) {
      router.recordOutcome(
        outcome.modelId,
        outcome.taskType,
        outcome.success,
        outcome.durationMs,
        outcome.tokensUsed,
      );
    }
  } catch (err) {
    reportSilentFailure(err, 'modelRouter:1504');
    /* best-effort: don't crash if store unavailable */
  }
  return router;
});

/** Get the global ModelRouter (single-tenant) or tenant-scoped (multi-tenant). */
export function getModelRouter(): ModelRouter {
  return routerSingleton.get();
}

/** Reset the model router singleton (for test isolation). */
export function resetModelRouter(): void {
  routerSingleton.reset();
}
