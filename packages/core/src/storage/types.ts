/**
 * Persistent-store type definitions (Phase 1 of iss-001).
 *
 * These types define the driver-agnostic surface for SQLite / JSON / in-memory
 * backends. They intentionally do NOT import any driver implementation to
 * keep the abstraction boundary clean.
 *
 * Abstractions supported:
 *   - insert:            standardized write
 *   - insertOrReplace:   upsert (INSERT OR REPLACE semantics; replaces on key collision)
 *   - get:               read by primary id
 *   - update:            in-place patch by id (no precondition)
 *   - updateIf:          atomic compare-and-set: UPDATE only if both id AND a
 *                        user-supplied `where` predicate matches the current row
 *   - delete:            remove by id
 *   - query / count:     filter (with optional sort/limit/offset)
 *
 * The `updateIf` method is the ATR-critical compare-and-set primitive that
 * cols lease/fencing-epoch checks, idempotency-store reclaims, and saga state
 * transitions all rely on.
 */

export type ColumnType = 'string' | 'number' | 'boolean';

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  index?: boolean;
}

export interface TableSchema<T extends { id: string }> {
  name: string;
  columns: readonly ColumnSpec[];
}

export interface QueryOptions<T extends { id: string }> {
  sort?: Array<{ column: keyof T; direction: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}

export interface DriverConfig {
  backend: DriverBackend;
  path?: string;
  namespace?: string;
}

export type DriverBackend = 'sqlite' | 'json' | 'memory';

export interface DriverDescription {
  backend: string;
  path: string;
  namespace?: string;
  tables: string[];
  fellBack: boolean;
}

/**
 * PersistentTable<T> — driver-agnostic CRUD + CAS surface.
 *
 * Conventions:
 *   - All methods are synchronous; callers must wrap concurrent blocks in
 *     `driver.transaction(fn)` if they need atomicity guarantees.
 *   - `insertOrReplace` and `updateIf` model better-sqlite3's `INSERT OR
 *     REPLACE` and conditional `UPDATE ... WHERE` primitives consistently.
 *   - The T type must extend { id: string } so the driver can build a primary
 *     key index without inspecting caller-specific fields.
 */
export interface PersistentTable<T extends { id: string }> {
  /** INSERT a new row. Throws if id already exists (use insertOrReplace for upsert). */
  insert(row: T): T;
  /** INSERT OR REPLACE: upsert. Replaces the existing row on id collision. */
  insertOrReplace(row: T): T;
  /** SELECT one row by id. Returns null if missing. */
  get(id: string): T | null;
  /** UPDATE by id (no precondition). Returns false if id missing. */
  update(id: string, patch: Partial<T>): boolean;
  /**
   * Atomic compare-and-set: UPDATE WHERE id=? AND <where fields match current row>.
   * Returns the updated row if the predicate matched and the UPDATE succeeded,
   * or null if the id doesn't exist OR the predicate didn't match.
   *
   * Designed for:
   *   - lease heartbeat: updateIf(id, { token }, { expiresAt: ... })
   *   - saga transitions: updateIf(runId, { state: 'PENDING', leaseToken, fencingEpoch }, { state: 'EXECUTING' })
   *   - idempotency reclaim: updateIf(id, { state: 'in_progress' }, { expiresAt: ... })  // actually we need not-and-state
   *
   * Empty `where` is equivalent to plain `update()` but still returns the row.
   */
  updateIf(id: string, where: Partial<T>, patch: Partial<T>): T | null;
  /** DELETE by id. Returns false if id missing. */
  delete(id: string): boolean;
  /** SELECT filtered rows with optional sort/limit/offset. */
  query(filter?: Partial<T>, opts?: QueryOptions<T>): T[];
  /** SELECT COUNT(*) with the same filter semantics as query(). */
  count(filter?: Partial<T>): number;
}

export interface PersistentDriver {
  readonly backend: DriverBackend;
  getTable<T extends { id: string }>(name: string, schema: TableSchema<T>): PersistentTable<T>;
  /**
   * Run `fn()` within an atomic transaction. Implementations must roll back
   * (or no-op) on throw, commit on resolve. The async wrapper is necessary
   * because better-sqlite3's auto-wrapper commits before async resolves.
   */
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): void;
  describe(): DriverDescription;
}

export interface MigrationStep {
  version: string;
  description: string;
  up(driver: PersistentDriver): void | Promise<void>;
  down?(driver: PersistentDriver): void | Promise<void>;
}

export interface ApplyMigrationsResult {
  applied: string[];
  skipped: string[];
  errors: Array<{ version: string; error: string }>;
}

/**
 * Reason metadata attached to every fallback from a richer backend (sqlite)
 * to a less rich one (memory). Useful for callers that need to know
 * degradation occurred without the driver throwing.
 */
export interface FallbackInfo {
  reason: string;
  from: DriverBackend;
  to: DriverBackend;
}
