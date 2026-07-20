import type Database from 'better-sqlite3';
import type { SqlClient, SqlPool, SqlQueryResult } from './postgres.js';

const JSON_COLUMNS = new Set([
  'metadata', 'dependencies', 'input', 'output', 'error', 'request', 'response',
  'payload', 'capabilities', 'labels', 'tenant_ids', 'reconcile_last_error', 'last_error',
]);

function parseJsonFields<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row };
  for (const key of Object.keys(out)) {
    if (!JSON_COLUMNS.has(key)) continue;
    const value = out[key];
    if (typeof value === 'string' && value.length > 0) {
      try {
        (out as Record<string, unknown>)[key] = JSON.parse(value);
      } catch {
        /* keep string */
      }
    }
  }
  if ('paused' in out && typeof out.paused === 'number') {
    (out as Record<string, unknown>).paused = out.paused === 1;
  }
  if ('allowed' in out && typeof out.allowed === 'number') {
    (out as Record<string, unknown>).allowed = out.allowed === 1;
  }
  if ('enabled' in out && typeof out.enabled === 'number') {
    (out as Record<string, unknown>).enabled = out.enabled === 1;
  }
  return out;
}

/** Translate Postgres parameter placeholders and dialect to SQLite. */
export function adaptPostgresSqlToSqlite(sql: string, values: readonly unknown[] = []): { sql: string; values: unknown[] } {
  const expanded: unknown[] = [];
  let out = sql;
  out = out.replace(/\s+FOR UPDATE(\s+OF\s+[\w,\s]+)?(\s+SKIP LOCKED)?/gi, '');
  out = out.replace(/jsonb_array_elements_text\(([^)]+)\)/g, 'json_each($1)');
  out = out.replace(
    /\$1::timestamptz\s*\+\s*\(POWER\(2,\s*GREATEST\(0,\s*attempts-1\)\)\s*\*\s*interval\s+'1 second'\)/g,
    "strftime('%Y-%m-%dT%H:%M:%fZ', datetime($1, printf('+%d seconds', CAST((POWER(2, MAX(0, attempts-1))) AS INTEGER))))",
  );
  // Outbox/reconcile claim CTE+UPDATE templates are native-only in sqlite.ts (not adapted).
  out = out.replace(
    /UPDATE commander_steps s SET([\s\S]*?)FROM expired WHERE s\.id=expired\.id RETURNING s\.\*/,
    (_, setBody: string) =>
      `UPDATE commander_steps SET${setBody.replace(/(?<![.\w])s\.(\w+)/g, '$1')}WHERE id IN (SELECT id FROM expired) RETURNING *`,
  );
  out = out.replace(
    /\$(\d+)::timestamptz\s*-\s*interval\s+'60 seconds'/g,
    (_, num) => `datetime($${num}, '-60 seconds')`,
  );
  out = out.replace(/\bGREATEST\b/g, 'MAX');
  out = out.replace(
    /\bnow\(\)\s*\+\s*\(POWER\(2,\s*attempts\)\s*\*\s*INTERVAL\s+'1 second'\)/g,
    "strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', printf('+%d seconds', CAST((POWER(2, attempts)) AS INTEGER))))",
  );
  out = out.replace(/\bnow\(\)/g, "strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  out = out.replace(/::jsonb/g, '');
  out = out.replace(/::timestamptz/g, '');
  out = out.replace(/::date/g, '');
  out = out.replace(/::text/g, '');
  out = out.replace(/::boolean/g, '');
  out = out.replace(/jsonb_build_object/g, 'json_object');
  out = out.replace(/UPDATE commander_effects e\b/g, 'UPDATE commander_effects');
  out = out.replace(/UPDATE commander_steps s\b/g, 'UPDATE commander_steps');
  out = out.replace(/json_each\(s\.dependencies\)/g, 'json_each(commander_steps.dependencies)');
  out = out.replace(/(?<![.\w])e\.(\w+)/g, 'commander_effects.$1');
  out = out.replace(/RETURNING e\.\*/g, 'RETURNING *');
  out = out.replace(/RETURNING commander_effects\.\*/g, 'RETURNING *');
  out = out.replace(/RETURNING commander_steps\.\*/g, 'RETURNING *');
  out = out.replace(/\$(\d+)(::\w+)?/g, (_, num) => {
    const index = Number(num) - 1;
    expanded.push(values[index]);
    return '?';
  });
  return { sql: out, values: expanded };
}

function serializeSqliteValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function runQuery<T = Record<string, unknown>>(
  db: Database.Database,
  sql: string,
  values: readonly unknown[],
): SqlQueryResult<T> {
  const hasPgParams = /\$\d+/.test(sql);
  const { sql: adaptedSql, values: boundValues } = hasPgParams
    ? adaptPostgresSqlToSqlite(sql, values)
    : { sql, values: [...values] };
  const bound = boundValues.map(serializeSqliteValue);
  const stmt = db.prepare(adaptedSql);
  const trimmed = adaptedSql.trimStart().toUpperCase();
  const returnsRows =
    trimmed.startsWith('SELECT') ||
    trimmed.startsWith('WITH') ||
    /RETURNING/i.test(adaptedSql);

  if (returnsRows) {
    const rows = stmt.all(...bound).map((row) => parseJsonFields(row as Record<string, unknown>) as T);
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...bound);
  return { rows: [], rowCount: info.changes };
}

class SqliteSqlClient implements SqlClient {
  constructor(private readonly db: Database.Database) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    return runQuery<T>(this.db, sql, values);
  }

  release(): void {
    /* single-connection pool */
  }
}

/** better-sqlite3 pool compatible with PostgresKernelRepository SqlPool interface. */
export function createSqlitePool(db: Database.Database): SqlPool {
  return {
    connect: async () => new SqliteSqlClient(db),
  };
}
