import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { SqlClient, SqlPool } from '@commander/kernel';

export interface RefreshTokenRecord {
  jti: string;
  userId: string;
  expiresAt: Date;
}

export interface RefreshTokenSession {
  insert(record: RefreshTokenRecord): Promise<void>;
  consume(jti: string): Promise<boolean>;
  revokeAllForUser(userId: string): Promise<void>;
}

export interface RefreshTokenRepository extends RefreshTokenSession {
  revoke(jti: string): Promise<void>;
  withUserSessionLock<T>(
    userId: string,
    operation: (session: RefreshTokenSession) => Promise<T>,
  ): Promise<T>;
}

type VerifiedPoolFactory = (
  input: { connectionString: string },
  env?: NodeJS.ProcessEnv,
) => SqlPool;

export class PostgresRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly pool: SqlPool) {}

  async withUserSessionLock<T>(
    userId: string,
    operation: (session: RefreshTokenSession) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const lockKey = 'commander_auth_session:' + userId;
    let lockAcquired = false;
    let operationError: unknown;
    let releaseError: Error | boolean | undefined;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      lockAcquired = true;
      return await operation({
        insert: (record) => this.insertWithClient(client, record),
        consume: (jti) => this.consumeWithClient(client, jti),
        revokeAllForUser: (targetUserId) => this.revokeAllForUserWithClient(client, targetUserId),
      });
    } catch (error) {
      operationError = error;
      releaseError = error instanceof Error ? error : true;
      throw error;
    } finally {
      let unlockError: unknown;
      if (lockAcquired) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        } catch (error) {
          unlockError = error;
          releaseError = error instanceof Error ? error : true;
        }
      }
      await client.release(releaseError);
      if (operationError === undefined && unlockError !== undefined) throw unlockError;
    }
  }

  async insert(record: RefreshTokenRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.insertWithClient(client, record);
    } finally {
      await client.release();
    }
  }

  async consume(jti: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      return await this.consumeWithClient(client, jti);
    } finally {
      await client.release();
    }
  }

  async revoke(jti: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'UPDATE commander_auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE jti = $1',
        [jti],
      );
    } finally {
      await client.release();
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.revokeAllForUserWithClient(client, userId);
    } finally {
      await client.release();
    }
  }

  private async insertWithClient(client: SqlClient, record: RefreshTokenRecord): Promise<void> {
    await client.query(
      'INSERT INTO commander_auth_refresh_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3)',
      [record.jti, record.userId, record.expiresAt],
    );
  }

  private async consumeWithClient(client: SqlClient, jti: string): Promise<boolean> {
    const result = await client.query<{ jti: string }>(
      'UPDATE commander_auth_refresh_tokens SET revoked_at = clock_timestamp() WHERE jti = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING jti',
      [jti],
    );
    return result.rowCount === 1;
  }

  private async revokeAllForUserWithClient(client: SqlClient, userId: string): Promise<void> {
    await client.query(
      'UPDATE commander_auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE user_id = $1',
      [userId],
    );
  }
}

export function createRefreshTokenRepositoryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): RefreshTokenRepository {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('AUTH_REFRESH_DATABASE_URL_REQUIRED');
  }

  let role: string;
  try {
    role = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('AUTH_REFRESH_DATABASE_URL_INVALID');
  }
  if (role !== 'commander_app') {
    throw new Error('AUTH_REFRESH_DATABASE_ROLE_INVALID');
  }

  return new PostgresRefreshTokenRepository(createPool({ connectionString }, env));
}

let defaultRepository: RefreshTokenRepository | undefined;

export function getRefreshTokenRepository(): RefreshTokenRepository {
  defaultRepository ??= createRefreshTokenRepositoryFromEnvironment();
  return defaultRepository;
}
