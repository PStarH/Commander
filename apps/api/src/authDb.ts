/**
 * Shared PostgreSQL plumbing for the API-layer auth repositories.
 *
 * All five auth authorities (users, API keys, refresh tokens, auth failures,
 * rate limits) are backed by PostgreSQL via `commander_app`. There is no
 * Redis / JSON-file / SQLite / in-memory fallback: production fails closed
 * when `DATABASE_URL` is missing or does not authenticate as `commander_app`.
 */
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { SqlClient, SqlPool } from '@commander/kernel';

export type VerifiedPoolFactory = (
  input: { connectionString: string },
  env?: NodeJS.ProcessEnv,
) => SqlPool;

/** Database role that every auth repository must authenticate as. */
export const AUTH_DATABASE_ROLE = 'commander_app';

export function resolveAuthDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('AUTH_DATABASE_URL_REQUIRED');
  }
  return connectionString;
}

export function validateAuthDatabaseUrl(connectionString: string): void {
  let role: string;
  try {
    role = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('AUTH_DATABASE_URL_INVALID');
  }
  if (role !== AUTH_DATABASE_ROLE) {
    throw new Error('AUTH_DATABASE_ROLE_INVALID');
  }
}

export function createAuthPool(
  env: NodeJS.ProcessEnv,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): SqlPool {
  const connectionString = resolveAuthDatabaseUrl(env);
  validateAuthDatabaseUrl(connectionString);
  return createPool({ connectionString }, env);
}

export async function withClient<T>(
  pool: SqlPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    await client.release();
  }
}

/**
 * Run `operation` inside a transaction that sets `app.tenant_scope` so RLS
 * policies on tenant-bearing auth tables apply. When `tenantScope` is empty
 * the global (pre-auth) path is used and the scope stays unset.
 */
export async function withTenantScopedClient<T>(
  pool: SqlPool,
  tenantScope: string,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantScope) {
      await client.query("SELECT set_config('app.tenant_scope', $1, true)", [tenantScope]);
    }
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await client.release();
  }
}
