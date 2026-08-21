import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { SqlPool } from '@commander/kernel';

export interface AuthFailureEntry {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface AuthFailureStore {
  get(failureKey: string): Promise<AuthFailureEntry | undefined>;
  recordFailure(failureKey: string, now: number, maxFailures: number, windowMs: number, lockoutMs: number): Promise<AuthFailureEntry>;
  cleanup(now: number, windowMs: number): Promise<void>;
}

type VerifiedPoolFactory = (input: { connectionString: string }, env?: NodeJS.ProcessEnv) => SqlPool;

interface FailureRow {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lockedUntil: number;
}

const RECORD_FAILURE_SQL = [
  'INSERT INTO commander_auth_failures (failure_key, count, first_failure_at, last_failure_at, locked_until)',
  'VALUES ($1, 1, to_timestamp($2 / 1000.0), to_timestamp($2 / 1000.0), CASE WHEN $4 <= 1 THEN to_timestamp(($2 + $5) / 1000.0) ELSE NULL END)',
  'ON CONFLICT (failure_key) DO UPDATE SET',
  'count = CASE WHEN commander_auth_failures.last_failure_at < to_timestamp(($2 - $3) / 1000.0) THEN 1 ELSE commander_auth_failures.count + 1 END,',
  'first_failure_at = CASE WHEN commander_auth_failures.last_failure_at < to_timestamp(($2 - $3) / 1000.0) THEN to_timestamp($2 / 1000.0) ELSE commander_auth_failures.first_failure_at END,',
  'last_failure_at = to_timestamp($2 / 1000.0),',
  'locked_until = CASE WHEN commander_auth_failures.locked_until > to_timestamp($2 / 1000.0) THEN commander_auth_failures.locked_until WHEN (CASE WHEN commander_auth_failures.last_failure_at < to_timestamp(($2 - $3) / 1000.0) THEN 1 ELSE commander_auth_failures.count + 1 END) >= $4 THEN to_timestamp(($2 + $5) / 1000.0) ELSE NULL END',
  'RETURNING count, EXTRACT(EPOCH FROM first_failure_at) * 1000 AS "firstFailureAt", EXTRACT(EPOCH FROM last_failure_at) * 1000 AS "lastFailureAt", COALESCE(EXTRACT(EPOCH FROM locked_until) * 1000, 0) AS "lockedUntil"',
].join('\n');

function toEntry(row: FailureRow): AuthFailureEntry {
  return { count: Number(row.count), firstFailureAt: Number(row.firstFailureAt), lastFailureAt: Number(row.lastFailureAt), lockedUntil: Number(row.lockedUntil) };
}

export class PostgresAuthFailureStore implements AuthFailureStore {
  constructor(private readonly pool: SqlPool) {}

  async get(failureKey: string): Promise<AuthFailureEntry | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<FailureRow>(
        'SELECT count, EXTRACT(EPOCH FROM first_failure_at) * 1000 AS "firstFailureAt", EXTRACT(EPOCH FROM last_failure_at) * 1000 AS "lastFailureAt", COALESCE(EXTRACT(EPOCH FROM locked_until) * 1000, 0) AS "lockedUntil" FROM commander_auth_failures WHERE failure_key = $1',
        [failureKey],
      );
      return result.rows[0] ? toEntry(result.rows[0]) : undefined;
    } finally {
      await client.release();
    }
  }

  async recordFailure(failureKey: string, now: number, maxFailures: number, windowMs: number, lockoutMs: number): Promise<AuthFailureEntry> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<FailureRow>(RECORD_FAILURE_SQL, [failureKey, now, windowMs, maxFailures, lockoutMs]);
      if (!result.rows[0]) throw new Error('AUTH_FAILURE_RECORD_MISSING');
      return toEntry(result.rows[0]);
    } finally {
      await client.release();
    }
  }

  async cleanup(now: number, windowMs: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'DELETE FROM commander_auth_failures WHERE locked_until IS NULL AND last_failure_at < to_timestamp(($1 - $2) / 1000.0)',
        [now, windowMs],
      );
    } finally {
      await client.release();
    }
  }
}

export interface CreateAuthFailureStoreOptions {
  environment?: NodeJS.ProcessEnv;
  createPool?: VerifiedPoolFactory;
}

export function createAuthFailureStore(options: CreateAuthFailureStoreOptions = {}): AuthFailureStore {
  const environment = options.environment ?? process.env;
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('AUTH_FAILURE_DATABASE_URL_REQUIRED');
  let role: string;
  try {
    role = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('AUTH_FAILURE_DATABASE_URL_INVALID');
  }
  if (role !== 'commander_app') throw new Error('AUTH_FAILURE_DATABASE_ROLE_INVALID');
  return new PostgresAuthFailureStore((options.createPool ?? createVerifiedPostgresPool)({ connectionString }, environment));
}

let sharedStore: AuthFailureStore | undefined;

export function getAuthFailureStore(): AuthFailureStore {
  sharedStore ??= createAuthFailureStore();
  return sharedStore;
}

export function setAuthFailureStore(store: AuthFailureStore): void {
  sharedStore = store;
}

export function resetAuthFailureStoreForTesting(): void {
  sharedStore = undefined;
}
