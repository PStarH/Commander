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

// FNV-1a 32-bit hash, non-cryptographic. Constants are FNV-1a standard.
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

interface InflightEntry {
  promise: Promise<LLMResponse>;
  startedAt: number;
  tenantId?: string;
}

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

export class SingleFlightRequestCache {
  private inflight = new Map<string, InflightEntry>();
  private config: SingleFlightConfig;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private monotonic = 0;

  constructor(config?: Partial<SingleFlightConfig>) {
    this.config = { enabled: true, maxInFlight: 1000, ...config };
  }

  static computeKey(request: LLMRequest, tenantId?: string): string {
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

  async dedupe(
    key: string,
    factory: () => Promise<LLMResponse>,
    tenantId?: string,
  ): Promise<LLMResponse> {
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

  getStats(): SingleFlightStats {
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

  inflightCount(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.inflight.clear();
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
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
