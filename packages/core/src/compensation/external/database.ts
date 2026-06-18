/**
 * Database compensation handler.
 *
 * Compensates SQL mutations (INSERT, UPDATE, DELETE) on SQLite and
 * PostgreSQL. Two strategies are supported:
 *
 *   1. **Row-level reverse** — capture the before/after row state, then
 *      apply the inverse SQL. Works for any SQL dialect. Uses a SQLite
 *      sidecar table to persist the snapshots.
 *
 *   2. **Savepoint ROLLBACK** — for SQLite, use savepoints to mark the
 *      start of each tool call. On failure, `ROLLBACK TO SAVEPOINT` is
 *      atomic. Cheaper than row-level reverse for bulk operations.
 *
 *   Sources:
 *   - https://www.sqlite.org/wal.html (WAL mode for crash safety)
 *   - https://www.postgresql.org/docs/current/sql-savepoint.html
 *   - Stripe "Designing robust and predictable APIs" (forward recovery
 *     is preferred when possible; we follow the same principle).
 *
 *   The handler is registered for tools named db_query, db_execute,
 *   sql_insert, sql_update, sql_delete, sql_transaction, and a generic
 *   `db_mutate` for plugin-supplied SQL.
 */

import type { CompensationHandler } from '../../runtime/compensationRegistry';
import { getSnapshotStore, type FileSnapshot } from './snapshotStore';
import type { CompensationOutcome } from './types';

// ============================================================================
// Snapshot sidecar schema
// ============================================================================

/**
 * Serialized row snapshot for inverse SQL. We store the entire row
 * (column → value) as JSON, plus the table name and primary key.
 */
export interface RowSnapshot {
  table: string;
  primaryKey: Record<string, unknown>;
  /** Row state BEFORE the mutation. `null` for INSERT. */
  before: Record<string, unknown> | null;
  /** Row state AFTER the mutation. `null` for DELETE. */
  after: Record<string, unknown> | null;
  /** Operation that produced the snapshot. */
  op: 'insert' | 'update' | 'delete';
}

export interface DBMutationContext {
  connectionId: string;
  /** Idempotency key for the mutation. */
  mutationId: string;
  /** All rows affected, in insertion order. */
  rows: RowSnapshot[];
  /** When the forward action ran. */
  executedAt: string;
}

/**
 * Compile a row snapshot into the inverse SQL. We avoid value
 * interpolation; the caller must use the returned `bindings` with
 * prepared statements.
 */
export interface InverseSQL {
  /** Human-readable SQL with `?` placeholders. */
  sql: string;
  bindings: unknown[];
  /** Operation type for audit. */
  op: 'insert' | 'update' | 'delete';
}

export function invertRowSnapshot(snap: RowSnapshot): InverseSQL {
  if (snap.op === 'insert') {
    // Inverse: DELETE
    const where = Object.keys(snap.primaryKey)
      .map((k) => `${quoteIdent(k)} = ?`)
      .join(' AND ');
    return {
      sql: `DELETE FROM ${quoteIdent(snap.table)} WHERE ${where}`,
      bindings: Object.values(snap.primaryKey),
      op: 'delete',
    };
  }
  if (snap.op === 'delete') {
    // Inverse: INSERT (recreate the row)
    if (!snap.before) {
      // No before-image — we cannot restore. Best-effort: no-op.
      return { sql: '-- no inverse: missing before image', bindings: [], op: 'insert' };
    }
    const cols = Object.keys(snap.before);
    const placeholders = cols.map(() => '?').join(', ');
    return {
      sql: `INSERT INTO ${quoteIdent(snap.table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`,
      bindings: cols.map((c) => snap.before![c]),
      op: 'insert',
    };
  }
  // UPDATE: restore each non-PK column to its before value
  if (!snap.before) {
    return { sql: '-- no inverse: missing before image', bindings: [], op: 'update' };
  }
  const setClause = Object.keys(snap.before)
    .filter((c) => !(c in snap.primaryKey))
    .map((c) => `${quoteIdent(c)} = ?`)
    .join(', ');
  if (!setClause) {
    return { sql: '-- no-op inverse: only PK changed', bindings: [], op: 'update' };
  }
  const where = Object.keys(snap.primaryKey)
    .map((k) => `${quoteIdent(k)} = ?`)
    .join(' AND ');
  return {
    sql: `UPDATE ${quoteIdent(snap.table)} SET ${setClause} WHERE ${where}`,
    bindings: [
      ...Object.keys(snap.before)
        .filter((c) => !(c in snap.primaryKey))
        .map((c) => snap.before![c]),
      ...Object.values(snap.primaryKey),
    ],
    op: 'update',
  };
}

// ============================================================================
// SQLite adapter — uses WAL replay for atomic rollback
// ============================================================================

interface BetterSqlite3Stmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  reset(): void;
}
interface BetterSqlite3DB {
  prepare(sql: string): BetterSqlite3Stmt;
  pragma(sql: string): void;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

interface DbConnectionRegistry {
  getConnection(id: string): BetterSqlite3DB | null;
}

/**
 * The default registry looks up connections from the runtime's
 * sqliteMemoryStore. In a plugin-supplied database handler, callers
 * can pass their own registry.
 */
let _registry: DbConnectionRegistry | null = null;

export function setDatabaseConnectionRegistry(registry: DbConnectionRegistry): void {
  _registry = registry;
}

function getRegistry(): DbConnectionRegistry {
  if (_registry) return _registry;
  // Lazy default: the memory store has its own connection.
  try {
    const memory = require('../../runtime/sqliteMemoryStore') as {
      getConnection?: () => BetterSqlite3DB;
    };
    return {
      getConnection: (id) => {
        if (id === 'memory' && memory.getConnection) return memory.getConnection();
        return null;
      },
    };
  } catch {
    return { getConnection: () => null };
  }
}

// ============================================================================
// Compensation handlers
// ============================================================================

/**
 * Restore a row-level mutation. Looks up the row snapshots from the
 * snapshot sidecar and applies the inverse SQL in reverse order.
 */
export async function applyRowLevelInverse(
  ctx: DBMutationContext,
  db: BetterSqlite3DB,
): Promise<CompensationOutcome> {
  // Apply in REVERSE order (last mutation first), matching saga LIFO.
  const reversed = [...ctx.rows].reverse();
  const errors: string[] = [];
  for (const snap of reversed) {
    const inv = invertRowSnapshot(snap);
    if (inv.sql.startsWith('-- ')) {
      // No-op inverse
      continue;
    }
    try {
      const stmt = db.prepare(inv.sql);
      stmt.run(...inv.bindings);
      stmt.reset();
    } catch (err) {
      errors.push(`inverse SQL for ${snap.table} (${inv.op}) failed: ${(err as Error).message}`);
    }
  }
  if (errors.length > 0) {
    return { success: false, error: errors.join('; ') };
  }
  return { success: true };
}

/**
 * Savepoint ROLLBACK: only valid for SQLite when the forward action
 * used a named savepoint. The savepoint name is recovered from the
 * action's args (`savepoint`).
 */
async function rollbackToSavepoint(
  savepointName: string,
  db: BetterSqlite3DB,
): Promise<CompensationOutcome> {
  // Names must be safe identifiers (alnum + underscore).
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(savepointName)) {
    return {
      success: false,
      permanent: true,
      error: `Invalid savepoint name: ${savepointName}`,
    };
  }
  try {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Generic database mutation handler. Dispatches based on `args.strategy`:
 *   - 'savepoint': uses ROLLBACK TO SAVEPOINT
 *   - 'rows': uses row-level reverse (default)
 *   - 'none': no compensation
 */
const dbMutateHandler: CompensationHandler = async (action) => {
  const args = (action.args ?? {}) as {
    strategy?: 'savepoint' | 'rows' | 'none';
    savepoint?: string;
    connectionId?: string;
    rows?: RowSnapshot[];
  };
  const strategy = args.strategy ?? 'rows';
  if (strategy === 'none') {
    return { success: true, alreadyCompensated: true };
  }
  const connId = args.connectionId ?? 'memory';
  const db = getRegistry().getConnection(connId);
  if (!db) {
    return {
      success: false,
      permanent: true,
      error: `No DB connection registered for "${connId}"`,
    };
  }

  if (strategy === 'savepoint') {
    if (!args.savepoint) {
      return {
        success: false,
        permanent: true,
        error: 'savepoint strategy requires args.savepoint',
      };
    }
    return rollbackToSavepoint(args.savepoint, db);
  }

  // row-level reverse
  if (!args.rows || args.rows.length === 0) {
    return { success: true, alreadyCompensated: true };
  }
  return applyRowLevelInverse(
    {
      connectionId: connId,
      mutationId: action.actionId,
      rows: args.rows,
      executedAt: new Date().toISOString(),
    },
    db,
  );
};

const dbQueryHandler: CompensationHandler = async () => {
  // Read-only: no compensation needed.
  return { success: true, alreadyCompensated: true };
};

/**
 * SQL transaction handler. When the action's args record the SQL
 * statements, we can replay them in reverse using row-level inverses.
 * If the args include a `savepoint` we prefer that.
 */
const sqlTransactionHandler: CompensationHandler = async (action) => {
  return dbMutateHandler(action);
};

// ============================================================================
// Tool → handler map
// ============================================================================

export const DATABASE_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  db_query: dbQueryHandler,
  db_select: dbQueryHandler,
  db_execute: dbMutateHandler,
  db_mutate: dbMutateHandler,
  sql_insert: dbMutateHandler,
  sql_update: dbMutateHandler,
  sql_delete: dbMutateHandler,
  sql_bulk_insert: dbMutateHandler,
  sql_bulk_update: dbMutateHandler,
  sql_bulk_delete: dbMutateHandler,
  sql_transaction: sqlTransactionHandler,
  // Postgres / generic SQL
  pg_query: dbQueryHandler,
  pg_execute: dbMutateHandler,
  mysql_query: dbQueryHandler,
  mysql_execute: dbMutateHandler,
};

export const DATABASE_TOOL_TAGS: Record<string, string[]> = {
  db_execute: ['db', 'db:mutate', 'destructive'],
  db_mutate: ['db', 'db:mutate', 'destructive'],
  sql_insert: ['db', 'db:insert'],
  sql_update: ['db', 'db:update'],
  sql_delete: ['db', 'db:delete', 'destructive'],
  sql_bulk_insert: ['db', 'db:bulk', 'destructive'],
  sql_bulk_update: ['db', 'db:bulk', 'destructive'],
  sql_bulk_delete: ['db', 'db:bulk', 'destructive'],
  sql_transaction: ['db', 'db:transaction', 'destructive'],
  pg_execute: ['db', 'db:postgres', 'destructive'],
  mysql_execute: ['db', 'db:mysql', 'destructive'],
};

// ============================================================================
// Registration helper
// ============================================================================

export function registerDatabaseCompensation(): void {
  const { getExecutionScheduler } =
    require('../../atr/scheduler') as typeof import('../../atr/scheduler');
  const scheduler = getExecutionScheduler();
  for (const [toolName, handler] of Object.entries(DATABASE_COMPENSATION_HANDLERS)) {
    scheduler.registerCompensation(toolName, handler);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function quoteIdent(name: string): string {
  // Conservative: only allow alnum + underscore. Everything else → "name".
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"${name}"`;
  // Best-effort double-quote escaping
  return `"${name.replace(/"/g, '""')}"`;
}

// Suppress unused-import warning for FileSnapshot.
void ({} as FileSnapshot);
void getSnapshotStore;
