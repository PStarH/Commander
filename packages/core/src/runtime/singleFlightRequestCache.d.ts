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
import type { LLMRequest, LLMResponse } from './types';
export interface SingleFlightStats {
    inflight: number;
    hits: number;
    misses: number;
    totalRequests: number;
    hitRate: number;
    evictions: number;
}
export interface SingleFlightConfig {
    enabled: boolean;
    maxInFlight: number;
}
export declare class SingleFlightRequestCache {
    private inflight;
    private config;
    private hits;
    private misses;
    private evictions;
    private monotonic;
    constructor(config?: Partial<SingleFlightConfig>);
    static computeKey(request: LLMRequest, tenantId?: string): string;
    dedupe(key: string, factory: () => Promise<LLMResponse>, tenantId?: string): Promise<LLMResponse>;
    getStats(): SingleFlightStats;
    inflightCount(): number;
    clear(): void;
    resetStats(): void;
    private evictOldest;
}
//# sourceMappingURL=singleFlightRequestCache.d.ts.map