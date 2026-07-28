/**
 * AuthFailureStore — persistent storage for authentication failure tracking.
 *
 * Replaces the in-memory Map used by authMiddleware so that failure counters
 * and lockouts can be shared across multiple API processes. The default
 * in-memory implementation is kept for single-process dev/test deployments;
 * production multi-instance deployments should set AUTH_FAILURE_REDIS_URL.
 */

import { getGlobalLogger, optionalImport, optionalRequire } from '@commander/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AuthFailureEntry {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface AuthFailureStore {
  get(ip: string): Promise<AuthFailureEntry | undefined>;
  set(ip: string, entry: AuthFailureEntry): Promise<void>;
  delete(ip: string): Promise<void>;
  cleanup(now: number, windowMs: number): Promise<void>;
}

class InMemoryAuthFailureStore implements AuthFailureStore {
  private map = new Map<string, AuthFailureEntry>();

  async get(ip: string): Promise<AuthFailureEntry | undefined> {
    return this.map.get(ip);
  }

  async set(ip: string, entry: AuthFailureEntry): Promise<void> {
    this.map.set(ip, entry);
  }

  async delete(ip: string): Promise<void> {
    this.map.delete(ip);
  }

  async cleanup(now: number, windowMs: number): Promise<void> {
    for (const [ip, entry] of this.map) {
      if (entry.lockedUntil < now && entry.lastFailureAt < now - windowMs) {
        this.map.delete(ip);
      }
    }
  }

  entries(): [string, AuthFailureEntry][] {
    return Array.from(this.map.entries());
  }

  clear(): void {
    this.map.clear();
  }
}

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data/auth-failures.sqlite');

/**
 * SQLite-backed implementation. Multiple processes on the same host can share
 * the same database file (with WAL), but this is not suitable for true
 * multi-instance deployments without a shared filesystem.
 */
class SqliteAuthFailureStore implements AuthFailureStore {
  private db: any;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    // Use optionalRequire so better-sqlite3 remains an optional dependency.
    const Database = optionalRequire<typeof import('better-sqlite3')>('better-sqlite3');
    if (!Database) {
      throw new Error(
        'better-sqlite3 is not installed. Install it with `npm install better-sqlite3` or set AUTH_FAILURE_REDIS_URL.',
      );
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_failure_entries (
        ip TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        first_failure_at INTEGER NOT NULL,
        last_failure_at INTEGER NOT NULL,
        locked_until INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  async get(ip: string): Promise<AuthFailureEntry | undefined> {
    const row = this.db
      .prepare(
        'SELECT count, first_failure_at AS firstFailureAt, last_failure_at AS lastFailureAt, locked_until AS lockedUntil FROM auth_failure_entries WHERE ip = ?',
      )
      .get(ip);
    return row;
  }

  async set(ip: string, entry: AuthFailureEntry): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO auth_failure_entries (ip, count, first_failure_at, last_failure_at, locked_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = excluded.count, first_failure_at = excluded.first_failure_at, last_failure_at = excluded.last_failure_at, locked_until = excluded.locked_until',
      )
      .run(ip, entry.count, entry.firstFailureAt, entry.lastFailureAt, entry.lockedUntil);
  }

  async delete(ip: string): Promise<void> {
    this.db.prepare('DELETE FROM auth_failure_entries WHERE ip = ?').run(ip);
  }

  async cleanup(now: number, windowMs: number): Promise<void> {
    this.db
      .prepare('DELETE FROM auth_failure_entries WHERE locked_until < ? AND last_failure_at < ?')
      .run(now, now - windowMs);
  }
}

interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<string | null>;
  del(key: string): Promise<number>;
  scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<[string, string[]]>;
}

interface RedisModule {
  createClient(options: { url: string }): {
    connect(): Promise<void>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX?: number }): Promise<string | null>;
    del(key: string): Promise<number>;
    scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<[string, string[]]>;
    quit(): Promise<void>;
  };
}

/**
 * Redis-backed implementation for true multi-instance deployments.
 * Falls back to in-memory if Redis is unavailable at connection time.
 */
class RedisAuthFailureStore implements AuthFailureStore {
  private client: RedisClient | null = null;
  private fallback: InMemoryAuthFailureStore;
  private prefix: string;

  constructor(url: string, prefix = 'commander:auth-failures:') {
    this.prefix = prefix;
    this.fallback = new InMemoryAuthFailureStore();
    this.init(url).catch((err) => {
      try {
        getGlobalLogger().warn(
          'RedisAuthFailureStore',
          'Failed to initialize Redis auth failure store; falling back to in-memory',
          { error: (err as Error).message },
        );
      } catch {
        process.stderr.write(
          `[Auth] Failed to initialize Redis auth failure store: ${(err as Error).message}\n`,
        );
      }
    });
  }

  private async init(url: string): Promise<void> {
    const redis = await optionalImport<RedisModule>('redis');
    if (!redis) {
      throw new Error('redis package is not installed');
    }
    const client = redis.createClient({ url });
    await client.connect();
    this.client = client;

    // Drain any lockout state that accumulated while the client was offline.
    // Compare lastFailureAt so we don't overwrite fresher data that may have
    // been written to Redis while this drain was in progress.
    const oldFallback = this.fallback;
    for (const [ip, entry] of oldFallback.entries()) {
      try {
        const current = await this.get(ip);
        if (!current || current.lastFailureAt < entry.lastFailureAt) {
          await this.set(ip, entry);
        }
      } catch (err) {
        process.stderr.write(
          `[Auth] Failed to migrate fallback lockout state for ${ip}: ${String(err)}\n`,
        );
      }
    }
    this.fallback.clear();
  }

  private key(ip: string): string {
    return `${this.prefix}${ip}`;
  }

  async get(ip: string): Promise<AuthFailureEntry | undefined> {
    if (!this.client) return this.fallback.get(ip);
    const raw = await this.client.get(this.key(ip));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as AuthFailureEntry;
    } catch (err) {
      try {
        getGlobalLogger().warn('RedisAuthFailureStore', 'Malformed entry; treating as missing', {
          error: String(err),
        });
      } catch {
        process.stderr.write(`[Auth] Malformed Redis auth failure entry: ${String(err)}\n`);
      }
      return undefined;
    }
  }

  async set(ip: string, entry: AuthFailureEntry): Promise<void> {
    if (!this.client) {
      return this.fallback.set(ip, entry);
    }
    const ttl = entry.lockedUntil > 0 ? Math.ceil((entry.lockedUntil - Date.now()) / 1000) : 3600;
    await this.client.set(this.key(ip), JSON.stringify(entry), { EX: Math.max(ttl, 1) });
  }

  async delete(ip: string): Promise<void> {
    if (!this.client) {
      return this.fallback.delete(ip);
    }
    await this.client.del(this.key(ip));
  }

  async cleanup(now: number, windowMs: number): Promise<void> {
    if (!this.client) {
      return this.fallback.cleanup(now, windowMs);
    }
    // Redis TTL handles expiry; this is a best-effort scan for stale keys.
    let cursor = 0;
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, {
        MATCH: `${this.prefix}*`,
        COUNT: 100,
      });
      for (const key of keys) {
        const raw = await this.client.get(key);
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw) as AuthFailureEntry;
          if (entry.lockedUntil < now && entry.lastFailureAt < now - windowMs) {
            await this.client.del(key);
          }
        } catch {
          await this.client.del(key);
        }
      }
      cursor = Number(nextCursor);
    } while (cursor !== 0);
  }
}

let sharedStore: AuthFailureStore | null = null;

export function getAuthFailureStore(): AuthFailureStore {
  if (!sharedStore) {
    sharedStore = createAuthFailureStore();
  }
  return sharedStore;
}

export function createAuthFailureStore(): AuthFailureStore {
  const redisUrl = process.env.AUTH_FAILURE_REDIS_URL;
  if (redisUrl) {
    return new RedisAuthFailureStore(redisUrl);
  }

  const dbPath = process.env.AUTH_FAILURE_STORE_PATH;
  if (dbPath) {
    return new SqliteAuthFailureStore(dbPath);
  }

  if (process.env.NODE_ENV === 'production') {
    try {
      getGlobalLogger().warn(
        'AuthFailureStore',
        'No AUTH_FAILURE_REDIS_URL configured in production; using SQLite with default path. Lockout state will not be shared across instances without a shared filesystem or Redis.',
      );
    } catch (err) {
      process.stderr.write(
        `[Auth] No AUTH_FAILURE_REDIS_URL configured in production; using SQLite. ${String(err)}\n`,
      );
    }
    return new SqliteAuthFailureStore();
  }

  return new InMemoryAuthFailureStore();
}

export function setAuthFailureStore(store: AuthFailureStore): void {
  sharedStore = store;
}

export function resetAuthFailureStoreForTesting(): void {
  sharedStore = null;
}
