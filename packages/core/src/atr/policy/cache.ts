import type { PolicyDecision, CacheEntry, PolicyEngineOptions } from './types';

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 30_000;

export class DecisionCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly inflight = new Map<string, Promise<PolicyDecision>>();
  private hits = 0;
  private misses = 0;

  constructor(opts: PolicyEngineOptions = {}) {
    this.maxEntries = opts.maxCacheEntries ?? DEFAULT_MAX_ENTRIES;
    this.defaultTtlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  get(key: string): PolicyDecision | null {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    this.map.delete(key);
    this.map.set(key, entry);
    return { ...entry.decision, cached: true };
  }

  set(key: string, decision: PolicyDecision, ttlMs?: number): void {
    if (!decision.cacheable) return;
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.map.set(key, { decision, expiresAt: Date.now() + ttl });
    if (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first) this.map.delete(first);
    }
  }

  invalidateByRun(runId: string): number {
    let count = 0;
    for (const k of this.map.keys()) {
      if (k.includes(`run:${runId}:`)) {
        this.map.delete(k);
        count++;
      }
    }
    return count;
  }

  invalidateByTenant(tenantId: string | null): number {
    let count = 0;
    for (const k of this.map.keys()) {
      if (k.includes(`tenant:${tenantId ?? 'null'}:`)) {
        this.map.delete(k);
        count++;
      }
    }
    return count;
  }

  invalidateByPackVersion(packVersion: number): number {
    let count = 0;
    for (const k of this.map.keys()) {
      if (k.includes(`pack:${packVersion}:`)) {
        this.map.delete(k);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  dedupe<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = factory().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p as unknown as Promise<PolicyDecision>);
    return p;
  }
}
