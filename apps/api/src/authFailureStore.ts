/**
 * Shared authentication-failure authority.
 *
 * AUDIT-E1: PostgreSQL is the authoritative backend. The previous Redis
 * implementation (AUTH_FAILURE_REDIS_URL) violated the no-Redis-auth-fallback
 * policy, and production deployments never configured it — the API crashed at
 * boot. Redis is removed entirely:
 *
 *   - production: a verified PostgreSQL pool is required (DSN from
 *     COMMANDER_AUTH_FAILURE_DATABASE_URL ?? COMMANDER_KERNEL_DATABASE_URL ??
 *     DATABASE_URL). Missing DSN → boot refusal (fail closed).
 *   - development/tests: the explicitly named process-local store.
 */

import { isProductionEnv } from './envSignal.js';

export interface AuthFailureEntry {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface AuthFailureStore {
  get(ip: string): Promise<AuthFailureEntry | undefined>;
  set(ip: string, entry: AuthFailureEntry): Promise<void>;
  delete(ip: string): Promise<void>;
  cleanup(now: number, windowMs: number): Promise<void>;
}

/** Minimal pg Pool surface the store depends on (injectable for tests). */
export interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end?: () => Promise<void>;
}

export type PgPoolLoader = (dsn: string) => PgPoolLike | Promise<PgPoolLike>;

export interface CreateAuthFailureStoreOptions {
  environment?: NodeJS.ProcessEnv;
  loadPgPool?: PgPoolLoader;
}

class InMemoryAuthFailureStore implements AuthFailureStore {
  private readonly map = new Map<string, AuthFailureEntry>();

  async get(ip: string): Promise<AuthFailureEntry | undefined> {
    return this.map.get(ip);
  }

  async set(ip: string, entry: AuthFailureEntry): Promise<void> {
    this.map.set(ip, entry);
  }

  async delete(ip: string): Promise<void> {
    this.map.delete(ip);
  }

  async cleanup(now: number, windowMs: number): Promise<void> {
    for (const [ip, entry] of this.map) {
      if (entry.lockedUntil < now && entry.lastFailureAt < now - windowMs) {
        this.map.delete(ip);
      }
    }
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseAuthFailureEntry(raw: unknown): AuthFailureEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Postgres auth failure entry is malformed');
  }
  const entry = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(entry.count) ||
    !isNonNegativeFiniteNumber(entry.count) ||
    !isNonNegativeFiniteNumber(entry.firstFailureAt) ||
    !isNonNegativeFiniteNumber(entry.lastFailureAt) ||
    !isNonNegativeFiniteNumber(entry.lockedUntil)
  ) {
    throw new Error('Postgres auth failure entry is malformed');
  }
  return {
    count: entry.count,
    firstFailureAt: entry.firstFailureAt,
    lastFailureAt: entry.lastFailureAt,
    lockedUntil: entry.lockedUntil,
  };
}

async function defaultLoadPgPool(dsn: string): Promise<PgPoolLike> {
  const { createVerifiedPostgresPool } = await import('@commander/postgres-runtime');
  return createVerifiedPostgresPool({ connectionString: dsn });
}

class PostgresAuthFailureStore implements AuthFailureStore {
  private readonly poolPromise: Promise<PgPoolLike>;

  constructor(
    dsn: string,
    loadPgPool: PgPoolLoader,
    private readonly ensureTable = true,
  ) {
    this.poolPromise = Promise.resolve(loadPgPool(dsn)).then(async (pool) => {
      if (ensureTable) {
        // Idempotent; kernel migrations own this DDL on migrated databases.
        // If the connecting role cannot CREATE and the table already exists,
        // this is a harmless duplicate-object error we swallow; a genuinely
        // missing table surfaces on first use and fails the request closed.
        await pool
          .query(
            `CREATE TABLE IF NOT EXISTS commander_auth_failures (
               ip TEXT PRIMARY KEY,
               entry JSONB NOT NULL,
               expires_at TIMESTAMPTZ NOT NULL
             )`,
          )
          .catch(() => undefined);
      }
      return pool;
    });
  }

  async get(ip: string): Promise<AuthFailureEntry | undefined> {
    const pool = await this.poolPromise;
    const result = await pool.query(
      'SELECT entry FROM commander_auth_failures WHERE ip = $1 AND expires_at > now()',
      [ip],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return parseAuthFailureEntry(row.entry);
  }

  async set(ip: string, entry: AuthFailureEntry): Promise<void> {
    const pool = await this.poolPromise;
    const ttlSeconds =
      entry.lockedUntil > Date.now()
        ? Math.ceil((entry.lockedUntil - Date.now()) / 1000)
        : 60 * 60;
    await pool.query(
      `INSERT INTO commander_auth_failures (ip, entry, expires_at)
       VALUES ($1, $2::jsonb, now() + make_interval(secs => $3))
       ON CONFLICT (ip) DO UPDATE SET entry = EXCLUDED.entry, expires_at = EXCLUDED.expires_at`,
      [ip, JSON.stringify(entry), ttlSeconds],
    );
  }

  async delete(ip: string): Promise<void> {
    const pool = await this.poolPromise;
    await pool.query('DELETE FROM commander_auth_failures WHERE ip = $1', [ip]);
  }

  async cleanup(_now: number, _windowMs: number): Promise<void> {
    const pool = await this.poolPromise;
    await pool.query('DELETE FROM commander_auth_failures WHERE expires_at <= now()');
  }
}

let sharedStore: AuthFailureStore | null = null;

export function getAuthFailureStore(): AuthFailureStore {
  if (!sharedStore) {
    sharedStore = createAuthFailureStore();
  }
  return sharedStore;
}

export function authFailureDsn(env: NodeJS.ProcessEnv): string | undefined {
  const dsn =
    env.COMMANDER_AUTH_FAILURE_DATABASE_URL ??
    env.COMMANDER_KERNEL_DATABASE_URL ??
    env.DATABASE_URL;
  return typeof dsn === 'string' && dsn.trim().length > 0 ? dsn.trim() : undefined;
}

export function createAuthFailureStore(
  options: CreateAuthFailureStoreOptions = {},
): AuthFailureStore {
  const environment = options.environment ?? process.env;
  const dsn = authFailureDsn(environment);
  if (dsn) {
    return new PostgresAuthFailureStore(dsn, options.loadPgPool ?? defaultLoadPgPool);
  }
  if (isProductionEnv(environment)) {
    // AUDIT-E1: fail closed — no Redis fallback, no silent in-memory authority.
    throw new Error(
      'COMMANDER_AUTH_FAILURE_DATABASE_URL (or COMMANDER_KERNEL_DATABASE_URL / DATABASE_URL) ' +
        'is required in production for the authentication-failure authority. ' +
        'The Redis backend (AUTH_FAILURE_REDIS_URL) has been removed.',
    );
  }
  return new InMemoryAuthFailureStore();
}

export function setAuthFailureStore(store: AuthFailureStore): void {
  sharedStore = store;
}

export function resetAuthFailureStoreForTesting(): void {
  sharedStore = null;
}
