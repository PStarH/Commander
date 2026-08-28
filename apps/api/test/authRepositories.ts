import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import type {
  CreateUserArgs,
  SafeUser,
  User,
  UserRepository,
  UserRole,
} from '../src/userStore.js';
import type {
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../src/refreshTokenStore.js';
import type { AuthFailureEntry, AuthFailureStore } from '../src/authFailureStore.js';

function toSafeUser(user: User): SafeUser {
  const { passwordHash: _passwordHash, oidcIssuer: _oidcIssuer, oidcSubject: _oidcSubject, ...safe } =
    user;
  return safe;
}

/** Explicit test double injected through the repository boundary. */
export class TestUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();

  async findUserById(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    const candidate = username.toLowerCase();
    return [...this.users.values()].find((user) => user.username.toLowerCase() === candidate);
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const candidate = email.toLowerCase();
    return [...this.users.values()].find((user) => user.email.toLowerCase() === candidate);
  }

  async findUserByOidcIdentity(issuer: string, subject: string): Promise<User | undefined> {
    return [...this.users.values()].find(
      (user) => user.oidcIssuer === issuer && user.oidcSubject === subject,
    );
  }

  async listUsers(): Promise<SafeUser[]> {
    return [...this.users.values()].map(toSafeUser);
  }

  async createUser(args: CreateUserArgs): Promise<{ user: SafeUser } | { error: string }> {
    if (await this.findUserByUsername(args.username)) return { error: 'Username already exists' };
    if (await this.findUserByEmail(args.email)) return { error: 'Email already registered' };
    if ((args.oidcIssuer === undefined) !== (args.oidcSubject === undefined)) {
      return { error: 'OIDC issuer and subject must be provided together' };
    }
    if (
      args.oidcIssuer &&
      args.oidcSubject &&
      (await this.findUserByOidcIdentity(args.oidcIssuer, args.oidcSubject))
    ) {
      return { error: 'OIDC identity already registered' };
    }
    const user: User = {
      id: randomUUID(),
      username: args.username,
      email: args.email,
      passwordHash: hashSync(args.password, 10),
      role: args.role ?? 'viewer',
      oidcIssuer: args.oidcIssuer,
      oidcSubject: args.oidcSubject,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    this.users.set(user.id, user);
    return { user: toSafeUser(user) };
  }

  async bindUserToOidcIdentity(
    userId: string,
    issuer: string,
    subject: string,
  ): Promise<SafeUser | { error: string }> {
    const user = this.users.get(userId);
    if (!user) return { error: 'User not found' };
    const existing = await this.findUserByOidcIdentity(issuer, subject);
    if (existing && existing.id !== userId) return { error: 'OIDC identity already registered' };
    if (user.oidcIssuer && (user.oidcIssuer !== issuer || user.oidcSubject !== subject)) {
      return { error: 'User is already linked to a different OIDC identity' };
    }
    user.oidcIssuer = issuer;
    user.oidcSubject = subject;
    return toSafeUser(user);
  }

  async updateLastLogin(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.lastLoginAt = new Date().toISOString();
  }

  async updateUserRole(userId: string, role: UserRole): Promise<SafeUser | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    user.role = role;
    return toSafeUser(user);
  }

  async updateUser(
    userId: string,
    updates: Partial<Pick<User, 'email' | 'role' | 'username'>>,
  ): Promise<SafeUser | { error: string }> {
    const user = this.users.get(userId);
    if (!user) return { error: 'User not found' };
    if (updates.username && (await this.findUserByUsername(updates.username))?.id !== userId) {
      return { error: 'Username already exists' };
    }
    if (updates.email && (await this.findUserByEmail(updates.email))?.id !== userId) {
      return { error: 'Email already registered' };
    }
    Object.assign(user, updates);
    return toSafeUser(user);
  }

  async resetUserPassword(userId: string, newPassword: string): Promise<SafeUser | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    user.passwordHash = hashSync(newPassword, 10);
    return toSafeUser(user);
  }

  async deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.users.delete(userId)) return { success: false, error: 'User not found' };
    return { success: true };
  }

  async countAdmins(): Promise<number> {
    return [...this.users.values()].filter(
      (user) => user.role === 'admin' || user.role === 'super_admin',
    ).length;
  }

  async bootstrapDefaultAdmin(password: string): Promise<void> {
    if (this.users.size === 0) {
      await this.createUser({
        username: 'admin',
        email: 'admin@commander.local',
        password,
        role: 'admin',
      });
    }
  }
}

type TestRefreshTokenRecord = RefreshTokenRecord & { revoked: boolean };

/** Explicit test double for HTTP routing tests; production always uses PostgreSQL. */
export class TestRefreshTokenRepository implements RefreshTokenRepository {
  private readonly tokens = new Map<string, TestRefreshTokenRecord>();

  async insert(record: RefreshTokenRecord): Promise<void> {
    this.tokens.set(record.jti, { ...record, revoked: false });
  }

  async consume(jti: string): Promise<boolean> {
    const record = this.tokens.get(jti);
    if (!record || record.revoked || record.exp <= Math.floor(Date.now() / 1000)) return false;
    record.revoked = true;
    return true;
  }

  async revoke(jti: string): Promise<void> {
    const record = this.tokens.get(jti);
    if (record) record.revoked = true;
  }

  async isActive(jti: string): Promise<boolean> {
    const record = this.tokens.get(jti);
    return Boolean(record && !record.revoked && record.exp > Math.floor(Date.now() / 1000));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const record of this.tokens.values()) {
      if (record.userId === userId) record.revoked = true;
    }
  }
}

/** Explicit test double; production authentication failures always use PostgreSQL. */
export class TestAuthFailureStore implements AuthFailureStore {
  private readonly entries = new Map<string, AuthFailureEntry>();

  async get(failureKey: string): Promise<AuthFailureEntry | undefined> {
    return this.entries.get(failureKey);
  }

  async recordFailure(
    failureKey: string,
    now: number,
    maxFailures: number,
    windowMs: number,
    lockoutMs: number,
  ): Promise<AuthFailureEntry> {
    const previous = this.entries.get(failureKey);
    const expired = !previous || previous.lastFailureAt < now - windowMs;
    const count = expired ? 1 : previous.count + 1;
    const entry = {
      count,
      firstFailureAt: expired ? now : previous.firstFailureAt,
      lastFailureAt: now,
      lockedUntil: count >= maxFailures ? now + lockoutMs : previous?.lockedUntil ?? 0,
    };
    this.entries.set(failureKey, entry);
    return entry;
  }

  async cleanup(now: number, windowMs: number): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && entry.lastFailureAt < now - windowMs) {
        this.entries.delete(key);
      }
    }
  }
}
