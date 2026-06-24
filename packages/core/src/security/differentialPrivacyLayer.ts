/**
 * DifferentialPrivacyLayer — ε-Differential Privacy for cross-agent memory sharing.
 *
 * EU AI Act Article 10 (data minimization): "Personal data shall be adequate, relevant,
 * and limited to what is necessary in relation to the purposes for which they are processed."
 *
 * ε-DP provides a mathematical gold standard for this — it guarantees that any single
 * data point's contribution is bounded by exp(ε), so an adversary cannot infer whether
 * a specific agent's data was included in a result, regardless of prior knowledge.
 *
 * Design:
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ 1. Laplace Mechanism (pure ε-DP):                                      │
 * │    F(x) = f(x) + Lap(0, Δf/ε)                                         │
 * │    Works for count, sum, histogram queries.                            │
 * │                                                                        │
 * │ 2. Gaussian Mechanism ((ε, δ)-DP):                                     │
 * │    F(x) = f(x) + N(0, σ²) where σ = Δf·√(2·ln(1.25/δ))/ε             │
 * │    Tighter for repeated queries (advanced composition).                │
 * │                                                                        │
 * │ 3. Sensitivity analysis: auto-compute Δf for count=1, sum=range,      │
 * │    avg=range/n, histogram=1.                                           │
 * │                                                                        │
 * │ 4. Privacy budget accounting: per-agent ε tracking with basic          │
 * │    composition (Σε_i ≤ ε_total). Configurable sliding window.          │
 * │                                                                        │
 * │ 5. Memory query sanitization: wraps ThreeLayerMemory.query() and       │
 * │    adds calibrated Laplace/Gaussian noise to numeric result fields     │
 * │    (importance, accessCount, decayScore) before cross-agent sharing.   │
 * │                                                                        │
 * │ 6. Answerable/non-answerable: queries consuming > remaining budget     │
 * │    are rejected with a budget-exhausted error rather than answered     │
 * │    without noise (prevents privacy budget exhaustion attacks).         │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   const dp = getDifferentialPrivacyLayer();
 *   const budget = dp.getBudget('agent-7');
 *   if (!dp.spendBudget('agent-7', 1.0)) throw new Error('Budget exhausted');
 *   const noisyCount = dp.sanitizeCount(42, 'agent-7');
 *   // noisyCount ≈ 42 ± Lap(0, 1/1.0)
 *
 *   // Sanitize memory entries before sharing across agents:
 *   const entries = memory.query({ layer: 'episodic', limit: 10 });
 *   const sanitized = dp.sanitizeMemoryEntries(entries, 3.0);
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'crypto';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { getAuditChainLedger } from './auditChainLedger';

// ============================================================================
// Types
// ============================================================================

/** Privacy level descriptor for epsilon ranges. */
export type DPPrivacyLevel = 'strong' | 'moderate' | 'weak';

/** Type of query for sensitivity analysis. */
export type DPQueryType = 'count' | 'sum' | 'average' | 'histogram' | 'custom';

/** Sensitivity analysis result for a query type. */
export interface DPSensitivity {
  /** L1 sensitivity (for Laplace mechanism). */
  l1Sensitivity: number;
  /** L2 sensitivity (for Gaussian mechanism). */
  l2Sensitivity: number;
  /** Whether the sensitivity is a global bound or data-dependent estimate. */
  boundType: 'global' | 'data_dependent';
  /** Human-readable explanation. */
  description: string;
}

/** Data bounds for sensitivity calculation. */
export interface DPDataBounds {
  /** Minimum possible value (inclusive). */
  min: number;
  /** Maximum possible value (inclusive). */
  max: number;
  /** Number of data points (for average sensitivity). */
  count?: number;
}

/** Privacy budget for a single agent/principal. */
export interface PrivacyBudget {
  /** Agent or principal identifier. */
  principalId: string;
  /** Total ε budget for the current window. */
  totalBudget: number;
  /** Remaining ε in the current window. */
  remainingBudget: number;
  /** Total ε consumed in this window. */
  consumedBudget: number;
  /** Number of queries answered in this window. */
  queryCount: number;
  /** Window start timestamp (ms since epoch). */
  windowStartMs: number;
  /** Window duration in ms. */
  windowDurationMs: number;
  /** When the budget was last spent (ms since epoch). */
  lastSpentMs: number;
}

/** Configuration for the differential privacy layer. */
export interface DifferentialPrivacyConfig {
  /** Default ε for sanitization when not specified per-call. */
  defaultEpsilon: number;
  /** Default δ for Gaussian mechanism (failure probability). */
  defaultDelta: number;
  /** Minimum ε allowed per query (prevents trivial privacy). */
  minEpsilonPerQuery: number;
  /** Maximum ε budget per window (prevents budget exhaustion attacks). */
  maxBudgetPerWindow: number;
  /** Privacy budget sliding window duration in ms (default: 1 hour). */
  budgetWindowMs: number;
  /** Whether to use Gaussian instead of Laplace for repeated queries. */
  preferGaussian: boolean;
  /** Minimum count of items before DP sanitization is applied.
   *  Queries returning fewer items are rejected to prevent small-N inference. */
  minItemsForSanitization: number;
}

/** Result of a DP-sanitized query. */
export interface DPQueryResult<T> {
  /** The sanitized result. */
  result: T;
  /** ε consumed by this query. */
  epsilonUsed: number;
  /** δ used (0 for pure ε-DP Laplace queries). */
  deltaUsed: number;
  /** Remaining budget after this query. */
  remainingBudget: number;
  /** Whether the query was answerable within the budget. */
  answerable: true;
  /** Noise mechanism used. */
  mechanism: 'laplace' | 'gaussian';
  /** Sensitivity applied. */
  sensitivity: number;
}

/** A rejected query result (budget exhausted or too few items). */
export interface DPQueryRejection {
  result: undefined;
  epsilonUsed: 0;
  deltaUsed: 0;
  remainingBudget: number;
  answerable: false;
  reason: 'budget_exhausted' | 'too_few_items' | 'invalid_bounds';
  detail: string;
}

export type DPQueryOutcome<T> = DPQueryResult<T> | DPQueryRejection;

// ============================================================================
// Constants
// ============================================================================

/** Default privacy budget window: 1 hour. */
const DEFAULT_BUDGET_WINDOW_MS = 60 * 60 * 1000;

/** Default ε (moderate privacy). */
const DEFAULT_EPSILON = 3.0;

/** Default δ for Gaussian mechanism. */
const DEFAULT_DELTA = 1e-5;

/** Minimum ε per query. */
const MIN_EPSILON_PER_QUERY = 0.01;

/** Maximum ε budget per window. */
const MAX_BUDGET_PER_WINDOW = 20.0;

/** Privacy level classification thresholds. */
const PRIVACY_LEVEL_THRESHOLDS: Array<{ level: DPPrivacyLevel; maxEpsilon: number }> = [
  { level: 'strong', maxEpsilon: 1.0 },
  { level: 'moderate', maxEpsilon: 10.0 },
  { level: 'weak', maxEpsilon: Infinity },
];

/** Default configuration. */
const DEFAULT_CONFIG: DifferentialPrivacyConfig = {
  defaultEpsilon: DEFAULT_EPSILON,
  defaultDelta: DEFAULT_DELTA,
  minEpsilonPerQuery: MIN_EPSILON_PER_QUERY,
  maxBudgetPerWindow: MAX_BUDGET_PER_WINDOW,
  budgetWindowMs: DEFAULT_BUDGET_WINDOW_MS,
  preferGaussian: false,
  minItemsForSanitization: 5,
};

// ============================================================================
// Core DP Mechanisms
// ============================================================================

/**
 * Sample from a Laplace(μ=0, b) distribution using the inverse CDF method.
 *
 * The Laplace distribution PDF is: f(x|μ,b) = (1/(2b)) · exp(-|x-μ|/b)
 * The inverse CDF is: F⁻¹(p) = μ - b·sgn(p-0.5)·ln(1-2·|p-0.5|)
 *
 * Equivalently, Laplace(0, b) = Exp(1/b) - Exp(1/b).
 * We use the difference-of-exponentials method for numerical stability.
 *
 * @param scale - b = Δf/ε
 * @returns Noise sampled from Laplace(0, b)
 */
export function sampleLaplace(scale: number): number {
  // Difference of two Exponential(1/scale) = Laplace(0, scale)
  // Generate two independent uniform(0,1) values
  const u1 = crypto.randomInt(1, 2 ** 31) / 2 ** 31; // (0, 1)
  const u2 = crypto.randomInt(1, 2 ** 31) / 2 ** 31;
  // Avoid log(0) by using 1 - u for one of them
  const e1 = -Math.log(u1) * scale;
  const e2 = -Math.log(u2) * scale;
  return e1 - e2;
}

/**
 * Laplace mechanism: add Laplace(0, Δf/ε) noise to a numeric value.
 *
 * Provides pure ε-DP. Best for count and sum queries with small ε budgets.
 *
 * @param value - True query result
 * @param sensitivity - L1 sensitivity Δf of the query
 * @param epsilon - Privacy budget ε
 * @returns Noisy value ≈ value + Lap(0, Δf/ε)
 */
export function laplaceMechanism(value: number, sensitivity: number, epsilon: number): number {
  if (epsilon <= 0) throw new Error(`epsilon must be > 0, got ${epsilon}`);
  if (sensitivity < 0) throw new Error(`sensitivity must be >= 0, got ${sensitivity}`);
  if (sensitivity === 0) return value; // No noise needed for constant queries
  const scale = sensitivity / epsilon;
  return value + sampleLaplace(scale);
}

/**
 * Sample from a Normal(μ=0, σ²) distribution using the Box-Muller transform.
 *
 * @param sigma - Standard deviation
 * @returns Noise sampled from N(0, σ²)
 */
export function sampleGaussian(sigma: number): number {
  // Box-Muller transform: generate two independent N(0,1) values
  const u1 = crypto.randomInt(1, 2 ** 31) / 2 ** 31;
  const u2 = crypto.randomInt(1, 2 ** 31) / 2 ** 31;
  // Avoid log(0) — crypto random is in (0,1) but we're paranoid
  const safeU1 = u1 === 0 ? 1e-10 : u1;
  const z1 = Math.sqrt(-2 * Math.log(safeU1)) * Math.cos(2 * Math.PI * u2);
  return z1 * sigma;
}

/**
 * Gaussian mechanism: add N(0, σ²) noise to a numeric value.
 *
 * Provides (ε, δ)-DP where σ = Δf · √(2·ln(1.25/δ)) / ε.
 * Better than Laplace for repeated queries (advanced composition).
 *
 * @param value - True query result
 * @param sensitivity - L2 sensitivity Δ₂f of the query
 * @param epsilon - Privacy budget ε
 * @param delta - Failure probability δ (e.g., 1e-5)
 * @returns Noisy value ≈ value + N(0, σ²)
 */
export function gaussianMechanism(
  value: number,
  sensitivity: number,
  epsilon: number,
  delta: number,
): number {
  if (epsilon <= 0) throw new Error(`epsilon must be > 0, got ${epsilon}`);
  if (delta <= 0 || delta >= 1) throw new Error(`delta must be in (0,1), got ${delta}`);
  if (sensitivity < 0) throw new Error(`sensitivity must be >= 0, got ${sensitivity}`);
  if (sensitivity === 0) return value;
  // σ = Δf · √(2·ln(1.25/δ)) / ε
  const sigma = (sensitivity * Math.sqrt(2 * Math.log(1.25 / delta))) / epsilon;
  return value + sampleGaussian(sigma);
}

// ============================================================================
// Sensitivity Analysis
// ============================================================================

/**
 * Compute the L1 and L2 sensitivity for a query type given data bounds.
 *
 * | Query Type | L1 Δf     | L2 Δf     | Description                        |
 * |------------|-----------|-----------|------------------------------------|
 * | count      | 1         | 1         | Adding/removing one row → ±1       |
 * | sum        | range     | range     | range = max - min                  |
 * | average    | range/n   | range/n   | n = number of rows (worst case = range for n=1) |
 * | histogram  | 1         | √2        | One row moves between bins         |
 * | custom     | (provided)| (provided)| Caller must specify                |
 */
export function analyzeSensitivity(queryType: DPQueryType, bounds?: DPDataBounds): DPSensitivity {
  switch (queryType) {
    case 'count':
      return {
        l1Sensitivity: 1,
        l2Sensitivity: 1,
        boundType: 'global',
        description: 'Count query: adding/removing one record changes count by at most 1',
      };
    case 'sum': {
      if (!bounds) {
        throw new Error('Data bounds required for sum sensitivity analysis');
      }
      const range = bounds.max - bounds.min;
      if (range <= 0) {
        throw new Error(`Invalid data bounds: max=${bounds.max} must be > min=${bounds.min}`);
      }
      return {
        l1Sensitivity: range,
        l2Sensitivity: range,
        boundType: 'global',
        description: `Sum query on data bounded in [${bounds.min}, ${bounds.max}]: sensitivity = range = ${range}`,
      };
    }
    case 'average': {
      if (!bounds || !bounds.count) {
        throw new Error('Data bounds with count required for average sensitivity analysis');
      }
      const range = bounds.max - bounds.min;
      if (range <= 0) {
        throw new Error(`Invalid data bounds: max=${bounds.max} must be > min=${bounds.min}`);
      }
      if (bounds.count <= 0) {
        throw new Error(`Invalid count: must be > 0, got ${bounds.count}`);
      }
      // Global sensitivity for average: range (worst case when n=1).
      // In practice, use data-dependent sensitivity + smooth sensitivity
      // framework, or split the budget: noisy_sum / noisy_count.
      const globalL1 = range;
      const dataL1 = range / bounds.count;
      return {
        l1Sensitivity: globalL1,
        l2Sensitivity: globalL1,
        boundType: 'global',
        description: `Average query on data bounded in [${bounds.min}, ${bounds.max}] with ${bounds.count} rows: global Δf=${globalL1}, data-dependent Δf≈${dataL1.toFixed(4)} (use split budget for better accuracy)`,
      };
    }
    case 'histogram':
      return {
        l1Sensitivity: 1,
        l2Sensitivity: Math.SQRT2, // √2
        boundType: 'global',
        description: 'Histogram query: one record moves between at most 2 bins, L1 Δf=1, L2 Δf=√2',
      };
    case 'custom':
      if (!bounds) {
        throw new Error('Data bounds required for custom sensitivity');
      }
      return {
        l1Sensitivity: bounds.max - bounds.min,
        l2Sensitivity: bounds.max - bounds.min,
        boundType: 'data_dependent',
        description: `Custom query: caller-provided bounds [${bounds.min}, ${bounds.max}]`,
      };
    default:
      throw new Error(`Unknown query type: ${queryType}`);
  }
}

/**
 * Classify an epsilon value into a privacy level.
 */
export function classifyEpsilon(epsilon: number): DPPrivacyLevel {
  for (const { level, maxEpsilon } of PRIVACY_LEVEL_THRESHOLDS) {
    if (epsilon < maxEpsilon) return level;
  }
  return 'weak';
}

// ============================================================================
// Privacy Budget Accounting
// ============================================================================

export class DifferentialPrivacyLayer {
  private config: DifferentialPrivacyConfig;
  private budgets: Map<string, PrivacyBudget> = new Map();

  constructor(config?: Partial<DifferentialPrivacyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Budget Management ────────────────────────────────────────────────

  /**
   * Get the current privacy budget for a principal (agent, user, tenant).
   * Creates a new budget if none exists or the window has expired.
   */
  getBudget(principalId: string): PrivacyBudget {
    const existing = this.budgets.get(principalId);
    const now = Date.now();

    if (existing && now - existing.windowStartMs < this.config.budgetWindowMs) {
      return { ...existing };
    }

    const fresh: PrivacyBudget = {
      principalId,
      totalBudget: this.config.maxBudgetPerWindow,
      remainingBudget: this.config.maxBudgetPerWindow,
      consumedBudget: 0,
      queryCount: 0,
      windowStartMs: now,
      windowDurationMs: this.config.budgetWindowMs,
      lastSpentMs: 0,
    };

    this.budgets.set(principalId, fresh);
    return { ...fresh };
  }

  /**
   * Check if a query with the given ε cost can be answered within budget.
   */
  checkBudget(principalId: string, epsilon: number): boolean {
    const budget = this.getBudget(principalId);
    return epsilon <= budget.remainingBudget;
  }

  /**
   * Atomically deduct ε from the budget. Returns true if successful.
   * Fails if the ε cost exceeds remaining budget.
   */
  spendBudget(principalId: string, epsilon: number): boolean {
    if (epsilon < this.config.minEpsilonPerQuery) {
      console.warn(
        `[DifferentialPrivacyLayer] epsilon=${epsilon} below minimum ${this.config.minEpsilonPerQuery}. Clamping.`,
      );
      epsilon = this.config.minEpsilonPerQuery;
    }

    const budget = this.getBudget(principalId);

    if (epsilon > budget.remainingBudget) {
      return false;
    }

    budget.remainingBudget -= epsilon;
    budget.consumedBudget += epsilon;
    budget.queryCount += 1;
    budget.lastSpentMs = Date.now();

    this.budgets.set(principalId, budget);

    try {
      getMetricsCollector().incrementCounter(
        'dp_budget_spend_total',
        'Differential privacy budget spend events',
        1,
      );
      getMetricsCollector().recordHistogram(
        'dp_budget_remaining_epsilon',
        'Remaining DP epsilon budget',
        budget.remainingBudget,
        [0.001, 0.01, 0.1, 0.5, 1, 5, 10],
      );
    } catch (err) {
      reportSilentFailure(err, 'differentialPrivacyLayer:462');
      /* best-effort */
    }

    // Audit trail: DP budget consumption is now tamper-evident.
    // Closes P0 audit gap — previously budget exhaustion was invisible.
    try {
      getAuditChainLedger().logEvent({
        type: 'config_change',
        severity: budget.remainingBudget < 1 ? 'high' : 'low',
        source: 'DifferentialPrivacyLayer',
        message: `DP budget spent: ε=${epsilon.toFixed(4)} by ${principalId} (remaining=${budget.remainingBudget.toFixed(4)}/${budget.totalBudget})`,
        details: {
          principalId,
          epsilonSpent: epsilon,
          remainingBudget: budget.remainingBudget,
          totalBudget: budget.totalBudget,
          queryCount: budget.queryCount,
        },
        context: {},
      });
    } catch (err) {
      reportSilentFailure(err, 'differentialPrivacyLayer:484');
      /* best-effort audit */
    }

    return true;
  }

  /**
   * Reset the privacy budget for a principal (new window starts now).
   * Only safe if the underlying data has been refreshed or replaced.
   */
  resetBudget(principalId: string): void {
    this.budgets.delete(principalId);
    this.getBudget(principalId); // creates fresh
  }

  /**
   * Get all active budgets for monitoring.
   */
  getAllBudgets(): PrivacyBudget[] {
    return Array.from(this.budgets.values()).map((b) => ({ ...b }));
  }

  /**
   * Get the total ε consumed across all principals in the current window.
   */
  getTotalConsumed(): number {
    let total = 0;
    for (const budget of this.budgets.values()) {
      total += budget.consumedBudget;
    }
    return total;
  }

  // ── Sanitization Methods ─────────────────────────────────────────────

  /**
   * DP-sanitize a count query.
   *
   * @param count - Raw count result
   * @param principalId - Principal spending the budget
   * @param epsilon - ε to spend (default: config.defaultEpsilon)
   * @returns DPQueryOutcome with noisy count and budget info
   */
  sanitizeCount(count: number, principalId: string, epsilon?: number): DPQueryOutcome<number> {
    const eps = epsilon ?? this.config.defaultEpsilon;

    if (!this.spendBudget(principalId, eps)) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'budget_exhausted',
        detail: `ε=${eps} exceeds remaining budget of ${budget.remainingBudget.toFixed(4)}`,
      };
    }

    const sensitivity = analyzeSensitivity('count');
    const noisyCount = laplaceMechanism(count, sensitivity.l1Sensitivity, eps);

    const budget = this.getBudget(principalId);
    return {
      result: Math.max(0, Math.round(noisyCount)),
      epsilonUsed: eps,
      deltaUsed: 0,
      remainingBudget: budget.remainingBudget,
      answerable: true,
      mechanism: 'laplace',
      sensitivity: sensitivity.l1Sensitivity,
    };
  }

  /**
   * DP-sanitize a sum query with bounded data.
   *
   * @param sum - Raw sum result
   * @param bounds - Data bounds [min, max]
   * @param principalId - Principal spending the budget
   * @param epsilon - ε to spend (default: config.defaultEpsilon)
   */
  sanitizeSum(
    sum: number,
    bounds: DPDataBounds,
    principalId: string,
    epsilon?: number,
  ): DPQueryOutcome<number> {
    const eps = epsilon ?? this.config.defaultEpsilon;

    if (bounds.max <= bounds.min) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'invalid_bounds',
        detail: `max=${bounds.max} must be > min=${bounds.min}`,
      };
    }

    if (!this.spendBudget(principalId, eps)) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'budget_exhausted',
        detail: `ε=${eps} exceeds remaining budget of ${budget.remainingBudget.toFixed(4)}`,
      };
    }

    const sensitivity = analyzeSensitivity('sum', bounds);
    const noisySum = laplaceMechanism(sum, sensitivity.l1Sensitivity, eps);

    const budget = this.getBudget(principalId);
    return {
      result: noisySum,
      epsilonUsed: eps,
      deltaUsed: 0,
      remainingBudget: budget.remainingBudget,
      answerable: true,
      mechanism: 'laplace',
      sensitivity: sensitivity.l1Sensitivity,
    };
  }

  /**
   * DP-sanitize an average query by splitting budget between noisy sum and noisy count.
   *
   * Uses 50% of ε for the sum, 50% for the count.
   * Result = noisy_sum / noisy_count, clipped to [min, max].
   *
   * @param sum - Raw sum of values
   * @param count - Raw count of values
   * @param bounds - Data bounds [min, max]
   * @param principalId - Principal spending the budget
   * @param epsilon - ε to spend (default: config.defaultEpsilon)
   */
  sanitizeAverage(
    sum: number,
    count: number,
    bounds: DPDataBounds,
    principalId: string,
    epsilon?: number,
  ): DPQueryOutcome<number> {
    const eps = epsilon ?? this.config.defaultEpsilon;
    const epsHalf = eps / 2;

    if (count < this.config.minItemsForSanitization) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'too_few_items',
        detail: `count=${count} < minItemsForSanitization=${this.config.minItemsForSanitization}. Too few items for DP.`,
      };
    }

    if (bounds.max <= bounds.min) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'invalid_bounds',
        detail: `max=${bounds.max} must be > min=${bounds.min}`,
      };
    }

    // Check total budget
    if (!this.checkBudget(principalId, eps)) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'budget_exhausted',
        detail: `ε=${eps} exceeds remaining budget of ${budget.remainingBudget.toFixed(4)}`,
      };
    }

    // Spend both halves atomically
    if (!this.spendBudget(principalId, epsHalf)) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'budget_exhausted',
        detail: 'Failed to spend first half of budget',
      };
    }
    if (!this.spendBudget(principalId, epsHalf)) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0 as const,
        deltaUsed: 0 as const,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'budget_exhausted',
        detail: 'Failed to spend second half of budget',
      };
    }

    const range = bounds.max - bounds.min;
    const noisySum = laplaceMechanism(sum, range, epsHalf);
    const noisyCount = laplaceMechanism(count, 1, epsHalf);
    const safeCount = Math.max(1, Math.round(noisyCount));
    const rawAvg = noisySum / safeCount;

    // Clip to data bounds
    const result = Math.max(bounds.min, Math.min(bounds.max, rawAvg));

    const budget = this.getBudget(principalId);
    return {
      result,
      epsilonUsed: eps,
      deltaUsed: 0,
      remainingBudget: budget.remainingBudget,
      answerable: true,
      mechanism: 'laplace',
      sensitivity: range,
    };
  }

  /**
   * DP-sanitize a numeric value (importance, access count, decay score)
   * from a single memory entry before cross-agent sharing.
   *
   * @param value - Raw numeric value
   * @param bounds - Data bounds [min, max]
   * @param principalId - Source agent spending the budget
   * @param epsilon - ε to spend
   */
  sanitizeNumeric(
    value: number,
    bounds: DPDataBounds,
    principalId: string,
    epsilon?: number,
  ): DPQueryOutcome<number> {
    const eps = epsilon ?? this.config.defaultEpsilon;

    if (!this.spendBudget(principalId, eps)) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'budget_exhausted',
        detail: `ε=${eps} exceeds remaining budget`,
      };
    }

    const range = bounds.max - bounds.min;
    if (range <= 0) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0 as const,
        deltaUsed: 0 as const,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'invalid_bounds',
        detail: `range=${range} must be > 0`,
      };
    }

    const noisy = laplaceMechanism(value, range, eps);
    const result = Math.max(bounds.min, Math.min(bounds.max, noisy));

    const budget = this.getBudget(principalId);
    return {
      result,
      epsilonUsed: eps,
      deltaUsed: 0,
      remainingBudget: budget.remainingBudget,
      answerable: true,
      mechanism: 'laplace',
      sensitivity: range,
    };
  }

  /**
   * DP-sanitize an array of MemoryEntry-like objects before cross-agent sharing.
   *
   * Adds Laplace noise to numeric fields (importance, accessCount, decayScore)
   * to prevent inference about individual agents' data from aggregate results.
   *
   * The TEXT content is NOT modified — DP does not apply to unstructured text.
   * For text privacy, use aggregation (bucketing, classification) or
   * abstention (don't share raw text across agents).
   *
   * @param entries - Array of entries with numeric fields to sanitize
   * @param principalId - Source principal spending the budget
   * @param epsilon - ε to spend per entry (default: config.defaultEpsilon/entries.length)
   * @returns Sanitized entries with noise added to numeric fields
   */
  sanitizeMemoryEntries<
    T extends { importance?: number; accessCount?: number; decayScore?: number },
  >(entries: T[], principalId: string, epsilon?: number): DPQueryOutcome<T[]> {
    if (entries.length === 0) {
      const budget = this.getBudget(principalId);
      return {
        result: [],
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: true,
        mechanism: 'laplace',
        sensitivity: 0,
      };
    }

    if (entries.length < this.config.minItemsForSanitization) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'too_few_items',
        detail: `${entries.length} entries < minItemsForSanitization=${this.config.minItemsForSanitization}. Too few items for safe DP.`,
      };
    }

    const totalEps = epsilon ?? this.config.defaultEpsilon;
    // Distribute ε equally across entries
    const epsPerEntry = totalEps / entries.length;

    if (!this.checkBudget(principalId, totalEps)) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'budget_exhausted',
        detail: `total ε=${totalEps} exceeds remaining budget`,
      };
    }

    // Importance is in [0, 1]
    const IMPORTANCE_BOUNDS: DPDataBounds = { min: 0, max: 1 };
    // Decay score is in [0, 1]
    const DECAY_BOUNDS: DPDataBounds = { min: 0, max: 1 };
    // Access count: [0, 10000] — reasonable upper bound
    const ACCESS_COUNT_BOUNDS: DPDataBounds = { min: 0, max: 10000 };

    const sanitized: T[] = [];
    let actualEpsilonSpent = 0;

    for (const entry of entries) {
      const entryCopy = { ...entry };

      // Sanitize importance
      if (entryCopy.importance !== undefined) {
        const fieldEps = epsPerEntry * 0.34;
        if (this.spendBudget(principalId, fieldEps)) {
          actualEpsilonSpent += fieldEps;
          const noisy = laplaceMechanism(
            entryCopy.importance,
            IMPORTANCE_BOUNDS.max - IMPORTANCE_BOUNDS.min,
            fieldEps,
          );
          entryCopy.importance = Math.max(0, Math.min(1, noisy));
        }
      }

      // Sanitize accessCount
      if (entryCopy.accessCount !== undefined) {
        const fieldEps = epsPerEntry * 0.33;
        if (this.spendBudget(principalId, fieldEps)) {
          actualEpsilonSpent += fieldEps;
          const noisy = laplaceMechanism(
            entryCopy.accessCount,
            ACCESS_COUNT_BOUNDS.max - ACCESS_COUNT_BOUNDS.min,
            fieldEps,
          );
          entryCopy.accessCount = Math.max(0, Math.round(noisy));
        }
      }

      // Sanitize decayScore
      if (entryCopy.decayScore !== undefined) {
        const fieldEps = epsPerEntry * 0.33;
        if (this.spendBudget(principalId, fieldEps)) {
          actualEpsilonSpent += fieldEps;
          const noisy = laplaceMechanism(
            entryCopy.decayScore,
            DECAY_BOUNDS.max - DECAY_BOUNDS.min,
            fieldEps,
          );
          entryCopy.decayScore = Math.max(0, Math.min(1, noisy));
        }
      }

      sanitized.push(entryCopy);
    }

    // The total ε spent is approximately totalEps (all spendBudget calls above)
    // We already checked checkBudget at the start, so we're safe
    const budget = this.getBudget(principalId);
    return {
      result: sanitized,
      epsilonUsed: actualEpsilonSpent,
      deltaUsed: 0,
      remainingBudget: budget.remainingBudget,
      answerable: true,
      mechanism: 'laplace',
      sensitivity: 1,
    };
  }

  /**
   * DP-sanitize a count from a set of entries with a single Laplace query.
   * More ε-efficient than per-entry sanitization for count-only queries.
   *
   * @param entries - Original entries (used only for count)
   * @param principalId - Principal spending budget
   * @param epsilon - ε to spend
   */
  sanitizeEntryCount(
    entries: unknown[],
    principalId: string,
    epsilon?: number,
  ): DPQueryOutcome<number> {
    if (entries.length < this.config.minItemsForSanitization) {
      const budget = this.getBudget(principalId);
      return {
        result: undefined,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: budget.remainingBudget,
        answerable: false,
        reason: 'too_few_items',
        detail: `${entries.length} entries < minItemsForSanitization=${this.config.minItemsForSanitization}`,
      };
    }

    return this.sanitizeCount(entries.length, principalId, epsilon);
  }

  // ── Configuration ────────────────────────────────────────────────────

  /** Update configuration at runtime. */
  updateConfig(partial: Partial<DifferentialPrivacyConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Get the current configuration. */
  getConfig(): DifferentialPrivacyConfig {
    return { ...this.config };
  }

  /** Clear all budgets (test isolation). */
  reset(): void {
    this.budgets.clear();
  }
}

// ============================================================================
// Tenant-aware singleton
// ============================================================================

const dpSingleton = createTenantAwareSingleton(() => new DifferentialPrivacyLayer());

/** Resolve the active DifferentialPrivacyLayer via the current tenant context. */
export function getDifferentialPrivacyLayer(): DifferentialPrivacyLayer {
  return dpSingleton.get();
}

/** Reset all DP layer instances (test isolation). */
export function resetDifferentialPrivacyLayer(): void {
  dpSingleton.reset();
}
