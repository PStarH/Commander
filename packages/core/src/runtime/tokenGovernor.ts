/**
 * Token Budget Governor — Advisory Optimization Layer (Layer 4 of UCA architecture)
 *
 * ADVISORY / NON-ENFORCEMENT. This class provides token optimization strategy
 * recommendations based on budget pressure. It NEVER blocks, rejects, or
 * mandates — all enforcement decisions are owned by UnifiedCostAuthority
 * (UCA, the Layer 2 BudgetEnforcer).
 *
 * 职责分层（Separation of Concerns）：
 *   UCA Layer 2 (BudgetEnforcer)  → 硬阻断（THROTTLE/MELT）— "能不能花"
 *   TokenGovernor (this class)    → 软优化（recommendations）— "怎么花得更省"
 *
 * The governor tracks token usage pressure (relaxed → moderate → tight → critical)
 * and selects optimization strategies (observation_mask, context_compaction,
 * tool_output_truncate, response_format, verification_skip, prompt_compression).
 * Callers consume recommendations via shouldApply() / getRecommendations() and
 * apply them at their own discretion.
 *
 * Central coordinator for token optimization. Tracks usage in real-time,
 * selects optimization strategies based on budget pressure and task type,
 * and learns from historical effectiveness.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getMetricsCollector } from './metricsCollector';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';
import { createTenantAwareSingleton } from './tenantAwareSingleton';

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
  // Strategy decisions (cached, ADVISORY — never enforces)
  // ---------------------------------------------------------------------------

  /**
   * Get optimization strategy recommendations for the current budget phase.
   *
   * ADVISORY: Returns suggestions only. Callers decide whether to apply.
   * For hard budget enforcement, use UnifiedCostAuthority.preCall() instead.
   */
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

  /**
   * Check whether a given optimization strategy should be applied.
   *
   * ADVISORY: Returns a recommendation, not a mandate. The caller retains
   * full discretion to ignore the suggestion. For hard enforcement, use
   * UnifiedCostAuthority.preCall() which can THROTTLE/MELT.
   */
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

  // ---------------------------------------------------------------------------
  // Per-run budget tracking (merged from TokenBudgetManager)
  // ---------------------------------------------------------------------------

  private runBudgets: Map<string, RunBudgetStatus> = new Map();

  /**
   * Start tracking a new run's budget.
   */
  startRun(runId: string, config: TokenBudgetConfig): RunBudgetStatus {
    const softCap = config.softCap ?? Math.round(config.hardCap * RUN_BUDGET_SOFT_CAP_RATIO);
    const status: RunBudgetStatus = {
      runId,
      totalBudget: config.hardCap,
      softCap,
      hardCap: config.hardCap,
      usedTokens: 0,
      remainingTokens: config.hardCap,
      utilizationPercent: 0,
      phase: 'relaxed',
      subAgents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Evict oldest if over capacity
    if (this.runBudgets.size >= MAX_ACTIVE_RUN_BUDGETS) {
      const oldest = this.runBudgets.keys().next().value;
      if (oldest) this.runBudgets.delete(oldest);
    }

    this.runBudgets.set(runId, status);
    this.emitRunMetrics(runId);
    return status;
  }

  /**
   * Allocate budget proportionally across sub-agents based on their
   * estimated token needs. Returns a Map of nodeId → allocated budget.
   */
  allocateToSubAgents(
    runId: string,
    subAgentEstimates: Array<{ nodeId: string; estimatedTokens: number }>,
  ): Map<string, number> {
    const status = this.runBudgets.get(runId);
    if (!status) {
      getGlobalLogger().warn('TokenGovernor', 'Allocation on unknown run', { runId });
      return new Map();
    }

    const totalEstimated = subAgentEstimates.reduce((s, e) => s + e.estimatedTokens, 0);
    if (totalEstimated === 0) {
      const equalShare = Math.floor(status.remainingTokens / subAgentEstimates.length);
      return new Map(subAgentEstimates.map((e) => [e.nodeId, equalShare]));
    }

    // 10% reserve for synthesis + quality fix overhead
    const allocatable = Math.floor(status.totalBudget * 0.9);

    const result = new Map<string, number>();
    const allocations: SubAgentAllocation[] = [];

    let allocatedSum = 0;
    const entries = subAgentEstimates.map((e, i) => {
      const isLast = i === subAgentEstimates.length - 1;
      const share = isLast
        ? allocatable - allocatedSum
        : Math.floor(allocatable * (e.estimatedTokens / totalEstimated));
      allocatedSum += share;
      return { ...e, share };
    });

    for (const entry of entries) {
      result.set(entry.nodeId, entry.share);
      allocations.push({
        nodeId: entry.nodeId,
        allocatedBudget: entry.share,
        usedTokens: 0,
        status: 'pending',
        hardCapExceeded: false,
      });
    }

    status.subAgents = allocations;
    status.updatedAt = new Date().toISOString();
    this.runBudgets.set(runId, status);

    return result;
  }

  /**
   * Record token usage from a sub-agent. Updates the run-level total
   * and the per-agent allocation tracker.
   */
  recordRunUsage(
    runId: string,
    nodeId: string,
    tokens: number,
  ): { warning: boolean; exceeded: boolean } {
    const status = this.runBudgets.get(runId);
    if (!status) return { warning: false, exceeded: false };

    status.usedTokens += tokens;
    status.remainingTokens = Math.max(0, status.totalBudget - status.usedTokens);
    status.utilizationPercent =
      status.totalBudget > 0 ? Math.round((status.usedTokens / status.totalBudget) * 100) : 0;
    status.updatedAt = new Date().toISOString();

    if (status.usedTokens >= status.hardCap) {
      status.phase = 'exceeded';
    } else if (status.usedTokens >= status.hardCap * 0.95) {
      status.phase = 'critical';
    } else if (status.usedTokens >= status.softCap) {
      status.phase = 'tight';
    } else if (status.usedTokens >= status.softCap * 0.65) {
      status.phase = 'moderate';
    }

    const agent = status.subAgents.find((a) => a.nodeId === nodeId);
    if (agent) {
      agent.usedTokens += tokens;
      agent.status = 'running';
      if (agent.usedTokens >= agent.allocatedBudget && agent.allocatedBudget > 0) {
        agent.hardCapExceeded = true;
      }
    }

    this.runBudgets.set(runId, status);

    const warning = status.phase === 'tight' || status.phase === 'critical';
    const exceeded = status.phase === 'exceeded';

    if (warning && !exceeded) {
      getMessageBus().publish('system.alert', 'budget-manager', {
        type: 'token_budget_warning',
        runId,
        phase: status.phase,
        utilizationPercent: status.utilizationPercent,
        usedTokens: status.usedTokens,
        remainingTokens: status.remainingTokens,
      });
    }

    if (exceeded) {
      getMessageBus().publish('system.alert', 'budget-manager', {
        type: 'token_budget_exceeded',
        runId,
        usedTokens: status.usedTokens,
        hardCap: status.hardCap,
      });
    }

    this.emitRunMetrics(runId);
    return { warning, exceeded };
  }

  /**
   * Alias for recordRunUsage kept for backward compatibility with
   * TokenBudgetManager consumers.
   */
  recordUsage(
    runId: string,
    nodeId: string,
    tokens: number,
  ): { warning: boolean; exceeded: boolean } {
    return this.recordRunUsage(runId, nodeId, tokens);
  }

  /**
   * Mark a sub-agent as completed and record its final token usage.
   */
  markSubAgentComplete(runId: string, nodeId: string, finalTokens: number): void {
    const status = this.runBudgets.get(runId);
    if (!status) return;

    const agent = status.subAgents.find((a) => a.nodeId === nodeId);
    if (agent) {
      agent.usedTokens = finalTokens;
      agent.status = 'completed';
      agent.hardCapExceeded = agent.usedTokens >= agent.allocatedBudget;
    }

    status.updatedAt = new Date().toISOString();
    this.runBudgets.set(runId, status);
  }

  /**
   * Get the budget status for a run.
   */
  getRunStatus(runId: string): RunBudgetStatus | null {
    return this.runBudgets.get(runId) ?? null;
  }

  /**
   * Check if a run's budget is exceeded (hard cap).
   */
  isBudgetExceeded(runId: string): boolean {
    const status = this.runBudgets.get(runId);
    return status ? status.phase === 'exceeded' : false;
  }

  /**
   * Get all active budget statuses, most recent first.
   */
  getActiveBudgets(): RunBudgetStatus[] {
    return Array.from(this.runBudgets.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  /**
   * Get remaining budget for a run.
   */
  getRemainingBudget(runId: string): number {
    return this.runBudgets.get(runId)?.remainingTokens ?? 0;
  }

  /**
   * Clean up a completed run's budget tracking.
   */
  completeRun(runId: string): void {
    this.runBudgets.delete(runId);
  }

  /**
   * Number of active budgets being tracked.
   */
  getActiveBudgetCount(): number {
    return this.runBudgets.size;
  }

  private emitRunMetrics(runId: string): void {
    const status = this.runBudgets.get(runId);
    if (!status) return;
    try {
      const mc = getMetricsCollector();
      mc.setGauge(
        'token_budget_utilization_percent',
        'Token budget utilization %',
        status.utilizationPercent,
        [
          { name: 'run_id', value: runId },
          { name: 'phase', value: status.phase },
        ],
      );
      mc.setGauge('token_budget_remaining', 'Remaining token budget', status.remainingTokens, [
        { name: 'run_id', value: runId },
      ]);
    } catch (err) {
      reportSilentFailure(err, 'tokenGovernor:698');
      /* best-effort */
    }
  }
}

// ============================================================================
// Per-run budget tracking exports (merged from TokenBudgetManager)
// ============================================================================

export interface SubAgentAllocation {
  nodeId: string;
  allocatedBudget: number;
  usedTokens: number;
  status: 'pending' | 'running' | 'completed' | 'cancelled';
  hardCapExceeded: boolean;
}

export interface RunBudgetStatus {
  runId: string;
  totalBudget: number;
  softCap: number;
  hardCap: number;
  usedTokens: number;
  remainingTokens: number;
  utilizationPercent: number;
  phase: 'relaxed' | 'moderate' | 'tight' | 'critical' | 'exceeded';
  subAgents: SubAgentAllocation[];
  createdAt: string;
  updatedAt: string;
}

export interface TokenBudgetConfig {
  /** Total token budget for the run (hard cap) */
  hardCap: number;
  /** Soft cap — warning threshold (default 80% of hard cap) */
  softCap?: number;
}

const RUN_BUDGET_SOFT_CAP_RATIO = 0.8;
const MAX_ACTIVE_RUN_BUDGETS = 200;

/**
 * Backward-compatible alias. TokenBudgetManager's per-run allocation API is now
 * part of TokenGovernor; this class exists so existing imports keep working.
 */
export class TokenBudgetManager extends TokenGovernor {
  constructor(config?: Partial<GovernorConfig>) {
    super(config);
  }
}

/**
 * Get the global TokenBudgetManager (single-tenant) or tenant-scoped (multi-tenant).
 */
export function getTokenBudgetManager(): TokenBudgetManager {
  return budgetManagerSingleton.get();
}

/** Reset for test isolation. */
export function resetTokenBudgetManager(): void {
  budgetManagerSingleton.reset();
}

const budgetManagerSingleton = createTenantAwareSingleton(() => new TokenBudgetManager(), {
  allowGlobalFallback: true,
});

// ============================================================================
// Singleton
// ============================================================================

let _governorConfig: Partial<GovernorConfig> | undefined;

const governorSingleton = createTenantAwareSingleton(() => new TokenGovernor(_governorConfig), {
  allowGlobalFallback: true,
});

/** Get the global TokenGovernor (single-tenant) or tenant-scoped (multi-tenant). */
export function getTokenGovernor(config?: Partial<GovernorConfig>): TokenGovernor {
  if (config) _governorConfig = config;
  return governorSingleton.get();
}

/** Reset the token governor singleton (for test isolation). */
export function resetTokenGovernor(): void {
  governorSingleton.reset();
}
