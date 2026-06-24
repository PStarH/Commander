/**
 * InMemoryDriver — Map-backed PersistentDriver implementation.
 *
 * Useful for tests and ephemeral contexts. Strict semantics:
 *   - getTable() registers the schema on first use; re-registering with the
 *     SAME schema returns the same table; re-registering with a DIFFERENT
 *     schema throws (prevents silent shape drift across tests).
 *   - transaction() takes a deep snapshot of all registered tables, runs
 *     `fn()`, and restores the snapshot if fn throws. Best-effort: deep
 *     clones via JSON, so only JSON-safe shape survives a rollback.
 *   - closed() throws on any subsequent table operation.
 */

import type {
  DriverDescription,
  DriverConfig,
  PersistentDriver,
  PersistentTable,
  QueryOptions,
  TableSchema,
} from './types';
import { matchesFilter } from './utils';

interface InMemoryTableState<T extends { id: string }> {
  schema: TableSchema<T>;
  rows: Map<string, T>;
  closed: boolean;
}

class InMemoryTable<T extends { id: string }> implements PersistentTable<T> {
  constructor(
    private readonly name: string,
    private readonly state: InMemoryTableState<T>,
  ) {}

  private assertOpen(): void {
    if (this.state.closed) {
      throw new Error(`InMemoryTable(${this.name}): already closed`);
    }
  }

  insert(row: T): T {
    this.assertOpen();
    if (!row.id || typeof row.id !== 'string') {
      throw new Error(`InMemoryTable(${this.name}).insert: row.id required`);
    }
    if (this.state.rows.has(row.id)) {
      throw new Error(`InMemoryTable(${this.name}).insert: row with id ${row.id} already exists`);
    }
    const clone = cloneRow(row);
    this.state.rows.set(row.id, clone);
    return clone;
  }

  insertOrReplace(row: T): T {
    this.assertOpen();
    if (!row.id || typeof row.id !== 'string') {
      throw new Error(`InMemoryTable(${this.name}).insertOrReplace: row.id required`);
    }
    const clone = cloneRow(row);
    this.state.rows.set(row.id, clone);
    return clone;
  }

  get(id: string): T | null {
    this.assertOpen();
    const row = this.state.rows.get(id);
    return row ? cloneRow(row) : null;
  }

  update(id: string, patch: Partial<T>): boolean {
    this.assertOpen();
    const existing = this.state.rows.get(id);
    if (!existing) return false;
    const merged: T = { ...existing, ...patch, id };
    this.state.rows.set(id, merged);
    return true;
  }

  updateIf(id: string, where: Partial<T>, patch: Partial<T>): T | null {
    this.assertOpen();
    const existing = this.state.rows.get(id);
    if (!existing) return null;
    if (!matchesFilter(existing as Record<string, unknown>, where)) return null;
    const merged: T = { ...existing, ...patch, id };
    this.state.rows.set(id, merged);
    return cloneRow(merged);
  }

  delete(id: string): boolean {
    this.assertOpen();
    return this.state.rows.delete(id);
  }

  query(filter?: Partial<T>, opts?: QueryOptions<T>): T[] {
    this.assertOpen();
    let out = Array.from(this.state.rows.values()).map(cloneRow);
    out = out.filter((r) => matchesFilter(r as Record<string, unknown>, filter));
    if (opts?.sort && opts.sort.length > 0) {
      out = out.slice().sort((a, b) => {
        for (const s of opts.sort!) {
          const av = a[s.column];
          const bv = b[s.column];
          const dir = s.direction === 'desc' ? -1 : 1;
          if (av === bv) continue;
          if (av === undefined) return dir;
          if (bv === undefined) return -dir;
          if (av === null) return dir;
          if (bv === null) return -dir;
          if ((av as number | string) < (bv as number | string)) return -1 * dir;
          if ((av as number | string) > (bv as number | string)) return 1 * dir;
        }
        return 0;
      });
    }
    if (opts?.offset && opts.offset > 0) out = out.slice(opts.offset);
    if (opts?.limit !== undefined && opts.limit >= 0) out = out.slice(0, opts.limit);
    return out.map(cloneRow);
  }

  count(filter?: Partial<T>): number {
    this.assertOpen();
    let n = 0;
    for (const row of this.state.rows.values()) {
      if (matchesFilter(row as Record<string, unknown>, filter)) n++;
    }
    return n;
  }
}

function cloneRow<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}

export class InMemoryDriver implements PersistentDriver {
  readonly backend = 'memory' as const;
  private readonly tables = new Map<string, InMemoryTableState<{ id: string }>>();
  private closed = false;

  constructor(_config?: Partial<DriverConfig>) {
    /* no-op */
  }

  getTable<T extends { id: string }>(name: string, schema: TableSchema<T>): PersistentTable<T> {
    if (this.closed) throw new Error('InMemoryDriver: already closed');
    const existing = this.tables.get(name) as InMemoryTableState<T> | undefined;
    if (existing) {
      // Schema-shape parity check: reject re-registration with different schema.
      if (!schemasMatch(existing.schema, schema)) {
        throw new Error(
          `InMemoryDriver.getTable(${name}): schema mismatch (existing vs requested)`,
        );
      }
      return new InMemoryTable<T>(name, existing);
    }
    const state: InMemoryTableState<T> = {
      schema,
      rows: new Map<string, T>(),
      closed: false,
    };
    this.tables.set(name, state as InMemoryTableState<{ id: string }>);
    return new InMemoryTable<T>(name, state);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new Error('InMemoryDriver: already closed');
    // Deep-snapshot all row maps. JSON clone is sufficient for our typed schemas.
    const snapshot: Array<{ name: string; rows: Map<string, unknown> }> = [];
    for (const [name, state] of this.tables.entries()) {
      const clone = new Map<string, unknown>();
      for (const [k, v] of (state.rows as Map<string, unknown>).entries()) {
        clone.set(k, JSON.parse(JSON.stringify(v)));
      }
      snapshot.push({ name, rows: clone });
    }
    try {
      return await fn();
    } catch (err) {
      // Rollback: restore every table's row map from the snapshot.
      for (const snap of snapshot) {
        const state = this.tables.get(snap.name) as InMemoryTableState<{ id: string }> | undefined;
        if (state) (state.rows as Map<string, unknown>).clear();
        if (state) {
          for (const [k, v] of snap.rows.entries()) {
            (state.rows as Map<string, unknown>).set(k, v);
          }
        }
      }
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.tables.values()) state.closed = true;
  }

  describe(): DriverDescription {
    return {
      backend: this.backend,
      path: ':memory:',
      tables: Array.from(this.tables.keys()),
      fellBack: false,
    };
  }
}

function schemasMatch<T extends { id: string }>(a: TableSchema<T>, b: TableSchema<T>): boolean {
  if (a.name !== b.name) return false;
  if (a.columns.length !== b.columns.length) return false;
  for (let i = 0; i < a.columns.length; i++) {
    const ca = a.columns[i];
    const cb = b.columns[i];
    if (ca.name !== cb.name || ca.type !== cb.type) return false;
  }
  return true;
}
