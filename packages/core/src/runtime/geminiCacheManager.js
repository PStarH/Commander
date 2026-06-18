"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiCacheManager = void 0;
// FNV-1a hash — same as toolResultCache.ts and singleFlightRequestCache.ts
function fnv1a(str) {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0; // FNV prime, unsigned
    }
    return hash.toString(36);
}
// ============================================================================
// GeminiCacheManager
// ============================================================================
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
class GeminiCacheManager {
    constructor(config = {}) {
        var _a, _b, _c, _d;
        /** Resolved cache: contentHash → { name, contentHash, model, createdAt, accessOrder } */
        this.cache = new Map();
        /** In-flight create operations: contentHash → Promise<name> */
        this.inflight = new Map();
        /** LRU monotonic counter. */
        this.accessCounter = 0;
        /** Stats counters. */
        this.stats = {
            hits: 0,
            creates: 0,
            evictions: 0,
            errors: 0,
        };
        this.enabled = (_a = config.enabled) !== null && _a !== void 0 ? _a : true;
        this.maxEntries = (_b = config.maxEntries) !== null && _b !== void 0 ? _b : 100;
        this.defaultTtlSeconds = (_c = config.defaultTtlSeconds) !== null && _c !== void 0 ? _c : 300;
        this.fetchTimeoutMs = (_d = config.fetchTimeoutMs) !== null && _d !== void 0 ? _d : 30000;
    }
    /**
     * Compute the content hash for a request. Exposed statically so callers can use the same
     * hash as a key when reporting metrics or when building a stable `cacheConfig.promptCacheKey`.
     */
    static computeContentHash(systemInstruction, tools, model) {
        const toolsJson = tools ? stableStringify(tools) : '[]';
        return fnv1a(`${model}::${systemInstruction !== null && systemInstruction !== void 0 ? systemInstruction : ''}::${toolsJson}`);
    }
    /**
     * Get a cached content name, creating one if needed. Returns undefined if disabled.
     *
     * Per-tenant scoping: tenantId is mixed into the hash so two tenants with the same system
     * prompt do not share cached content (and cannot leak cached responses across tenants).
     */
    async getOrCreate(params) {
        var _a, _b;
        if (!this.enabled) {
            return { contentHash: '', createdNow: false };
        }
        const baseHash = GeminiCacheManager.computeContentHash(params.systemInstruction, params.tools, params.model);
        const contentHash = params.tenantId ? fnv1a(`${params.tenantId}::${baseHash}`) : baseHash;
        // Hit path: look up the resolved cache
        const existing = this.cache.get(contentHash);
        if (existing) {
            existing.accessOrder = ++this.accessCounter;
            this.stats.hits++;
            return { contentHash, cachedContentName: existing.name, createdNow: false };
        }
        // Miss path: check if a create is already in flight
        const inflightPromise = this.inflight.get(contentHash);
        if (inflightPromise) {
            try {
                const name = await inflightPromise;
                // The original creator bumps stats; we count a separate hit for the waiter
                this.stats.hits++;
                return { contentHash, cachedContentName: name, createdNow: false };
            }
            catch {
                // In-flight create failed; surface the same error
                this.stats.errors++;
                throw new Error(`Gemini cached content create failed for hash ${contentHash}`);
            }
        }
        // Cold path: kick off a new create, store it as in-flight, then resolve into cache
        const baseUrl = (_a = params.baseUrl) !== null && _a !== void 0 ? _a : 'https://generativelanguage.googleapis.com/v1beta';
        const ttl = (_b = params.ttlSeconds) !== null && _b !== void 0 ? _b : this.defaultTtlSeconds;
        const promise = this.createCachedContent({
            systemInstruction: params.systemInstruction,
            tools: params.tools,
            model: params.model,
            apiKey: params.apiKey,
            baseUrl,
            ttlSeconds: ttl,
        });
        this.inflight.set(contentHash, promise);
        try {
            const name = await promise;
            this.inflight.delete(contentHash);
            this.stats.creates++;
            this.storeEntry(contentHash, name, params.model);
            return { contentHash, cachedContentName: name, createdNow: true };
        }
        catch (err) {
            this.inflight.delete(contentHash);
            this.stats.errors++;
            throw err;
        }
    }
    /**
     * Mark a cached content as expired/evicted by the server. Used by the provider when
     * Gemini returns a 404 or `NOT_FOUND` indicating the resource has been pruned.
     * Removes the entry from the local cache. Does NOT call deleteCachedContent
     * (the server already pruned it).
     */
    evictByName(name) {
        let found = false;
        for (const [hash, entry] of this.cache.entries()) {
            if (entry.name === name) {
                this.cache.delete(hash);
                this.stats.evictions++;
                found = true;
                break;
            }
        }
        return found;
    }
    /**
     * Snapshot of current stats. Cheap to call (no copies of cache contents).
     */
    getStats() {
        const total = this.stats.hits + this.stats.creates;
        return {
            totalEntries: this.cache.size,
            totalHits: this.stats.hits,
            totalCreates: this.stats.creates,
            totalEvictions: this.stats.evictions,
            totalErrors: this.stats.errors,
            hitRate: total === 0 ? 0 : this.stats.hits / total,
            inflight: this.inflight.size,
        };
    }
    /**
     * Reset all in-memory state. For tests and for tenant eviction.
     */
    reset() {
        this.cache.clear();
        this.inflight.clear();
        this.stats = { hits: 0, creates: 0, evictions: 0, errors: 0 };
        this.accessCounter = 0;
    }
    // ============================================================================
    // Private
    // ============================================================================
    /**
     * POST to /v1beta/cachedContents and return the resource name.
     * Throws on non-2xx, network failure, or timeout.
     */
    async createCachedContent(params) {
        const url = `${params.baseUrl}/cachedContents?key=${params.apiKey}`;
        const body = {
            model: `models/${params.model}`,
            ttl: `${params.ttlSeconds}s`,
        };
        // System instruction is sent as a separate top-level field on /cachedContents (not in contents)
        if (params.systemInstruction) {
            body.systemInstruction = { parts: [{ text: params.systemInstruction }] };
        }
        // Tools: convert Commander ToolDefinition → Gemini functionDeclarations
        if (params.tools && params.tools.length > 0) {
            body.tools = [
                {
                    functionDeclarations: params.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parametersJsonSchema: t.inputSchema,
                    })),
                },
            ];
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Gemini cachedContents API error ${response.status}: ${errText}`);
            }
            const data = (await response.json());
            if (!data.name) {
                throw new Error('Gemini cachedContents response missing `name` field');
            }
            return data.name;
        }
        finally {
            clearTimeout(timer);
        }
    }
    /**
     * Store a resolved entry. Evicts the oldest LRU entry if at the cap.
     */
    storeEntry(contentHash, name, model) {
        if (this.cache.size >= this.maxEntries && !this.cache.has(contentHash)) {
            // Find the entry with the smallest accessOrder (oldest in LRU)
            let oldestHash;
            let oldestOrder = Number.POSITIVE_INFINITY;
            for (const [hash, entry] of this.cache.entries()) {
                if (entry.accessOrder < oldestOrder) {
                    oldestOrder = entry.accessOrder;
                    oldestHash = hash;
                }
            }
            if (oldestHash !== undefined) {
                this.cache.delete(oldestHash);
                this.stats.evictions++;
            }
        }
        this.cache.set(contentHash, {
            name,
            contentHash,
            model,
            createdAt: Date.now(),
            accessOrder: ++this.accessCounter,
        });
    }
}
exports.GeminiCacheManager = GeminiCacheManager;
// ============================================================================
// Helpers
// ============================================================================
/**
 * Stable JSON.stringify: sorts object keys recursively AND array elements by their stringified
 * value so the same content produces the same string regardless of key order or element order.
 * Without this, {a:1,b:2} and {b:2,a:1} would produce different hashes; same for [toolA,toolB]
 * vs [toolB,toolA] when the items are semantically a set.
 */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        const items = value.map(stableStringify).sort();
        return '[' + items.join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return '{' + pairs.join(',') + '}';
}
