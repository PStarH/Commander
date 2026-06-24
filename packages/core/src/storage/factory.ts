/**
 * Persistent-driver factory (Phase 1 of iss-001).
 *
 * Functions:
 *   - createDriver(config): hard factory — throws on failure
 *   - createDriverSoft(config): soft factory — falls back to in-memory on
 *     better-sqlite3 unavailability / open failures. Returns the chosen
 *     driver's describe() so callers can observe degradation.
 *
 * The factory never imports better-sqlite3 directly — it goes through
 * probeSqlite() so a missing native module is detected lazily and the
 * warn-and-fallback path is well-defined.
 */

import { DriverBackend, DriverConfig, DriverDescription, PersistentDriver } from './types';
import { InMemoryDriver } from './inMemoryDriver';
import { SqliteDriver, SqliteOpenError, probeSqlite } from './sqliteDriver';
import { JsonDriver } from './jsonDriver';

export interface CreateDriverResult {
  driver: PersistentDriver;
  description: DriverDescription;
  fellBack: boolean;
  fallbackReason?: string;
}

/**
 * Create a driver for the requested backend. Throws on construction failure
 * (open error, missing native, invalid config). Use createDriverSoft() if
 * you need guaranteed-non-throwing semantics.
 */
export function createDriver(config: DriverConfig): PersistentDriver {
  switch (config.backend) {
    case 'memory':
      return new InMemoryDriver(config);
    case 'json':
      return new JsonDriver(config);
    case 'sqlite':
      return new SqliteDriver(config);
    default:
      throw new Error(
        `createDriver: unknown backend ${String((config as { backend: string }).backend)}`,
      );
  }
}

/**
 * Create a driver, falling back to in-memory if the requested backend cannot
 * be opened or its native binding is unavailable. The chosen backend is
 * reported in the description so callers can subscribe to degradation.
 */
export function createDriverSoft(config: DriverConfig): CreateDriverResult {
  try {
    const driver = createDriver(config);
    return {
      driver,
      description: driver.describe(),
      fellBack: false,
    };
  } catch (err) {
    // Only fall back if the requested backend was sqlite — json/memory
    // failure is the caller's bug, not an availability issue.
    if (config.backend !== 'sqlite') throw err;
    const mem = new InMemoryDriver();
    return {
      driver: mem,
      description: { ...mem.describe(), fellBack: true },
      fellBack: true,
      fallbackReason:
        (err as Error)?.message ?? (err instanceof SqliteOpenError ? 'SqliteOpenError' : 'unknown'),
    };
  }
}

/**
 * Cheap pre-flight check — returns true iff SQLite is usable. Use to gate
 * tests or to short-circuit a soft-fallback path.
 */
export function isSqliteUsable(): boolean {
  return probeSqlite().available;
}

/**
 * Returns the list of available backends. Always includes 'memory';
 * 'sqlite' iff better-sqlite3 is loadable; 'json' iff fs is available
 * (always true in node).
 */
export function listAvailableBackends(): DriverBackend[] {
  const out: DriverBackend[] = ['memory', 'json'];
  if (isSqliteUsable()) out.unshift('sqlite');
  return out;
}
