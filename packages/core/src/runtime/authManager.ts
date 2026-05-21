/**
 * Authentication & Authorization Manager
 *
 * User management, RBAC roles, and API key lifecycle management.
 * File-based persistence using .commander/auth.json.
 * Uses built-in crypto only — no external dependencies.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

// ── Types ──────────────────────────────────────────────────────────

export type AuthRole = 'admin' | 'operator' | 'viewer';

export const ROLE_HIERARCHY: Record<AuthRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

export interface ApiKeyEntry {
  /** SHA-256 hash of the actual key (we never store raw keys) */
  keyHash: string;
  /** Human-readable name for this key (e.g. "CI/CD pipeline") */
  name: string;
  createdAt: string;
  expiresAt?: string;
  /** Last 4 chars of the raw key for identification */
  keyPrefix: string;
  lastUsedAt?: string;
}

export interface AuthUser {
  id: string;
  username: string;
  role: AuthRole;
  apiKeys: ApiKeyEntry[];
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
}

export interface AuthData {
  users: AuthUser[];
}

// ── Constants ──────────────────────────────────────────────────────

const AUTH_FILE = path.join(process.cwd(), '.commander', 'auth.json');
const KEY_BYTES = 32; // 256-bit API keys

// ── Manager ────────────────────────────────────────────────────────

export class AuthManager {
  private users: Map<string, AuthUser> = new Map();

  constructor() {
    this.load();
  }

  // ── User CRUD ────────────────────────────────────────────────────

  createUser(username: string, role: AuthRole = 'viewer'): AuthUser {
    if (this.users.has(username)) {
      throw new Error(`User already exists: ${username}`);
    }
    const now = new Date().toISOString();
    const user: AuthUser = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      username,
      role,
      apiKeys: [],
      createdAt: now,
      updatedAt: now,
      enabled: true,
    };
    this.users.set(username, user);
    this.save();
    getGlobalLogger().info('AuthManager', 'User created', { username, role });
    return user;
  }

  getUser(username: string): AuthUser | undefined {
    return this.users.get(username);
  }

  getUserById(id: string): AuthUser | undefined {
    return Array.from(this.users.values()).find(u => u.id === id);
  }

  updateUser(username: string, updates: { role?: AuthRole; enabled?: boolean; username?: string }): AuthUser | null {
    const user = this.users.get(username);
    if (!user) return null;
    if (updates.role) user.role = updates.role;
    if (updates.enabled !== undefined) user.enabled = updates.enabled;
    user.updatedAt = new Date().toISOString();
    this.save();
    getGlobalLogger().info('AuthManager', 'User updated', { username, updates: Object.keys(updates) });
    return user;
  }

  deleteUser(username: string): boolean {
    const existed = this.users.delete(username);
    if (existed) {
      this.save();
      getGlobalLogger().info('AuthManager', 'User deleted', { username });
    }
    return existed;
  }

  listUsers(): AuthUser[] {
    return Array.from(this.users.values());
  }

  // ── API Key Management ───────────────────────────────────────────

  generateApiKey(username: string, keyName: string = 'default', expiresInDays?: number): { rawKey: string; entry: ApiKeyEntry } {
    const user = this.users.get(username);
    if (!user) throw new Error(`User not found: ${username}`);
    if (!user.enabled) throw new Error(`User disabled: ${username}`);

    const rawKey = `cmdr_${crypto.randomBytes(KEY_BYTES).toString('base64url')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const now = new Date().toISOString();

    const entry: ApiKeyEntry = {
      keyHash,
      name: keyName,
      createdAt: now,
      keyPrefix: rawKey.slice(-4),
      expiresAt: expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined,
    };

    user.apiKeys.push(entry);
    user.updatedAt = now;
    this.save();
    getGlobalLogger().info('AuthManager', 'API key generated', { username, keyName });
    return { rawKey, entry };
  }

  rotateApiKey(username: string, keyHash: string, keyName?: string, expiresInDays?: number): { rawKey: string; entry: ApiKeyEntry } | null {
    const user = this.users.get(username);
    if (!user) return null;
    const idx = user.apiKeys.findIndex(k => k.keyHash === keyHash);
    if (idx === -1) return null;
    user.apiKeys.splice(idx, 1);
    this.save();
    return this.generateApiKey(username, keyName ?? 'rotated', expiresInDays);
  }

  revokeApiKey(username: string, keyHash: string): boolean {
    const user = this.users.get(username);
    if (!user) return false;
    const idx = user.apiKeys.findIndex(k => k.keyHash === keyHash);
    if (idx === -1) return false;
    user.apiKeys.splice(idx, 1);
    user.updatedAt = new Date().toISOString();
    this.save();
    getGlobalLogger().info('AuthManager', 'API key revoked', { username });
    return true;
  }

  listApiKeys(username: string): ApiKeyEntry[] {
    return this.users.get(username)?.apiKeys ?? [];
  }

  // ── Authentication ───────────────────────────────────────────────

  /**
   * Authenticate a raw API key. Returns the user and role if valid.
   * The raw key is hashed and compared against stored hashes.
   */
  authenticate(rawKey: string): { user: AuthUser; role: AuthRole } | null {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    for (const user of this.users.values()) {
      if (!user.enabled) continue;
      const match = user.apiKeys.find(k => {
        if (k.keyHash !== keyHash) return false;
        if (k.expiresAt && new Date(k.expiresAt) < new Date()) return false;
        return true;
      });
      if (match) {
        match.lastUsedAt = new Date().toISOString();
        return { user, role: user.role };
      }
    }
    return null;
  }

  /**
   * Check if a role has sufficient permission for a required role.
   */
  hasPermission(userRole: AuthRole, requiredRole: AuthRole): boolean {
    return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0);
  }

  /**
   * Require a minimum role. Throws if insufficient.
   */
  requireRole(userRole: AuthRole, requiredRole: AuthRole): void {
    if (!this.hasPermission(userRole, requiredRole)) {
      throw new Error(`Insufficient permissions. Required: ${requiredRole}, has: ${userRole}`);
    }
  }

  // ── Persistence ──────────────────────────────────────────────────

  private save(): void {
    try {
      const dir = path.dirname(AUTH_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: AuthData = { users: Array.from(this.users.values()) };
      fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      getGlobalLogger().error('AuthManager', 'Failed to save auth data', err as Error);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(AUTH_FILE)) return;
      const data: AuthData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
      if (data.users && Array.isArray(data.users)) {
        for (const user of data.users) {
          this.users.set(user.username, user);
        }
      }
    } catch (err) {
      getGlobalLogger().error('AuthManager', 'Failed to load auth data', err as Error);
    }
  }

  /** Total user count */
  getStats(): { totalUsers: number; totalKeys: number; roles: Record<AuthRole, number> } {
    const roles: Record<AuthRole, number> = { admin: 0, operator: 0, viewer: 0 };
    let totalKeys = 0;
    for (const user of this.users.values()) {
      roles[user.role]++;
      totalKeys += user.apiKeys.length;
    }
    return { totalUsers: this.users.size, totalKeys, roles };
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let globalAuthManager: AuthManager | null = null;

export function getAuthManager(): AuthManager {
  if (!globalAuthManager) {
    globalAuthManager = new AuthManager();
  }
  return globalAuthManager;
}

export function resetAuthManager(): void {
  globalAuthManager = null;
}
