/**
 * PostgreSQL-authoritative refresh-token jti store.
 *
 * Consumption is a single atomic `UPDATE ... RETURNING` so a jti can be
 * consumed by exactly one replica/request — concurrent refreshes of the same
 * token cannot both succeed (single-use rotation).
 */
import type { SqlPool } from '@commander/kernel';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import { createAuthPool, withClient, type VerifiedPoolFactory } from './authDb';

export interface RefreshTokenRecord {
  jti: string;
  userId: string;
  /** Unix expiry (seconds), matching JWT `exp`. */
  exp: number;
}

export interface RefreshTokenRepository {
  insert(record: RefreshTokenRecord): Promise<void>;
  /** Atomic single-use consumption; true only for the first successful consumer. */
  consume(jti: string): Promise<boolean>;
  revoke(jti: string): Promise<void>;
  isActive(jti: string): Promise<boolean>;
  revokeAllForUser(userId: string): Promise<void>;
}

export class PostgresRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly pool: SqlPool) {}

  async insert(record: RefreshTokenRecord): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query(
        'INSERT INTO commander_auth_refresh_tokens (jti, user_id, expires_at, revoked_at) VALUES ($1, $2, to_timestamp($3), $4)',
        [record.jti, record.userId, record.exp, null],
      );
    });
  }

  async consume(jti: string): Promise<boolean> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<{ jti: string }>(
        `UPDATE commander_auth_refresh_tokens SET revoked_at = clock_timestamp()
         WHERE jti = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
         RETURNING jti`,
        [jti],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async revoke(jti: string): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query(
        'UPDATE commander_auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE jti = $1',
        [jti],
      );
    });
  }

  async isActive(jti: string): Promise<boolean> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<{ jti: string }>(
        `SELECT jti FROM commander_auth_refresh_tokens
         WHERE jti = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
        [jti],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query(
        'UPDATE commander_auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE user_id = $1',
        [userId],
      );
    });
  }
}

let defaultRepository: RefreshTokenRepository | undefined;

export function createRefreshTokenRepository(
  env: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): RefreshTokenRepository {
  return new PostgresRefreshTokenRepository(createAuthPool(env, createPool));
}

export function getRefreshTokenRepository(): RefreshTokenRepository {
  defaultRepository ??= createRefreshTokenRepository();
  return defaultRepository;
}

export function setRefreshTokenRepository(repository: RefreshTokenRepository): void {
  defaultRepository = repository;
}

export function _resetRefreshTokenStoreForTests(): void {
  defaultRepository = undefined;
}

// ── Async facade preserving the historical function surface ─────────────────

/** Persist a newly issued refresh jti. */
export async function persist(jti: string, userId: string, exp: number): Promise<void> {
  await getRefreshTokenRepository().insert({ jti, userId, exp });
}

/**
 * Atomically check that jti is active and revoke it.
 * Returns true only for the first successful consumer.
 */
export async function consume(jti: string): Promise<boolean> {
  return getRefreshTokenRepository().consume(jti);
}

/** Mark a jti as revoked (logout / explicit revoke). */
export async function revoke(jti: string): Promise<void> {
  await getRefreshTokenRepository().revoke(jti);
}

/** True when jti exists, is not revoked, and has not expired. */
export async function isActive(jti: string): Promise<boolean> {
  return getRefreshTokenRepository().isActive(jti);
}

/** Revoke every active refresh token for a user (e.g. password reset). */
export async function revokeAllForUser(userId: string): Promise<void> {
  await getRefreshTokenRepository().revokeAllForUser(userId);
}
