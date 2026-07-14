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
import { PostgresDriver, probePostgres } from './postgresDriver';

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
    case 'postgres':
      return new PostgresDriver(config);
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
 *
 * Architecture V2: production is fail-closed. Soft fallback to in-memory is
 * refused when NODE_ENV=production unless COMMANDER_ALLOW_SOFT_STORAGE=1 is
 * explicitly set by an operator (emergency only).
 */
export function createDriverSoft(config: DriverConfig): CreateDriverResult {
  const failClosed =
    process.env.NODE_ENV === 'production' && process.env.COMMANDER_ALLOW_SOFT_STORAGE !== '1';

  // Architecture V2: In production, only PostgreSQL is allowed as a durable
  // storage backend. SQLite and JSON are dev/test only — they are pod-local
  // and violate the shared-state invariant.
  if (
    failClosed &&
    (config.backend === 'sqlite' || config.backend === 'json' || config.backend === 'memory')
  ) {
    throw new Error(
      `createDriverSoft: fail-closed in production — backend '${config.backend}' is not allowed in production. ` +
        `Only 'postgres' is permitted. Set COMMANDER_ALLOW_SOFT_STORAGE=1 only for emergency degraded mode.`,
    );
  }

  try {
    const driver = createDriver(config);
    return {
      driver,
      description: driver.describe(),
      fellBack: false,
    };
  } catch (err) {
    if (failClosed) {
      throw new Error(
        `createDriverSoft: fail-closed in production — refused in-memory fallback for backend=${config.backend}. ` +
          `Set COMMANDER_ALLOW_SOFT_STORAGE=1 only for emergency degraded mode. Cause: ${(err as Error).message}`,
        { cause: err },
      );
    }
    // Fall back to in-memory only when the requested backend's native
    // dependency is unavailable. Connection/config errors still throw so
    // callers are not silently degraded.
    if (config.backend === 'sqlite') {
      const mem = new InMemoryDriver();
      return {
        driver: mem,
        description: { ...mem.describe(), fellBack: true },
        fellBack: true,
        fallbackReason:
          (err as Error)?.message ??
          (err instanceof SqliteOpenError ? 'SqliteOpenError' : 'unknown'),
      };
    }
    if (config.backend === 'postgres' && !probePostgres().available) {
      const mem = new InMemoryDriver();
      return {
        driver: mem,
        description: { ...mem.describe(), fellBack: true },
        fellBack: true,
        fallbackReason: (err as Error)?.message ?? 'pg module unavailable',
      };
    }
    throw err;
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
 * Cheap pre-flight check — returns true iff pg is loadable.
 */
export function isPostgresUsable(): boolean {
  return probePostgres().available;
}

/**
 * Returns the list of available backends. Always includes 'memory';
 * 'sqlite' iff better-sqlite3 is loadable; 'json' iff fs is available
 * (always true in node); 'postgres' iff pg is loadable.
 */
export function listAvailableBackends(): DriverBackend[] {
  const out: DriverBackend[] = ['memory', 'json'];
  if (isSqliteUsable()) out.unshift('sqlite');
  if (isPostgresUsable()) out.push('postgres');
  return out;
}
