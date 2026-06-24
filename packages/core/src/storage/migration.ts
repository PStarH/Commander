/**
 * Migration runner (Phase 1 of iss-001).
 *
 * Models an idempotent migration pipeline. Each MigrationStep has a `version`
 * string (M1-key) and an `up(driver)` callback. applyMigrations records
 * applied versions in a `_migrations` table when the driver is SQLite, and
 * in a WeakMap-keyed fallback Set for json / in-memory drivers so re-runs
 * don't double-apply.
 *
 * BLOCKER-fix #2: previous implementation only tracked applied versions on
 * SQLite; json/memory would re-apply every step on every call. Now tracked
 * per-driver-identity via a module-level WeakMap so json/memory a caller
 * may legitimately re-run migrations.
 *
 * On error, the failing step is recorded in the result and subsequent
 * steps do NOT run. The runner never throws — callers should inspect
 * `result.errors`.
 */

import type { ApplyMigrationsResult, MigrationStep, PersistentDriver } from './types';

const MIGRATIONS_TABLE = '_migrations';

interface MigrationRow {
  version: string;
  appliedAt: string;
  description: string;
}

/**
 * Per-driver applied-version tracking. For non-SQLite drivers we can't
 * persist state across calls (JsonDriver is file-backed but the schema
 * doesn't include _migrations; InMemoryDriver is per-process). Use the
 * driver's reference identity as the key — same driver → same Set.
 */
const seenByDriver = new WeakMap<object, Set<string>>();

function seenFor(driver: PersistentDriver): Set<string> {
  let s = seenByDriver.get(driver);
  if (!s) {
    s = new Set<string>();
    seenByDriver.set(driver, s);
  }
  return s;
}

export async function applyMigrations(
  driver: PersistentDriver,
  steps: MigrationStep[],
): Promise<ApplyMigrationsResult> {
  const result: ApplyMigrationsResult = {
    applied: [],
    skipped: [],
    errors: [],
  };

  // Bootstrap the migrations metadata table (SQLite) so subsequent reads
  // find something. Json / memory skip this and rely on the in-process Set.
  ensureMigrationsTable(driver);

  // Read applied versions from the driver's persisted store when possible.
  const fromStore = readApplied(driver);
  // Merge with the in-process tracker so cross-run state is correct for
  // json / memory (which have no `_migrations` table semantics yet).
  const seen = new Set<string>(fromStore);
  const inMem = seenFor(driver);
  for (const v of inMem) seen.add(v);
  const sorted = steps.slice().sort((a, b) => versionKey(a.version) - versionKey(b.version));

  for (const step of sorted) {
    if (seen.has(step.version)) {
      result.skipped.push(step.version);
      continue;
    }
    try {
      await step.up(driver);
      const row = {
        version: step.version,
        appliedAt: new Date().toISOString(),
        description: step.description,
      };
      recordApplied(driver, row);
      inMem.add(step.version);
      result.applied.push(step.version);
    } catch (err) {
      result.errors.push({
        version: step.version,
        error: (err as Error)?.message ?? String(err),
      });
      break;
    }
  }

  return result;
}

/**
 * Tie-breaker for migration versions. Numeric prefixes are preferred over
 * lexicographic ordering so M2 sorts before M10.
 */
function versionKey(version: string): number {
  const m = version.match(/^(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function ensureMigrationsTable(driver: PersistentDriver): void {
  if (driver.backend !== 'sqlite') return;
  const anyDriver = driver as PersistentDriver & {
    db?: { exec: (sql: string) => void };
  };
  if (!anyDriver.db || typeof anyDriver.db.exec !== 'function') return;
  try {
    anyDriver.db.exec(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} ` +
        '(version TEXT PRIMARY KEY, appliedAt TEXT NOT NULL, description TEXT)',
    );
  } catch (err) {
    console.warn('[Catch]', err);
    /* best-effort bootstrap */
  }
}

function readApplied(driver: PersistentDriver): Set<string> {
  const out = new Set<string>();
  if (driver.backend !== 'sqlite') return out;
  const anyDriver = driver as PersistentDriver & {
    db?: {
      prepare: (sql: string) => {
        all: (params?: Record<string, unknown>) => unknown[];
      };
    };
  };
  if (!anyDriver.db || typeof anyDriver.db.prepare !== 'function') return out;
  try {
    const rows = anyDriver.db.prepare(`SELECT version FROM ${MIGRATIONS_TABLE}`).all() as Array<{
      version: string;
    }>;
    for (const r of rows) out.add(r.version);
  } catch (err) {
    console.warn('[Catch]', err);
    // table missing → no applied versions
  }
  return out;
}

function recordApplied(driver: PersistentDriver, row: MigrationRow): void {
  if (driver.backend !== 'sqlite') return;
  const anyDriver = driver as PersistentDriver & {
    db?: {
      prepare: (sql: string) => {
        run: (params: Record<string, unknown>) => { changes: number };
      };
    };
  };
  if (!anyDriver.db || typeof anyDriver.db.prepare !== 'function') return;
  try {
    anyDriver.db
      .prepare(
        `INSERT OR REPLACE INTO ${MIGRATIONS_TABLE} (version, appliedAt, description) ` +
          'VALUES (@version, @appliedAt, @description)',
      )
      .run({
        version: row.version,
        appliedAt: row.appliedAt,
        description: row.description,
      });
  } catch (err) {
    console.warn('[Catch]', err);
    /* best-effort */
  }
}
