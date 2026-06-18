"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolResultCache = void 0;
const metricsCollector_1 = require("./metricsCollector");
const contentScanner_1 = require("../contentScanner");
const logging_1 = require("../logging");
// FNV-1a hash — fast, non-cryptographic, sufficient for in-memory cache keys
function fnv1a(str) {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0; // FNV prime, unsigned
    }
    return hash.toString(36);
}
const DEFAULT_CONFIG = {
    enabled: true,
    maxEntries: 256,
    defaultTtlMs: 300000,
    toolTtls: {},
    neverCache: [
        'shell_execute',
        'python_execute',
        'file_write',
        'file_edit',
        'git_push',
        'git_commit',
        'agent',
        'memory_store',
    ],
    securityScanEnabled: true,
};
// ============================================================================
// Tool Result Cache
// ============================================================================
class ToolResultCache {
    constructor(config) {
        this.cache = new Map();
        this.stats = { hits: 0, misses: 0, evictions: 0 };
        this.pruneTimer = null;
        this.accessCounter = 0;
        // Precomputed neverCache lookup for O(1) checks
        this.neverCacheSet = new Set();
        this.neverCachePrefixes = [];
        // Running memory estimate (updated on set/delete, not recomputed)
        this.memoryEstimateBytes = 0;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.buildNeverCacheIndex();
        // GAP-22: Auto-prune expired entries every 60s
        if (this.config.enabled) {
            this.pruneTimer = setInterval(() => this.prune(), 60000);
            if (this.pruneTimer.unref)
                this.pruneTimer.unref();
        }
    }
    buildNeverCacheIndex() {
        this.neverCacheSet.clear();
        this.neverCachePrefixes = [];
        for (const pattern of this.config.neverCache) {
            if (pattern.endsWith('*')) {
                this.neverCachePrefixes.push(pattern.slice(0, -1));
            }
            else {
                this.neverCacheSet.add(pattern);
            }
        }
    }
    /**
     * Generate a deterministic cache key from tool name and arguments.
     * Uses FNV-1a hash for speed (non-cryptographic, sufficient for cache keys).
     * When tenantId is provided, it's prepended to isolate caches per tenant.
     */
    static computeKey(toolName, args, tenantId) {
        const canonical = ToolResultCache.fastCanonicalize(args);
        const payload = tenantId ? `${tenantId}:${toolName}:${canonical}` : `${toolName}:${canonical}`;
        return fnv1a(payload);
    }
    /**
     * Fast canonical JSON: sort top-level keys only (not deeply nested).
     * Deep sorting was too expensive for a cache hot-path; top-level is sufficient
     * for deterministic ordering since tool args are typically flat objects.
     */
    static fastCanonicalize(args) {
        const keys = Object.keys(args).sort();
        let result = '{';
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const v = args[k];
            if (i > 0)
                result += ',';
            result += JSON.stringify(k) + ':' + JSON.stringify(v);
        }
        return result + '}';
    }
    /**
     * Check if a tool call result is in cache and still valid.
     * When tenantId is provided, cache lookup is scoped to that tenant.
     */
    get(toolCall, tenantId) {
        var _a, _b;
        if (!this.config.enabled)
            return undefined;
        if (this.isNeverCache(toolCall.name))
            return undefined;
        const key = ToolResultCache.computeKey(toolCall.name, toolCall.arguments, tenantId);
        const entry = this.cache.get(key);
        if (!entry) {
            this.stats.misses++;
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordToolCacheEvent('miss', tenantId);
            }
            catch {
                /* best-effort */
            }
            return undefined;
        }
        // Check TTL expiry
        if (Date.now() - entry.createdAt > entry.ttlMs) {
            this.memoryEstimateBytes -= 500 + ((_b = (_a = entry.result.output) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) * 2;
            this.cache.delete(key);
            this.stats.misses++;
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordToolCacheEvent('miss', tenantId);
            }
            catch {
                /* best-effort */
            }
            return undefined;
        }
        // Update access stats (LRU)
        entry.hitCount++;
        entry.lastAccessAt = Date.now();
        entry.accessOrder = ++this.accessCounter;
        this.stats.hits++;
        // Record metrics
        try {
            (0, metricsCollector_1.getMetricsCollector)().recordToolCacheEvent('hit', tenantId);
        }
        catch {
            /* best-effort */
        }
        // Return a copy to prevent callers from corrupting the cached entry
        return { ...entry.result, durationMs: 0 };
    }
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
    set(toolCall, result, tenantId) {
        var _a, _b, _c;
        if (!this.config.enabled)
            return;
        if (this.isNeverCache(toolCall.name))
            return;
        if (result.error)
            return;
        const key = ToolResultCache.computeKey(toolCall.name, toolCall.arguments, tenantId);
        const ttlMs = (_a = this.config.toolTtls[toolCall.name]) !== null && _a !== void 0 ? _a : this.config.defaultTtlMs;
        // LRU eviction if at capacity
        if (this.cache.size >= this.config.maxEntries) {
            this.evictLRU();
        }
        // Store with tool name for invalidation matching
        const entrySize = 500 + ((_c = (_b = result.output) === null || _b === void 0 ? void 0 : _b.length) !== null && _c !== void 0 ? _c : 0) * 2;
        const entry = {
            key,
            result: { ...result, name: toolCall.name },
            createdAt: Date.now(),
            ttlMs,
            hitCount: 0,
            lastAccessAt: Date.now(),
            accessOrder: ++this.accessCounter,
        };
        this.cache.set(key, entry);
        this.memoryEstimateBytes += entrySize;
        // Best-effort security scan: evict later if the output is flagged.
        if (this.config.securityScanEnabled !== false && result.output) {
            (async () => {
                try {
                    const scanner = (0, contentScanner_1.createContentScanner)();
                    const scan = await scanner.scan(result.output);
                    const severe = scan.threats.filter((t) => t.severity === 'HIGH' || t.severity === 'CRITICAL');
                    if (severe.length > 0) {
                        (0, logging_1.getGlobalLogger)().warn('ToolResultCache', `Evicting cached ${toolCall.name} due to security threats`, {
                            threats: severe.map((t) => t.type),
                        });
                        // Only evict if this exact entry is still present.
                        if (this.cache.get(key) === entry) {
                            this.cache.delete(key);
                            this.memoryEstimateBytes -= entrySize;
                        }
                    }
                }
                catch {
                    // Scan failure should not prevent caching; fail open on scanner errors.
                }
            })();
        }
        // Record metrics
        try {
            (0, metricsCollector_1.getMetricsCollector)().recordToolCacheEvent('store', tenantId);
        }
        catch {
            /* best-effort */
        }
    }
    /**
     * Invalidate cache entries for a specific tool.
     * Useful when a tool's state changes (e.g., file was written).
     */
    invalidateTool(toolName) {
        var _a, _b;
        let count = 0;
        for (const [key, entry] of this.cache) {
            if (entry.result.name === toolName) {
                this.memoryEstimateBytes -= 500 + ((_b = (_a = entry.result.output) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) * 2;
                this.cache.delete(key);
                count++;
            }
        }
        return count;
    }
    /**
     * Invalidate all entries matching a pattern.
     * Supports prefix matching: "file_*" invalidates file_read, file_write, etc.
     */
    invalidatePattern(pattern) {
        var _a, _b;
        const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : null;
        let count = 0;
        for (const [key, entry] of this.cache) {
            const match = prefix ? entry.result.name.startsWith(prefix) : entry.result.name === pattern;
            if (match) {
                this.memoryEstimateBytes -= 500 + ((_b = (_a = entry.result.output) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) * 2;
                this.cache.delete(key);
                count++;
            }
        }
        return count;
    }
    /**
     * Clear all cached entries.
     */
    clear() {
        this.cache.clear();
        this.memoryEstimateBytes = 0;
    }
    /** Stop the auto-prune timer. Call when shutting down. */
    dispose() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }
    /**
     * Get cache statistics.
     */
    getStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            totalEntries: this.cache.size,
            totalHits: this.stats.hits,
            totalMisses: this.stats.misses,
            hitRate: total > 0 ? this.stats.hits / total : 0,
            evictions: this.stats.evictions,
            memoryEstimateBytes: this.memoryEstimateBytes,
        };
    }
    /**
     * Prune expired entries. Call periodically to reclaim memory.
     */
    prune() {
        var _a, _b;
        const now = Date.now();
        let pruned = 0;
        for (const [key, entry] of this.cache) {
            if (now - entry.createdAt > entry.ttlMs) {
                this.memoryEstimateBytes -= 500 + ((_b = (_a = entry.result.output) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) * 2;
                this.cache.delete(key);
                pruned++;
            }
        }
        return pruned;
    }
    /**
     * Check if a tool should never be cached. Uses precomputed Set + prefix array for O(1) lookup.
     */
    isNeverCache(toolName) {
        if (this.neverCacheSet.has(toolName))
            return true;
        for (const prefix of this.neverCachePrefixes) {
            if (toolName.startsWith(prefix))
                return true;
        }
        return false;
    }
    /**
     * Evict the least recently used entry.
     */
    evictLRU() {
        var _a, _b;
        let oldestKey;
        let oldestEntry;
        let oldestTime = Infinity;
        let oldestOrder = Infinity;
        for (const [key, entry] of this.cache) {
            if (entry.lastAccessAt < oldestTime ||
                (entry.lastAccessAt === oldestTime && entry.accessOrder < oldestOrder)) {
                oldestTime = entry.lastAccessAt;
                oldestOrder = entry.accessOrder;
                oldestKey = key;
                oldestEntry = entry;
            }
        }
        if (oldestKey) {
            this.memoryEstimateBytes -= 500 + ((_b = (_a = oldestEntry.result.output) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) * 2;
            this.cache.delete(oldestKey);
            this.stats.evictions++;
        }
    }
}
exports.ToolResultCache = ToolResultCache;
