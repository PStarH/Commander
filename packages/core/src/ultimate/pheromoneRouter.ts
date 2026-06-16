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
export const DEFAULT_TENANT_ID = '__default__';

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
  expectedSuccess: number; // alpha / (alpha + beta)
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
export class PheromoneRouter {
  private readonly priorAlpha: number;
  private readonly priorBeta: number;
  private readonly minSamplesBeforeBias: number;
  private readonly maxBiasMagnitude: number;
  private readonly rng: () => number;
  private readonly defaultTenantId: string;

  /** Keyed by `${tenantId}::${taskType}::${topology}`. */
  private readonly state = new Map<string, PheromoneState>();
  /** Per-tenant set of (taskType, topology) pairs, for clean cleanup / introspection. */
  private readonly tasks = new Map<string, Set<OrchestrationTopology>>();

  constructor(options: PheromoneRouterOptions = {}) {
    this.priorAlpha = options.priorAlpha ?? 1;
    this.priorBeta = options.priorBeta ?? 1;
    this.minSamplesBeforeBias = options.minSamplesBeforeBias ?? 3;
    this.maxBiasMagnitude = options.maxBiasMagnitude ?? 1.0;
    this.rng = options.rng ?? Math.random;
    this.defaultTenantId = options.defaultTenantId ?? DEFAULT_TENANT_ID;
  }

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
  recordOutcome(
    taskTypeOrTenantId: string,
    taskTypeOrTopology: string | OrchestrationTopology,
    topologyOrSuccess: OrchestrationTopology | boolean,
    successOrQuality: boolean | number | undefined,
    qualityArg?: number,
  ): void {
    // Detect the signature by checking if args[2] is a boolean (legacy)
    // or an OrchestrationTopology (tenant-aware). When args[2] is a
    // boolean the call is legacy P1; otherwise it's tenant-aware.
    const isLegacy = typeof topologyOrSuccess === 'boolean';
    let tenantId: string;
    let taskType: string;
    let topology: OrchestrationTopology;
    let success: boolean;
    let qualityScore: number | undefined;
    if (isLegacy) {
      tenantId = this.defaultTenantId;
      taskType = taskTypeOrTenantId;
      topology = taskTypeOrTopology as OrchestrationTopology;
      success = topologyOrSuccess as boolean;
      qualityScore = typeof successOrQuality === 'number' ? successOrQuality : undefined;
    } else {
      tenantId = taskTypeOrTenantId || this.defaultTenantId;
      taskType = taskTypeOrTopology as string;
      topology = topologyOrSuccess as OrchestrationTopology;
      success = Boolean(successOrQuality);
      qualityScore = qualityArg;
    }
    this.recordOutcomeFor(tenantId, taskType, topology, success, qualityScore);
  }

  /**
   * Tenant-aware, unambiguous record API (preferred for P2 wiring).
   * Always uses the (tenantId, taskType, topology, success, q?) signature.
   */
  recordOutcomeFor(
    tenantId: string,
    taskType: string,
    topology: OrchestrationTopology,
    success: boolean,
    qualityScore?: number,
  ): void {
    const tid = this.resolveTenantId(tenantId);
    const key = this.keyOf(tid, taskType, topology);
    const cur = this.state.get(key) ?? {
      alpha: this.priorAlpha,
      beta: this.priorBeta,
      samples: 0,
      lastUpdated: Date.now(),
    };
    const q = qualityScore ?? 0.5; // neutral default; symmetric across success/failure
    const clampedQ = Math.max(0, Math.min(1, q));
    // Quality-weighted observation: range [0.5, 1.5].
    const weight = 0.5 + clampedQ;
    if (success) {
      cur.alpha += weight;
    } else {
      cur.beta += weight;
    }
    cur.samples += 1;
    cur.lastUpdated = Date.now();
    this.state.set(key, cur);

    const taskKey = this.taskKeyOf(tid, taskType);
    if (!this.tasks.has(taskKey)) this.tasks.set(taskKey, new Set());
    this.tasks.get(taskKey)!.add(topology);
  }

  /**
   * Thompson-sample one topology from the candidate set. Tenant-aware:
   * pass `tenantId` to scope the sampling to that tenant's posterior;
   * omit to use the per-instance default.
   */
  selectTopology(
    taskTypeOrTenantId: string,
    taskTypeOrCandidates: string | OrchestrationTopology[],
    candidatesOrUndefined?: OrchestrationTopology[],
  ): { selected: OrchestrationTopology | null; samples: PheromoneSample[] } {
    // Detect the signature: if args[1] is an array, it's the legacy
    // (taskType, candidates) form. Otherwise it's (tenantId, taskType, candidates).
    const isLegacy = Array.isArray(taskTypeOrCandidates);
    let tenantId: string;
    let taskType: string;
    let candidates: OrchestrationTopology[];
    if (isLegacy) {
      tenantId = this.defaultTenantId;
      taskType = taskTypeOrTenantId;
      candidates = taskTypeOrCandidates as OrchestrationTopology[];
    } else {
      tenantId = taskTypeOrTenantId || this.defaultTenantId;
      taskType = taskTypeOrCandidates as string;
      candidates = candidatesOrUndefined ?? [];
    }
    return this.selectTopologyFor(tenantId, taskType, candidates);
  }

  selectTopologyFor(
    tenantId: string,
    taskType: string,
    candidates: OrchestrationTopology[],
  ): { selected: OrchestrationTopology | null; samples: PheromoneSample[] } {
    if (candidates.length === 0) return { selected: null, samples: [] };
    const tid = this.resolveTenantId(tenantId);

    const samples: PheromoneSample[] = candidates.map((topology) => {
      const st = this.state.get(this.keyOf(tid, taskType, topology)) ?? {
        alpha: this.priorAlpha,
        beta: this.priorBeta,
        samples: 0,
        lastUpdated: 0,
      };
      return {
        topology,
        sample: this.sampleBeta(st.alpha, st.beta),
        expectedSuccess: st.alpha / (st.alpha + st.beta),
        alpha: st.alpha,
        beta: st.beta,
      };
    });

    // Gate: if every candidate has fewer than minSamples observations, refuse
    // to make a call. The caller can fall back to its heuristic.
    const anyMature = samples.some((s) => {
      const stored = this.state.get(this.keyOf(tid, taskType, s.topology));
      return (stored?.samples ?? 0) >= this.minSamplesBeforeBias;
    });
    if (!anyMature) return { selected: null, samples };

    let best = samples[0];
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].sample > best.sample) best = samples[i];
    }
    return { selected: best.topology, samples };
  }

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
  bias(
    taskTypeOrTenantId: string,
    taskTypeOrScores: string | Array<{ topology: OrchestrationTopology; score: number }>,
    scoresOrUndefined?: Array<{ topology: OrchestrationTopology; score: number }>,
  ): PheromoneBiasedScore[] {
    // Legacy P1: bias(taskType, scores) — args[1] is the array.
    // P1.1:      bias(tenantId, taskType, scores) — args[1] is a string.
    const isLegacy = Array.isArray(taskTypeOrScores);
    if (isLegacy) {
      return this.biasFor(this.defaultTenantId, taskTypeOrTenantId, taskTypeOrScores);
    }
    return this.biasFor(
      taskTypeOrTenantId || this.defaultTenantId,
      taskTypeOrScores as string,
      scoresOrUndefined ?? [],
    );
  }

  biasFor(
    tenantId: string,
    taskType: string,
    scores: Array<{ topology: OrchestrationTopology; score: number }>,
  ): PheromoneBiasedScore[] {
    const tid = this.resolveTenantId(tenantId);
    return scores.map((entry) => {
      const st = this.state.get(this.keyOf(tid, taskType, entry.topology));
      if (!st || st.samples < this.minSamplesBeforeBias) {
        const expected =
          (st?.alpha ?? this.priorAlpha) /
          ((st?.alpha ?? this.priorAlpha) + (st?.beta ?? this.priorBeta));
        return {
          topology: entry.topology,
          score: entry.score,
          pheromoneBias: 0,
          pheromoneSamples: st?.samples ?? 0,
          expectedSuccess: expected,
        };
      }
      const expected = st.alpha / (st.alpha + st.beta); // in (0, 1)
      // (expected - 0.5) ∈ (-0.5, 0.5). Scale by 4 → roughly (-2, 2) range.
      const rawBias = (expected - 0.5) * 4;
      const capped = Math.max(-this.maxBiasMagnitude, Math.min(this.maxBiasMagnitude, rawBias));
      return {
        topology: entry.topology,
        score: entry.score + capped,
        pheromoneBias: capped,
        pheromoneSamples: st.samples,
        expectedSuccess: expected,
      };
    });
  }

  /**
   * Estimated success probability (alpha / (alpha + beta)) for a triple.
   * Supports both legacy and tenant-aware signatures (same detector as
   * `recordOutcome`).
   */
  getConfidence(
    taskTypeOrTenantId: string,
    taskTypeOrTopology: string | OrchestrationTopology,
    topologyOrUndefined?: OrchestrationTopology,
  ): number {
    const isLegacy = arguments.length <= 2;
    let tenantId: string;
    let taskType: string;
    let topology: OrchestrationTopology;
    if (isLegacy) {
      tenantId = this.defaultTenantId;
      taskType = taskTypeOrTenantId;
      topology = taskTypeOrTopology as OrchestrationTopology;
    } else {
      tenantId = taskTypeOrTenantId || this.defaultTenantId;
      taskType = taskTypeOrTopology as string;
      topology = topologyOrUndefined as OrchestrationTopology;
    }
    return this.getConfidenceFor(tenantId, taskType, topology);
  }

  getConfidenceFor(tenantId: string, taskType: string, topology: OrchestrationTopology): number {
    const st = this.state.get(this.keyOf(this.resolveTenantId(tenantId), taskType, topology));
    if (!st) return 0.5; // uninformative prior
    return st.alpha / (st.alpha + st.beta);
  }

  /** Return all recorded states for observability / debugging. When
   *  `tenantId` is given, returns only that tenant's triples. */
  getStats(tenantId?: string): Array<{
    tenantId: string;
    taskType: string;
    topology: OrchestrationTopology;
    state: PheromoneState;
  }> {
    const out: Array<{
      tenantId: string;
      taskType: string;
      topology: OrchestrationTopology;
      state: PheromoneState;
    }> = [];
    const tid = tenantId === undefined ? undefined : this.resolveTenantId(tenantId);
    for (const [key, st] of this.state.entries()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      if (tid !== undefined && parsed.tenantId !== tid) continue;
      out.push({
        tenantId: parsed.tenantId,
        taskType: parsed.taskType,
        topology: parsed.topology,
        state: st,
      });
    }
    return out;
  }

  /** List all tenant ids that have at least one recorded triple. */
  listTenants(): string[] {
    const tenants = new Set<string>();
    for (const key of this.state.keys()) {
      const parsed = this.parseKey(key);
      if (parsed) tenants.add(parsed.tenantId);
    }
    return Array.from(tenants).sort();
  }

  /** Reset all state. When `tenantId` is given, only resets that tenant's
   *  triples; otherwise clears everything. */
  reset(tenantId?: string): void {
    if (tenantId === undefined) {
      this.state.clear();
      this.tasks.clear();
      return;
    }
    const tid = this.resolveTenantId(tenantId);
    const prefix = `${tid}::`;
    for (const key of Array.from(this.state.keys())) {
      if (key.startsWith(prefix)) this.state.delete(key);
    }
    const taskPrefix = `${tid}::`;
    for (const tk of Array.from(this.tasks.keys())) {
      if (tk.startsWith(taskPrefix)) this.tasks.delete(tk);
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

  private taskKeyOf(tenantId: string, taskType: string): string {
    return `${tenantId}::${taskType}`;
  }

  private parseKey(
    key: string,
  ): { tenantId: string; taskType: string; topology: OrchestrationTopology } | null {
    // Key format: `${tenantId}::${taskType}::${topology}` — the *first* "::"
    // separates tenant from the rest, and the *last* "::" separates
    // taskType from topology.
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

  /**
   * Sample from Beta(α, β) using the Marsaglia-Tsang gamma method.
   * Requires α, β ≥ 1, which we always satisfy because we initialize at
   * the prior (default 1) and only add to α/β on each observation.
   */
  private sampleBeta(alpha: number, beta: number): number {
    const g1 = this.sampleGamma(alpha);
    const g2 = this.sampleGamma(beta);
    const denom = g1 + g2;
    if (denom <= 0) return 0.5;
    return g1 / denom;
  }

  private sampleGamma(alpha: number): number {
    if (alpha < 1) {
      // Boost: G(α) = G(α+1) * U^(1/α) for α < 1
      return this.sampleGamma(alpha + 1) * Math.pow(this.rng(), 1 / alpha);
    }
    const d = alpha - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.randn();
      const v = Math.pow(1 + c * x, 3);
      if (v <= 0) continue;
      const u = this.rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /** Box-Muller standard-normal sample. */
  private randn(): number {
    const u1 = Math.max(this.rng(), 1e-12);
    const u2 = this.rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
