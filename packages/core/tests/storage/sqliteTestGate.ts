/**
 * Durability-acceptance gate for the SQLite-backed storage suites.
 *
 * Why this exists
 * ---------------
 * `sqliteDriver.test.ts` and `persistentStore.test.ts` guard the durability
 * contracts (persist-across-reopen, atomic CAS, transaction rollback, lease and
 * recovery behaviour). Both used to gate every case with
 * `it.skipIf(!probeSqlite().available)`.
 *
 * When the better-sqlite3 native binding is missing, every one of those cases
 * skips, vitest reports zero failures, and the run exits 0. A job that never
 * measured durability therefore produced a green required check — the exact
 * failure mode this repository forbids: an unmeasured result must never be
 * converted into success.
 *
 * Two further problems with relying on `probeSqlite()` alone:
 *
 *   1. It only checks that `require('better-sqlite3')` returns a constructor.
 *      A module whose native addon is present but unusable still reports
 *      `available: true`, so "available" was not evidence of a working binding.
 *   2. It caches its verdict for the process, so a binding that breaks later in
 *      the run is never re-checked.
 *
 * What this module does
 * ---------------------
 *   - Runs a *functional* probe: open a temporary database, create a table,
 *     insert a row, read it back, close, and remove the file.
 *   - Treats `COMMANDER_REQUIRE_SQLITE_TESTS=1` (set by the release-gate job)
 *     as a hard requirement: if the binding is unusable the suite fails loudly
 *     instead of skipping.
 *   - Emits a greppable `SQLITE_DURABILITY_NOT_RUN` marker whenever the suites
 *     are about to skip, so a structured report can distinguish
 *     "not measured" from "measured and passing".
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeSqlite } from '../../src/storage';

/** Values accepted as "the release gate requires SQLite". Anything else is not. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export interface SqliteGateResult {
  /** True only when a real open/write/read/close cycle succeeded. */
  available: boolean;
  /** Why the binding is unusable. Empty when `available` is true. */
  reason: string;
}

/**
 * True when the caller has declared that this run is a release gate, in which
 * case an unusable SQLite binding is a hard failure rather than a skip.
 *
 * Unset/empty/unrecognised values are treated as "not required" — this flag
 * only ever *tightens* the gate, so an unparseable value cannot loosen it.
 */
export function sqliteTestsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.COMMANDER_REQUIRE_SQLITE_TESTS;
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** Minimal native surface the functional probe needs. */
interface ProbeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { get(param?: unknown): unknown };
  close(): void;
}

/**
 * Open a temporary SQLite database and exercise the full native round trip.
 * Returns a failure reason rather than throwing so callers can decide whether
 * an unusable binding is a skip or a hard error.
 */
export function probeSqliteFunctionally(): SqliteGateResult {
  const moduleProbe = probeSqlite();
  if (!moduleProbe.available) {
    return { available: false, reason: moduleProbe.reason ?? 'better-sqlite3 is not loadable' };
  }

  const dir = mkdtempSync(join(tmpdir(), 'sqlite-gate-'));
  const dbPath = join(dir, 'probe.db');
  let db: ProbeDatabase | undefined;
  try {
    const Database = moduleProbe.Database as unknown as new (path: string) => ProbeDatabase;
    db = new Database(dbPath);
    db.exec('CREATE TABLE gate_probe (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    db.exec("INSERT INTO gate_probe (id, value) VALUES ('k', 42)");
    const row = db.prepare('SELECT value FROM gate_probe WHERE id = ?').get('k') as
      { value: number } | undefined;
    if (!row || row.value !== 42) {
      return {
        available: false,
        reason: `functional probe read back ${JSON.stringify(row)} instead of { value: 42 }`,
      };
    }
    return { available: true, reason: '' };
  } catch (err) {
    return {
      available: false,
      reason: `functional probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* the probe already failed; a close error adds nothing */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Resolve whether the SQLite durability suites may run.
 *
 * The probe and the environment are injectable so the decision logic can be
 * tested deterministically without having to break the real native binding.
 *
 * @throws when `COMMANDER_REQUIRE_SQLITE_TESTS` is set and the binding is
 *   unusable. Throwing at module scope makes the whole suite fail to collect,
 *   which is the intended fail-closed behaviour for a release gate.
 */
export function sqliteDurabilityGate(
  probe: () => SqliteGateResult = probeSqliteFunctionally,
  env: NodeJS.ProcessEnv = process.env,
): SqliteGateResult {
  const result = probe();
  if (result.available) return result;

  if (sqliteTestsRequired(env)) {
    throw new Error(
      'COMMANDER_REQUIRE_SQLITE_TESTS is set but the SQLite durability suites cannot run: ' +
        `${result.reason}. ` +
        'Refusing to skip the persistence acceptance suite — an unmeasured durability ' +
        'result must never be reported as a pass.',
    );
  }

  // Development mode: skipping is allowed, but the skip is announced so that a
  // structured report can tell "not measured" apart from "measured and passed".
  console.warn(
    '[sqlite-gate] SQLITE_DURABILITY_NOT_RUN — the SQLite persistence suites will be ' +
      `skipped, so durability was NOT measured. Reason: ${result.reason}. ` +
      'Set COMMANDER_REQUIRE_SQLITE_TESTS=1 to make this a hard failure.',
  );
  return result;
}
