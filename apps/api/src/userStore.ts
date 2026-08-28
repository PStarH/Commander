import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import type { SqlPool } from '@commander/kernel';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import {
  createAuthPool,
  withClient,
  withTenantScopedClient,
  type VerifiedPoolFactory,
} from './authDb';

// ── Types ───────────────────────────────────────────────────────────────────

export type UserRole = 'super_admin' | 'admin' | 'developer' | 'operator' | 'auditor' | 'viewer';

/**
 * Numeric hierarchy for each role (higher = more privileged).
 * Used for level-based permission checks so that, e.g., a `super_admin`
 * satisfies an `admin` requirement. Mirrors the core AuthManager hierarchy.
 */
export const ROLE_HIERARCHY: Record<UserRole, number> = {
  super_admin: 6,
  admin: 5,
  developer: 4,
  operator: 3,
  auditor: 2,
  viewer: 1,
};

/**
 * Returns true when `userRole` meets or exceeds the level of `requiredRole`.
 */
export function hasRole(userRole: UserRole, requiredRole: UserRole): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0);
}

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  /** Durable external identity binding for OIDC-provisioned users. */
  oidcIssuer?: string;
  oidcSubject?: string;
  createdAt: string;
  lastLoginAt: string | null;
}

/**
 * The user object returned to clients — never includes the password hash.
 */
export type SafeUser = Omit<User, 'passwordHash' | 'oidcIssuer' | 'oidcSubject'>;

function toSafeUser(user: User): SafeUser {
  const {
    passwordHash: _passwordHash,
    oidcIssuer: _oidcIssuer,
    oidcSubject: _oidcSubject,
    ...safe
  } = user;
  return safe;
}

export function toSafeUserPublic(user: User): SafeUser {
  return toSafeUser(user);
}

// ── PostgreSQL repository ───────────────────────────────────────────────────

type UserRow = {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: UserRole;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  created_at: Date | string;
  last_login_at: Date | string | null;
};

const USER_COLUMNS =
  'id, username, email, password_hash, role, oidc_issuer, oidc_subject, created_at, last_login_at';

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    oidcIssuer: row.oidc_issuer ?? undefined,
    oidcSubject: row.oidc_subject ?? undefined,
    createdAt: timestamp(row.created_at),
    lastLoginAt: row.last_login_at === null ? null : timestamp(row.last_login_at),
  };
}

function uniqueViolation(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const postgres = error as { code?: unknown; constraint?: unknown };
  if (postgres.code !== '23505' || typeof postgres.constraint !== 'string') return undefined;
  if (postgres.constraint === 'commander_auth_users_username_ci_uidx') {
    return 'Username already exists';
  }
  if (postgres.constraint === 'commander_auth_users_email_ci_uidx') {
    return 'Email already registered';
  }
  if (postgres.constraint === 'commander_auth_users_oidc_uidx') {
    return 'OIDC identity already registered';
  }
  return undefined;
}

export interface CreateUserArgs {
  username: string;
  email: string;
  password: string;
  role?: UserRole;
  oidcIssuer?: string;
  oidcSubject?: string;
}

export interface UserRepository {
  findUserById(id: string): Promise<User | undefined>;
  findUserByUsername(username: string): Promise<User | undefined>;
  findUserByEmail(email: string): Promise<User | undefined>;
  findUserByOidcIdentity(issuer: string, subject: string): Promise<User | undefined>;
  listUsers(): Promise<SafeUser[]>;
  createUser(args: CreateUserArgs): Promise<{ user: SafeUser } | { error: string }>;
  bindUserToOidcIdentity(
    userId: string,
    issuer: string,
    subject: string,
  ): Promise<SafeUser | { error: string }>;
  updateLastLogin(userId: string): Promise<void>;
  updateUserRole(userId: string, role: UserRole): Promise<SafeUser | null>;
  updateUser(
    userId: string,
    updates: Partial<Pick<User, 'email' | 'role' | 'username'>>,
  ): Promise<SafeUser | { error: string }>;
  resetUserPassword(userId: string, newPassword: string): Promise<SafeUser | null>;
  deleteUser(userId: string): Promise<{ success: boolean; error?: string }>;
  countAdmins(): Promise<number>;
  /** Seed the initial admin account when no user rows exist. */
  bootstrapDefaultAdmin(password: string): Promise<void>;
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: SqlPool) {}

  async findUserById(id: string): Promise<User | undefined> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM commander_auth_users WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM commander_auth_users WHERE lower(username) = lower($1)`,
        [username],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM commander_auth_users WHERE lower(email) = lower($1)`,
        [email],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async findUserByOidcIdentity(issuer: string, subject: string): Promise<User | undefined> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM commander_auth_users WHERE oidc_issuer = $1 AND oidc_subject = $2`,
        [issuer, subject],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async listUsers(): Promise<SafeUser[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM commander_auth_users ORDER BY created_at ASC`,
      );
      return result.rows.map(fromRow).map(toSafeUser);
    });
  }

  async createUser(args: CreateUserArgs): Promise<{ user: SafeUser } | { error: string }> {
    if ((args.oidcIssuer === undefined) !== (args.oidcSubject === undefined)) {
      return { error: 'OIDC issuer and subject must be provided together' };
    }
    try {
      const result = await withClient(this.pool, async (client) => {
        return client.query<UserRow>(
          `INSERT INTO commander_auth_users (id, username, email, password_hash, role, oidc_issuer, oidc_subject, created_at, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), NULL)
           RETURNING ${USER_COLUMNS}`,
          [
            randomUUID(),
            args.username,
            args.email,
            hashSync(args.password, 10),
            args.role ?? 'viewer',
            args.oidcIssuer ?? null,
            args.oidcSubject ?? null,
          ],
        );
      });
      return { user: toSafeUser(fromRow(result.rows[0]!)) };
    } catch (error) {
      const conflict = uniqueViolation(error);
      if (conflict) return { error: conflict };
      throw error;
    }
  }

  async bindUserToOidcIdentity(
    userId: string,
    issuer: string,
    subject: string,
  ): Promise<SafeUser | { error: string }> {
    try {
      const result = await withClient(this.pool, async (client) => {
        return client.query<UserRow>(
          `UPDATE commander_auth_users SET oidc_issuer = $2, oidc_subject = $3
           WHERE id = $1 AND (oidc_issuer IS NULL OR (oidc_issuer = $2 AND oidc_subject = $3))
           RETURNING ${USER_COLUMNS}`,
          [userId, issuer, subject],
        );
      });
      if (!result.rows[0]) {
        // Either the user is missing, or they are bound to a different OIDC identity.
        const user = await this.findUserById(userId);
        if (!user) return { error: 'User not found' };
        return { error: 'User is already linked to a different OIDC identity' };
      }
      return toSafeUser(fromRow(result.rows[0]));
    } catch (error) {
      const conflict = uniqueViolation(error);
      if (conflict) return { error: conflict };
      throw error;
    }
  }

  async updateLastLogin(userId: string): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query(
        'UPDATE commander_auth_users SET last_login_at = clock_timestamp() WHERE id = $1',
        [userId],
      );
    });
  }

  async updateUserRole(userId: string, role: UserRole): Promise<SafeUser | null> {
    const result = await withClient(this.pool, async (client) => {
      return client.query<UserRow>(
        `UPDATE commander_auth_users SET role = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [userId, role],
      );
    });
    return result.rows[0] ? toSafeUser(fromRow(result.rows[0])) : null;
  }

  async updateUser(
    userId: string,
    updates: Partial<Pick<User, 'email' | 'role' | 'username'>>,
  ): Promise<SafeUser | { error: string }> {
    try {
      const result = await withClient(this.pool, async (client) => {
        return client.query<UserRow>(
          `UPDATE commander_auth_users
           SET email = COALESCE($2, email), role = COALESCE($3, role), username = COALESCE($4, username)
           WHERE id = $1
           RETURNING ${USER_COLUMNS}`,
          [userId, updates.email ?? null, updates.role ?? null, updates.username ?? null],
        );
      });
      if (!result.rows[0]) return { error: 'User not found' };
      return toSafeUser(fromRow(result.rows[0]));
    } catch (error) {
      const conflict = uniqueViolation(error);
      if (conflict) return { error: conflict };
      throw error;
    }
  }

  async resetUserPassword(userId: string, newPassword: string): Promise<SafeUser | null> {
    const result = await withClient(this.pool, async (client) => {
      return client.query<UserRow>(
        `UPDATE commander_auth_users SET password_hash = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [userId, hashSync(newPassword, 10)],
      );
    });
    return result.rows[0] ? toSafeUser(fromRow(result.rows[0])) : null;
  }

  async deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
    return withTenantScopedClient(this.pool, '', async (client) => {
      const user = await client.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM commander_auth_users WHERE id = $1 FOR UPDATE`,
        [userId],
      );
      if (!user.rows[0]) return { success: false, error: 'User not found' };

      const admins = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM commander_auth_users WHERE role IN ('admin', 'super_admin')",
      );
      if (
        (user.rows[0].role === 'admin' || user.rows[0].role === 'super_admin') &&
        Number(admins.rows[0]?.count ?? 0) <= 1
      ) {
        return { success: false, error: 'Cannot delete the last admin account' };
      }

      // Revoke every outstanding refresh token for the user before deletion so a
      // previously issued refresh token can never authenticate post-deletion.
      await client.query(
        'UPDATE commander_auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE user_id = $1',
        [userId],
      );
      await client.query('DELETE FROM commander_auth_users WHERE id = $1', [userId]);
      return { success: true };
    });
  }

  async countAdmins(): Promise<number> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM commander_auth_users WHERE role IN ('admin', 'super_admin')",
      );
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  async bootstrapDefaultAdmin(password: string): Promise<void> {
    await withTenantScopedClient(this.pool, '', async (client) => {
      // Serialize concurrent first-boot so replicas cannot both seed an admin.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('commander_auth_users.bootstrap'))",
      );
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM commander_auth_users LIMIT 1',
      );
      if (existing.rows[0]) return;
      await client.query(
        `INSERT INTO commander_auth_users (id, username, email, password_hash, role, oidc_issuer, oidc_subject, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, clock_timestamp(), NULL)`,
        [randomUUID(), 'admin', 'admin@commander.local', hashSync(password, 10), 'admin'],
      );
    });
  }
}

// ── Default repository (PostgreSQL authority, no fallback) ──────────────────

let defaultRepository: UserRepository | undefined;

export function createUserRepository(
  env: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): UserRepository {
  return new PostgresUserRepository(createAuthPool(env, createPool));
}

export function getUserRepository(): UserRepository {
  defaultRepository ??= createUserRepository();
  return defaultRepository;
}

export function setUserRepository(repository: UserRepository): void {
  defaultRepository = repository;
}

export function _resetUserStoreForTests(): void {
  defaultRepository = undefined;
}

// ── Async facade preserving the historical function surface ─────────────────

export async function findUserById(id: string): Promise<User | undefined> {
  return getUserRepository().findUserById(id);
}

export async function findUserByUsername(username: string): Promise<User | undefined> {
  return getUserRepository().findUserByUsername(username);
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  return getUserRepository().findUserByEmail(email);
}

export async function findUserByOidcIdentity(
  issuer: string,
  subject: string,
): Promise<User | undefined> {
  return getUserRepository().findUserByOidcIdentity(issuer, subject);
}

export async function listUsers(): Promise<SafeUser[]> {
  return getUserRepository().listUsers();
}

export async function createUser(
  args: CreateUserArgs,
): Promise<{ user: SafeUser } | { error: string }> {
  return getUserRepository().createUser(args);
}

export async function bindUserToOidcIdentity(
  userId: string,
  issuer: string,
  subject: string,
): Promise<SafeUser | { error: string }> {
  return getUserRepository().bindUserToOidcIdentity(userId, issuer, subject);
}

export async function updateLastLogin(userId: string): Promise<void> {
  return getUserRepository().updateLastLogin(userId);
}

export async function updateUserRole(userId: string, role: UserRole): Promise<SafeUser | null> {
  return getUserRepository().updateUserRole(userId, role);
}

export async function updateUser(
  userId: string,
  updates: Partial<Pick<User, 'email' | 'role' | 'username'>>,
): Promise<SafeUser | { error: string }> {
  return getUserRepository().updateUser(userId, updates);
}

export async function resetUserPassword(
  userId: string,
  newPassword: string,
): Promise<SafeUser | null> {
  return getUserRepository().resetUserPassword(userId, newPassword);
}

export async function deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
  return getUserRepository().deleteUser(userId);
}

export async function countAdmins(): Promise<number> {
  return getUserRepository().countAdmins();
}

export function isInitialized(): boolean {
  return defaultRepository !== undefined;
}

/**
 * Seed the default admin account on first boot (AUTH-4: production refuses to
 * use the well-known dev password). Call once during server startup.
 */
export async function bootstrapDefaultAdminAccount(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const repository = getUserRepository();
  const existing = await repository.countAdmins();
  if (existing > 0) return;
  const configuredPassword = env.ADMIN_PASSWORD;
  if (!configuredPassword && env.NODE_ENV === 'production') {
    throw new Error(
      '[userStore] ADMIN_PASSWORD must be set in production before the default admin account ' +
        'can be created. Refusing to seed the well-known admin/commander-admin credential.',
    );
  }
  const adminPassword = configuredPassword ?? 'commander-admin';
  await repository.bootstrapDefaultAdmin(adminPassword);
  process.stdout.write(
    `[userStore] Created default admin user (username=admin). ` +
      `Change the password immediately in production.\n`,
  );
}
