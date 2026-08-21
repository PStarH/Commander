import { createHash, randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import type { ApiKeyCreationResult, ApiKeyRecord, ApiKeyStore } from '../src/apiKeyStore';
import type { SafeUser, User, UserRepository, UserRole } from '../src/userStore';

function safeUser(user: User): SafeUser {
  const { passwordHash: _passwordHash, oidcIssuer: _oidcIssuer, oidcSubject: _oidcSubject, ...safe } =
    user;
  return safe;
}

export class TestUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();

  async findUserById(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    return [...this.users.values()].find((user) => user.username.toLowerCase() === username.toLowerCase());
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    return [...this.users.values()].find((user) => user.email.toLowerCase() === email.toLowerCase());
  }

  async findUserByOidcIdentity(issuer: string, subject: string): Promise<User | undefined> {
    return [...this.users.values()].find(
      (user) => user.oidcIssuer === issuer && user.oidcSubject === subject,
    );
  }

  async listUsers(): Promise<SafeUser[]> {
    return [...this.users.values()].map(safeUser);
  }

  async createUser(args: {
    username: string;
    email: string;
    password: string;
    role?: UserRole;
    oidcIssuer?: string;
    oidcSubject?: string;
  }): Promise<{ user: SafeUser } | { error: string }> {
    if ((args.oidcIssuer === undefined) !== (args.oidcSubject === undefined)) {
      return { error: 'OIDC issuer and subject must be provided together' };
    }
    if (await this.findUserByUsername(args.username)) return { error: 'Username already exists' };
    if (await this.findUserByEmail(args.email)) return { error: 'Email already registered' };
    if (args.oidcIssuer && (await this.findUserByOidcIdentity(args.oidcIssuer, args.oidcSubject!))) {
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
    return { user: safeUser(user) };
  }

  async bindUserToOidcIdentity(userId: string, issuer: string, subject: string): Promise<SafeUser | { error: string }> {
    const user = this.users.get(userId);
    if (!user) return { error: 'User not found' };
    const existing = await this.findUserByOidcIdentity(issuer, subject);
    if (existing && existing.id !== userId) return { error: 'OIDC identity already registered' };
    if (user.oidcIssuer && (user.oidcIssuer !== issuer || user.oidcSubject !== subject)) {
      return { error: 'User is already linked to a different OIDC identity' };
    }
    user.oidcIssuer = issuer;
    user.oidcSubject = subject;
    return safeUser(user);
  }

  async updateLastLogin(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.lastLoginAt = new Date().toISOString();
  }

  async updateUserRole(userId: string, role: UserRole): Promise<SafeUser | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    user.role = role;
    return safeUser(user);
  }

  async updateUser(userId: string, updates: Partial<Pick<User, 'email' | 'role' | 'username'>>): Promise<SafeUser | { error: string }> {
    const user = this.users.get(userId);
    if (!user) return { error: 'User not found' };
    Object.assign(user, updates);
    return safeUser(user);
  }

  async resetUserPassword(userId: string, password: string): Promise<SafeUser | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    user.passwordHash = hashSync(password, 10);
    return safeUser(user);
  }

  async deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
    return { success: this.users.delete(userId) };
  }

  async countAdmins(): Promise<number> {
    return [...this.users.values()].filter((user) => user.role === 'admin').length;
  }

  async bootstrapDefaultAdmin(): Promise<void> {}
}

export class TestApiKeyStore implements ApiKeyStore {
  private readonly records = new Map<string, ApiKeyRecord>();

  async list(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return [...this.records.values()].map(({ hash: _hash, ...record }) => record);
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    return [...this.records.values()].find((record) => record.hash === hash && record.enabled);
  }

  async create(name: string, scopes = ['read', 'write'], tenantId?: string): Promise<ApiKeyCreationResult> {
    const key = 'cmdr_test_' + randomUUID().replaceAll('-', '');
    const record: ApiKeyRecord = {
      id: 'ak_' + randomUUID(),
      name,
      prefix: key.slice(0, 8),
      hash: createHash('sha256').update(key).digest('hex'),
      scopes,
      tenantId,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.records.set(record.id, record);
    return { record, key };
  }

  async revoke(id: string): Promise<ApiKeyRecord | undefined> {
    const record = this.records.get(id);
    if (!record || !record.enabled) return undefined;
    record.enabled = false;
    record.revokedAt = new Date().toISOString();
    return record;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}
