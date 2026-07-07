import { reportSilentFailure } from '../silentFailureReporter';
// IdempotencyStore — P0-1 ATR kernel component.
// Persistent deduplication for tool side-effect calls. SQLite-backed, per-tenant.
//
//   begin(key, opts) → { acquired, record }
//     acquired=true  → fresh slot, state='in_progress'
//     acquired=false → existing live record; inspect record.state:
//       'in_progress' → another worker holds it; wait/fail-fast/skip
//       'completed'   → return record.result as cached output (replay)
//       'failed'      → return record.error as cached failure
//   complete(key, result) → state='completed'
//   fail(key, error)      → state='failed'
//   evict()               → garbage-collect expired entries
//
// Race semantics: two concurrent begin() calls — one wins INSERT, the other
// sees the live record. TTL bounds the race window; stuck 'in_progress' is
// reclaimed by the lease/fencing layer in P0-2 (not by this store).
//
// Tenancy: when tenantId is provided, the stored key is
//   SHA256(tenantId || "::" || inputKey) — prevents cross-tenant collisions.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getGlobalLogger } from '../logging';
import type { IdempotencyOptions, IdempotencyRecord, IdempotencyState } from './types';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

export interface IdempotencyStoreConfig {
  filePath: string;
  maxRecords: number;
  defaultTtlSeconds: number;
  evictEveryOps: number;
}

const DEFAULT_CONFIG: Omit<IdempotencyStoreConfig, 'filePath'> = {
  maxRecords: 100_000,
  defaultTtlSeconds: 24 * 60 * 60,
  evictEveryOps: 1_000,
};

function defaultFilePath(): string {
  return process.env.COMMANDER_ATR_IDEMPOTENCY_PATH ?? '.commander/atr_idempotency.db';
}

interface BetterSqlite3Stmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}
interface BetterSqlite3DB {
  prepare(sql: string): BetterSqlite3Stmt;
  pragma(sql: string): void;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch (_silentE_) {
  reportSilentFailure(_silentE_, 'idempotencyStore:62');
}

export class IdempotencyStore {
  private db: BetterSqlite3DB | null = null;
  private config: IdempotencyStoreConfig;
  private opCount = 0;

  private stmtGet: BetterSqlite3Stmt | null = null;
  private stmtGetRaw: BetterSqlite3Stmt | null = null;
  private stmtInsertIgnore: BetterSqlite3Stmt | null = null;
  private stmtReclaim: BetterSqlite3Stmt | null = null;
  private stmtComplete: BetterSqlite3Stmt | null = null;
  private stmtFail: BetterSqlite3Stmt | null = null;
  private stmtEvictExpired: BetterSqlite3Stmt | null = null;
  private stmtCount: BetterSqlite3Stmt | null = null;
  private stmtTrimOldest: BetterSqlite3Stmt | null = null;

  constructor(config?: Partial<IdempotencyStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, filePath: defaultFilePath(), ...config };
    this.openDb();
    this.prepareStatements();
  }

  private openDb(): void {
    if (!BetterSqlite3) {
      throw new Error(
        'IdempotencyStore requires better-sqlite3. Install it: pnpm add better-sqlite3',
      );
    }
    if (this.config.filePath !== ':memory:') {
      mkdirSync(dirname(this.config.filePath), { recursive: true });
    }
    this.db = new BetterSqlite3(this.config.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        result TEXT,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        expires_at TEXT NOT NULL,
        tenant_id TEXT,
        run_id TEXT,
        tool_name TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_expires ON idempotency(expires_at);
      CREATE INDEX IF NOT EXISTS idx_tenant_run ON idempotency(tenant_id, run_id);
    `);
  }

  private prepareStatements(): void {
    if (!this.db) return;
    this.stmtGet = this.db.prepare(`
      SELECT key, state, result, error, attempt_count, started_at,
             completed_at, expires_at, tenant_id, run_id, tool_name
      FROM idempotency WHERE key = ? AND expires_at > ?
    `);
    this.stmtGetRaw = this.db.prepare(`
      SELECT key, state, result, error, attempt_count, started_at,
             completed_at, expires_at, tenant_id, run_id, tool_name
      FROM idempotency WHERE key = ?
    `);
    this.stmtInsertIgnore = this.db.prepare(`
      INSERT OR IGNORE INTO idempotency
        (key, state, attempt_count, started_at, expires_at, tenant_id, run_id, tool_name)
      VALUES (?, 'in_progress', 1, ?, ?, ?, ?, ?)
    `);
    this.stmtReclaim = this.db.prepare(`
      UPDATE idempotency
      SET state = 'in_progress',
          attempt_count = attempt_count + 1,
          started_at = ?,
          expires_at = ?
      WHERE key = ?
        AND expires_at <= ?
        AND state != 'in_progress'
    `);
    this.stmtComplete = this.db.prepare(`
      UPDATE idempotency
      SET state = 'completed', result = ?, completed_at = ?, expires_at = ?
      WHERE key = ?
    `);
    this.stmtFail = this.db.prepare(`
      UPDATE idempotency
      SET state = 'failed', error = ?, completed_at = ?, expires_at = ?
      WHERE key = ?
    `);
    this.stmtEvictExpired = this.db.prepare(`DELETE FROM idempotency WHERE expires_at <= ?`);
    this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS c FROM idempotency`);
    this.stmtTrimOldest = this.db.prepare(`
      DELETE FROM idempotency WHERE key IN (
        SELECT key FROM idempotency ORDER BY expires_at ASC LIMIT ?
      )
    `);
  }

  begin(
    key: string,
    options?: Partial<IdempotencyOptions>,
  ): { acquired: boolean; record: IdempotencyRecord } {
    if (!this.db || !this.stmtGetRaw || !this.stmtInsertIgnore || !this.stmtReclaim) {
      throw new Error('IdempotencyStore not initialized');
    }

    this.maybeEvict();

    const opts: IdempotencyOptions = {
      ttlSeconds: options?.ttlSeconds ?? this.config.defaultTtlSeconds,
      tenantId: options?.tenantId,
      runId: options?.runId,
      toolName: options?.toolName,
    };
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + opts.ttlSeconds * 1000).toISOString();
    const namespacedKey = this.namespaceKey(key, opts.tenantId);

    const insertResult = this.stmtInsertIgnore.run(
      namespacedKey,
      nowIso,
      expiresIso,
      opts.tenantId ?? null,
      opts.runId ?? null,
      opts.toolName ?? null,
    );

    if (insertResult.changes === 1) {
      this.enforceSizeCap();
      const row = this.stmtGetRaw.get(namespacedKey);
      if (!row) {
        throw new Error('IdempotencyStore.begin: row vanished after insert (eviction race)');
      }
      return { acquired: true, record: this.rowToRecord(row) };
    }

    const existing = this.stmtGetRaw.get(namespacedKey);
    if (!existing) {
      throw new Error('IdempotencyStore.begin: row vanished after conflict (eviction race)');
    }

    const isExpired = new Date(existing.expires_at as string).getTime() <= now.getTime();
    const existingState = existing.state as IdempotencyState;

    if (isExpired && existingState !== 'in_progress') {
      const reclaimResult = this.stmtReclaim.run(nowIso, expiresIso, namespacedKey, nowIso);
      if (reclaimResult.changes === 1) {
        const reclaimed = this.stmtGetRaw.get(namespacedKey);
        if (reclaimed) return { acquired: true, record: this.rowToRecord(reclaimed) };
      }
      const afterRace = this.stmtGetRaw.get(namespacedKey);
      if (!afterRace) {
        throw new Error('IdempotencyStore.begin: row vanished after reclaim (eviction race)');
      }
      return { acquired: false, record: this.rowToRecord(afterRace) };
    }

    return { acquired: false, record: this.rowToRecord(existing) };
  }

  complete(key: string, result: string, opts?: { tenantId?: string; ttlSeconds?: number }): void {
    if (!this.db || !this.stmtComplete) return;
    const ttl = opts?.ttlSeconds ?? this.config.defaultTtlSeconds;
    const now = new Date();
    this.stmtComplete.run(
      result,
      now.toISOString(),
      new Date(now.getTime() + ttl * 1000).toISOString(),
      this.namespaceKey(key, opts?.tenantId),
    );
  }

  fail(key: string, error: string, opts?: { tenantId?: string; ttlSeconds?: number }): void {
    if (!this.db || !this.stmtFail) return;
    const ttl = opts?.ttlSeconds ?? this.config.defaultTtlSeconds;
    const now = new Date();
    this.stmtFail.run(
      error,
      now.toISOString(),
      new Date(now.getTime() + ttl * 1000).toISOString(),
      this.namespaceKey(key, opts?.tenantId),
    );
  }

  get(key: string, opts?: { tenantId?: string }): IdempotencyRecord | null {
    if (!this.db || !this.stmtGet) return null;
    const row = this.stmtGet.get(
      this.namespaceKey(key, opts?.tenantId),
      new Date().toISOString(),
    ) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  evict(): number {
    if (!this.db || !this.stmtEvictExpired) return 0;
    return this.stmtEvictExpired.run(new Date().toISOString()).changes;
  }

  size(): number {
    if (!this.db || !this.stmtCount) return 0;
    const row = this.stmtCount.get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.stmtGet = null;
    this.stmtGetRaw = null;
    this.stmtInsertIgnore = null;
    this.stmtReclaim = null;
    this.stmtComplete = null;
    this.stmtFail = null;
    this.stmtEvictExpired = null;
    this.stmtCount = null;
    this.stmtTrimOldest = null;
  }

  private namespaceKey(key: string, tenantId?: string): string {
    if (!tenantId) return key;
    return createHash('sha256').update(`${tenantId}::${key}`).digest('hex');
  }

  private enforceSizeCap(): void {
    if (!this.stmtTrimOldest) return;
    try {
      const overage = this.size() - this.config.maxRecords;
      if (overage > 0) this.stmtTrimOldest.run(overage);
    } catch (e) {
      getGlobalLogger().warn('IdempotencyStore', 'Trim failed', {
        error: (e as Error)?.message,
      });
    }
  }

  private maybeEvict(): void {
    this.opCount++;
    if (this.opCount < this.config.evictEveryOps) return;
    this.opCount = 0;
    try {
      this.evict();
    } catch (e) {
      getGlobalLogger().warn('IdempotencyStore', 'Evict failed', {
        error: (e as Error)?.message,
      });
    }
  }

  private rowToRecord(row: Record<string, unknown>): IdempotencyRecord {
    return {
      key: row.key as string,
      state: row.state as IdempotencyState,
      result: (row.result as string) ?? undefined,
      error: (row.error as string) ?? undefined,
      attemptCount: row.attempt_count as number,
      startedAt: row.started_at as string,
      completedAt: (row.completed_at as string) ?? undefined,
      expiresAt: row.expires_at as string,
      tenantId: (row.tenant_id as string) ?? undefined,
      runId: (row.run_id as string) ?? undefined,
      toolName: (row.tool_name as string) ?? undefined,
    };
  }
}

const idempotencyStoreSingleton = createTenantAwareSingleton(
  () =>
    new IdempotencyStore(
      process.env.COMMANDER_ATR_MEMORY === '1'
        ? { filePath: ':memory:' }
        : process.env.COMMANDER_ATR_IDEMPOTENCY_PATH
          ? { filePath: process.env.COMMANDER_ATR_IDEMPOTENCY_PATH }
          : undefined,
    ),
  { allowGlobalFallback: true, dispose: (store) => store.close() },
);

export function getIdempotencyStore(): IdempotencyStore {
  return idempotencyStoreSingleton.get();
}

export function resetIdempotencyStore(): void {
  idempotencyStoreSingleton.reset();
}

export function newLeaseToken(): string {
  return randomUUID();
}
