import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';

// ── Types ───────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'operator' | 'viewer';

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
  try {
    if (!fs.existsSync(USERS_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(USERS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as User[];
    if (!Array.isArray(parsed)) {
      process.stderr.write(`[userStore] users.json is not an array — ignoring\n`);
      return [];
    }
    return parsed;
  } catch (err) {
    process.stderr.write(`[userStore] Failed to read users.json: ${err}\n`);
    return [];
  }
}

function saveToDisk(users: User[]): void {
  try {
    if (!fs.existsSync(USERS_DIR)) {
      fs.mkdirSync(USERS_DIR, { recursive: true });
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
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
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'commander-admin';
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
