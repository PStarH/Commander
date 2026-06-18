/**
 * Tool Result Cache — Content-Hash Based Caching
 *
 * Unique innovation: no competitor (Codex, Claude Code, OpenCode, OpenClaw, Hermes)
 * caches tool results. Deterministic tool calls (same name + same args) produce the
 * same hash and return cached results without re-execution.
 *
 * Key design decisions:
 * - Content-hash based: FNV-1a of (toolName + sortedArgs) → cache key
 * - TTL-based expiry: configurable per-tool, default 5 minutes
 * - LRU eviction: bounded memory with configurable max entries
 * - Selective caching: tools opt-in via `isCacheable` flag; side-effect tools excluded
 * - Token savings: cached results skip execution AND reduce context rebuilds
 */
import type { ToolCall, ToolResult } from './types';
export interface ToolCacheStats {
    totalEntries: number;
    totalHits: number;
    totalMisses: number;
    hitRate: number;
    evictions: number;
    memoryEstimateBytes: number;
}
export interface ToolCacheConfig {
    /** Enable caching (default: false — opt-in) */
    enabled: boolean;
    /** Maximum cache entries before LRU eviction (default: 256) */
    maxEntries: number;
    /** Default TTL in ms (default: 300_000 = 5 minutes) */
    defaultTtlMs: number;
    /** Per-tool TTL overrides */
    toolTtls: Record<string, number>;
    /** Tools that should NEVER be cached (side-effects, state-mutating) */
    neverCache: string[];
    /** Scan tool outputs for security threats before caching (default: true) */
    securityScanEnabled?: boolean;
}
export declare class ToolResultCache {
    private cache;
    private config;
    private stats;
    private pruneTimer;
    private accessCounter;
    private neverCacheSet;
    private neverCachePrefixes;
    private memoryEstimateBytes;
    constructor(config?: Partial<ToolCacheConfig>);
    private buildNeverCacheIndex;
    /**
     * Generate a deterministic cache key from tool name and arguments.
     * Uses FNV-1a hash for speed (non-cryptographic, sufficient for cache keys).
     * When tenantId is provided, it's prepended to isolate caches per tenant.
     */
    static computeKey(toolName: string, args: Record<string, unknown>, tenantId?: string): string;
    /**
     * Fast canonical JSON: sort top-level keys only (not deeply nested).
     * Deep sorting was too expensive for a cache hot-path; top-level is sufficient
     * for deterministic ordering since tool args are typically flat objects.
     */
    private static fastCanonicalize;
    /**
     * Check if a tool call result is in cache and still valid.
     * When tenantId is provided, cache lookup is scoped to that tenant.
     */
    get(toolCall: ToolCall, tenantId?: string): ToolResult | undefined;
    /**
     * Store a tool result in cache.
     * Only caches if: enabled, tool is cacheable, result has no error, and output passes
     * the security scan when enabled.
     * When tenantId is provided, cache is scoped to that tenant.
     *
     * Note: the cache entry is inserted synchronously so that callers (including tests
     * and legacy code paths) can rely on an immediate `get` hit. A best-effort async
     * security scan runs in the background and evicts the entry if HIGH/CRITICAL
     * threats are found.
     */
    set(toolCall: ToolCall, result: ToolResult, tenantId?: string): void;
    /**
     * Invalidate cache entries for a specific tool.
     * Useful when a tool's state changes (e.g., file was written).
     */
    invalidateTool(toolName: string): number;
    /**
     * Invalidate all entries matching a pattern.
     * Supports prefix matching: "file_*" invalidates file_read, file_write, etc.
     */
    invalidatePattern(pattern: string): number;
    /**
     * Clear all cached entries.
     */
    clear(): void;
    /** Stop the auto-prune timer. Call when shutting down. */
    dispose(): void;
    /**
     * Get cache statistics.
     */
    getStats(): ToolCacheStats;
    /**
     * Prune expired entries. Call periodically to reclaim memory.
     */
    prune(): number;
    /**
     * Check if a tool should never be cached. Uses precomputed Set + prefix array for O(1) lookup.
     */
    private isNeverCache;
    /**
     * Evict the least recently used entry.
     */
    private evictLRU;
}
//# sourceMappingURL=toolResultCache.d.ts.map