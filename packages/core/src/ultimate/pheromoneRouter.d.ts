/**
 * Pheromone-Enhanced Topology Router (P1) with Cross-Tenant Isolation (P1.1)
 *
 * Records per-(tenant, taskType, topology) outcomes as a Beta-distributed
 * posterior and uses Thompson sampling at routing time to bias selection
 * toward historically-winning topologies while still exploring
 * underperformers.
 *
 * Inspired by ant-colony pheromone dynamics in swarm routing: paths that
 * succeed get reinforced (alpha grows), paths that fail evaporate (beta
 * grows).
 *
 * Design choices:
 *  - Beta(α, β) is conjugate to the Bernoulli likelihood, so updating on
 *    each (success/failure) observation is a simple additive update.
 *  - Quality-weighted observations: a high-quality success adds more to α
 *    than a marginal one, and a low-quality failure adds more to β. This
 *    keeps the posterior meaningful when outcomes are graded rather than
 *    binary.
 *  - Tenant isolation (P1.1): every state key is namespaced by tenantId
 *    so signal from one tenant never bleeds into another tenant's
 *    routing decisions. The DEFAULT_TENANT_ID sentinel absorbs all
 *    un-scoped traffic so single-tenant deployments behave identically
 *    to the original P1 design.
 *  - The router can EITHER Thompson-sample a single winner (`selectTopology`)
 *    OR apply a bias to a pre-computed heuristic ranking (`bias`). The bias
 *    path is what `TopologyRouter.route()` uses so the existing heuristic
 *    remains the floor.
 *
 * Thread-safety: state is held in a Map; concurrent writers may race on the
 * same key but the additive update is commutative, so worst case is one
 * observation lost — acceptable for a routing signal.
 */
import type { OrchestrationTopology } from './types';
/** Sentinel tenant id used when no tenant is specified. Single-tenant
 *  deployments and un-scoped test traffic all land in this bucket. */
export declare const DEFAULT_TENANT_ID = "__default__";
/** Posterior state for a single (tenant, taskType, topology) triple. */
export interface PheromoneState {
    /** Posterior alpha (pseudo-counts of weighted successes + prior). */
    alpha: number;
    /** Posterior beta (pseudo-counts of weighted failures + prior). */
    beta: number;
    /** Total observations recorded. */
    samples: number;
    /** Last update timestamp (epoch ms). */
    lastUpdated: number;
}
/** Result of a Thompson sample, useful for observability. */
export interface PheromoneSample {
    topology: OrchestrationTopology;
    sample: number;
    expectedSuccess: number;
    alpha: number;
    beta: number;
}
export interface PheromoneRouterOptions {
    /** Prior alpha (default 1 — uniform Beta(1,1)). */
    priorAlpha?: number;
    /** Prior beta (default 1 — uniform Beta(1,1)). */
    priorBeta?: number;
    /**
     * Minimum samples on a (tenant, taskType, topology) triple before the
     * pheromone is allowed to bias the heuristic. Below this, we treat the
     * prior as uninformative and skip the adjustment (default 3).
     */
    minSamplesBeforeBias?: number;
    /**
     * Maximum absolute score bonus the pheromone can add to a heuristic
     * candidate. Caps the influence of the posterior so a strongly-typed
     * heuristic can still override a noisy pheromone (default 1.0).
     * Calibrate against typical heuristic score range in TopologyRouter
     * (heuristic scores are typically in [0, 10]); 1.0 ≈ 10% of the
     * upper end, so the pheromone can nudge but not dominate.
     */
    maxBiasMagnitude?: number;
    /**
     * Optional RNG for Thompson sampling (default Math.random). Injected for
     * deterministic testing.
     */
    rng?: () => number;
    /**
     * Default tenant id used when callers don't pass a tenantId. Defaults
     * to DEFAULT_TENANT_ID. Setting this to a per-instance value lets
     * callers bake the tenant into the API instead of threading it through
     * every call (e.g. when wiring into a per-tenant singleton).
     */
    defaultTenantId?: string;
}
/** Result of bias application, including the original entry plus the delta. */
export interface PheromoneBiasedScore {
    topology: OrchestrationTopology;
    score: number;
    pheromoneBias: number;
    pheromoneSamples: number;
    expectedSuccess: number;
}
/**
 * PheromoneRouter: per-(tenant, taskType, topology) Beta posterior with
 * Thompson sampling. See file header for design notes.
 */
export declare class PheromoneRouter {
    private readonly priorAlpha;
    private readonly priorBeta;
    private readonly minSamplesBeforeBias;
    private readonly maxBiasMagnitude;
    private readonly rng;
    private readonly defaultTenantId;
    /** Keyed by `${tenantId}::${taskType}::${topology}`. */
    private readonly state;
    /** Per-tenant set of (taskType, topology) pairs, for clean cleanup / introspection. */
    private readonly tasks;
    constructor(options?: PheromoneRouterOptions);
    /**
     * Record an outcome for a (tenant, taskType, topology) triple.
     *
     * Tenant-aware signature (P1.1):
     *   recordOutcome(tenantId, taskType, topology, success, qualityScore?)
     *
     * For single-tenant callers, the legacy signature is still supported
     * by detecting argument shape (a string-only first arg is the taskType
     * in P1; an OrchestrationTopology-shape first arg cannot occur here
     * so we simply test the first arg's position in the signature).
     * Concretely: we accept (tenantId, taskType, topology, success, q?) and
     * fall back to (taskType, topology, success, q?) when the first arg
     * would collide with the taskType (always a string in practice).
     *
     * In P1.1, callers must opt in by passing a non-empty tenantId as the
     * first argument. The detector inspects argument *types* at runtime:
     * if args[1] is an OrchestrationTopology string and args[0] doesn't
     * look like a tenantId, we shift.
     *
     * To make the call sites unambiguous, the helper `recordOutcomeFor`
     * (P2 path) accepts an explicit tenantId and should be preferred by
     * the orchestrator.
     */
    recordOutcome(taskTypeOrTenantId: string, taskTypeOrTopology: string | OrchestrationTopology, topologyOrSuccess: OrchestrationTopology | boolean, successOrQuality: boolean | number | undefined, qualityArg?: number): void;
    /**
     * Tenant-aware, unambiguous record API (preferred for P2 wiring).
     * Always uses the (tenantId, taskType, topology, success, q?) signature.
     */
    recordOutcomeFor(tenantId: string, taskType: string, topology: OrchestrationTopology, success: boolean, qualityScore?: number): void;
    /**
     * Thompson-sample one topology from the candidate set. Tenant-aware:
     * pass `tenantId` to scope the sampling to that tenant's posterior;
     * omit to use the per-instance default.
     */
    selectTopology(taskTypeOrTenantId: string, taskTypeOrCandidates: string | OrchestrationTopology[], candidatesOrUndefined?: OrchestrationTopology[]): {
        selected: OrchestrationTopology | null;
        samples: PheromoneSample[];
    };
    selectTopologyFor(tenantId: string, taskType: string, candidates: OrchestrationTopology[]): {
        selected: OrchestrationTopology | null;
        samples: PheromoneSample[];
    };
    /**
     * Apply a pheromone bias to a pre-computed heuristic score list.
     * Topologies with strong historical performance get a positive bonus
     * proportional to (expectedSuccess - 0.5); topologies with poor performance
     * get a negative bonus. Magnitude is capped at `maxBiasMagnitude`.
     *
     * Tenant-aware: when `tenantId` is provided, scopes the posterior lookups
     * to that tenant; otherwise uses the per-instance default.
     *
     * Does NOT change `scores[i].topology` — the caller is responsible for
     * picking the winner (typically via `Math.max` on `.score`).
     */
    bias(taskTypeOrTenantId: string, taskTypeOrScores: string | Array<{
        topology: OrchestrationTopology;
        score: number;
    }>, scoresOrUndefined?: Array<{
        topology: OrchestrationTopology;
        score: number;
    }>): PheromoneBiasedScore[];
    biasFor(tenantId: string, taskType: string, scores: Array<{
        topology: OrchestrationTopology;
        score: number;
    }>): PheromoneBiasedScore[];
    /**
     * Estimated success probability (alpha / (alpha + beta)) for a triple.
     * Supports both legacy and tenant-aware signatures (same detector as
     * `recordOutcome`).
     */
    getConfidence(taskTypeOrTenantId: string, taskTypeOrTopology: string | OrchestrationTopology, topologyOrUndefined?: OrchestrationTopology): number;
    getConfidenceFor(tenantId: string, taskType: string, topology: OrchestrationTopology): number;
    /** Return all recorded states for observability / debugging. When
     *  `tenantId` is given, returns only that tenant's triples. */
    getStats(tenantId?: string): Array<{
        tenantId: string;
        taskType: string;
        topology: OrchestrationTopology;
        state: PheromoneState;
    }>;
    /** List all tenant ids that have at least one recorded triple. */
    listTenants(): string[];
    /** Reset all state. When `tenantId` is given, only resets that tenant's
     *  triples; otherwise clears everything. */
    reset(tenantId?: string): void;
    private resolveTenantId;
    private keyOf;
    private taskKeyOf;
    private parseKey;
    /**
     * Sample from Beta(α, β) using the Marsaglia-Tsang gamma method.
     * Requires α, β ≥ 1, which we always satisfy because we initialize at
     * the prior (default 1) and only add to α/β on each observation.
     */
    private sampleBeta;
    private sampleGamma;
    /** Box-Muller standard-normal sample. */
    private randn;
}
//# sourceMappingURL=pheromoneRouter.d.ts.map