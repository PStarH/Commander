/**
 * JsonDriver — file-backed PersistentDriver implementation using one JSON file
 * per table inside a configured directory.
 *
 * Atomicity strategy:
 *   - insert/update/delete trigger an immediate synchronous flushNow() —
 *     this is the same contract kill9.test.ts:122 expects: after `save()`,
 *     a freshly opened backend on the same path sees the row.
 *   - flushNow() writes to <file>.tmp then atomically renames over the
 *     target file. POSIX rename(2) is atomic within the same filesystem.
 *   - chmod 0o600 on the data file and 0o700 on the parent directory to
 *     match filePermissions.test.ts:310-384 invariant.
 *
 * Concurrency: a single in-process mutex serializes file writes. Cross-process
 * safety relies on atomic rename semantics; concurrent readers may see stale
 * snapshots for a few milliseconds during a flush.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import type {
  DriverDescription,
  DriverConfig,
  PersistentDriver,
  PersistentTable,
  QueryOptions,
  TableSchema,
} from './types';
import { matchesFilter } from './utils';

interface JsonTableState<T extends { id: string }> {
  schema: TableSchema<T>;
  rows: Map<string, T>;
  filePath: string;
  closed: boolean;
}

class JsonTable<T extends { id: string }> implements PersistentTable<T> {
  constructor(
    private readonly name: string,
    private readonly state: JsonTableState<T>,
    private readonly driver: JsonDriver,
  ) {}

  private assertOpen(): void {
    if (this.state.closed) {
      throw new Error(`JsonTable(${this.name}): already closed`);
    }
  }

  insert(row: T): T {
    this.assertOpen();
    if (!row.id || typeof row.id !== 'string') {
      throw new Error(`JsonTable(${this.name}).insert: row.id required`);
    }
    if (this.state.rows.has(row.id)) {
      throw new Error(`JsonTable(${this.name}).insert: row with id ${row.id} already exists`);
    }
    const clone = cloneRow(row);
    this.state.rows.set(row.id, clone);
    this.driver.flushTable(this.state);
    return clone;
  }

  insertOrReplace(row: T): T {
    this.assertOpen();
    if (!row.id || typeof row.id !== 'string') {
      throw new Error(`JsonTable(${this.name}).insertOrReplace: row.id required`);
    }
    const clone = cloneRow(row);
    this.state.rows.set(row.id, clone);
    this.driver.flushTable(this.state);
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
    this.driver.flushTable(this.state);
    return true;
  }

  updateIf(id: string, where: Partial<T>, patch: Partial<T>): T | null {
    this.assertOpen();
    const existing = this.state.rows.get(id);
    if (!existing) return null;
    if (!matchesFilter(existing as Record<string, unknown>, where)) return null;
    const merged: T = { ...existing, ...patch, id };
    this.state.rows.set(id, merged);
    this.driver.flushTable(this.state);
    return cloneRow(merged);
  }

  delete(id: string): boolean {
    this.assertOpen();
    const removed = this.state.rows.delete(id);
    if (removed) this.driver.flushTable(this.state);
    return removed;
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

interface PersistedFile<T extends { id: string }> {
  schema: TableSchema<T>;
  rows: T[];
}

export class JsonDriver implements PersistentDriver {
  readonly backend = 'json' as const;
  private readonly rootDir: string;
  private readonly tables = new Map<string, JsonTableState<{ id: string }>>();
  private closed = false;
  private transactionDepth = 0;

  constructor(config: Partial<DriverConfig>) {
    if (!config.path) {
      throw new Error('JsonDriver: `path` (directory) is required');
    }
    this.rootDir = config.path;
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      chmodSafe(this.rootDir, 0o700);
    } catch (err) {
      throw new Error(`JsonDriver: could not create root dir ${this.rootDir}: ${String(err)}`);
    }
  }

  getTable<T extends { id: string }>(name: string, schema: TableSchema<T>): PersistentTable<T> {
    if (this.closed) throw new Error('JsonDriver: already closed');
    const existing = this.tables.get(name) as JsonTableState<T> | undefined;
    if (existing) {
      return new JsonTable<T>(name, existing, this);
    }
    const filePath = path.join(this.rootDir, `${name}.json`);
    const persisted = loadPersisted<T>(filePath);
    const rows = new Map<string, T>();
    if (persisted) {
      for (const r of persisted.rows) rows.set(r.id, r);
    }
    const state: JsonTableState<T> = {
      schema,
      rows,
      filePath,
      closed: false,
    };
    this.tables.set(name, state as JsonTableState<{ id: string }>);
    // Persist schema on first touch so a fresh open sees the same shape.
    this.flushTable(state);
    return new JsonTable<T>(name, state, this);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new Error('JsonDriver: already closed');
    const snapshot: Array<{ name: string; rows: Map<string, unknown> }> = [];
    for (const [name, state] of this.tables.entries()) {
      const clone = new Map<string, unknown>();
      for (const [k, v] of (state.rows as Map<string, unknown>).entries()) {
        clone.set(k, cloneRow(v));
      }
      snapshot.push({ name, rows: clone });
    }
    this.transactionDepth++;
    try {
      const result = await fn();
      this.transactionDepth--;
      for (const state of this.tables.values()) this.flushTable(state);
      return result;
    } catch (err) {
      this.transactionDepth--;
      for (const snap of snapshot) {
        const state = this.tables.get(snap.name) as JsonTableState<{ id: string }> | undefined;
        if (state) {
          (state.rows as Map<string, unknown>).clear();
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
      path: this.rootDir,
      tables: Array.from(this.tables.keys()),
      fellBack: false,
    };
  }

  /** Synchronously write the in-memory state to disk via tmp+rename.
   *  Suppressed during transactions to allow proper rollback. */
  flushTable<T extends { id: string }>(state: JsonTableState<T>): void {
    if (this.transactionDepth > 0) return;
    const persisted: PersistedFile<T> = {
      schema: state.schema,
      rows: Array.from(state.rows.values()),
    };
    const tmpPath = `${state.filePath}.tmp`;
    const payload = JSON.stringify(persisted, null, 2);
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8' });
    chmodSafe(tmpPath, 0o600);
    fs.renameSync(tmpPath, state.filePath);
    chmodSafe(state.filePath, 0o600);
  }
}

function loadPersisted<T extends { id: string }>(filePath: string): PersistedFile<T> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as PersistedFile<T>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function chmodSafe(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    reportSilentFailure(err, 'jsonDriver:276');
    if (process.platform === 'win32') return;
    // eslint-disable-next-line no-console
    console.warn(`[JsonDriver] chmod ${mode.toString(8)} on ${target} failed`);
  }
}
