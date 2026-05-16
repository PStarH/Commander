/**
 * Tool Result Cache — Content-Hash Based Caching
 *
 * Unique innovation: no competitor (Codex, Claude Code, OpenCode, OpenClaw, Hermes)
 * caches tool results. Deterministic tool calls (same name + same args) produce the
 * same hash and return cached results without re-execution.
 *
 * Key design decisions:
 * - Content-hash based: SHA-256 of (toolName + sortedArgs) → cache key
 * - TTL-based expiry: configurable per-tool, default 5 minutes
 * - LRU eviction: bounded memory with configurable max entries
 * - Selective caching: tools opt-in via `isCacheable` flag; side-effect tools excluded
 * - Token savings: cached results skip execution AND reduce context rebuilds
 */

import { createHash } from 'node:crypto';
import type { ToolCall, ToolResult } from './types';

// ============================================================================
// Cache Entry
// ============================================================================

interface CacheEntry {
  /** SHA-256 hash of (toolName + canonicalArgs) */
  key: string;
  /** Cached tool result */
  result: ToolResult;
  /** When this entry was created */
  createdAt: number;
  /** TTL in milliseconds */
  ttlMs: number;
  /** Number of times this entry was served from cache */
  hitCount: number;
  /** Last access time (for LRU) */
  lastAccessAt: number;
  /** Monotonic access counter for LRU tiebreaking when timestamps collide */
  accessOrder: number;
}

// ============================================================================
// Cache Stats
// ============================================================================

export interface ToolCacheStats {
  totalEntries: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  evictions: number;
  memoryEstimateBytes: number;
}

// ============================================================================
// Cache Configuration
// ============================================================================

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
}

const DEFAULT_CONFIG: ToolCacheConfig = {
  enabled: false,
  maxEntries: 256,
  defaultTtlMs: 300_000,
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
};

// ============================================================================
// Tool Result Cache
// ============================================================================

export class ToolResultCache {
  private cache: Map<string, CacheEntry> = new Map();
  private config: ToolCacheConfig;
  private stats = { hits: 0, misses: 0, evictions: 0 };
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private accessCounter = 0;

  constructor(config?: Partial<ToolCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // GAP-22: Auto-prune expired entries every 60s
    if (this.config.enabled) {
      this.pruneTimer = setInterval(() => this.prune(), 60_000);
      if (this.pruneTimer.unref) this.pruneTimer.unref();
    }
  }

  /**
   * Generate a deterministic cache key from tool name and arguments.
   * Sorts object keys recursively for canonical form.
   * When tenantId is provided, it's prepended to isolate caches per tenant.
   */
  static computeKey(toolName: string, args: Record<string, unknown>, tenantId?: string): string {
    const canonical = JSON.stringify(args, ToolResultCache.sortReplacer);
    const payload = tenantId ? `${tenantId}:${toolName}:${canonical}` : `${toolName}:${canonical}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  /** JSON.stringify replacer that sorts object keys recursively */
  private static sortReplacer(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  }

  /**
   * Check if a tool call result is in cache and still valid.
   * When tenantId is provided, cache lookup is scoped to that tenant.
   */
  get(toolCall: ToolCall, tenantId?: string): ToolResult | undefined {
    if (!this.config.enabled) return undefined;
    if (this.isNeverCache(toolCall.name)) return undefined;

    const key = ToolResultCache.computeKey(toolCall.name, toolCall.arguments, tenantId);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check TTL expiry
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // Update access stats (LRU)
    entry.hitCount++;
    entry.lastAccessAt = Date.now();
    entry.accessOrder = ++this.accessCounter;
    this.stats.hits++;

    // Return cached result with zero duration
    return {
      ...entry.result,
      durationMs: 0,
    };
  }

  /**
   * Store a tool result in cache.
   * Only caches if: enabled, tool is cacheable, result has no error.
   * When tenantId is provided, cache is scoped to that tenant.
   */
  set(toolCall: ToolCall, result: ToolResult, tenantId?: string): void {
    if (!this.config.enabled) return;
    if (this.isNeverCache(toolCall.name)) return;
    if (result.error) return;

    const key = ToolResultCache.computeKey(toolCall.name, toolCall.arguments, tenantId);
    const ttlMs = this.config.toolTtls[toolCall.name] ?? this.config.defaultTtlMs;

    // LRU eviction if at capacity
    if (this.cache.size >= this.config.maxEntries) {
      this.evictLRU();
    }

    // Store with tool name for invalidation matching
    this.cache.set(key, {
      key,
      result: { ...result, name: toolCall.name },
      createdAt: Date.now(),
      ttlMs,
      hitCount: 0,
      lastAccessAt: Date.now(),
      accessOrder: ++this.accessCounter,
    });
  }

  /**
   * Invalidate cache entries for a specific tool.
   * Useful when a tool's state changes (e.g., file was written).
   */
  invalidateTool(toolName: string): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (entry.result.name === toolName) {
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
  invalidatePattern(pattern: string): number {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : null;
    let count = 0;
    for (const [key, entry] of this.cache) {
      const match = prefix
        ? entry.result.name.startsWith(prefix)
        : entry.result.name === pattern;
      if (match) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /** Stop the auto-prune timer. Call when shutting down. */
  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): ToolCacheStats {
    const total = this.stats.hits + this.stats.misses;
    // Rough estimate: each entry ~500 bytes overhead + output size
    let memBytes = 0;
    for (const entry of this.cache.values()) {
      memBytes += 500 + (entry.result.output?.length ?? 0) * 2;
    }
    return {
      totalEntries: this.cache.size,
      totalHits: this.stats.hits,
      totalMisses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      evictions: this.stats.evictions,
      memoryEstimateBytes: memBytes,
    };
  }

  /**
   * Prune expired entries. Call periodically to reclaim memory.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Check if a tool should never be cached.
   */
  private isNeverCache(toolName: string): boolean {
    return this.config.neverCache.some(pattern => {
      if (pattern.endsWith('*')) {
        return toolName.startsWith(pattern.slice(0, -1));
      }
      return toolName === pattern;
    });
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    let oldestOrder = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessAt < oldestTime ||
          (entry.lastAccessAt === oldestTime && entry.accessOrder < oldestOrder)) {
        oldestTime = entry.lastAccessAt;
        oldestOrder = entry.accessOrder;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }
}
