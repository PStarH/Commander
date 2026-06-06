/**
 * Semantic Cache — Embedding-based response caching for LLM calls.
 *
 * Closes the largest single cost gap in production LLM systems: repeated or
 * semantically-similar queries account for 35-62% of LLM traffic (GPTCache
 * study; FrugalGPT arXiv:2305.05176).
 *
 * Unlike `ToolResultCache` (FNV-1a exact match), this cache uses cosine
 * similarity over embeddings to detect near-duplicate prompts.
 *
 * Backed by `EmbeddingFunction` from `embedding.ts` — use `MockEmbeddingFunction`
 * in tests (deterministic 64-dim), `OpenAIEmbeddingFunction` in production.
 */
import { createHash } from 'node:crypto';
import type { EmbeddingFunction } from './embedding';
import { cosineSimilarity } from './embedding';
import type { LLMRequest, LLMResponse } from './types';

// ============================================================================
// Configuration
// ============================================================================

export interface SemanticCacheConfig {
  /** Enable the cache. Default: false (opt-in, like ToolResultCache). */
  enabled: boolean;
  /** Cosine threshold for cache hit. Range [0, 1]. Default: 0.92. */
  similarityThreshold: number;
  /** Max cache entries before LRU eviction. Default: 10000. */
  maxEntries: number;
  /** Default TTL in ms. Default: 86_400_000 (24h). */
  defaultTtlMs: number;
  /** Per-bucket cap to bound search cost. Default: 64. */
  maxBucketSize: number;
  /** Cache responses with temperature > 0. Default: false. */
  cacheStochastic: boolean;
  /** Cache responses that include tool_calls. Default: false (safety first). */
  cacheToolCalls: boolean;
  /** Auto-prune interval in ms. 0 disables. Default: 60_000. */
  pruneIntervalMs: number;
}

const DEFAULT_CONFIG: SemanticCacheConfig = {
  enabled: false,
  similarityThreshold: 0.92,
  maxEntries: 10_000,
  defaultTtlMs: 86_400_000,
  maxBucketSize: 64,
  cacheStochastic: false,
  cacheToolCalls: false,
  pruneIntervalMs: 60_000,
};

// ============================================================================
// Cache Entry
// ============================================================================

interface CacheEntry {
  queryHash: string;
  embedding: number[];
  response: LLMResponse;
  createdAt: number;
  ttlMs: number;
  hitCount: number;
  lastAccessAt: number;
  accessOrder: number;
  costPerHit: number;
}

// ============================================================================
// Stats
// ============================================================================

export interface SemanticCacheStats {
  totalEntries: number;
  totalBuckets: number;
  totalHits: number;
  totalMisses: number;
  totalStores: number;
  totalEvictions: number;
  hitRate: number;
  embeddingCalls: number;
  estimatedCostSavedUsd: number;
  memoryEstimateBytes: number;
}

// ============================================================================
// Request Signature — bucket key
// ============================================================================

/**
 * Bucket key from request fields that affect output distribution. Two requests
 * with the same signature can plausibly share a response; different signatures
 * must not.
 */
export function computeRequestSignature(request: LLMRequest): string {
  const systemPrompt = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const tempMarker =
    request.temperature === undefined || request.temperature === 0
      ? 'greedy'
      : `temp-${request.temperature}`;
  const toolCount = request.tools?.length ?? 0;
  const payload = `${request.model}|${tempMarker}|t${toolCount}|${systemPrompt}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Extract the most semantically meaningful text to embed.
 * Priority: last user message → last non-system → system.
 */
function extractEmbeddingTarget(request: LLMRequest): string | null {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    if (request.messages[i].role === 'user' && request.messages[i].content.trim().length > 0) {
      return request.messages[i].content;
    }
  }
  for (let i = request.messages.length - 1; i >= 0; i--) {
    if (request.messages[i].role !== 'system' && request.messages[i].content.trim().length > 0) {
      return request.messages[i].content;
    }
  }
  const sysMsg = request.messages.find((m) => m.role === 'system');
  return sysMsg?.content.trim() ?? null;
}

/**
 * Estimate cost of a response in dollars using a flat blended rate
 * ($3/M input + $15/M output, covering GPT-4-class models).
 */
function estimateDefaultCost(response: LLMResponse): number {
  const inputRate = 3.0 / 1_000_000;
  const outputRate = 15.0 / 1_000_000;
  return (
    response.usage.promptTokens * inputRate +
    response.usage.completionTokens * outputRate
  );
}

// ============================================================================
// SemanticCache
// ============================================================================

export class SemanticCache {
  private config: SemanticCacheConfig;
  private buckets: Map<string, CacheEntry[]>;
  private embeddingFn: EmbeddingFunction;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private accessCounter = 0;
  private memoryEstimateBytes = 0;
  private stats = {
    hits: 0,
    misses: 0,
    stores: 0,
    evictions: 0,
    embeddingCalls: 0,
    costSavedUsd: 0,
  };

  constructor(embeddingFn: EmbeddingFunction, config?: Partial<SemanticCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingFn = embeddingFn;
    this.buckets = new Map();

    if (this.config.enabled && this.config.pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => this.prune(), this.config.pruneIntervalMs);
      if (this.pruneTimer.unref) this.pruneTimer.unref();
    }
  }

  // --------------------------------------------------------------------------
  // Lookup
  // --------------------------------------------------------------------------

  /** Look up a cached response for the given request. Returns null on miss. */
  async lookup(request: LLMRequest, tenantId?: string): Promise<LLMResponse | null> {
    if (!this.config.enabled) return null;
    if (this.shouldSkip(request)) return null;

    const target = extractEmbeddingTarget(request);
    if (!target) return null;

    const signature = computeRequestSignature(request);
    const bucketKey = this.bucketKey(signature, tenantId);
    const bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.length === 0) {
      this.stats.misses++;
      return null;
    }

    this.stats.embeddingCalls++;
    const queryEmbedding = await Promise.resolve(this.embeddingFn.generate(target));

    let bestEntry: CacheEntry | null = null;
    let bestSim = 0;
    const now = Date.now();

    for (const entry of bucket) {
      if (now - entry.createdAt > entry.ttlMs) continue;
      if (entry.embedding.length !== queryEmbedding.length) continue;
      const sim = cosineSimilarity(queryEmbedding, entry.embedding);
      if (sim >= this.config.similarityThreshold && sim > bestSim) {
        bestSim = sim;
        bestEntry = entry;
      }
    }

    if (!bestEntry) {
      this.stats.misses++;
      return null;
    }

    bestEntry.hitCount++;
    bestEntry.lastAccessAt = now;
    bestEntry.accessOrder = ++this.accessCounter;
    this.stats.hits++;
    this.stats.costSavedUsd += bestEntry.costPerHit;
    return cloneResponse(bestEntry.response);
  }

  // --------------------------------------------------------------------------
  // Store
  // --------------------------------------------------------------------------

  /**
   * Store a response in the cache. Embeds the query in the background; never
   * blocks the call site. Embedding failures are silently dropped — the caller
   * has already received the response.
   */
  store(request: LLMRequest, response: LLMResponse, tenantId?: string): void {
    if (!this.config.enabled) return;
    if (this.shouldSkip(request)) return;
    if (response.finishReason === 'error') return;
    if (!this.config.cacheToolCalls && (response.toolCalls?.length ?? 0) > 0) return;

    const target = extractEmbeddingTarget(request);
    if (!target) return;

    const signature = computeRequestSignature(request);
    const bucketKey = this.bucketKey(signature, tenantId);
    const costPerHit = estimateDefaultCost(response);
    const ttlMs = this.config.defaultTtlMs;
    const createdAt = Date.now();
    const queryHash = createHash('sha256').update(target).digest('hex').slice(0, 16);

    this.stats.embeddingCalls++;
    Promise.resolve(this.embeddingFn.generate(target)).then(
      (embedding) => {
        let bucket = this.buckets.get(bucketKey);
        if (!bucket) {
          bucket = [];
          this.buckets.set(bucketKey, bucket);
        }

        if (bucket.length >= this.config.maxBucketSize) {
          const evicted = bucket.shift();
          if (evicted) {
            this.memoryEstimateBytes -= estimateEntryBytes(evicted);
            this.stats.evictions++;
          }
        }

        if (this.totalEntries() >= this.config.maxEntries) {
          this.evictGlobalLRU(1);
        }

        const entry: CacheEntry = {
          queryHash,
          embedding,
          response: cloneResponse(response),
          createdAt,
          ttlMs,
          hitCount: 0,
          lastAccessAt: createdAt,
          accessOrder: ++this.accessCounter,
          costPerHit,
        };
        bucket.push(entry);
        this.memoryEstimateBytes += estimateEntryBytes(entry);
        this.stats.stores++;
      },
      () => undefined,
    );
  }

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  /** Prune expired entries from all buckets. Returns the number removed. */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, bucket] of this.buckets) {
      const filtered = bucket.filter((e) => {
        const expired = now - e.createdAt > e.ttlMs;
        if (expired) {
          this.memoryEstimateBytes -= estimateEntryBytes(e);
        }
        return !expired;
      });
      if (filtered.length === 0) {
        this.buckets.delete(key);
      } else if (filtered.length !== bucket.length) {
        this.buckets.set(key, filtered);
      }
      pruned += bucket.length - filtered.length;
    }
    return pruned;
  }

  /** Invalidate all entries for a tenant. */
  invalidateTenant(tenantId: string): number {
    if (!tenantId) return 0;
    let count = 0;
    for (const [key, bucket] of this.buckets) {
      if (key.startsWith(`${tenantId}:`)) {
        for (const entry of bucket) {
          this.memoryEstimateBytes -= estimateEntryBytes(entry);
          count++;
        }
        this.buckets.delete(key);
      }
    }
    return count;
  }

  /** Invalidate all entries for a model (e.g., after a model update). */
  invalidateModel(modelName: string): number {
    // Bucket keys are hashed; we scan entries by their cached response.model.
    let count = 0;
    for (const [key, bucket] of this.buckets) {
      const filtered = bucket.filter((e) => {
        const match = e.response.model === modelName;
        if (match) {
          this.memoryEstimateBytes -= estimateEntryBytes(e);
          count++;
        }
        return !match;
      });
      if (filtered.length === 0) {
        this.buckets.delete(key);
      } else if (filtered.length !== bucket.length) {
        this.buckets.set(key, filtered);
      }
    }
    return count;
  }

  /** Clear all entries. */
  clear(): void {
    this.buckets.clear();
    this.memoryEstimateBytes = 0;
  }

  /** Get cache statistics. */
  getStats(): SemanticCacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      totalEntries: this.totalEntries(),
      totalBuckets: this.buckets.size,
      totalHits: this.stats.hits,
      totalMisses: this.stats.misses,
      totalStores: this.stats.stores,
      totalEvictions: this.stats.evictions,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      embeddingCalls: this.stats.embeddingCalls,
      estimatedCostSavedUsd: this.stats.costSavedUsd,
      memoryEstimateBytes: this.memoryEstimateBytes,
    };
  }

  /** Stop the auto-prune timer. Call when shutting down. */
  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private shouldSkip(request: LLMRequest): boolean {
    if (!this.config.cacheStochastic) {
      if (request.temperature !== undefined && request.temperature > 0) return true;
    }
    if (!this.config.cacheToolCalls && (request.tools?.length ?? 0) > 0) return true;
    return false;
  }

  private bucketKey(signature: string, tenantId?: string): string {
    return tenantId ? `${tenantId}:${signature}` : `_:${signature}`;
  }

  private totalEntries(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) n += bucket.length;
    return n;
  }

  private evictGlobalLRU(count: number): void {
    const all: Array<[string, CacheEntry]> = [];
    for (const [key, bucket] of this.buckets) {
      for (const entry of bucket) all.push([key, entry]);
    }
    all.sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
    for (let i = 0; i < Math.min(count, all.length); i++) {
      const [key, entry] = all[i];
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      const idx = bucket.indexOf(entry);
      if (idx >= 0) bucket.splice(idx, 1);
      this.memoryEstimateBytes -= estimateEntryBytes(entry);
      this.stats.evictions++;
      if (bucket.length === 0) this.buckets.delete(key);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function cloneResponse(response: LLMResponse): LLMResponse {
  return {
    content: response.content,
    model: response.model,
    finishReason: response.finishReason,
    usage: { ...response.usage },
    toolCalls: response.toolCalls ? response.toolCalls.map((tc) => ({ ...tc })) : undefined,
    reasoning_content: response.reasoning_content,
  };
}

function estimateEntryBytes(entry: CacheEntry): number {
  return 500 + entry.embedding.length * 4 + (entry.response.content?.length ?? 0) * 2;
}
