"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PheromoneRouter = exports.DEFAULT_TENANT_ID = void 0;
/** Sentinel tenant id used when no tenant is specified. Single-tenant
 *  deployments and un-scoped test traffic all land in this bucket. */
exports.DEFAULT_TENANT_ID = '__default__';
/**
 * PheromoneRouter: per-(tenant, taskType, topology) Beta posterior with
 * Thompson sampling. See file header for design notes.
 */
class PheromoneRouter {
    constructor(options = {}) {
        var _a, _b, _c, _d, _e, _f;
        /** Keyed by `${tenantId}::${taskType}::${topology}`. */
        this.state = new Map();
        /** Per-tenant set of (taskType, topology) pairs, for clean cleanup / introspection. */
        this.tasks = new Map();
        this.priorAlpha = (_a = options.priorAlpha) !== null && _a !== void 0 ? _a : 1;
        this.priorBeta = (_b = options.priorBeta) !== null && _b !== void 0 ? _b : 1;
        this.minSamplesBeforeBias = (_c = options.minSamplesBeforeBias) !== null && _c !== void 0 ? _c : 3;
        this.maxBiasMagnitude = (_d = options.maxBiasMagnitude) !== null && _d !== void 0 ? _d : 1.0;
        this.rng = (_e = options.rng) !== null && _e !== void 0 ? _e : Math.random;
        this.defaultTenantId = (_f = options.defaultTenantId) !== null && _f !== void 0 ? _f : exports.DEFAULT_TENANT_ID;
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
    recordOutcome(taskTypeOrTenantId, taskTypeOrTopology, topologyOrSuccess, successOrQuality, qualityArg) {
        // Detect the signature by checking if args[2] is a boolean (legacy)
        // or an OrchestrationTopology (tenant-aware). When args[2] is a
        // boolean the call is legacy P1; otherwise it's tenant-aware.
        const isLegacy = typeof topologyOrSuccess === 'boolean';
        let tenantId;
        let taskType;
        let topology;
        let success;
        let qualityScore;
        if (isLegacy) {
            tenantId = this.defaultTenantId;
            taskType = taskTypeOrTenantId;
            topology = taskTypeOrTopology;
            success = topologyOrSuccess;
            qualityScore = typeof successOrQuality === 'number' ? successOrQuality : undefined;
        }
        else {
            tenantId = taskTypeOrTenantId || this.defaultTenantId;
            taskType = taskTypeOrTopology;
            topology = topologyOrSuccess;
            success = Boolean(successOrQuality);
            qualityScore = qualityArg;
        }
        this.recordOutcomeFor(tenantId, taskType, topology, success, qualityScore);
    }
    /**
     * Tenant-aware, unambiguous record API (preferred for P2 wiring).
     * Always uses the (tenantId, taskType, topology, success, q?) signature.
     */
    recordOutcomeFor(tenantId, taskType, topology, success, qualityScore) {
        var _a;
        const tid = this.resolveTenantId(tenantId);
        const key = this.keyOf(tid, taskType, topology);
        const cur = (_a = this.state.get(key)) !== null && _a !== void 0 ? _a : {
            alpha: this.priorAlpha,
            beta: this.priorBeta,
            samples: 0,
            lastUpdated: Date.now(),
        };
        const q = qualityScore !== null && qualityScore !== void 0 ? qualityScore : 0.5; // neutral default; symmetric across success/failure
        const clampedQ = Math.max(0, Math.min(1, q));
        // Quality-weighted observation: range [0.5, 1.5].
        const weight = 0.5 + clampedQ;
        if (success) {
            cur.alpha += weight;
        }
        else {
            cur.beta += weight;
        }
        cur.samples += 1;
        cur.lastUpdated = Date.now();
        this.state.set(key, cur);
        const taskKey = this.taskKeyOf(tid, taskType);
        if (!this.tasks.has(taskKey))
            this.tasks.set(taskKey, new Set());
        this.tasks.get(taskKey).add(topology);
    }
    /**
     * Thompson-sample one topology from the candidate set. Tenant-aware:
     * pass `tenantId` to scope the sampling to that tenant's posterior;
     * omit to use the per-instance default.
     */
    selectTopology(taskTypeOrTenantId, taskTypeOrCandidates, candidatesOrUndefined) {
        // Detect the signature: if args[1] is an array, it's the legacy
        // (taskType, candidates) form. Otherwise it's (tenantId, taskType, candidates).
        const isLegacy = Array.isArray(taskTypeOrCandidates);
        let tenantId;
        let taskType;
        let candidates;
        if (isLegacy) {
            tenantId = this.defaultTenantId;
            taskType = taskTypeOrTenantId;
            candidates = taskTypeOrCandidates;
        }
        else {
            tenantId = taskTypeOrTenantId || this.defaultTenantId;
            taskType = taskTypeOrCandidates;
            candidates = candidatesOrUndefined !== null && candidatesOrUndefined !== void 0 ? candidatesOrUndefined : [];
        }
        return this.selectTopologyFor(tenantId, taskType, candidates);
    }
    selectTopologyFor(tenantId, taskType, candidates) {
        if (candidates.length === 0)
            return { selected: null, samples: [] };
        const tid = this.resolveTenantId(tenantId);
        const samples = candidates.map((topology) => {
            var _a;
            const st = (_a = this.state.get(this.keyOf(tid, taskType, topology))) !== null && _a !== void 0 ? _a : {
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
            var _a;
            const stored = this.state.get(this.keyOf(tid, taskType, s.topology));
            return ((_a = stored === null || stored === void 0 ? void 0 : stored.samples) !== null && _a !== void 0 ? _a : 0) >= this.minSamplesBeforeBias;
        });
        if (!anyMature)
            return { selected: null, samples };
        let best = samples[0];
        for (let i = 1; i < samples.length; i++) {
            if (samples[i].sample > best.sample)
                best = samples[i];
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
    bias(taskTypeOrTenantId, taskTypeOrScores, scoresOrUndefined) {
        // Legacy P1: bias(taskType, scores) — args[1] is the array.
        // P1.1:      bias(tenantId, taskType, scores) — args[1] is a string.
        const isLegacy = Array.isArray(taskTypeOrScores);
        if (isLegacy) {
            return this.biasFor(this.defaultTenantId, taskTypeOrTenantId, taskTypeOrScores);
        }
        return this.biasFor(taskTypeOrTenantId || this.defaultTenantId, taskTypeOrScores, scoresOrUndefined !== null && scoresOrUndefined !== void 0 ? scoresOrUndefined : []);
    }
    biasFor(tenantId, taskType, scores) {
        const tid = this.resolveTenantId(tenantId);
        return scores.map((entry) => {
            var _a, _b, _c, _d;
            const st = this.state.get(this.keyOf(tid, taskType, entry.topology));
            if (!st || st.samples < this.minSamplesBeforeBias) {
                const expected = ((_a = st === null || st === void 0 ? void 0 : st.alpha) !== null && _a !== void 0 ? _a : this.priorAlpha) /
                    (((_b = st === null || st === void 0 ? void 0 : st.alpha) !== null && _b !== void 0 ? _b : this.priorAlpha) + ((_c = st === null || st === void 0 ? void 0 : st.beta) !== null && _c !== void 0 ? _c : this.priorBeta));
                return {
                    topology: entry.topology,
                    score: entry.score,
                    pheromoneBias: 0,
                    pheromoneSamples: (_d = st === null || st === void 0 ? void 0 : st.samples) !== null && _d !== void 0 ? _d : 0,
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
    getConfidence(taskTypeOrTenantId, taskTypeOrTopology, topologyOrUndefined) {
        const isLegacy = arguments.length <= 2;
        let tenantId;
        let taskType;
        let topology;
        if (isLegacy) {
            tenantId = this.defaultTenantId;
            taskType = taskTypeOrTenantId;
            topology = taskTypeOrTopology;
        }
        else {
            tenantId = taskTypeOrTenantId || this.defaultTenantId;
            taskType = taskTypeOrTopology;
            topology = topologyOrUndefined;
        }
        return this.getConfidenceFor(tenantId, taskType, topology);
    }
    getConfidenceFor(tenantId, taskType, topology) {
        const st = this.state.get(this.keyOf(this.resolveTenantId(tenantId), taskType, topology));
        if (!st)
            return 0.5; // uninformative prior
        return st.alpha / (st.alpha + st.beta);
    }
    /** Return all recorded states for observability / debugging. When
     *  `tenantId` is given, returns only that tenant's triples. */
    getStats(tenantId) {
        const out = [];
        const tid = tenantId === undefined ? undefined : this.resolveTenantId(tenantId);
        for (const [key, st] of this.state.entries()) {
            const parsed = this.parseKey(key);
            if (!parsed)
                continue;
            if (tid !== undefined && parsed.tenantId !== tid)
                continue;
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
    listTenants() {
        const tenants = new Set();
        for (const key of this.state.keys()) {
            const parsed = this.parseKey(key);
            if (parsed)
                tenants.add(parsed.tenantId);
        }
        return Array.from(tenants).sort();
    }
    /** Reset all state. When `tenantId` is given, only resets that tenant's
     *  triples; otherwise clears everything. */
    reset(tenantId) {
        if (tenantId === undefined) {
            this.state.clear();
            this.tasks.clear();
            return;
        }
        const tid = this.resolveTenantId(tenantId);
        const prefix = `${tid}::`;
        for (const key of Array.from(this.state.keys())) {
            if (key.startsWith(prefix))
                this.state.delete(key);
        }
        const taskPrefix = `${tid}::`;
        for (const tk of Array.from(this.tasks.keys())) {
            if (tk.startsWith(taskPrefix))
                this.tasks.delete(tk);
        }
    }
    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------
    resolveTenantId(tenantId) {
        if (tenantId && tenantId.length > 0)
            return tenantId;
        return this.defaultTenantId;
    }
    keyOf(tenantId, taskType, topology) {
        return `${tenantId}::${taskType}::${topology}`;
    }
    taskKeyOf(tenantId, taskType) {
        return `${tenantId}::${taskType}`;
    }
    parseKey(key) {
        // Key format: `${tenantId}::${taskType}::${topology}` — the *first* "::"
        // separates tenant from the rest, and the *last* "::" separates
        // taskType from topology.
        const first = key.indexOf('::');
        if (first < 0)
            return null;
        const second = key.indexOf('::', first + 2);
        if (second < 0)
            return null;
        return {
            tenantId: key.slice(0, first),
            taskType: key.slice(first + 2, second),
            topology: key.slice(second + 2),
        };
    }
    /**
     * Sample from Beta(α, β) using the Marsaglia-Tsang gamma method.
     * Requires α, β ≥ 1, which we always satisfy because we initialize at
     * the prior (default 1) and only add to α/β on each observation.
     */
    sampleBeta(alpha, beta) {
        const g1 = this.sampleGamma(alpha);
        const g2 = this.sampleGamma(beta);
        const denom = g1 + g2;
        if (denom <= 0)
            return 0.5;
        return g1 / denom;
    }
    sampleGamma(alpha) {
        if (alpha < 1) {
            // Boost: G(α) = G(α+1) * U^(1/α) for α < 1
            return this.sampleGamma(alpha + 1) * Math.pow(this.rng(), 1 / alpha);
        }
        const d = alpha - 1 / 3;
        const c = 1 / Math.sqrt(9 * d);
        for (;;) {
            const x = this.randn();
            const v = Math.pow(1 + c * x, 3);
            if (v <= 0)
                continue;
            const u = this.rng();
            if (u < 1 - 0.0331 * x * x * x * x)
                return d * v;
            if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
                return d * v;
        }
    }
    /** Box-Muller standard-normal sample. */
    randn() {
        const u1 = Math.max(this.rng(), 1e-12);
        const u2 = this.rng();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
}
exports.PheromoneRouter = PheromoneRouter;
