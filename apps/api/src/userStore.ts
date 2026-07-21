import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import { atomicWriteFileSync, readJsonFileSafe } from './atomicWrite';
import { isProductionEnv } from './envSignal';

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
  createdAt: string;
  lastLoginAt: string | null;
}

/**
 * The user object returned to clients — never includes the password hash.
 */
export type SafeUser = Omit<User, 'passwordHash'>;

function toSafeUser(user: User): SafeUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

// ── Persistence ─────────────────────────────────────────────────────────────
//
// Users are stored in a JSON file at <cwd>/.commander/users.json. An in-memory
// cache is kept for fast lookups; writes flush to disk synchronously so a
// crash never loses a freshly created account. The store auto-initializes a
// default admin user on first load.

const USERS_DIR = path.resolve(process.cwd(), '.commander');
const USERS_FILE = path.join(USERS_DIR, 'users.json');

let cache: User[] | null = null;
let initialized = false;

function loadFromDisk(): User[] {
  // REL-4: 损坏或错形（如 {"users":[...]}）均隔离到 .corrupt-*，禁止 silent [] →
  // ensureDefaultAdmin 原地抹掉 passwordHash（与 refreshTokenStore 对齐）。
  const parsed = readJsonFileSafe<User[] | null>(USERS_FILE, null, Array.isArray);
  return parsed ?? [];
}

function saveToDisk(users: User[]): void {
  try {
    // REL-3: atomic write so a crash mid-write cannot truncate password hashes.
    atomicWriteFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    process.stderr.write(`[userStore] Failed to write users.json: ${err}\n`);
  }
}

/**
 * Creates the default admin user if no users exist yet.
 * Username: admin
 * Password: ADMIN_PASSWORD env var, or 'commander-admin' as a dev default.
 */
function ensureDefaultAdmin(users: User[]): User[] {
  if (users.length > 0) {
    return users;
  }
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword && isProductionEnv()) {
    // AUTH-4: never seed a default admin with a well-known password in
    // production. Fail hard so the operator must provide ADMIN_PASSWORD.
    throw new Error(
      '[userStore] ADMIN_PASSWORD must be set in production before the default admin account ' +
        'can be created. Refusing to seed the well-known admin/commander-admin credential.',
    );
  }
  const adminPassword = configuredPassword ?? 'commander-admin';
  const now = new Date().toISOString();
  const admin: User = {
    id: randomUUID(),
    username: 'admin',
    email: 'admin@commander.local',
    passwordHash: hashSync(adminPassword, 10),
    role: 'admin',
    createdAt: now,
    lastLoginAt: null,
  };
  users.push(admin);
  saveToDisk(users);
  process.stdout.write(
    `[userStore] Created default admin user (username=admin). ` +
      `Change the password immediately in production.\n`,
  );
  return users;
}

/**
 * Loads users from disk (or cache) and ensures the default admin exists.
 * Called lazily on first access so import-time side effects are avoided.
 */
function getUsers(): User[] {
  if (cache !== null) {
    return cache;
  }
  cache = loadFromDisk();
  cache = ensureDefaultAdmin(cache);
  initialized = true;
  return cache;
}

/**
 * Persists the current cache to disk.
 */
function persist(users: User[]): void {
  cache = users;
  saveToDisk(users);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isInitialized(): boolean {
  return initialized;
}

export function findUserById(id: string): User | undefined {
  return getUsers().find((u) => u.id === id);
}

export function findUserByUsername(username: string): User | undefined {
  const lower = username.toLowerCase();
  return getUsers().find((u) => u.username.toLowerCase() === lower);
}

export function findUserByEmail(email: string): User | undefined {
  const lower = email.toLowerCase();
  return getUsers().find((u) => u.email.toLowerCase() === lower);
}

export function listUsers(): SafeUser[] {
  return getUsers().map(toSafeUser);
}

export function createUser(args: {
  username: string;
  email: string;
  password: string;
  role?: UserRole;
}): { user: SafeUser } | { error: string } {
  const users = getUsers();

  if (users.some((u) => u.username.toLowerCase() === args.username.toLowerCase())) {
    return { error: 'Username already exists' };
  }
  if (users.some((u) => u.email.toLowerCase() === args.email.toLowerCase())) {
    return { error: 'Email already registered' };
  }

  const now = new Date().toISOString();
  const user: User = {
    id: randomUUID(),
    username: args.username,
    email: args.email,
    passwordHash: hashSync(args.password, 10),
    role: args.role ?? 'viewer',
    createdAt: now,
    lastLoginAt: null,
  };
  users.push(user);
  persist(users);
  return { user: toSafeUser(user) };
}

export function updateLastLogin(userId: string): void {
  const users = getUsers();
  const user = users.find((u) => u.id === userId);
  if (user) {
    user.lastLoginAt = new Date().toISOString();
    persist(users);
  }
}

export function updateUserRole(userId: string, role: UserRole): SafeUser | null {
  const users = getUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) {
    return null;
  }
  user.role = role;
  persist(users);
  return toSafeUser(user);
}

export function updateUser(
  userId: string,
  updates: Partial<Pick<User, 'email' | 'role' | 'username'>>,
): SafeUser | { error: string } {
  const users = getUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) {
    return { error: 'User not found' };
  }

  if (updates.username !== undefined) {
    const conflict = users.find(
      (u) => u.id !== userId && u.username.toLowerCase() === updates.username!.toLowerCase(),
    );
    if (conflict) {
      return { error: 'Username already exists' };
    }
    user.username = updates.username;
  }

  if (updates.email !== undefined) {
    const conflict = users.find(
      (u) => u.id !== userId && u.email.toLowerCase() === updates.email!.toLowerCase(),
    );
    if (conflict) {
      return { error: 'Email already registered' };
    }
    user.email = updates.email;
  }

  if (updates.role !== undefined) {
    user.role = updates.role;
  }

  persist(users);
  return toSafeUser(user);
}

export function resetUserPassword(userId: string, newPassword: string): SafeUser | null {
  const users = getUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) {
    return null;
  }
  user.passwordHash = hashSync(newPassword, 10);
  persist(users);
  return toSafeUser(user);
}

export function deleteUser(userId: string): { success: boolean; error?: string } {
  const users = getUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }

  const adminCount = users.filter((u) => u.role === 'admin').length;
  if (user.role === 'admin' && adminCount <= 1) {
    return { success: false, error: 'Cannot delete the last admin account' };
  }

  const remaining = users.filter((u) => u.id !== userId);
  persist(remaining);
  return { success: true };
}

export function countAdmins(): number {
  return getUsers().filter((u) => u.role === 'admin').length;
}

export function toSafeUserPublic(user: User): SafeUser {
  return toSafeUser(user);
}

/** Test helper: clear in-memory cache so the next access re-reads disk. */
export function _resetUserStoreForTests(): void {
  cache = null;
  initialized = false;
}
