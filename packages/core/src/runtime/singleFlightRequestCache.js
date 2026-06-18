"use strict";
/**
 * Single-Flight Request Cache — Concurrent Deduplication for LLM Calls
 *
 * When multiple sub-agents, parallel tool paths, or sibling retries fire
 * identical LLM requests in the same millisecond, only ONE request
 * actually goes to the provider. The rest wait for that result and share
 * it. Standard "single-flight" pattern (Go's x/sync/singleflight) applied
 * to LLM traffic.
 *
 * Why this matters for cost:
 * - Parallel tool execution: 3 sibling tools fire identical planning
 *   calls → 1 paid call instead of 3
 * - Multi-agent topologies (PARALLEL, HIERARCHICAL, ENSEMBLE): N agents
 *   ask the same planning question → 1 paid call instead of N
 * - Reflexion: same failed step retried 3x with identical context →
 *   1 paid call instead of 3
 *
 * Key invariants:
 * - Per-tenant isolation: tenant A's request must NEVER dedupe with
 *   tenant B's (data leak + cache poisoning vector)
 * - In-flight only: dedupe WHILE a request is in flight. Once the
 *   primary completes, callers go to the regular semantic cache for any
 *   subsequent same-content request. Prevents stale results after the
 *   underlying context has changed.
 * - LRU eviction of in-flight entries (bounded memory)
 * - Failures are NOT cached: if the primary rejects, dedupe'd callers
 *   also reject and can retry via the LLM retry loop
 * - Config-gated: enabled by default (safe, low overhead); opt-out via
 *   `singleFlight.enabled = false`
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SingleFlightRequestCache = void 0;
// FNV-1a 32-bit hash, non-cryptographic. Constants are FNV-1a standard.
function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
}
class SingleFlightRequestCache {
    constructor(config) {
        this.inflight = new Map();
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
        this.monotonic = 0;
        this.config = { enabled: true, maxInFlight: 1000, ...config };
    }
    static computeKey(request, tenantId) {
        const canonical = {
            model: request.model,
            messages: request.messages,
            tools: request.tools,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            stop: request.stop,
            cacheConfig: request.cacheConfig,
            reasoningConfig: request.reasoningConfig,
        };
        const payload = tenantId
            ? `${tenantId}::${JSON.stringify(canonical)}`
            : `null::${JSON.stringify(canonical)}`;
        return fnv1a(payload);
    }
    async dedupe(key, factory, tenantId) {
        if (!this.config.enabled) {
            this.misses++;
            return factory();
        }
        const existing = this.inflight.get(key);
        if (existing) {
            this.hits++;
            return existing.promise;
        }
        if (this.inflight.size >= this.config.maxInFlight) {
            this.evictOldest();
        }
        this.misses++;
        const promise = factory().finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, {
            promise,
            startedAt: ++this.monotonic,
            tenantId,
        });
        return promise;
    }
    getStats() {
        const total = this.hits + this.misses;
        return {
            inflight: this.inflight.size,
            hits: this.hits,
            misses: this.misses,
            totalRequests: total,
            hitRate: total > 0 ? this.hits / total : 0,
            evictions: this.evictions,
        };
    }
    inflightCount() {
        return this.inflight.size;
    }
    clear() {
        this.inflight.clear();
    }
    resetStats() {
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
    }
    evictOldest() {
        let oldestKey;
        let oldestTime = Infinity;
        for (const [k, e] of this.inflight) {
            if (e.startedAt < oldestTime) {
                oldestTime = e.startedAt;
                oldestKey = k;
            }
        }
        if (oldestKey) {
            this.inflight.delete(oldestKey);
            this.evictions++;
        }
    }
}
exports.SingleFlightRequestCache = SingleFlightRequestCache;
