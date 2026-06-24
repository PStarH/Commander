/**
 * SqliteDriver — better-sqlite3-backed PersistentDriver implementation.
 *
 * Hard constraints (must satisfy security-test invariants):
 *   1. NEVER-throws on require (`better-sqlite3`). probeSqlite() is lazy and
 *      catches any require / compile / link exception.
 *   2. NEVER-throws silently at construction. File-open errors are wrapped
 *      in SqliteOpenError so callers can branch on `cause`.
 *   3. WAL + sync=NORMAL for atomicity (kill9.test.ts:122 contract).
 *   4. Permissions: file 0o600, dir 0o700 (filePermissions.test.ts:310-384).
 *
 * CAS (compare-and-set) primitive `updateIf(id, where, patch)`:
 *   The SET clause is built from `Object.keys(patch)` (excl. id) so non-patch
 *   columns are preserved. The WHERE clause includes id + every defined
 *   `where` predicate. If rows-changed is 0, the predicate failed and we
 *   return null. NULL `where` values use `IS @wN` semantics.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DriverDescription,
  DriverConfig,
  PersistentDriver,
  PersistentTable,
  QueryOptions,
  TableSchema,
} from './types';
import { coerceColumn, isCompatibleWithSpec, cloneRow, matchesFilter } from './utils';

interface SqliteTableState<T extends { id: string }> {
  name: string;
  schema: TableSchema<T>;
  closed: boolean;
}

interface SqliteStmt {
  run(params?: Record<string, unknown> | unknown[]): { changes: number };
  get(params?: Record<string, unknown> | unknown[] | string | number): unknown;
  all(params?: Record<string, unknown> | unknown[]): unknown[];
}

export interface SqliteNativeDatabase {
  prepare(sql: string): SqliteStmt;
  exec(sql: string): void;
  pragma(name: string): unknown;
  close(): void;
}

class SqliteTable<T extends { id: string }> implements PersistentTable<T> {
  constructor(
    private readonly db: SqliteNativeDatabase,
    private readonly state: SqliteTableState<T>,
  ) {}

  private get tableName(): string {
    return this.state.name;
  }

  private assertOpen(): void {
    if (this.state.closed) {
      throw new Error(`SqliteTable(${this.tableName}): already closed`);
    }
  }

  private colNames(): string[] {
    return this.state.schema.columns.map((c) => c.name);
  }

  /** Build `{col: value}` for better-sqlite3 named bindings. Booleans are
   *  coerced to INTEGER 0/1 since SQLite has no native boolean type. */
  private bindParams(row: T): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of this.state.schema.columns) {
      const v = (row as unknown as Record<string, unknown>)[c.name];
      if (v === undefined) {
        out[c.name] = null;
      } else if (c.type === 'boolean' && typeof v === 'boolean') {
        out[c.name] = v ? 1 : 0;
      } else {
        out[c.name] = v;
      }
    }
    return out;
  }

  insert(row: T): T {
    this.assertOpen();
    if (!row.id || typeof row.id !== 'string') {
      throw new Error(`SqliteTable(${this.tableName}).insert: row.id required`);
    }
    this.validateRow(row);
    const cols = this.colNames();
    const placeholders = cols.map((n) => `@${n}`).join(', ');
    const sql =
      `INSERT INTO ${qid(this.tableName)} ` +
      `(${cols.map((n) => qid(n)).join(', ')}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(this.bindParams(row));
    return row;
  }

  insertOrReplace(row: T): T {
    this.assertOpen();
    if (!row.id || typeof row.id !== 'string') {
      throw new Error(`SqliteTable(${this.tableName}).insertOrReplace: row.id required`);
    }
    this.validateRow(row);
    const cols = this.colNames();
    const placeholders = cols.map((n) => `@${n}`).join(', ');
    const sql =
      `INSERT OR REPLACE INTO ${qid(this.tableName)} ` +
      `(${cols.map((n) => qid(n)).join(', ')}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(this.bindParams(row));
    return row;
  }

  get(id: string): T | null {
    this.assertOpen();
    const row = this.db
      .prepare(`SELECT * FROM ${qid(this.tableName)} WHERE id = @id`)
      .get({ id }) as Record<string, unknown> | undefined;
    if (!row) return null;
    return normalizeRow(row, this.state.schema.columns) as unknown as T;
  }

  update(id: string, patch: Partial<T>): boolean {
    this.assertOpen();
    return this.updateIf(id, {}, patch) !== null;
  }

  /**
   * Atomic compare-and-set (CAS). The SET clause is derived from
   * `Object.keys(patch)` (excl. id) so non-patch columns are preserved.
   * The WHERE clause includes id + every defined `where` predicate.
   * null values in `where` use SQL `IS @wN` semantics.
   * If rows-changed is 0, the predicate failed (or id is absent) and we
   * return null.
   */
  updateIf(id: string, where: Partial<T>, patch: Partial<T>): T | null {
    this.assertOpen();
    const setClauses: string[] = [];
    const bindArgs: Record<string, unknown> = { id };

    for (const k of Object.keys(patch) as Array<keyof T>) {
      if (k === 'id') continue;
      const name = String(k);
      const raw = (patch as unknown as Record<string, unknown>)[name];
      const col = this.state.schema.columns.find((c) => c.name === name);
      bindArgs[name] =
        raw === undefined
          ? null
          : col && col.type === 'boolean' && typeof raw === 'boolean'
            ? raw
              ? 1
              : 0
            : raw;
      setClauses.push(`${qid(name)} = @${name}`);
    }

    const whereClauses: string[] = ['id = @id'];
    let wIndex = 0;
    for (const k of Object.keys(where) as Array<keyof T>) {
      const v = where[k];
      if (v === undefined) continue;
      const name = String(k);
      const col = this.state.schema.columns.find((c) => c.name === name);
      const bound = col && col.type === 'boolean' && typeof v === 'boolean' ? (v ? 1 : 0) : v;
      bindArgs[`w${wIndex}`] = bound;
      whereClauses.push(
        bound === null ? `${qid(name)} IS @w${wIndex}` : `${qid(name)} = @w${wIndex}`,
      );
      wIndex++;
    }

    if (setClauses.length === 0) {
      // Predicate-only check on the unchanged row.
      const exists = this.db
        .prepare(`SELECT 1 FROM ${qid(this.tableName)} WHERE ${whereClauses.join(' AND ')} LIMIT 1`)
        .get(bindArgs);
      return exists ? this.get(id) : null;
    }

    const sql =
      `UPDATE ${qid(this.tableName)} SET ${setClauses.join(', ')} ` +
      `WHERE ${whereClauses.join(' AND ')}`;
    const info = this.db.prepare(sql).run(bindArgs);
    if (info.changes === 0) return null;

    return this.get(id);
  }

  delete(id: string): boolean {
    this.assertOpen();
    const info = this.db.prepare(`DELETE FROM ${qid(this.tableName)} WHERE id = @id`).run({ id });
    return info.changes > 0;
  }

  query(filter?: Partial<T>, opts?: QueryOptions<T>): T[] {
    this.assertOpen();
    const raw = this.db.prepare(`SELECT * FROM ${qid(this.tableName)}`).all() as Record<
      string,
      unknown
    >[];
    const filterKeys: string[] = filter ? Object.keys(filter) : [];
    const sortSpecs = opts && opts.sort ? opts.sort : [];

    const out: T[] = raw
      .map(cloneRow as <U>(v: U) => U)
      .map(
        (r) =>
          normalizeRow(r as Record<string, unknown>, this.state.schema.columns) as unknown as T,
      );

    const filtered: T[] =
      filterKeys.length === 0
        ? out
        : out.filter((r) => {
            const rec = r as unknown as Record<string, unknown>;
            for (const k of filterKeys) {
              const want = (filter as unknown as Record<string, unknown>)[k];
              if (want === undefined) continue;
              if (rec[k] !== want) return false;
            }
            return true;
          });

    if (sortSpecs.length > 0) {
      filtered.sort((a, b) => {
        const ar = a as unknown as Record<string, unknown>;
        const br = b as unknown as Record<string, unknown>;
        for (const s of sortSpecs) {
          const av = ar[String(s.column)];
          const bv = br[String(s.column)];
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

    let sliced: T[] = filtered;
    if (opts && opts.offset && opts.offset > 0) sliced = sliced.slice(opts.offset);
    if (opts && opts.limit !== undefined && opts.limit >= 0) sliced = sliced.slice(0, opts.limit);
    return sliced;
  }

  count(filter?: Partial<T>): number {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT * FROM ${qid(this.tableName)}`).all() as Record<
      string,
      unknown
    >[];
    let n = 0;
    for (const raw of rows) {
      const row = normalizeRow(raw, this.state.schema.columns) as Record<string, unknown>;
      if (matchesFilter(row, filter)) n++;
    }
    return n;
  }

  private validateRow(row: T): void {
    for (const col of this.state.schema.columns) {
      const v = (row as unknown as Record<string, unknown>)[col.name];
      if (v === undefined) continue;
      if (!isCompatibleWithSpec(v, col)) {
        throw new Error(
          `SqliteTable(${this.tableName}).insert: column ${col.name} value ${String(
            v,
          )} is incompatible with declared type ${col.type}`,
        );
      }
    }
  }
}

function qid(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeRow(
  row: Record<string, unknown>,
  columns: ReadonlyArray<{ name: string; type: import('./types').ColumnType }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const col of columns) {
    const v = out[col.name];
    if (v === null || v === undefined) continue;
    out[col.name] = coerceColumn(v, col.type);
  }
  return out;
}

export interface SqliteUnavailable {
  available: false;
  reason: string;
}

export interface SqliteAvailable {
  available: true;
  Database: new (path: string) => SqliteNativeDatabase;
}

export type SqliteAvailability = SqliteAvailable | SqliteUnavailable;

let cachedAvailability: SqliteAvailability | null = null;

export function probeSqlite(): SqliteAvailability {
  if (cachedAvailability) return cachedAvailability;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('better-sqlite3') as new (path: string) => SqliteNativeDatabase;
    if (typeof mod !== 'function') {
      cachedAvailability = {
        available: false,
        reason: 'better-sqlite3 module did not export a constructor',
      };
      return cachedAvailability;
    }
    cachedAvailability = { available: true, Database: mod };
    return cachedAvailability;
  } catch (err) {
    cachedAvailability = {
      available: false,
      reason: `better-sqlite3 require failed: ${String((err as Error)?.message ?? err)}`,
    };
    return cachedAvailability;
  }
}

export function _resetSqliteProbeForTesting(): void {
  cachedAvailability = null;
}

export class SqliteOpenError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SqliteOpenError';
  }
}

export class SqliteDriver implements PersistentDriver {
  readonly backend = 'sqlite' as const;
  private readonly db: SqliteNativeDatabase;
  private readonly filePath: string;
  private readonly namespace?: string;
  private tables: Map<string, SqliteTableState<{ id: string }>> = new Map();

  constructor(private readonly config: DriverConfig) {
    if (!config.path) {
      throw new Error('SqliteDriver: `path` is required in DriverConfig');
    }
    const availability = probeSqlite();
    if (!availability.available) {
      throw new SqliteOpenError(`SqliteDriver unavailable: ${availability.reason}`);
    }
    this.filePath = config.path;
    this.namespace = config.namespace;
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      chmodSafe(dir, 0o700);
    } catch (err) {
      console.warn('[Catch]', err);
      /* dir may already exist */
    }
    try {
      this.db = new availability.Database(this.filePath);
    } catch (err) {
      throw new SqliteOpenError(
        `SqliteDriver: could not open ${this.filePath}: ${String((err as Error)?.message ?? err)}`,
        err,
      );
    }
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    } catch (err) {
      console.warn('[Catch]', err);
      /* pragma failures are recoverable */
    }
    chmodSafe(this.filePath, 0o600);
  }

  getTable<T extends { id: string }>(name: string, schema: TableSchema<T>): PersistentTable<T> {
    const existing = this.tables.get(name) as SqliteTableState<T> | undefined;
    if (!existing) {
      this.createTable(name, schema);
      const state: SqliteTableState<T> = { name, schema, closed: false };
      this.tables.set(name, state as SqliteTableState<{ id: string }>);
      return new SqliteTable<T>(this.db, state);
    }
    return new SqliteTable<T>(this.db, existing);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    // BEGIN IMMEDIATE acquires the RESERVED lock right away, sidestepping
    // SQLITE_BUSY under multi-process contention.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (err) {
        console.warn('[Catch]', err);
        /* rollback failure is swallowed; original error propagates */
      }
      throw err;
    }
  }

  close(): void {
    for (const state of this.tables.values()) state.closed = true;
    this.tables.clear();
    try {
      this.db.pragma('wal_checkpoint(FULL)');
    } catch (err) {
      console.warn('[Catch]', err);
      /* best-effort checkpoint */
    }
    try {
      this.db.close();
    } catch (err) {
      console.warn('[Catch]', err);
      /* close-after-corruption: test invariant still holds */
    }
  }

  describe(): DriverDescription {
    return {
      backend: this.backend,
      path: this.filePath,
      namespace: this.namespace,
      tables: Array.from(this.tables.keys()),
      fellBack: false,
    };
  }

  private createTable<T extends { id: string }>(name: string, schema: TableSchema<T>): void {
    const cols = schema.columns
      .map((c) => {
        const sqlType = c.type === 'string' ? 'TEXT' : c.type === 'number' ? 'REAL' : 'INTEGER';
        const pk = c.name === 'id' ? ' PRIMARY KEY' : '';
        return `${qid(c.name)} ${sqlType}${pk}`;
      })
      .join(', ');
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${qid(name)} (${cols})`);
    for (const c of schema.columns) {
      if (c.index) {
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS ${qid(`idx_${name}_${c.name}`)} ON ${qid(name)}(${qid(c.name)})`,
        );
      }
    }
  }
}

function chmodSafe(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    if (process.platform === 'win32') return;
    // eslint-disable-next-line no-console
    console.warn(`[SqliteDriver] chmod ${mode.toString(8)} on ${target} failed: ${String(err)}`);
  }
}
