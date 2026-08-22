import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { SqlClient, SqlPool } from '@commander/kernel';

export type UserRole = 'super_admin' | 'admin' | 'developer' | 'operator' | 'auditor' | 'viewer';

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  super_admin: 6,
  admin: 5,
  developer: 4,
  operator: 3,
  auditor: 2,
  viewer: 1,
};

export function hasRole(userRole: UserRole, requiredRole: UserRole): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0);
}

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  oidcIssuer?: string;
  oidcSubject?: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export type SafeUser = Omit<User, 'passwordHash' | 'oidcIssuer' | 'oidcSubject'>;
export interface UserTenantMembership {
  userId: string;
  tenantId: string;
  role: UserRole;
}

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

type VerifiedPoolFactory = (
  input: { connectionString: string },
  env?: NodeJS.ProcessEnv,
) => SqlPool;

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

function toSafeUser(user: User): SafeUser {
  const {
    passwordHash: _passwordHash,
    oidcIssuer: _oidcIssuer,
    oidcSubject: _oidcSubject,
    ...safe
  } = user;
  return safe;
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

const USER_COLUMNS = [
  'id',
  'username',
  'email',
  'password_hash',
  'role',
  'oidc_issuer',
  'oidc_subject',
  'created_at',
  'last_login_at',
].join(', ');

type CreateUserArgs = {
  username: string;
  email: string;
  password: string;
  role?: UserRole;
  oidcIssuer?: string;
  oidcSubject?: string;
  tenantId: string;
};

export interface UserRepository {
  findUserById(id: string): Promise<User | undefined>;
  findUserByUsername(username: string): Promise<User | undefined>;
  findUserByEmail(email: string): Promise<User | undefined>;
  findUserByOidcIdentity(issuer: string, subject: string): Promise<User | undefined>;
  findUserTenantMembership(userId: string, tenantId: string): Promise<UserTenantMembership | undefined>;
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
  bootstrapDefaultAdmin(password: string, tenantId: string): Promise<void>;
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: SqlPool) {}

  private async withClient<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      await client.release();
    }
  }

  private async withAdminInvariant<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('commander_auth_users.admin'))");
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async findUserById(id: string): Promise<User | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<UserRow>(
        'SELECT ' + USER_COLUMNS + ' FROM commander_auth_users WHERE id = $1',
        [id],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<UserRow>(
        'SELECT ' + USER_COLUMNS + ' FROM commander_auth_users WHERE lower(username) = lower($1)',
        [username],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<UserRow>(
        'SELECT ' + USER_COLUMNS + ' FROM commander_auth_users WHERE lower(email) = lower($1)',
        [email],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async findUserByOidcIdentity(issuer: string, subject: string): Promise<User | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<UserRow>(
        'SELECT ' +
          USER_COLUMNS +
          ' FROM commander_auth_users WHERE oidc_issuer = $1 AND oidc_subject = $2',
        [issuer, subject],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async findUserTenantMembership(
    userId: string,
    tenantId: string,
  ): Promise<UserTenantMembership | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<UserTenantMembership>(
        'SELECT user_id AS "userId", tenant_id AS "tenantId", role FROM commander_auth_user_tenants WHERE user_id = $1 AND tenant_id = $2',
        [userId, tenantId],
      );
      return result.rows[0];
    });
  }

  async listUsers(): Promise<SafeUser[]> {
    return this.withClient(async (client) => {
      const result = await client.query<UserRow>(
        'SELECT ' + USER_COLUMNS + ' FROM commander_auth_users ORDER BY created_at ASC',
      );
      return result.rows.map(fromRow).map(toSafeUser);
    });
  }

  async createUser(args: CreateUserArgs): Promise<{ user: SafeUser } | { error: string }> {
    if ((args.oidcIssuer === undefined) !== (args.oidcSubject === undefined)) {
      return { error: 'OIDC issuer and subject must be provided together' };
    }
    try {
      return await this.withClient(async (client) => {
        await client.query('BEGIN');
        try {
        const result = await client.query<UserRow>(
          'INSERT INTO commander_auth_users (id, username, email, password_hash, role, oidc_issuer, oidc_subject, created_at, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), NULL) RETURNING ' +
            USER_COLUMNS,
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
        const user = fromRow(result.rows[0]!);
        await client.query(
          'INSERT INTO commander_auth_user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3)',
          [user.id, args.tenantId, args.role ?? 'viewer'],
        );
        await client.query('COMMIT');
        return { user: toSafeUser(user) };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      const message = uniqueViolation(error);
      if (message) return { error: message };
      throw error;
    }
  }

  async bindUserToOidcIdentity(
    userId: string,
    issuer: string,
    subject: string,
  ): Promise<SafeUser | { error: string }> {
    try {
      return await this.withClient(async (client) => {
        const linked = await client.query<UserRow>(
          'UPDATE commander_auth_users SET oidc_issuer = $2, oidc_subject = $3 WHERE id = $1 AND oidc_issuer IS NULL AND oidc_subject IS NULL RETURNING ' +
            USER_COLUMNS,
          [userId, issuer, subject],
        );
        if (linked.rows[0]) return toSafeUser(fromRow(linked.rows[0]));
        const existing = await client.query<UserRow>(
          'SELECT ' + USER_COLUMNS + ' FROM commander_auth_users WHERE id = $1',
          [userId],
        );
        const user = existing.rows[0];
        if (!user) return { error: 'User not found' };
        if (user.oidc_issuer === issuer && user.oidc_subject === subject) {
          return toSafeUser(fromRow(user));
        }
        return { error: 'User is already linked to a different OIDC identity' };
      });
    } catch (error) {
      const message = uniqueViolation(error);
      if (message) return { error: message };
      throw error;
    }
  }

  async updateLastLogin(userId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        'UPDATE commander_auth_users SET last_login_at = clock_timestamp() WHERE id = $1',
        [userId],
      );
    });
  }

  async updateUserRole(userId: string, role: UserRole): Promise<SafeUser | null> {
    return this.withAdminInvariant(async (client) => {
      const current = await client.query<Pick<UserRow, 'role'>>(
        'SELECT role FROM commander_auth_users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (!current.rows[0]) return null;
      if (current.rows[0].role === 'admin' && !hasRole(role, 'admin')) {
        const admins = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM commander_auth_users WHERE role = 'admin'",
        );
        if (Number(admins.rows[0]?.count ?? 0) <= 1) return null;
      }
      const updated = await client.query<UserRow>(
        'UPDATE commander_auth_users SET role = $2 WHERE id = $1 RETURNING ' + USER_COLUMNS,
        [userId, role],
      );
      return toSafeUser(fromRow(updated.rows[0]!));
    });
  }

  async updateUser(
    userId: string,
    updates: Partial<Pick<User, 'email' | 'role' | 'username'>>,
  ): Promise<SafeUser | { error: string }> {
    const fields: Array<{ column: 'username' | 'email'; value: string }> = [];
    if (updates.username !== undefined)
      fields.push({ column: 'username', value: updates.username });
    if (updates.email !== undefined) fields.push({ column: 'email', value: updates.email });
    try {
      return await this.withAdminInvariant(async (client) => {
        const current = await client.query<Pick<UserRow, 'role'>>(
          'SELECT role FROM commander_auth_users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        if (!current.rows[0]) return { error: 'User not found' };
        if (
          updates.role !== undefined &&
          current.rows[0].role === 'admin' &&
          !hasRole(updates.role, 'admin')
        ) {
          const admins = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM commander_auth_users WHERE role = 'admin'",
          );
          if (Number(admins.rows[0]?.count ?? 0) <= 1) {
            return { error: 'Cannot demote the last admin account' };
          }
        }
        const values: unknown[] = [userId];
        const setters: string[] = [];
        if (updates.role !== undefined) {
          values.push(updates.role);
          setters.push('role = $' + values.length);
        }
        for (const field of fields) {
          values.push(field.value);
          setters.push(field.column + ' = $' + values.length);
        }
        if (setters.length === 0) {
          const existing = await client.query<UserRow>(
            'SELECT ' + USER_COLUMNS + ' FROM commander_auth_users WHERE id = $1',
            [userId],
          );
          return toSafeUser(fromRow(existing.rows[0]!));
        }
        const updated = await client.query<UserRow>(
          'UPDATE commander_auth_users SET ' +
            setters.join(', ') +
            ' WHERE id = $1 RETURNING ' +
            USER_COLUMNS,
          values,
        );
        return toSafeUser(fromRow(updated.rows[0]!));
      });
    } catch (error) {
      const message = uniqueViolation(error);
      if (message) return { error: message };
      throw error;
    }
  }

  async resetUserPassword(userId: string, newPassword: string): Promise<SafeUser | null> {
    return this.withClient(async (client) => {
      const updated = await client.query<UserRow>(
        'UPDATE commander_auth_users SET password_hash = $2 WHERE id = $1 RETURNING ' +
          USER_COLUMNS,
        [userId, hashSync(newPassword, 10)],
      );
      return updated.rows[0] ? toSafeUser(fromRow(updated.rows[0])) : null;
    });
  }

  async deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
    return this.withAdminInvariant(async (client) => {
      const current = await client.query<Pick<UserRow, 'role'>>(
        'SELECT role FROM commander_auth_users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (!current.rows[0]) return { success: false, error: 'User not found' };
      if (current.rows[0].role === 'admin') {
        const admins = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM commander_auth_users WHERE role = 'admin'",
        );
        if (Number(admins.rows[0]?.count ?? 0) <= 1) {
          return { success: false, error: 'Cannot delete the last admin account' };
        }
      }
      await client.query('DELETE FROM commander_auth_users WHERE id = $1', [userId]);
      return { success: true };
    });
  }

  async countAdmins(): Promise<number> {
    return this.withClient(async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM commander_auth_users WHERE role = 'admin'",
      );
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  async bootstrapDefaultAdmin(password: string, tenantId: string): Promise<void> {
    await this.withAdminInvariant(async (client) => {
      const users = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM commander_auth_users',
      );
      if (Number(users.rows[0]?.count ?? 0) > 0) return;

      const userId = randomUUID();
      await client.query(
        'INSERT INTO commander_auth_users (id, username, email, password_hash, role, oidc_issuer, oidc_subject, created_at, last_login_at) VALUES ($1, $2, $3, $4, $5, NULL, NULL, clock_timestamp(), NULL)',
        [userId, 'admin', 'admin@commander.local', hashSync(password, 10), 'admin'],
      );
      await client.query(
        'INSERT INTO commander_auth_user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3)',
        [userId, tenantId, 'admin'],
      );
    });
  }
}

export function createUserRepositoryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): UserRepository {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('AUTH_USERS_DATABASE_URL_REQUIRED');
  let role: string;
  try {
    role = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('AUTH_USERS_DATABASE_URL_INVALID');
  }
  if (role !== 'commander_app') throw new Error('AUTH_USERS_DATABASE_ROLE_INVALID');
  return new PostgresUserRepository(createPool({ connectionString }, env));
}

let defaultRepository: UserRepository | undefined;

export function getUserRepository(): UserRepository {
  defaultRepository ??= createUserRepositoryFromEnvironment();
  return defaultRepository;
}

export function setUserRepositoryForTesting(repository: UserRepository | undefined): void {
  defaultRepository = repository;
}

export async function bootstrapDefaultAdmin(
  env: NodeJS.ProcessEnv = process.env,
  repository?: UserRepository,
): Promise<void> {
  const password = env.ADMIN_PASSWORD;
  if (!password) {
    if (env.NODE_ENV === 'production') throw new Error('AUTH_USERS_ADMIN_PASSWORD_REQUIRED');
    return;
  }
  const tenantId = env.ADMIN_TENANT_ID;
  if (!tenantId) throw new Error('AUTH_USERS_ADMIN_TENANT_REQUIRED');
  await (repository ?? getUserRepository()).bootstrapDefaultAdmin(password, tenantId);
}

export function isInitialized(): boolean {
  return defaultRepository !== undefined;
}

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

export async function findUserTenantMembership(
  userId: string,
  tenantId: string,
): Promise<UserTenantMembership | undefined> {
  return getUserRepository().findUserTenantMembership(userId, tenantId);
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
  await getUserRepository().updateLastLogin(userId);
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

export function toSafeUserPublic(user: User): SafeUser {
  return toSafeUser(user);
}

export function _resetUserStoreForTests(): void {
  defaultRepository = undefined;
}
