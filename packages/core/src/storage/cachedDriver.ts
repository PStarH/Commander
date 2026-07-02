/**
 * CachedPersistentDriver — TTL + LRU cache layer for any PersistentDriver.
 *
 * Design rationale (iss-001 closure):
 *   - The "do less" requirement of a cache sits on top of the durable
 *     primary. SQLite WAL is plenty fast for sequential checkpoint writes,
 *     but command-line / dashboard UIs issue repeated `get(id)` lookups
 *     against the same row inside a single run lifetime; we want those to
 *     stay in-memory across calls.
 *   - We MUST NOT make the cache authoritative. TTL+LRU is a hint that
 *     "this row was N ms ago; re-fetch on miss". On `updateIf` rollback
 *     inside a transaction, the cache is wholesale-flushed so reads
 *     inside the rolled-back txn don't leak through.
 *
 * Known limitations (deliberate, not bugs):
 *   - **TOCTOU on TTL expiry**: two concurrent reads of the same expired
 *     entry both observe "expired" and both call primary. Result is two
 *     primary fetches (not one) but no correctness violation. Callers that
 *     require stronger consistency should call `get()` directly.
 *   - **`updateIf` miss does not invalidate cache**: a CAS that returns
 *     null (predicate mismatch OR id-missing) leaves the cache intact.
 *     This is bounded by TTL; the rare id-missing + cache-present edge
 *     case can leave a phantom entry until TTL.
 *
 * Semantics:
 *   - Read (get): cache-first when entry exists AND not expired; otherwise
 *     primary fetch + populate. `lastAccess` bumped on hit for LRU.
 *   - Write (insert/insertOrReplace): write-through primary, then populate
 *     cache so the next read sees the entry.
 *   - Update: write-through primary, then evict stale entry.
 *   - UpdateIf: write-through primary; on success evict stale entry and
 *     populate with the returned row.
 *   - Delete: write-through primary, then evict cache entry.
 *   - Query / count: bypass cache entirely — filtered scans are not
 *     memoized (schema-correctness over speed; callers call `get(id)`
 *     to populate the per-id cache).
 *   - Transaction: delegate to primary. On commit OR rollback, evict ALL
 *     table caches. Coarse but safe: any read inside the txn that
 *     populated the cache is discarded so post-txn reads re-fetch.
 *   - Close: forwards to primary and clears local caches.
 *   - describe(): reports `cache-over-<backend>` and threads through the
 *     primary's `fellBack` flag.
 *
 * Defaults (overridable via constructor {
 *   ttlMs: 60_000,         // 60 seconds
 *   maxEntries: 1024,      // per table
 * }):
 *   - TTL is short because checkpoint rows mutate frequently (every LLM
 *     call). 60s balances staleness against bypassing SQLite for hot reads.
 *   - maxEntries 1024 covers a single long-running run's worth of recent
 *     checkpoints without outgrowing typical heap budgets.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { cloneRow } from './utils';
import type {
  DriverDescription,
  DriverBackend,
  PersistentDriver,
  PersistentTable,
  QueryOptions,
  TableSchema,
} from './types';

export interface CachedDriverOptions {
  /** Time-to-live for a cache entry in milliseconds. Default 60_000. */
  ttlMs?: number;
  /** Maximum entries per table. Evict LRU over cap. Default 1024. */
  maxEntries?: number;
}

interface CacheEntry<T> {
  row: T;
  expiresAt: number;
  lastAccess: number;
}

interface CachedTableState {
  cache: Map<string, CacheEntry<unknown>>;
  // Schema is still owned by the primary; we hold a reference so we can
  // re-validate on getTable() re-registration.
  schema: TableSchema<{ id: string }>;
}

class CachedTable<T extends { id: string }> implements PersistentTable<T> {
  constructor(
    private readonly tableName: string,
    private readonly primary: PersistentTable<T>,
    private readonly cacheState: CachedTableState,
    private readonly opts: Required<CachedDriverOptions>,
  ) {}

  private get cache(): Map<string, CacheEntry<unknown>> {
    return this.cacheState.cache;
  }

  private get now(): number {
    return Date.now();
  }

  private putCache(row: T): void {
    const entry: CacheEntry<T> = {
      // Deep clone via JSON so cached rows are isolated from caller mutations
      // AND from primary mutations until the next invalidation. For nested
      // schemas (e.g., CheckpointSnapshot.messages) shallow spread would
      // leak references; matches the invariant used by all other drivers.
      row: cloneRow(row),
      expiresAt: this.now + this.opts.ttlMs,
      lastAccess: this.now,
    };
    this.cache.set(row.id, entry as CacheEntry<unknown>);
    this.evictOverCap();
  }

  private evictOverCap(): void {
    if (this.cache.size <= this.opts.maxEntries) return;
    // Drop one LRU entry at a time, repeated until under cap.
    let lruKey: string | undefined;
    let lruAccess = Number.MAX_SAFE_INTEGER;
    for (const [k, e] of this.cache) {
      if (e.lastAccess < lruAccess) {
        lruAccess = e.lastAccess;
        lruKey = k;
      }
    }
    if (lruKey !== undefined) this.cache.delete(lruKey);
  }

  insert(row: T): T {
    const inserted = this.primary.insert(row);
    this.cache.delete(row.id); // ensure no stale hot entry remains before fresh populate
    this.putCache(inserted);
    return { ...inserted };
  }

  insertOrReplace(row: T): T {
    const inserted = this.primary.insertOrReplace(row);
    this.cache.delete(row.id);
    this.putCache(inserted);
    return { ...inserted };
  }

  get(id: string): T | null {
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > this.now) {
      cached.lastAccess = this.now;
      // Defensive clone on read so the caller can't mutate the cached row.
      return cloneRow(cached.row as T);
    }
    if (cached && cached.expiresAt <= this.now) {
      this.cache.delete(id);
    }
    const fresh = this.primary.get(id);
    if (fresh) this.putCache(fresh);
    return fresh ? cloneRow(fresh) : null;
  }

  update(id: string, patch: Partial<T>): boolean {
    const ok = this.primary.update(id, patch);
    // Invalidate regardless — we cannot pre-image the post-update row
    // outside of updateIf semantics.
    this.cache.delete(id);
    return ok;
  }

  /**
   * Compare-and-set with cache coherence.
   *
   * On success: the underlying row changed, so the stale cache entry is
   * evicted and the post-update row is populating the cache.
   *
   * On failure (returns null): NO state change occurred in primary ("no
   * rows changed" semantics from better-sqlite3 cover both predicate
   * mismatch and id-missing). The cache entry is left intact so callers
   * observing the null return are still served the pre-CAS value without
   * a spurious primary read.
   *
   * Caveat: in the rare id-missing-but-cache-present scenario (a row was
   * primary-deleted via a non-cached path while a stale entry remained in
   * cache), the cache might serve a phantom. This is bounded by the cache
   * TTL and is the deliberate trade-off for avoiding a primary round-trip
   * on every CAS miss. Callers that need miss-detection-on-stale-cache
   * semantics should call `get()` directly after a null updateIf.
   */
  updateIf(id: string, where: Partial<T>, patch: Partial<T>): T | null {
    const updated = this.primary.updateIf(id, where, patch);
    if (updated) {
      // CAS succeeded: state changed → invalidate stale entry, populate new.
      this.cache.delete(id);
      this.putCache(updated);
      return cloneRow(updated);
    }
    // CAS failed: state unchanged. Leave the cache intact (see JSDoc above).
    return null;
  }

  delete(id: string): boolean {
    const ok = this.primary.delete(id);
    this.cache.delete(id);
    return ok;
  }

  query(filter?: Partial<T>, opts?: QueryOptions<T>): T[] {
    // Bypass cache: filtered scans are not memoized (cache holds single rows).
    return this.primary.query(filter, opts);
  }

  count(filter?: Partial<T>): number {
    return this.primary.count(filter);
  }
}

export class CachedPersistentDriver implements PersistentDriver {
  // The declared canonical backend is 'cache-sqlite'. describe() can report
  // the underlying primary (e.g. 'cache-over-<inner>') for richer diagnostics.
  readonly backend: DriverBackend = 'cache-sqlite';

  private readonly primary: PersistentDriver;
  private readonly opts: Required<CachedDriverOptions>;
  private readonly tableCache: Map<string, CachedTableState> = new Map();
  private readonly tableRefs: Map<string, PersistentTable<{ id: string }>> = new Map();
  private closed = false;

  constructor(primary: PersistentDriver, opts?: CachedDriverOptions) {
    this.primary = primary;
    this.opts = {
      ttlMs: opts?.ttlMs ?? 60_000,
      maxEntries: opts?.maxEntries ?? 1024,
    };
  }

  /** The underlying primary's backend name (for logging). */
  get backingBackend(): string {
    return this.primary.backend;
  }

  /**
   * Test/inspection hook: report cache stats per table.
   *
   * Returns a **point-in-time snapshot** of every table's cache size. The
   * `size` field is captured at call time — re-invoke after any mutation
   * to observe fresh values. Not safe to read from inside an active
   * transaction body.
   */
  cacheStats(): Array<{ table: string; size: number; cap: number }> {
    return Array.from(this.tableCache.entries()).map(([table, state]) => ({
      table,
      size: state.cache.size,
      cap: this.opts.maxEntries,
    }));
  }

  /** Test hook: invalidate every cached table. Coarse-grained. */
  invalidateAll(): void {
    for (const state of this.tableCache.values()) state.cache.clear();
  }

  getTable<T extends { id: string }>(name: string, schema: TableSchema<T>): PersistentTable<T> {
    if (this.closed) throw new Error('CachedPersistentDriver: already closed');
    const existing = this.tableRefs.get(name) as PersistentTable<T> | undefined;
    if (existing) return existing;
    const primaryTable = this.primary.getTable(name, schema);
    const cacheState: CachedTableState = {
      cache: new Map<string, CacheEntry<unknown>>(),
      schema: schema as TableSchema<{ id: string }>,
    };
    const table = new CachedTable<T>(name, primaryTable, cacheState, this.opts);
    this.tableCache.set(name, cacheState);
    this.tableRefs.set(name, table as PersistentTable<{ id: string }>);
    return table;
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await this.primary.transaction(fn);
    } catch (err) {
      // Rollback safety: any cache populated by inside-transaction reads
      // must be evicted so post-rollback state is invisible to readers.
      try {
        this.invalidateAll();
      } catch (cleanupErr) {
        reportSilentFailure(cleanupErr, 'cachedDriver:txRollbackInvalidate');
      }
      throw err;
    }
    // Commit safety: force a re-fetch on the next read in case the txn
    // mutated rows that were already in the cache.
    try {
      this.invalidateAll();
    } catch (cleanupErr) {
      reportSilentFailure(cleanupErr, 'cachedDriver:txCommitInvalidate');
    }
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.tableCache.clear();
    this.tableRefs.clear();
    try {
      this.primary.close();
    } catch (err) {
      reportSilentFailure(err, 'cachedDriver:close');
      /* best-effort — primary may already be closed */
    }
  }

  describe(): DriverDescription {
    const inner = this.primary.describe();
    return {
      backend: `cache-over-${inner.backend}`,
      path: inner.path,
      namespace: inner.namespace,
      tables: Array.from(this.tableCache.keys()),
      fellBack: inner.fellBack,
    };
  }
}
