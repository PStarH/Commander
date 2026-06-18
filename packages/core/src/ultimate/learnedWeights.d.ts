/**
 * Online Meta-Learner for Topology Weight Adaptation (P10) with Cross-Tenant
 * Isolation (P2).
 *
 * Wraps PheromoneRouter to make the static `TASK_TYPE_WEIGHTS` table in
 * TopologyRouter adaptive. Each (tenant, taskType, topology) triple
 * accumulates an exponential moving average of `(pheromoneConfidence - 0.5)`,
 * so a topology that succeeds for a given tenant+taskType drifts up in
 * weight, and one that fails drifts down. The static base weights are
 * preserved as a prior and blended with the learned adjustment so the
 * system still has a sensible starting point when little signal is
 * available.
 *
 * Composes with P1 (PheromoneRouter) and P2 (multi-tenant isolation):
 *  - PheromoneRouter provides the per-pair success signal.
 *  - P2 adds a `tenantId` dimension to every state key so signal from
 *    one tenant never leaks into another tenant's routing.
 *  - The pheromone bias in TopologyRouter still applies on top, so the
 *    two signals are additive: learned weights adjust the *base* score
 *    (per-tenant × per-topology × per-taskType), pheromone bias adjusts
 *    the *outcome-aware* score at routing time.
 *
 * Why EMA rather than a hard posterior? Weight adjustments should react
 * to recent evidence, not be dominated by the full history. EMA gives
 * an "effective window" of ~1/α observations; with α=0.1 the window is
 * ~10 observations, which matches the typical warm-up time for a new
 * (tenant, taskType, topology) triple in production.
 */
/** Sentinel tenant id used when no tenant is specified. Single-tenant
 *  deployments and un-scoped test traffic all land in this bucket. */
export declare const DEFAULT_TENANT_ID = "__default__";
import type { OrchestrationTopology } from './types';
import type { PheromoneRouter } from './pheromoneRouter';
/** Subset of TASK_TYPE_WEIGHTS: the four weight dimensions used for scoring. */
export interface TypeWeights {
    research: number;
    parallel: number;
    sequential: number;
    complex: number;
}
/** Per-(tenant, taskType, topology) learned EMA state. */
export interface LearnedWeightState {
    /** EMA of (pheromoneConfidence - 0.5), range roughly [-0.5, 0.5]. */
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
     * Minimum pheromone samples before the learned weight kicks in. Below
     * this, the static base is returned unchanged (default 3, matching
     * PheromoneRouter's minSamplesBeforeBias).
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
 * LearnedWeights: wraps PheromoneRouter and converts per-(tenant, taskType,
 * topology) confidence signals into adaptive weights for the
 * TopologyRouter heuristic.
 */
export declare class LearnedWeights {
    private readonly pheromoneRouter;
    private readonly alpha;
    private readonly maxAdjustment;
    private readonly minSamplesBeforeAdjust;
    private readonly defaultTenantId;
    /** Keyed by `${tenantId}::${taskType}::${topology}`. */
    private readonly state;
    /**
     * Generic coordination-weight storage. Keyed by `${tenantId}::${key}::${taskType}`.
     * Stores learned scalar values for coordination policy dimensions like
     * 'coupling', 'breadth_gain', etc. — see `recordCoordinationWeight` /
     * `getCoordinationWeight`.
     */
    private readonly coordinationWeights;
    constructor(pheromoneRouter: PheromoneRouter, options?: LearnedWeightsOptions);
    /**
     * Record a new signal for a (tenant, taskType, topology) triple. Pulls the
     * current tenant-scoped pheromone confidence and updates the EMA. When
     * `tenantId` is undefined, the per-instance default is used.
     *
     * Forwards the same signal to the underlying PheromoneRouter (with the
     * same tenantId) so the pheromone posterior and the learned EMA stay
     * in sync as a single source of truth.
     */
    recordSignal(taskType: string, topology: OrchestrationTopology, success: boolean, qualityScore?: number, tenantId?: string): void;
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
    getAdjustedWeights(taskType: string, base: TypeWeights, tenantId?: string): AdjustedWeights;
    /** Direct lookup for a single (tenant, taskType, topology) triple. Returns
     *  undefined when the pair has no recorded signal — callers can use this
     *  to skip emitting a "samples=0" gauge for missing pairs. */
    getState(taskType: string, topology: OrchestrationTopology, tenantId?: string): LearnedWeightState | undefined;
    /** Return the current EMA state for all observed triples, optionally
     *  filtered by tenantId. When `tenantId` is undefined, returns all
     *  triples across all tenants. */
    getStats(tenantId?: string): Array<{
        tenantId: string;
        taskType: string;
        topology: OrchestrationTopology;
        state: LearnedWeightState;
    }>;
    /** List all tenant ids that have at least one recorded signal. */
    listTenants(): string[];
    /** Reset all state. When tenantId is given, only resets that tenant's
     *  triples; otherwise clears everything. */
    reset(tenantId?: string): void;
    /** Number of recorded triples (all tenants, or filtered to one). */
    size(tenantId?: string): number;
    /**
     * Record a learned coordination weight for a (tenant, key, taskType) triple.
     * The `value` is an EMA-smoothed scalar; callers typically record the
     * observed coupling or gain after each task completion.
     */
    recordCoordinationWeight(key: string, taskType: string, value: number, tenantId?: string): void;
    /**
     * Retrieve a learned coordination weight. Returns `defaultValue` when no
     * signal has been recorded for the (tenant, key, taskType) triple.
     */
    getCoordinationWeight(key: string, taskType: string, defaultValue: number, tenantId?: string): number;
    /** Reset coordination weights. When tenantId is given, only resets that tenant's entries. */
    resetCoordinationWeights(tenantId?: string): void;
    private resolveTenantId;
    /**
     * Forward to the underlying PheromoneRouter. Always uses the P1.1
     * tenant-aware `recordOutcomeFor` API — the P1 `recordOutcome` shim
     * still exists in PheromoneRouter for external callers that haven't
     * migrated, but LearnedWeights is an internal caller and benefits
     * from the unambiguous, tenant-scoped path. (An earlier draft tried
     * to probe `recordOutcome.length >= 5` to detect P1.1 support, but
     * TypeScript compiles optional `?` parameters out of `.length`, so
     * the P1.1 arity is 4 (not 5) and the probe was unreliable.)
     */
    private feedPheromone;
    /**
     * Forward to the underlying PheromoneRouter's tenant-aware
     * `getConfidenceFor`. See `feedPheromone` for the rationale on using
     * the `*For` variant unconditionally.
     */
    private pheromoneConfidence;
    private keyOf;
    private parseKey;
}
//# sourceMappingURL=learnedWeights.d.ts.map