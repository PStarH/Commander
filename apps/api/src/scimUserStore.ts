/**
 * Persistent multi-tenant SCIM 2.0 user/group store.
 *
 * Data is kept as JSON files per tenant:
 *   <dataRoot>/data/scim/<tenantId>/users.json
 *   <dataRoot>/data/scim/<tenantId>/groups.json
 *
 * Writes are atomic (temp file + rename) and serialized per file by a simple
 * in-process lock so concurrent requests cannot corrupt JSON.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

export interface ScimEmail {
  value?: string;
  primary?: boolean;
}

export interface ScimMember {
  value: string;
  display?: string;
  type?: 'User' | 'Group';
}

export interface ScimUser {
  schemas: string[];
  id: string;
  userName: string;
  name?: ScimName;
  emails?: ScimEmail[];
  active: boolean;
  meta: {
    resourceType: 'User';
    created: string;
    lastModified: string;
    location: string;
  };
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  displayName: string;
  members?: ScimMember[];
  meta: {
    resourceType: 'Group';
    created: string;
    lastModified: string;
    location: string;
  };
}

export type ScimUserPatch = Partial<Pick<ScimUser, 'userName' | 'name' | 'emails' | 'active'>>;

export type ScimGroupPatch = Partial<Pick<ScimGroup, 'displayName' | 'members'>>;

export class ScimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScimConflictError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function defaultDataRoot(): string {
  return process.cwd();
}

function normalizeTenantId(tenantId: string | undefined | null): string {
  return tenantId && typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : '__default__';
}

// ── Store ───────────────────────────────────────────────────────────────────

export class ScimUserStore {
  readonly dataRoot: string;
  private locks = new Map<string, Promise<unknown>>();

  constructor(dataRoot?: string) {
    this.dataRoot = dataRoot ?? process.env.SCIM_DATA_DIR ?? defaultDataRoot();
  }

  // ── Paths ─────────────────────────────────────────────────────────────────

  private tenantDir(tenantId: string): string {
    return path.join(this.dataRoot, 'data', 'scim', tenantId);
  }

  private usersFile(tenantId: string): string {
    return path.join(this.tenantDir(tenantId), 'users.json');
  }

  private groupsFile(tenantId: string): string {
    return path.join(this.tenantDir(tenantId), 'groups.json');
  }

  // ── File locking / atomic IO ──────────────────────────────────────────────

  private async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(filePath) ?? Promise.resolve();
    const next = previous
      .then(
        () => fn(),
        () => fn(),
      )
      .finally(() => {
        if (this.locks.get(filePath) === next) {
          this.locks.delete(filePath);
        }
      });
    this.locks.set(filePath, next);
    return next;
  }

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${filePath}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, filePath);
  }

  private async readJsonFile<T>(filePath: string): Promise<T[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(`Invalid data: expected array`);
      }
      return parsed as T[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async createUser(tenantId: string | undefined, user: ScimUser): Promise<ScimUser> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.usersFile(tId);
    return this.withLock(filePath, async () => {
      const users = await this.readJsonFile<ScimUser>(filePath);
      if (users.some((u) => u.userName === user.userName)) {
        throw new ScimConflictError(`User ${user.userName} already exists`);
      }
      users.push(user);
      await this.atomicWrite(filePath, users);
      return user;
    });
  }

  async getUser(tenantId: string | undefined, userId: string): Promise<ScimUser | null> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.usersFile(tId);
    return this.withLock(filePath, async () => {
      const users = await this.readJsonFile<ScimUser>(filePath);
      return users.find((u) => u.id === userId) ?? null;
    });
  }

  async getUserByUserName(
    tenantId: string | undefined,
    userName: string,
  ): Promise<ScimUser | null> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.usersFile(tId);
    return this.withLock(filePath, async () => {
      const users = await this.readJsonFile<ScimUser>(filePath);
      return users.find((u) => u.userName === userName) ?? null;
    });
  }

  async updateUser(
    tenantId: string | undefined,
    userId: string,
    patch: ScimUserPatch,
  ): Promise<ScimUser | null> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.usersFile(tId);
    return this.withLock(filePath, async () => {
      const users = await this.readJsonFile<ScimUser>(filePath);
      const idx = users.findIndex((u) => u.id === userId);
      if (idx === -1) {
        return null;
      }
      const existing = users[idx];

      if (patch.userName !== undefined) {
        if (
          patch.userName !== existing.userName &&
          users.some((u) => u.userName === patch.userName)
        ) {
          throw new ScimConflictError(`User ${patch.userName} already exists`);
        }
        existing.userName = patch.userName;
      }
      if (patch.name !== undefined) {
        existing.name = patch.name;
      }
      if (patch.emails !== undefined) {
        existing.emails = patch.emails;
      }
      if (patch.active !== undefined) {
        existing.active = patch.active;
      }
      existing.meta.lastModified = new Date().toISOString();

      await this.atomicWrite(filePath, users);
      return existing;
    });
  }

  async deleteUser(tenantId: string | undefined, userId: string): Promise<boolean> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.usersFile(tId);
    return this.withLock(filePath, async () => {
      const users = await this.readJsonFile<ScimUser>(filePath);
      const filtered = users.filter((u) => u.id !== userId);
      if (filtered.length === users.length) {
        return false;
      }
      await this.atomicWrite(filePath, filtered);
      return true;
    });
  }

  async listUsers(tenantId: string | undefined, filter?: string): Promise<ScimUser[]> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.usersFile(tId);
    return this.withLock(filePath, async () => {
      const users = await this.readJsonFile<ScimUser>(filePath);
      if (!filter) {
        return users;
      }
      return users.filter((u) => matchesFilter(u as unknown as Record<string, unknown>, filter));
    });
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  async createGroup(tenantId: string | undefined, group: ScimGroup): Promise<ScimGroup> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.groupsFile(tId);
    return this.withLock(filePath, async () => {
      const groups = await this.readJsonFile<ScimGroup>(filePath);
      if (groups.some((g) => g.displayName === group.displayName)) {
        throw new ScimConflictError(`Group ${group.displayName} already exists`);
      }
      groups.push(group);
      await this.atomicWrite(filePath, groups);
      return group;
    });
  }

  async getGroup(tenantId: string | undefined, groupId: string): Promise<ScimGroup | null> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.groupsFile(tId);
    return this.withLock(filePath, async () => {
      const groups = await this.readJsonFile<ScimGroup>(filePath);
      return groups.find((g) => g.id === groupId) ?? null;
    });
  }

  async updateGroup(
    tenantId: string | undefined,
    groupId: string,
    patch: ScimGroupPatch,
  ): Promise<ScimGroup | null> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.groupsFile(tId);
    return this.withLock(filePath, async () => {
      const groups = await this.readJsonFile<ScimGroup>(filePath);
      const idx = groups.findIndex((g) => g.id === groupId);
      if (idx === -1) {
        return null;
      }
      const existing = groups[idx];

      if (patch.displayName !== undefined) {
        if (
          patch.displayName !== existing.displayName &&
          groups.some((g) => g.displayName === patch.displayName)
        ) {
          throw new ScimConflictError(`Group ${patch.displayName} already exists`);
        }
        existing.displayName = patch.displayName;
      }
      if (patch.members !== undefined) {
        existing.members = patch.members;
      }
      existing.meta.lastModified = new Date().toISOString();

      await this.atomicWrite(filePath, groups);
      return existing;
    });
  }

  async deleteGroup(tenantId: string | undefined, groupId: string): Promise<boolean> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.groupsFile(tId);
    return this.withLock(filePath, async () => {
      const groups = await this.readJsonFile<ScimGroup>(filePath);
      const filtered = groups.filter((g) => g.id !== groupId);
      if (filtered.length === groups.length) {
        return false;
      }
      await this.atomicWrite(filePath, filtered);
      return true;
    });
  }

  async listGroups(tenantId: string | undefined, filter?: string): Promise<ScimGroup[]> {
    const tId = normalizeTenantId(tenantId);
    const filePath = this.groupsFile(tId);
    return this.withLock(filePath, async () => {
      const groups = await this.readJsonFile<ScimGroup>(filePath);
      if (!filter) {
        return groups;
      }
      return groups.filter((g) => matchesFilter(g as unknown as Record<string, unknown>, filter));
    });
  }

  // ── Reset (test helper) ───────────────────────────────────────────────────

  async reset(tenantId?: string): Promise<void> {
    if (tenantId !== undefined) {
      const tId = normalizeTenantId(tenantId);
      await fs.rm(this.tenantDir(tId), { recursive: true, force: true });
      return;
    }
    const base = path.join(this.dataRoot, 'data', 'scim');
    await fs.rm(base, { recursive: true, force: true });
  }
}

// ── Filter parsing (minimal SCIM subset) ────────────────────────────────────

function matchesFilter(resource: Record<string, unknown>, filter: string): boolean {
  const lower = filter.trim().toLowerCase();

  // Split top-level 'and' clauses (no parentheses support).
  const clauses = lower.split(/\s+and\s+/);
  return clauses.every((clause) => matchesClause(resource, clause.trim()));
}

function matchesClause(resource: Record<string, unknown>, clause: string): boolean {
  const eqMatch = clause.match(/^([a-z0-9_]+)\s+eq\s+"([^"]*)"$/i);
  if (eqMatch) {
    const attr = eqMatch[1];
    const value = eqMatch[2];
    const actual = getAttribute(resource, attr);
    if (Array.isArray(actual)) {
      return actual.includes(value);
    }
    return actual === value;
  }

  const prMatch = clause.match(/^([a-z0-9_]+)\s+pr$/i);
  if (prMatch) {
    const attr = prMatch[1];
    const val = getAttribute(resource, attr);
    if (Array.isArray(val)) {
      return val.length > 0;
    }
    return val !== undefined && val !== null && val !== '';
  }

  // Unknown clauses are treated as non-matching.
  return false;
}

function getAttribute(resource: Record<string, unknown>, attr: string): unknown {
  const lowerAttr = attr.toLowerCase();

  // Case-insensitive direct scalar lookup: userName, displayName, active.
  for (const key of Object.keys(resource)) {
    if (key.toLowerCase() === lowerAttr) {
      const val = resource[key];
      if (typeof val === 'string' || typeof val === 'boolean') {
        return String(val).toLowerCase();
      }
      break;
    }
  }

  // Multi-value complex attributes: emails.value, members.value.
  if (lowerAttr === 'emails') {
    const emails = resource.emails;
    if (Array.isArray(emails)) {
      return emails
        .map((e) =>
          e && typeof (e as ScimEmail).value === 'string'
            ? (e as ScimEmail).value!.toLowerCase()
            : '',
        )
        .filter(Boolean);
    }
  }

  if (lowerAttr === 'members') {
    const members = resource.members;
    if (Array.isArray(members)) {
      return members
        .map((m) =>
          m && typeof (m as ScimMember).value === 'string'
            ? (m as ScimMember).value!.toLowerCase()
            : '',
        )
        .filter(Boolean);
    }
  }

  return undefined;
}

// ── Singleton for production use ────────────────────────────────────────────

let defaultStore: ScimUserStore | undefined;

export function getDefaultScimUserStore(): ScimUserStore {
  if (!defaultStore) {
    defaultStore = new ScimUserStore();
  }
  return defaultStore;
}

export function resetDefaultScimUserStore(): void {
  defaultStore = undefined;
}
