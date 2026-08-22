import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { SqlPool } from '@commander/kernel';

export interface RefreshTokenRecord {
  jti: string;
  userId: string;
  expiresAt: Date;
}

export interface RefreshTokenRepository {
  insert(record: RefreshTokenRecord): Promise<void>;
  consume(jti: string): Promise<boolean>;
  revoke(jti: string): Promise<void>;
}

type VerifiedPoolFactory = (
  input: { connectionString: string },
  env?: NodeJS.ProcessEnv,
) => SqlPool;

export class PostgresRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly pool: SqlPool) {}

  async insert(record: RefreshTokenRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'INSERT INTO commander_auth_refresh_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3)',
        [record.jti, record.userId, record.expiresAt],
      );
    } finally {
      await client.release();
    }
  }

  async consume(jti: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ jti: string }>(
        'UPDATE commander_auth_refresh_tokens SET revoked_at = clock_timestamp() WHERE jti = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING jti',
        [jti],
      );
      return result.rowCount === 1;
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
