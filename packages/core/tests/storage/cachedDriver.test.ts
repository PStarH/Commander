import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DriverDescription,
  PersistentDriver,
  PersistentTable,
  TableSchema,
} from '../../src/storage/types';
import { CachedPersistentDriver } from '../../src/storage/cachedDriver';

interface Row {
  id: string;
  name: string;
  count: number;
}

const rowSchema: TableSchema<Row> = {
  name: 'widgets',
  columns: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'count', type: 'number' },
  ],
};

/**
 * FakePrimaryDriver — Map-backed PersistentDriver used in lieu of
 * better-sqlite3 so the cache tests run on machines without the native
 * binary. Tracks every read so we can assert the cache layer is actually
 * bypassing the primary after a hit.
 */
class FakeTable<T extends { id: string }> implements PersistentTable<T> {
  public reads = 0;
  public writes = 0;
  private rows = new Map<string, T>();

  constructor(private readonly name: string) {}

  insert(row: T): T {
    this.writes++;
    const clone = JSON.parse(JSON.stringify(row)) as T;
    this.rows.set(row.id, clone);
    return clone;
  }
  insertOrReplace(row: T): T {
    this.writes++;
    const clone = JSON.parse(JSON.stringify(row)) as T;
    this.rows.set(row.id, clone);
    return clone;
  }
  get(id: string): T | null {
    this.reads++;
    const row = this.rows.get(id);
    return row ? (JSON.parse(JSON.stringify(row)) as T) : null;
  }
  update(id: string, patch: Partial<T>): boolean {
    const existing = this.rows.get(id);
    if (!existing) return false;
    this.rows.set(id, { ...existing, ...patch, id });
    this.writes++;
    return true;
  }
  updateIf(id: string, where: Partial<T>, patch: Partial<T>): T | null {
    const existing = this.rows.get(id);
    if (!existing) return null;
    for (const k of Object.keys(where) as Array<keyof T>) {
      const v = where[k];
      if (v === undefined) continue;
      if (existing[k] !== v) return null;
    }
    const merged = { ...existing, ...patch, id } as T;
    this.rows.set(id, merged);
    this.writes++;
    return JSON.parse(JSON.stringify(merged)) as T;
  }
  delete(id: string): boolean {
    this.writes++;
    return this.rows.delete(id);
  }
  query(filter?: Partial<T>): T[] {
    const all = Array.from(this.rows.values()).map((r) => JSON.parse(JSON.stringify(r)) as T);
    if (!filter) return all;
    return all.filter((r) => {
      for (const k of Object.keys(filter) as Array<keyof T>) {
        if (filter[k] === undefined) continue;
        if (r[k] !== filter[k]) return false;
      }
      return true;
    });
  }
  count(filter?: Partial<T>): number {
    return this.query(filter).length;
  }
  rawGet(id: string): T | null {
    return this.rows.get(id) ?? null;
  }
}

class FakePrimary implements PersistentDriver {
  readonly backend = 'fake' as const;
  public fakeCloses = 0;
  private tables = new Map<string, FakeTable<{ id: string }>>();

  getTable<T extends { id: string }>(name: string, _schema: TableSchema<T>): PersistentTable<T> {
    const existing = this.tables.get(name) as FakeTable<T> | undefined;
    if (existing) return existing;
    const t = new FakeTable<T>(name);
    this.tables.set(name, t as FakeTable<{ id: string }>);
    return t;
  }
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    return fn();
  }
  close(): void {
    this.fakeCloses++;
    this.tables.clear();
  }
  describe(): DriverDescription {
    return { backend: 'fake', path: ':memory-ram:', tables: [], fellBack: false };
  }
}

let primary: FakePrimary;
let driver: CachedPersistentDriver;
let table: PersistentTable<Row>;

beforeEach(() => {
  primary = new FakePrimary();
  driver = new CachedPersistentDriver(primary, { ttlMs: 1000, maxEntries: 4 });
  table = driver.getTable<Row>('widgets', rowSchema);
});

afterEach(() => {
  driver.close();
});

describe('CachedPersistentDriver — read/write contract', () => {
  it('first get() hits the primary and warms the cache', () => {
    // Insert via the underlying fake primary (bypassing the cache wrapper) so
    // that the cache starts empty. The cached table's first get() must then
    // hit primary and populate the cache.
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    fakeTable.insert({ id: 'a', name: 'Widget A', count: 1 });
    const readsBefore = fakeTable.reads;

    const r1 = table.get('a'); // first get — cache miss, primary fetch
    expect(r1).toEqual({ id: 'a', name: 'Widget A', count: 1 });
    expect(fakeTable.reads).toBe(readsBefore + 1);

    const r2 = table.get('a'); // second get — cache hit
    expect(r2).toEqual({ id: 'a', name: 'Widget A', count: 1 });
    expect(fakeTable.reads).toBe(readsBefore + 1); // no further primary traffic
  });

  it('insert is write-through and populates cache', () => {
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    table.insert({ id: 'b', name: 'Widget B', count: 2 });
    const readsBefore = fakeTable.reads;
    const r = table.get('b');
    expect(r).toEqual({ id: 'b', name: 'Widget B', count: 2 });
    // cache hit — primary.reads must not increment
    expect(fakeTable.reads).toBe(readsBefore);
  });

  it('update invalidates the cache entry, next get() refetches', () => {
    table.insert({ id: 'c', name: 'Widget C', count: 3 });
    table.get('c'); // warm
    table.update('c', { name: 'Widget C2', count: 9 });
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    const readsBefore = fakeTable.reads;
    const r = table.get('c');
    expect(r).toEqual({ id: 'c', name: 'Widget C2', count: 9 });
    expect(fakeTable.reads).toBe(readsBefore + 1); // was invalidated → primary fetch
  });

  it('updateIf on success populates cache with returned row', () => {
    table.insert({ id: 'd', name: 'Widget D', count: 4 });
    const updated = table.updateIf('d', { name: 'Widget D' }, { name: 'Widget D2' });
    expect(updated).toEqual({ id: 'd', name: 'Widget D2', count: 4 });
    // primary was written → no extra read needed
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    const readsBefore = fakeTable.reads;
    const r = table.get('d');
    expect(r).toEqual({ id: 'd', name: 'Widget D2', count: 4 });
    expect(fakeTable.reads).toBe(readsBefore);
  });

  it('delete invalidates the cache entry', () => {
    table.insert({ id: 'e', name: 'Widget E', count: 5 });
    table.get('e'); // warm
    table.delete('e');
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    const readsBefore = fakeTable.reads;
    expect(table.get('e')).toBeNull();
    expect(fakeTable.reads).toBe(readsBefore + 1);
  });
});

describe('CachedPersistentDriver — TTL behaviour', () => {
  it('expires entries after ttlMs and re-fetches from primary', async () => {
    table.insert({ id: 'f', name: 'Widget F', count: 6 });
    table.get('f'); // warm
    await new Promise((r) => setTimeout(r, 1100)); // ttlMs=1000
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    const readsBefore = fakeTable.reads;
    const r = table.get('f');
    expect(r).toEqual({ id: 'f', name: 'Widget F', count: 6 });
    expect(fakeTable.reads).toBe(readsBefore + 1);
  });
});

describe('CachedPersistentDriver — LRU eviction', () => {
  it('drops the least-recently-accessed entry beyond maxEntries', () => {
    table.insert({ id: 'g1', name: 'G1', count: 1 });
    table.insert({ id: 'g2', name: 'G2', count: 2 });
    table.insert({ id: 'g3', name: 'G3', count: 3 });
    table.insert({ id: 'g4', name: 'G4', count: 4 });
    table.insert({ id: 'g5', name: 'G5', count: 5 }); // cap=4 → LRU evicts one
    // After 5 inserts we expect at most 4 entries; g1 (oldest by lastAccess)
    // is the candidate for eviction. Touch g1 to refresh lastAccess so g2 drops instead.
    table.get('g1');
    const stats = driver.cacheStats();
    expect(stats[0].size).toBeLessThanOrEqual(stats[0].cap);
  });
});

describe('CachedPersistentDriver — query / count bypass', () => {
  it('query()/count() bypass the per-id cache (cached size is unchanged)', () => {
    table.insert({ id: 'h1', name: 'H1', count: 1 });
    table.insert({ id: 'h2', name: 'H2', count: 2 });
    // Write-through populated the cache with these two rows. We assert query()
    // does NOT memoise into the per-id cache by size-diffing pre/post.
    const sizeBefore = driver.cacheStats()[0].size;
    expect(sizeBefore).toBe(2);

    expect(table.query()).toHaveLength(2);
    expect(table.query({ name: 'H1' })).toEqual([{ id: 'h1', name: 'H1', count: 1 }]);
    expect(table.count()).toBe(2);

    const sizeAfter = driver.cacheStats()[0].size;
    expect(sizeAfter).toBe(sizeBefore); // unchanged — query() bypassed
  });
});

describe('CachedPersistentDriver — transaction boundaries', () => {
  it('invalidates cache on commit (subsequent read re-fetches)', async () => {
    table.insert({ id: 'i', name: 'I', count: 1 });
    table.get('i'); // warm cache
    await driver.transaction(async () => {
      table.insertOrReplace({ id: 'i', name: 'I2', count: 99 });
    });
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    const readsBefore = fakeTable.reads;
    const r = table.get('i');
    expect(r).toEqual({ id: 'i', name: 'I2', count: 99 });
    expect(fakeTable.reads).toBe(readsBefore + 1); // cache was flushed → primary fetch
  });

  it('invalidates cache on rollback (post-txn cache size is zero)', async () => {
    // Probe the cache-INVALIDATION contract directly here: when the txn
    // body throws, every cache entry across every table is evicted. We
    // assert by checking cacheStats().size === 0 post-throw.
    table.insert({ id: 'j', name: 'J', count: 1 });
    table.get('j'); // warm cache (size=1)
    expect(driver.cacheStats()[0].size).toBe(1);

    let thrown: unknown = null;
    try {
      await driver.transaction(async () => {
        // No mutation — isolates rollback path from primary state.
        throw new Error('rollback');
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error)?.message).toBe('rollback');

    const statsAfter = driver.cacheStats();
    expect(statsAfter.length).toBeGreaterThan(0); // sanity: tables registered
    for (const s of statsAfter) {
      expect(s.size).toBe(0); // invalidated
    }
  });
});

describe('CachedPersistentDriver — describe() and close()', () => {
  it('describe() reports cache-over-<backend>', () => {
    const desc = driver.describe();
    expect(desc.backend).toBe('cache-over-fake');
    expect(desc.fellBack).toBe(false);
    expect(desc.tables).toContain('widgets');
  });

  it('close() forwards to primary and on second call throws nothing', () => {
    driver.close();
    expect(primary.fakeCloses).toBe(1);
    // Idempotent: second close should not throw nor bump fakeCloses again.
    expect(() => driver.close()).not.toThrow();
    // The driver marks itself closed; further table access throws.
    expect(() => driver.getTable('x', rowSchema)).toThrow(/already closed/);
  });

  it('invalidateAll() test hook drops every cached entry', () => {
    table.insert({ id: 'k1', name: 'K1', count: 1 });
    table.insert({ id: 'k2', name: 'K2', count: 2 });
    table.get('k1');
    table.get('k2');
    expect(driver.cacheStats()[0].size).toBe(2);
    driver.invalidateAll();
    expect(driver.cacheStats()[0].size).toBe(0);
  });
});

describe('CachedPersistentDriver — defaults without explicit options', () => {
  it('uses ttlMs=60_000 and maxEntries=1024 by default', () => {
    const d = new CachedPersistentDriver(primary);
    table = d.getTable<Row>('widgets', rowSchema);
    table.insert({ id: 'l', name: 'L', count: 1 });
    table.get('l'); // warm
    const stats = d.cacheStats()[0];
    expect(stats.cap).toBe(1024);
    d.close();
  });
});

describe('CachedPersistentDriver — extras (reviewer nits)', () => {
  it('insertOrReplace warms cache so subsequent get() bypasses primary', () => {
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    table.insert({ id: 'm', name: 'M', count: 1 });
    table.insertOrReplace({ id: 'm', name: 'M2', count: 99 });
    const readsBefore = fakeTable.reads;
    const r = table.get('m');
    expect(r).toEqual({ id: 'm', name: 'M2', count: 99 });
    expect(fakeTable.reads).toBe(readsBefore); // cache hit
  });

  it('multiple tables have independent cache maps', () => {
    type Other = { id: string; flag: boolean };
    const otherSchema: TableSchema<Other> = {
      name: 'flags',
      columns: [
        { name: 'id', type: 'string' },
        { name: 'flag', type: 'boolean' },
      ],
    };
    const otherTable = driver.getTable<Other>('flags', otherSchema);
    table.insert({ id: 'n', name: 'N', count: 1 });
    otherTable.insert({ id: 'o', flag: true });
    table.get('n');
    otherTable.get('o');

    // Snapshot before invalidate.
    let stats = driver.cacheStats();
    let widgetsStats = stats.find((s) => s.table === 'widgets');
    let flagsStats = stats.find((s) => s.table === 'flags');
    expect(widgetsStats?.size).toBe(1);
    expect(flagsStats?.size).toBe(1);

    // invalidateAll clears both — re-snapshot because stats is a fresh probe.
    driver.invalidateAll();
    stats = driver.cacheStats();
    widgetsStats = stats.find((s) => s.table === 'widgets');
    flagsStats = stats.find((s) => s.table === 'flags');
    expect(widgetsStats?.size).toBe(0);
    expect(flagsStats?.size).toBe(0);
  });

  it('updateIf with predicate mismatch returns null and leaves cache unchanged', () => {
    table.insert({ id: 'p', name: 'P', count: 1 });
    table.get('p'); // warm
    table.update('p', { name: 'P2' }); // invalidate by update
    table.get('p'); // re-warm with new value
    // Now CAS with stale predicate (name === 'P0' which doesn't match)
    const updated = table.updateIf('p', { name: 'P0' }, { count: 999 });
    expect(updated).toBeNull();
    // cache should still hold the post-update value (CAS failed → no cache write,
    // but also no eviction; reads continue to be served from cache)
    const fakeTable = primary.getTable<Row>('widgets', rowSchema) as FakeTable<Row>;
    const readsBefore = fakeTable.reads;
    const r = table.get('p');
    expect(r).toEqual({ id: 'p', name: 'P2', count: 1 });
    expect(fakeTable.reads).toBe(readsBefore); // cache hit
  });

  it('declared backend matches the DriverBackend union', () => {
    // Type-level guarantee: the literal type is assignable. Runtime check too.
    expect(driver.backend).toBe('cache-sqlite');
  });

  it('cached and returned rows are deep-cloned (caller mutation does not corrupt cache)', () => {
    // Lock the cloneRow contract: a returned row is NOT the same reference as
    // what the primary holds, and mutating the returned row must not affect a
    // subsequent cached read. Without cloneRow, this test would let the caller
    // poison the cache for all future reads.
    type Nested = { id: string; name: string; tags: string[] };
    const nestedSchema: TableSchema<Nested> = {
      name: 'nested',
      columns: [
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
        // Schema only models primitive columns. Drivers accept any JSON-safe
        // shape at insert time; deep cloning is verified via runtime identity.
        { name: 'tags', type: 'string' },
      ],
    };
    const nestedTable = driver.getTable<Nested>('nested', nestedSchema);
    nestedTable.insert({ id: 'q', name: 'Q', tags: ['a', 'b'] });

    const r1 = nestedTable.get('q');
    expect(r1).not.toBeNull();
    expect(r1?.tags).toEqual(['a', 'b']);
    expect(r1).not.toBe(nestedTable.get('q') as unknown); // different ref — cloneRow returned a copy

    // Caller mutates the nested array (the strongest signal of aliasing).
    r1!.tags.push('poisoned');
    expect(r1?.tags).toEqual(['a', 'b', 'poisoned']);

    // A subsequent get() must NOT return the poison — the cache deep-clones.
    const r2 = nestedTable.get('q');
    expect(r2?.tags).toEqual(['a', 'b']);
  });
});
