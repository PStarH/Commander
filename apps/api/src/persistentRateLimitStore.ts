/**
 * PersistentRateLimitStore — SQLite-backed rate limit state.
 *
 * Replaces the in-memory Map so rate limit counters survive process restarts.
 * Uses better-sqlite3 with WAL for atomicity.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/rate-limit.sqlite');

export interface RateLimitEntryRow {
  key: string;
  count: number;
  resetAt: number;
}

export class PersistentRateLimitStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const filePath = dbPath ?? DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_entries (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        reset_at INTEGER NOT NULL
      )
    `);

    // Migration: older installations used an `ip` column. SQLite supports
    // RENAME COLUMN since 3.25; better-sqlite3 bundles a recent release.
    // If the rename fails (unexpected old SQLite), we drop and recreate —
    // losing transient rate-limit counters is acceptable and avoids startup
    // crashes on schema skew.
    const columns = this.db.prepare('PRAGMA table_info(rate_limit_entries)').all() as Array<{
      name: string;
    }>;
    if (columns.some((c) => c.name === 'ip') && !columns.some((c) => c.name === 'key')) {
      try {
        this.db.exec('ALTER TABLE rate_limit_entries RENAME COLUMN ip TO key');
      } catch (e) {
        process.stderr.write(
          `[PersistentRateLimitStore] Schema migration failed, recreating table: ${(e as Error).message}\n`,
        );
        this.db.exec('DROP TABLE rate_limit_entries');
        this.db.exec(`
          CREATE TABLE rate_limit_entries (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0,
            reset_at INTEGER NOT NULL
          )
        `);
      }
    }
  }

  get(key: string, now: number): { count: number; resetAt: number } | null {
    const row = this.db
      .prepare('SELECT count, reset_at FROM rate_limit_entries WHERE key = ?')
      .get(key) as { count: number; reset_at: number } | undefined;
    if (!row) return null;
    if (row.reset_at < now) {
      this.db.prepare('DELETE FROM rate_limit_entries WHERE key = ?').run(key);
      return null;
    }
    return { count: row.count, resetAt: row.reset_at };
  }

  set(key: string, count: number, resetAt: number): void {
    this.db
      .prepare(
        'INSERT INTO rate_limit_entries (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at',
      )
      .run(key, count, resetAt);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM rate_limit_entries WHERE key = ?').run(key);
  }

  cleanup(now: number): number {
    const result = this.db.prepare('DELETE FROM rate_limit_entries WHERE reset_at < ?').run(now);
    return result.changes;
  }

  /**
   * listActive(now) — return all rate-limit rows whose reset_at >= now.
   *
   * Used at boot to hydrate the in-memory cache so the first request after
   * a process restart sees the rate-limit state from before the crash.
   * Filtering expired rows here keeps Map hydration bounded — only live
   * counters cross the SQL→Map boundary. Ordered by reset_at ASC so the
   * most-imminent expirations are first (matches the eviction order of
   * the in-memory Map).
   */
  listActive(now: number, limit?: number): RateLimitEntryRow[] {
    const sql =
      `SELECT key, count, reset_at AS resetAt FROM rate_limit_entries ` +
      `WHERE reset_at >= ? ORDER BY reset_at ASC` +
      (limit ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : '');
    const rows = this.db.prepare(sql).all(now) as Array<{
      key: string;
      count: number;
      resetAt: number;
    }>;
    return rows.map((r) => ({ key: r.key, count: r.count, resetAt: r.resetAt }));
  }

  /**
   * countActive(now) — return the number of unexpired rows. Cheap
   * diagnostic for boots: lets the middleware log "hydrated N rows from
   * persistent store" without iterating the result set twice.
   */
  countActive(now: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM rate_limit_entries WHERE reset_at >= ?')
      .get(now) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
