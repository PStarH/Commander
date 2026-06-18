/**
 * Gemini Cached Content Manager
 *
 * Manages Google's Gemini `cachedContent` resource lifecycle for the Gemini API.
 * The cachedContent API lets you upload a large system prompt + tool definitions
 * once, get back a `name` (e.g. "cachedContents/abc123"), and then reference that
 * name in subsequent `:generateContent` calls. Gemini bills cached tokens at 90%
 * discount when the cached payload exceeds 4096 tokens.
 *
 * References:
 * - https://ai.google.dev/api/caching
 * - https://ai.google.dev/gemini-api/docs/caching
 *
 * Key design decisions (mirrors singleFlightRequestCache.ts and toolResultCache.ts):
 * - Content-hash based: FNV-1a of (systemInstruction + tools + model) → cache key
 * - Single-flight create: concurrent calls for the same key share one POST to /cachedContents
 * - LRU eviction: bounded memory with configurable max entries (oldest name dropped, NOT the
 *   server-side resource — the server enforces its own TTL via the `ttl` field we send at create)
 * - Failures not cached: a failed `create` rejects all waiters; they can retry fresh
 * - Per-tenant isolation: tenant A and tenant B with identical systems get different keys
 * - Health-check on hit: even if we have a cached name, we trust the server's TTL. We do NOT
 *   call `:getCachedContent` on every read (would defeat the latency savings). The provider
 *   will return an error if the resource has expired/been pruned; we evict on that signal.
 */
import type { ToolDefinition } from './types';
/**
 * Status of a cached content lookup / create operation.
 * - hit: a cached name was already present for the key
 * - create: a new cached content resource was successfully created
 * - evict: a stale entry was evicted (either LRU cap, or server returned expired)
 * - error: the create call failed (network, 4xx, 5xx)
 */
export type GeminiCacheOutcome = 'hit' | 'create' | 'evict' | 'error';
/**
 * Stats snapshot for the Gemini cache manager.
 */
export interface GeminiCacheStats {
    totalEntries: number;
    totalHits: number;
    totalCreates: number;
    totalEvictions: number;
    totalErrors: number;
    /** hitRate in [0,1]. */
    hitRate: number;
    /** Pending in-flight create operations (currently waiting on a network call). */
    inflight: number;
}
/**
 * Configuration for the Gemini cached content manager.
 * - enabled: when false, getOrCreate is a no-op (returns undefined, no network call)
 * - maxEntries: LRU cap; default 100 (each entry is just a string name + small metadata, low cost)
 * - defaultTtlSeconds: TTL to send to Gemini on create; default 300s (5m). Max is 86400 (24h).
 *   The 1h option matches Anthropic's 1h TTL. 5m is the cheap default.
 * - fetchTimeoutMs: per-create request timeout; default 30s
 */
export interface GeminiCacheManagerConfig {
    enabled?: boolean;
    maxEntries?: number;
    defaultTtlSeconds?: number;
    fetchTimeoutMs?: number;
}
/**
 * The content hash result returned to callers so they can build stable request-level keys.
 */
export interface GeminiCacheLookup {
    /** FNV-1a hash of (systemInstruction + tools + model) for the current request. */
    contentHash: string;
    /** Server-side cached content name (e.g. "cachedContents/abc123"). Undefined if not cached. */
    cachedContentName?: string;
    /** True iff this lookup resulted in a create (not a hit). */
    createdNow: boolean;
}
/**
 * Manages Gemini cachedContent resource lifecycle.
 *
 * The create flow:
 *   1. Caller invokes getOrCreate({ systemInstruction, tools, model, apiKey, baseUrl, tenantId })
 *   2. We compute a stable content hash from (system + tools + model), scoped by tenant
 *   3. If we have a fresh name for that hash, return it (hit)
 *   4. If a create is already in flight for that hash, return its shared promise (single-flight)
 *   5. Otherwise: POST to /cachedContents with model, systemInstruction, tools, ttl
 *   6. Store the returned name. Evict the LRU entry if we're at maxEntries.
 *
 * In-flight operations are stored separately from the resolved cache so that:
 * - New callers during a create share the same network call (single-flight)
 * - Once the create resolves, callers transition to the resolved cache
 * - If the create fails, the in-flight entry is removed so callers can retry
 */
export declare class GeminiCacheManager {
    private readonly enabled;
    private readonly maxEntries;
    private readonly defaultTtlSeconds;
    private readonly fetchTimeoutMs;
    /** Resolved cache: contentHash → { name, contentHash, model, createdAt, accessOrder } */
    private cache;
    /** In-flight create operations: contentHash → Promise<name> */
    private inflight;
    /** LRU monotonic counter. */
    private accessCounter;
    /** Stats counters. */
    private stats;
    constructor(config?: GeminiCacheManagerConfig);
    /**
     * Compute the content hash for a request. Exposed statically so callers can use the same
     * hash as a key when reporting metrics or when building a stable `cacheConfig.promptCacheKey`.
     */
    static computeContentHash(systemInstruction: string | undefined, tools: ToolDefinition[] | undefined, model: string): string;
    /**
     * Get a cached content name, creating one if needed. Returns undefined if disabled.
     *
     * Per-tenant scoping: tenantId is mixed into the hash so two tenants with the same system
     * prompt do not share cached content (and cannot leak cached responses across tenants).
     */
    getOrCreate(params: {
        systemInstruction: string | undefined;
        tools: ToolDefinition[] | undefined;
        model: string;
        apiKey: string;
        baseUrl?: string;
        ttlSeconds?: number;
        tenantId?: string;
    }): Promise<GeminiCacheLookup>;
    /**
     * Mark a cached content as expired/evicted by the server. Used by the provider when
     * Gemini returns a 404 or `NOT_FOUND` indicating the resource has been pruned.
     * Removes the entry from the local cache. Does NOT call deleteCachedContent
     * (the server already pruned it).
     */
    evictByName(name: string): boolean;
    /**
     * Snapshot of current stats. Cheap to call (no copies of cache contents).
     */
    getStats(): GeminiCacheStats;
    /**
     * Reset all in-memory state. For tests and for tenant eviction.
     */
    reset(): void;
    /**
     * POST to /v1beta/cachedContents and return the resource name.
     * Throws on non-2xx, network failure, or timeout.
     */
    private createCachedContent;
    /**
     * Store a resolved entry. Evicts the oldest LRU entry if at the cap.
     */
    private storeEntry;
}
//# sourceMappingURL=geminiCacheManager.d.ts.map