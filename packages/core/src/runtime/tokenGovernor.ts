/**
 * Token Budget Governor
 *
 * Central coordinator for token optimization. Tracks usage in real-time,
 * selects optimization strategies based on budget pressure and task type,
 * and learns from historical effectiveness.
 */

// ============================================================================
// Types
// ============================================================================

export type OptimizationStrategy =
  | 'observation_mask'
  | 'context_compaction'
  | 'tool_retrieval'
  | 'entropy_gating'
  | 'response_format'
  | 'prompt_compression'
  | 'verification_skip'
  | 'tool_output_truncate'
  | 'speculative_skip';

export type TaskCategory = 'code' | 'search' | 'analysis' | 'creative' | 'structured' | 'general';

export interface BudgetState {
  totalBudget: number;
  usedTokens: number;
  remainingTokens: number;
  pressure: number; // 0-1
  phase: 'relaxed' | 'moderate' | 'tight' | 'critical';
}

export interface GovernorDecision {
  strategy: OptimizationStrategy;
  apply: boolean;
  intensity: number; // 0-1
  reason: string;
}

export interface GovernorConfig {
  totalBudget: number;
  thresholds: {
    relaxed: number;
    moderate: number;
    tight: number;
    critical: number;
  };
  enableLearning: boolean;
}

const DEFAULT_CONFIG: GovernorConfig = {
  totalBudget: 200000,
  thresholds: {
    relaxed: 0.4,
    moderate: 0.65,
    tight: 0.85,
    critical: 1.0,
  },
  enableLearning: true,
};

// ============================================================================
// Strategy definitions per phase
// ============================================================================

interface StrategyDef {
  strategy: OptimizationStrategy;
  baseIntensity: number;
  reason: string;
  /** Task types where this strategy is more effective (boost intensity) */
  goodFor: TaskCategory[];
  /** Task types where this strategy is harmful (skip or reduce) */
  badFor: TaskCategory[];
}

const STRATEGY_DEFS: Record<string, StrategyDef[]> = {
  relaxed: [
    {
      strategy: 'observation_mask',
      baseIntensity: 0.3,
      reason: 'Baseline masking',
      goodFor: [],
      badFor: [],
    },
  ],
  moderate: [
    {
      strategy: 'observation_mask',
      baseIntensity: 0.5,
      reason: 'Moderate masking',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'tool_output_truncate',
      baseIntensity: 0.3,
      reason: 'Truncate verbose outputs',
      goodFor: ['search', 'analysis'],
      badFor: [],
    },
    {
      strategy: 'response_format',
      baseIntensity: 0.3,
      reason: 'Request concise responses',
      goodFor: ['structured'],
      badFor: ['creative'],
    },
  ],
  tight: [
    {
      strategy: 'observation_mask',
      baseIntensity: 0.8,
      reason: 'Aggressive masking',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'context_compaction',
      baseIntensity: 0.5,
      reason: 'Compact conversation',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'tool_output_truncate',
      baseIntensity: 0.6,
      reason: 'Aggressive truncation',
      goodFor: ['search'],
      badFor: [],
    },
    {
      strategy: 'response_format',
      baseIntensity: 0.6,
      reason: 'Force concise',
      goodFor: ['structured'],
      badFor: ['creative'],
    },
    {
      strategy: 'verification_skip',
      baseIntensity: 0.5,
      reason: 'Skip LLM verification',
      goodFor: ['search'],
      badFor: ['code'],
    },
    {
      strategy: 'prompt_compression',
      baseIntensity: 0.4,
      reason: 'Compress prompt',
      goodFor: [],
      badFor: [],
    },
  ],
  critical: [
    {
      strategy: 'observation_mask',
      baseIntensity: 1.0,
      reason: 'Maximum masking',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'context_compaction',
      baseIntensity: 1.0,
      reason: 'Emergency compaction',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'tool_output_truncate',
      baseIntensity: 1.0,
      reason: 'Minimal output',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'response_format',
      baseIntensity: 1.0,
      reason: 'Maximally terse',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'verification_skip',
      baseIntensity: 1.0,
      reason: 'Skip all verification',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'prompt_compression',
      baseIntensity: 1.0,
      reason: 'Minimal prompt',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'speculative_skip',
      baseIntensity: 1.0,
      reason: 'No speculation',
      goodFor: [],
      badFor: [],
    },
    {
      strategy: 'entropy_gating',
      baseIntensity: 1.0,
      reason: 'Skip optional tools',
      goodFor: [],
      badFor: [],
    },
  ],
};

// ============================================================================
// Governor
// ============================================================================

export class TokenGovernor {
  private config: GovernorConfig;
  private usedTokens = 0;
  private taskCategory: TaskCategory = 'general';
  // Ring buffer for history — O(1) insert, no allocation on overflow
  private history: Array<{ strategy: string; effective: boolean; timestamp: number }>;
  private historyHead = 0;
  private historyCount = 0;
  private readonly maxHistory = 500;
  private readonly decayHalfLifeMs = 20 * 60 * 1000; // 20 minutes

  // Pre-bucketed strategy index for O(1) lookups
  private strategyIndex: Map<
    string,
    Array<{ strategy: string; effective: boolean; timestamp: number }>
  > = new Map();

  // Cache for recommendations (invalidated on reportUsage or setTaskCategory)
  private cachedPhase: string | null = null;
  private cachedRecommendations: GovernorDecision[] | null = null;
  private cachedRecommendationsMap: Map<OptimizationStrategy, GovernorDecision> | null = null;

  // Precompiled CJK regex for fast token estimation (g flag required for match() to return all occurrences)
  private static readonly CJK_RE = /[一-鿿㐀-䶿]/g;

  constructor(config?: Partial<GovernorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.history = new Array(this.maxHistory);
  }

  // ---------------------------------------------------------------------------
  // Budget tracking
  // ---------------------------------------------------------------------------

  reportUsage(tokens: number): void {
    this.usedTokens += tokens;
    this.cachedPhase = null; // Invalidate cache
  }

  getState(): BudgetState {
    const remaining = Math.max(0, this.config.totalBudget - this.usedTokens);
    const pressure =
      this.config.totalBudget > 0 ? Math.min(1, this.usedTokens / this.config.totalBudget) : 1;

    let phase: BudgetState['phase'];
    if (pressure < this.config.thresholds.relaxed) phase = 'relaxed';
    else if (pressure < this.config.thresholds.moderate) phase = 'moderate';
    else if (pressure < this.config.thresholds.tight) phase = 'tight';
    else phase = 'critical';

    return {
      totalBudget: this.config.totalBudget,
      usedTokens: this.usedTokens,
      remainingTokens: remaining,
      pressure,
      phase,
    };
  }

  reset(budget?: number): void {
    this.usedTokens = 0;
    if (budget !== undefined) this.config.totalBudget = budget;
    this.cachedPhase = null;
    this.cachedRecommendations = null;
    this.cachedRecommendationsMap = null;
    this.historyHead = 0;
    this.historyCount = 0;
    this.strategyIndex.clear();
  }

  /** Set task category for strategy selection. Call before first shouldApply(). */
  setTaskCategory(cat: TaskCategory): void {
    this.taskCategory = cat;
    this.cachedPhase = null;
  }

  // ---------------------------------------------------------------------------
  // Strategy decisions (cached)
  // ---------------------------------------------------------------------------

  getRecommendations(): GovernorDecision[] {
    const state = this.getState();

    // Return cached if phase hasn't changed
    if (this.cachedPhase === state.phase && this.cachedRecommendations) {
      return this.cachedRecommendations;
    }

    const defs = STRATEGY_DEFS[state.phase] ?? STRATEGY_DEFS.relaxed;
    let decisions: GovernorDecision[] = defs.map((d) => {
      let intensity = d.baseIntensity;

      // Adjust intensity based on task type
      if (d.goodFor.includes(this.taskCategory)) {
        intensity = Math.min(1, intensity + 0.15);
      }
      if (d.badFor.includes(this.taskCategory)) {
        intensity = Math.max(0, intensity - 0.2);
      }

      return {
        strategy: d.strategy,
        apply: true,
        intensity,
        reason: d.reason,
      };
    });

    // Apply learning adjustments
    if (this.config.enableLearning) {
      decisions = this.adjustByLearning(decisions);
    }

    this.cachedPhase = state.phase;
    this.cachedRecommendations = decisions;
    // Build O(1) lookup map
    this.cachedRecommendationsMap = new Map(decisions.map((d) => [d.strategy, d]));
    return decisions;
  }

  shouldApply(strategy: OptimizationStrategy): { apply: boolean; intensity: number } {
    // Ensure recommendations are built
    this.getRecommendations();
    const decision = this.cachedRecommendationsMap?.get(strategy);
    return decision
      ? { apply: decision.apply, intensity: decision.intensity }
      : { apply: false, intensity: 0 };
  }

  // ---------------------------------------------------------------------------
  // Learning (with time decay)
  // ---------------------------------------------------------------------------

  recordOutcome(strategy: string, tokensBefore: number, tokensAfter: number): void {
    if (!this.config.enableLearning) return;
    const now = Date.now();
    const record = { strategy, effective: tokensBefore > tokensAfter, timestamp: now };

    // Ring buffer: O(1) insert
    if (this.historyCount < this.maxHistory) {
      this.history[this.historyHead] = record;
      this.historyHead = (this.historyHead + 1) % this.maxHistory;
      this.historyCount++;
    } else {
      // Evict oldest from strategy index
      const evicted = this.history[this.historyHead];
      const evictedList = this.strategyIndex.get(evicted.strategy);
      if (evictedList) {
        const idx = evictedList.indexOf(evicted);
        if (idx !== -1) evictedList.splice(idx, 1);
        if (evictedList.length === 0) this.strategyIndex.delete(evicted.strategy);
      }
      this.history[this.historyHead] = record;
      this.historyHead = (this.historyHead + 1) % this.maxHistory;
    }

    // Update strategy index
    let list = this.strategyIndex.get(strategy);
    if (!list) {
      list = [];
      this.strategyIndex.set(strategy, list);
    }
    list.push(record);

    // Invalidate cache since learning may change decisions
    this.cachedPhase = null;
    this.cachedRecommendationsMap = null;
  }

  private strategyEffectiveness(strategy: string): number {
    // O(1) lookup via strategy index instead of linear scan
    const records = this.strategyIndex.get(strategy);
    if (!records || records.length < 3) return 0.5;
    const now = Date.now();
    let weightedEffective = 0;
    let totalWeight = 0;
    for (const r of records) {
      const age = now - r.timestamp;
      const weight = Math.exp(-age / this.decayHalfLifeMs);
      totalWeight += weight;
      if (r.effective) weightedEffective += weight;
    }
    return totalWeight > 0 ? weightedEffective / totalWeight : 0.5;
  }

  private adjustByLearning(decisions: GovernorDecision[]): GovernorDecision[] {
    return decisions.map((d) => {
      const effectiveness = this.strategyEffectiveness(d.strategy);
      // Demote strategies that are consistently ineffective, regardless of intensity
      if (effectiveness < 0.3) {
        return {
          ...d,
          apply: false,
          reason: `${d.reason} (demoted: ${(effectiveness * 100).toFixed(0)}% effective)`,
        };
      }
      // Gradually reduce intensity for moderately ineffective strategies
      if (effectiveness < 0.5) {
        return {
          ...d,
          intensity: Math.max(0.1, d.intensity * effectiveness * 2),
          reason: `${d.reason} (reduced: ${(effectiveness * 100).toFixed(0)}% effective)`,
        };
      }
      // Boost consistently effective strategies
      if (effectiveness > 0.8) {
        return { ...d, intensity: Math.min(1, d.intensity + 0.1) };
      }
      return d;
    });
  }

  // ---------------------------------------------------------------------------
  // Budget estimation
  // ---------------------------------------------------------------------------

  static estimateTokens(text: string): number {
    // Use precompiled regex for CJK detection — single pass, much faster than char-by-char
    const cjkCount = (text.match(TokenGovernor.CJK_RE) ?? []).length;
    return Math.ceil((text.length - cjkCount) / 4 + cjkCount / 1.5);
  }

  remainingForComponent(ratio: number): number {
    return Math.floor(this.getState().remainingTokens * ratio);
  }
}

// ============================================================================
// Singleton
// ============================================================================

import { createTenantAwareSingleton } from './tenantAwareSingleton';

let _governorConfig: Partial<GovernorConfig> | undefined;

const governorSingleton = createTenantAwareSingleton(() => new TokenGovernor(_governorConfig));

/** Get the global TokenGovernor (single-tenant) or tenant-scoped (multi-tenant). */
export function getTokenGovernor(config?: Partial<GovernorConfig>): TokenGovernor {
  if (config) _governorConfig = config;
  return governorSingleton.get();
}

/** Reset the token governor singleton (for test isolation). */
export function resetTokenGovernor(): void {
  governorSingleton.reset();
}
