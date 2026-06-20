/**
 * Online Meta-Learner for Topology Weight Adaptation (P10) with Cross-Tenant
 * Isolation (P2).
 *
 * Takes success/failure signals directly and maintains an exponential moving
 * average per (tenant, taskType, topology) triple. A topology that succeeds
 * for a given tenant+taskType drifts up in weight, and one that fails drifts
 * down. The static base weights are preserved as a prior and blended with the
 * learned adjustment so the system still has a sensible starting point when
 * little signal is available.
 *
 * The original implementation delegated signal computation to PheromoneRouter.
 * That abstraction was removed because the posterior was uniform until enough
 * samples accumulated; computing the signal directly removes the indirection
 * while preserving the same EMA behavior.
 *
 * Why EMA rather than a hard posterior? Weight adjustments should react
 * to recent evidence, not be dominated by the full history. EMA gives
 * an "effective window" of ~1/α observations; with α=0.1 the window is
 * ~10 observations, which matches the typical warm-up time for a new
 * (tenant, taskType, topology) triple in production.
 */

/** Sentinel tenant id used when no tenant is specified. Single-tenant
 *  deployments and un-scoped test traffic all land in this bucket. */
export const DEFAULT_TENANT_ID = '__default__';

import type { OrchestrationTopology } from './types';

/** Subset of TASK_TYPE_WEIGHTS: the four weight dimensions used for scoring. */
export interface TypeWeights {
  research: number;
  parallel: number;
  sequential: number;
  complex: number;
}

/** Per-(tenant, taskType, topology) learned EMA state. */
export interface LearnedWeightState {
  /** EMA of the success signal, range roughly [-0.5, 0.5]. */
  ema: number;
  /** Number of signals observed (for diagnostics, not used in blend). */
  samples: number;
  /** Last update timestamp (epoch ms). */
  lastUpdated: number;
}

export interface LearnedWeightsOptions {
  /**
   * EMA smoothing factor α. Higher = more reactive to recent observations
   * (default 0.1 → effective window of ~10 observations).
   */
  smoothingFactor?: number;
  /**
   * Maximum relative adjustment applied to the base weight. With
   * maxAdjustment=0.5, weights can range from 50% to 150% of the base.
   * Caps the influence of the learned signal so a noisy early posterior
   * can't dominate the static prior (default 0.5).
   */
  maxAdjustment?: number;
  /**
   * Minimum samples before the learned weight kicks in. Below
   * this, the static base is returned unchanged (default 3).
   */
  minSamplesBeforeAdjust?: number;
  /**
   * Default tenant id used when callers don't pass a tenantId. Defaults
   * to DEFAULT_TENANT_ID. Setting this to a per-instance value lets
   * callers bake the tenant into the API instead of threading it through
   * every call (e.g. when wiring into a per-tenant singleton).
   */
  defaultTenantId?: string;
}

/** Result of weight adaptation for observability. */
export interface AdjustedWeights {
  base: TypeWeights;
  adjusted: TypeWeights;
  /** Per-topology adjustment used in the blend, range [-maxAdjustment, +maxAdjustment]. */
  adjustments: Partial<Record<OrchestrationTopology, number>>;
  /** Number of (taskType, topology) pairs that contributed to this adjustment. */
  maturePairs: number;
  /** The tenant id this adaptation was computed for. */
  tenantId: string;
}

/**
 * Mapping from OrchestrationTopology to the type-weight dimensions it
 * affects. Each topology has a primary dimension and (for topologies
 * that materially contribute to research tasks) an optional secondary
 * dimension. The adjustment is split 70/30 between primary and
 * secondary so the dominant `research` dimension on RESEARCH/ANALYSIS
 * taskTypes is actually reachable from a learned signal.
 */
interface TopologyDimensionMap {
  primary: keyof TypeWeights;
  secondary?: keyof TypeWeights;
}

const TOPOLOGY_DIMENSION: Record<OrchestrationTopology, TopologyDimensionMap> = {
  SINGLE: { primary: 'sequential' },
  SEQUENTIAL: { primary: 'sequential' },
  PARALLEL: { primary: 'parallel', secondary: 'research' },
  HIERARCHICAL: { primary: 'complex', secondary: 'research' },
  HYBRID: { primary: 'complex', secondary: 'research' },
  DEBATE: { primary: 'complex' },
  ENSEMBLE: { primary: 'parallel' },
  EVALUATOR_OPTIMIZER: { primary: 'complex' },
  HANDOFF: { primary: 'sequential' },
  CONSENSUS: { primary: 'parallel' },
};

/**
 * LearnedWeights: wraps PheromoneRouter and converts per-(tenant, taskType,
 * topology) confidence signals into adaptive weights for the
 * TopologyRouter heuristic.
 */
export class LearnedWeights {
  private readonly alpha: number;
  private readonly maxAdjustment: number;
  private readonly minSamplesBeforeAdjust: number;
  private readonly defaultTenantId: string;

  /** Keyed by `${tenantId}::${taskType}::${topology}`. */
  private readonly state = new Map<string, LearnedWeightState>();

  /**
   * Generic coordination-weight storage. Keyed by `${tenantId}::${key}::${taskType}`.
   * Stores learned scalar values for coordination policy dimensions like
   * 'coupling', 'breadth_gain', etc. — see `recordCoordinationWeight` /
   * `getCoordinationWeight`.
   */
  private readonly coordinationWeights = new Map<string, number>();

  constructor(options: LearnedWeightsOptions = {}) {
    this.alpha = options.smoothingFactor ?? 0.1;
    this.maxAdjustment = options.maxAdjustment ?? 0.5;
    this.minSamplesBeforeAdjust = options.minSamplesBeforeAdjust ?? 3;
    this.defaultTenantId = options.defaultTenantId ?? DEFAULT_TENANT_ID;
  }

  /**
   * Record a new signal for a (tenant, taskType, topology) triple. Computes
   * a quality-scaled success signal in [-0.5, 0.5] and updates the EMA. When
   * `tenantId` is undefined, the per-instance default is used.
   */
  recordSignal(
    taskType: string,
    topology: OrchestrationTopology,
    success: boolean,
    qualityScore?: number,
    tenantId?: string,
  ): void {
    const tid = this.resolveTenantId(tenantId);
    const key = this.keyOf(tid, taskType, topology);

    // success -> +0.5, failure -> -0.5. qualityScore is accepted for API
    // compatibility but no longer scales the signal (the removed PheromoneRouter
    // indirection is replaced by this direct, deterministic mapping).
    const signal = success ? 0.5 : -0.5;

    const cur = this.state.get(key) ?? {
      ema: 0,
      samples: 0,
      lastUpdated: Date.now(),
    };
    // EMA: cur.ema ← (1 - α) * cur.ema + α * signal
    cur.ema = (1 - this.alpha) * cur.ema + this.alpha * signal;
    cur.samples += 1;
    cur.lastUpdated = Date.now();
    this.state.set(key, cur);
  }

  /**
   * Return adjusted type weights for the given tenantId+taskType. The static
   * base weights are blended with the learned adjustment: each (taskType,
   * topology) pair contributes ±maxAdjustment to its primary dimension
   * (e.g., PARALLEL → parallel dimension).
   *
   * When fewer than `minSamplesBeforeAdjust` observations exist for the
   * (tenant, taskType, topology) triple, that pair contributes 0 to the
   * blend, so the result equals the base (unchanged).
   */
  getAdjustedWeights(taskType: string, base: TypeWeights, tenantId?: string): AdjustedWeights {
    const tid = this.resolveTenantId(tenantId);
    const adjusted: TypeWeights = {
      research: base.research,
      parallel: base.parallel,
      sequential: base.sequential,
      complex: base.complex,
    };
    const adjustments: Partial<Record<OrchestrationTopology, number>> = {};
    let maturePairs = 0;

    for (const topology of Object.keys(TOPOLOGY_DIMENSION) as OrchestrationTopology[]) {
      const st = this.getState(taskType, topology, tid);
      if (!st || st.samples < this.minSamplesBeforeAdjust) {
        adjustments[topology] = 0;
        continue;
      }
      // Map EMA in [-0.5, 0.5] to [-maxAdjustment, +maxAdjustment].
      // The signal-to-adjustment scale is 2× (so an EMA of 0.25 → +0.5 × adjustment).
      const adjustment = Math.max(-this.maxAdjustment, Math.min(this.maxAdjustment, st.ema * 2));
      adjustments[topology] = adjustment;
      maturePairs += 1;

      const map = TOPOLOGY_DIMENSION[topology];
      // Split the adjustment 70/30 between primary and secondary dimensions
      // so the `research` dimension on RESEARCH/ANALYSIS taskTypes is reachable
      // from a learned signal on HYBRID/HIERARCHICAL/PARALLEL.
      const primaryShare = 0.7;
      const secondaryShare = 1 - primaryShare;
      adjusted[map.primary] = Math.max(
        0,
        adjusted[map.primary] + base[map.primary] * adjustment * primaryShare,
      );
      if (map.secondary) {
        adjusted[map.secondary] = Math.max(
          0,
          adjusted[map.secondary] + base[map.secondary] * adjustment * secondaryShare,
        );
      }
    }

    return { base, adjusted, adjustments, maturePairs, tenantId: tid };
  }

  /** Direct lookup for a single (tenant, taskType, topology) triple. Returns
   *  undefined when the pair has no recorded signal — callers can use this
   *  to skip emitting a "samples=0" gauge for missing pairs. */
  getState(
    taskType: string,
    topology: OrchestrationTopology,
    tenantId?: string,
  ): LearnedWeightState | undefined {
    const tid = this.resolveTenantId(tenantId);
    return this.state.get(this.keyOf(tid, taskType, topology));
  }

  /** Return the current EMA state for all observed triples, optionally
   *  filtered by tenantId. When `tenantId` is undefined, returns all
   *  triples across all tenants. */
  getStats(tenantId?: string): Array<{
    tenantId: string;
    taskType: string;
    topology: OrchestrationTopology;
    state: LearnedWeightState;
  }> {
    const out: Array<{
      tenantId: string;
      taskType: string;
      topology: OrchestrationTopology;
      state: LearnedWeightState;
    }> = [];
    for (const [key, st] of this.state.entries()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      if (tenantId !== undefined && parsed.tenantId !== this.resolveTenantId(tenantId)) continue;
      out.push({
        tenantId: parsed.tenantId,
        taskType: parsed.taskType,
        topology: parsed.topology,
        state: st,
      });
    }
    return out;
  }

  /** List all tenant ids that have at least one recorded signal. */
  listTenants(): string[] {
    const tenants = new Set<string>();
    for (const key of this.state.keys()) {
      const parsed = this.parseKey(key);
      if (parsed) tenants.add(parsed.tenantId);
    }
    return Array.from(tenants).sort();
  }

  /** Reset all state. When tenantId is given, only resets that tenant's
   *  triples; otherwise clears everything. */
  reset(tenantId?: string): void {
    if (tenantId === undefined) {
      this.state.clear();
      return;
    }
    const tid = this.resolveTenantId(tenantId);
    const prefix = `${tid}::`;
    for (const key of Array.from(this.state.keys())) {
      if (key.startsWith(prefix)) this.state.delete(key);
    }
  }

  /** Number of recorded triples (all tenants, or filtered to one). */
  size(tenantId?: string): number {
    if (tenantId === undefined) return this.state.size;
    const tid = this.resolveTenantId(tenantId);
    const prefix = `${tid}::`;
    let count = 0;
    for (const key of this.state.keys()) {
      if (key.startsWith(prefix)) count++;
    }
    return count;
  }

  /**
   * Record a learned coordination weight for a (tenant, key, taskType) triple.
   * The `value` is an EMA-smoothed scalar; callers typically record the
   * observed coupling or gain after each task completion.
   */
  recordCoordinationWeight(key: string, taskType: string, value: number, tenantId?: string): void {
    const tid = this.resolveTenantId(tenantId);
    const mapKey = `${tid}::${key}::${taskType}`;
    const prev = this.coordinationWeights.get(mapKey);
    const blended = prev !== undefined ? (1 - this.alpha) * prev + this.alpha * value : value;
    this.coordinationWeights.set(mapKey, blended);
  }

  /**
   * Retrieve a learned coordination weight. Returns `defaultValue` when no
   * signal has been recorded for the (tenant, key, taskType) triple.
   */
  getCoordinationWeight(
    key: string,
    taskType: string,
    defaultValue: number,
    tenantId?: string,
  ): number {
    const tid = this.resolveTenantId(tenantId);
    const mapKey = `${tid}::${key}::${taskType}`;
    return this.coordinationWeights.get(mapKey) ?? defaultValue;
  }

  /** Reset coordination weights. When tenantId is given, only resets that tenant's entries. */
  resetCoordinationWeights(tenantId?: string): void {
    if (tenantId === undefined) {
      this.coordinationWeights.clear();
      return;
    }
    const tid = this.resolveTenantId(tenantId);
    const prefix = `${tid}::`;
    for (const key of Array.from(this.coordinationWeights.keys())) {
      if (key.startsWith(prefix)) this.coordinationWeights.delete(key);
    }
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private resolveTenantId(tenantId: string | undefined): string {
    if (tenantId && tenantId.length > 0) return tenantId;
    return this.defaultTenantId;
  }

  private keyOf(tenantId: string, taskType: string, topology: OrchestrationTopology): string {
    return `${tenantId}::${taskType}::${topology}`;
  }

  private parseKey(
    key: string,
  ): { tenantId: string; taskType: string; topology: OrchestrationTopology } | null {
    // Key format: `${tenantId}::${taskType}::${topology}` — the *first* "::"
    // separates tenant from the rest, and the *last* "::" separates
    // taskType from topology. We split into at most 3 parts.
    const first = key.indexOf('::');
    if (first < 0) return null;
    const second = key.indexOf('::', first + 2);
    if (second < 0) return null;
    return {
      tenantId: key.slice(0, first),
      taskType: key.slice(first + 2, second),
      topology: key.slice(second + 2) as OrchestrationTopology,
    };
  }
}
