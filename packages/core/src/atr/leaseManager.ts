import { reportSilentFailure } from '../silentFailureReporter';
/**
 * LeaseManager — P0-2 ATR kernel component.
 *
 * Process fencing for run ownership. When a process acquires a lease for a
 * runId, it gets back a token + a monotonic fencing epoch. Any resume / mutate
 * operation must present the matching token, AND the stored epoch must be
 * monotonically increasing. A zombie process that resumes with a stale epoch
 * is rejected (fenced).
 *
 * Why this matters: process A starts a run, gets epoch 5, crashes mid-execution.
 * Process B picks up the run, gets epoch 6. When process A's death-throes try
 * to write a checkpoint, the epoch check fails and the write is rejected.
 *
 * Persistence: SQLite-backed so leases survive process restarts. Multi-process
 * scenarios (e.g. a worker pool sharing the same DB file) get true fencing.
 * Single-process scenarios get a fast in-process path that falls through to
 * SQLite on contention.
 *
 * Tenancy: leases are namespaced by tenantId (the SQLite row key is
 *   SHA256(tenantId || "::" || runId)
 * ), so tenant A cannot reclaim tenant B's lease.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunLease } from './types';
import { getGlobalLogger } from '../logging';

export interface LeaseManagerConfig {
  filePath: string;
  /** Lease TTL in seconds — after this, a lease is considered expired and reclaimable */
  defaultTtlSeconds: number;
  /** Default holder label if caller does not provide one */
  defaultHolder: string;
}

const DEFAULT_CONFIG: LeaseManagerConfig = {
  filePath: '.commander/atr_leases.db',
  defaultTtlSeconds: 30,
  defaultHolder: `unknown-${process.pid}`,
};

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
}

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch (_silentE_) {
  reportSilentFailure(_silentE_, 'leaseManager:60');
}

interface LeaseRow {
  run_id: string;
  tenant_id: string | null;
  token: string;
  fencing_epoch: number;
  acquired_at: string;
  expires_at: string;
  holder: string;
}

/**
 * Outcome of an acquire attempt.
 *
 *  - acquired=true  → fresh lease, caller is the new owner
 *  - acquired=false → existing live lease; inspect `lease` to see who owns it
 */
export interface AcquireResult {
  acquired: boolean;
  lease: RunLease;
  /** True if the previous lease had expired and was reclaimed */
  reclaimed?: boolean;
}

export class LeaseManager {
  private db: BetterSqlite3DB | null = null;
  private config: LeaseManagerConfig;
  /** In-process cache: token → epoch. Faster than SQLite for heartbeat calls. */
  private inProcess: Map<string, RunLease> = new Map();

  private stmtGet: BetterSqlite3Stmt | null = null;
  private stmtInsert: BetterSqlite3Stmt | null = null;
  private stmtHeartbeat: BetterSqlite3Stmt | null = null;
  private stmtBumpEpoch: BetterSqlite3Stmt | null = null;
  private stmtRelease: BetterSqlite3Stmt | null = null;
  private stmtEvictExpired: BetterSqlite3Stmt | null = null;

  constructor(config?: Partial<LeaseManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.openDb();
    this.prepareStatements();
  }

  private openDb(): void {
    if (!BetterSqlite3) {
      throw new Error('LeaseManager requires better-sqlite3. Install it: pnpm add better-sqlite3');
    }
    if (this.config.filePath !== ':memory:') {
      mkdirSync(dirname(this.config.filePath), { recursive: true });
    }
    this.db = new BetterSqlite3(this.config.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        run_id TEXT NOT NULL,
        tenant_id TEXT,
        token TEXT NOT NULL,
        fencing_epoch INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        holder TEXT NOT NULL,
        PRIMARY KEY (run_id, tenant_id)
      );
    `);
  }

  private prepareStatements(): void {
    if (!this.db) return;
    this.stmtGet = this.db.prepare(`
      SELECT run_id, tenant_id, token, fencing_epoch, acquired_at, expires_at, holder
      FROM leases WHERE run_id = ? AND tenant_id IS ? LIMIT 1
    `);
    this.stmtInsert = this.db.prepare(`
      INSERT OR REPLACE INTO leases
        (run_id, tenant_id, token, fencing_epoch, acquired_at, expires_at, holder)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtHeartbeat = this.db.prepare(`
      UPDATE leases SET expires_at = ? WHERE run_id = ? AND tenant_id IS ? AND token = ?
    `);
    this.stmtBumpEpoch = this.db.prepare(`
      UPDATE leases
      SET fencing_epoch = fencing_epoch + 1,
          token = ?,
          acquired_at = ?,
          expires_at = ?,
          holder = ?
      WHERE run_id = ? AND tenant_id IS ? AND token = ?
    `);
    this.stmtRelease = this.db.prepare(`
      DELETE FROM leases WHERE run_id = ? AND tenant_id IS ? AND token = ?
    `);
    this.stmtEvictExpired = this.db.prepare(`
      DELETE FROM leases WHERE expires_at <= ?
    `);
  }

  /**
   * Acquire a lease for a run. If the run is not leased, returns a fresh lease.
   * If the run is already leased, returns the existing lease with `acquired=false`
   * (unless the existing lease has expired, in which case it is reclaimed and
   * `acquired=true` is returned with `reclaimed=true`).
   *
   * Reclamation bumps the fencing epoch, invalidating any tokens a zombie
   * process might still hold.
   */
  acquire(
    runId: string,
    options?: { tenantId?: string; holder?: string; ttlSeconds?: number },
  ): AcquireResult {
    if (!this.db || !this.stmtGet || !this.stmtInsert || !this.stmtBumpEpoch) {
      throw new Error('LeaseManager not initialized');
    }
    const tenantId = options?.tenantId ?? null;
    const holder = options?.holder ?? this.config.defaultHolder;
    const ttlSeconds = options?.ttlSeconds ?? this.config.defaultTtlSeconds;

    const existing = this.stmtGet.get(runId, tenantId) as LeaseRow | undefined;
    const now = new Date();

    if (existing) {
      const isExpired = new Date(existing.expires_at).getTime() <= now.getTime();
      if (isExpired) {
        // Bump epoch: any zombie process holding the old token is now fenced.
        const newToken = randomUUID();
        const newEpoch = existing.fencing_epoch + 1;
        const newAcquired = now.toISOString();
        const newExpires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
        this.stmtBumpEpoch.run(
          newToken,
          newAcquired,
          newExpires,
          holder,
          runId,
          tenantId,
          existing.token,
        );
        const lease: RunLease = {
          token: newToken,
          fencingEpoch: newEpoch,
          acquiredAt: newAcquired,
          expiresAt: newExpires,
          runId,
          holder,
        };
        this.inProcess.set(this.cacheKey(runId, tenantId), lease);
        return { acquired: true, lease, reclaimed: true };
      }
      const lease: RunLease = {
        token: existing.token,
        fencingEpoch: existing.fencing_epoch,
        acquiredAt: existing.acquired_at,
        expiresAt: existing.expires_at,
        runId,
        holder: existing.holder,
      };
      this.inProcess.set(this.cacheKey(runId, tenantId), lease);
      return { acquired: false, lease };
    }

    // No existing lease — create one.
    const token = randomUUID();
    const lease: RunLease = {
      token,
      fencingEpoch: 1,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      runId,
      holder,
    };
    this.stmtInsert.run(
      runId,
      tenantId,
      token,
      lease.fencingEpoch,
      lease.acquiredAt,
      lease.expiresAt,
      holder,
    );
    this.inProcess.set(this.cacheKey(runId, tenantId), lease);
    return { acquired: true, lease };
  }

  /**
   * Refresh a lease's expiry. Returns true if the heartbeat succeeded; false
   * if the lease was lost (token mismatch / fenced / evicted).
   */
  heartbeat(
    runId: string,
    token: string,
    options?: { tenantId?: string; ttlSeconds?: number },
  ): boolean {
    if (!this.db || !this.stmtHeartbeat) return false;
    const tenantId = options?.tenantId ?? null;
    const ttlSeconds = options?.ttlSeconds ?? this.config.defaultTtlSeconds;
    const newExpires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const result = this.stmtHeartbeat.run(newExpires, runId, tenantId, token);
    if (result.changes === 1) {
      const cached = this.inProcess.get(this.cacheKey(runId, tenantId));
      if (cached && cached.token === token) {
        cached.expiresAt = newExpires;
      }
      return true;
    }
    return false;
  }

  /**
   * Release a lease. Returns true if it was actually held by this token.
   */
  release(runId: string, token: string, options?: { tenantId?: string }): boolean {
    if (!this.db || !this.stmtRelease) return false;
    const tenantId = options?.tenantId ?? null;
    const result = this.stmtRelease.run(runId, tenantId, token);
    this.inProcess.delete(this.cacheKey(runId, tenantId));
    return result.changes === 1;
  }

  /**
   * Validate that a (token, epoch) pair is still the current owner of a run.
   * Returns the live lease if valid; null if the caller is fenced (stale epoch)
   * or the lease has been released / evicted.
   */
  validate(
    runId: string,
    token: string,
    expectedEpoch: number,
    options?: { tenantId?: string },
  ): RunLease | null {
    if (!this.db || !this.stmtGet) return null;
    const tenantId = options?.tenantId ?? null;
    const row = this.stmtGet.get(runId, tenantId) as LeaseRow | undefined;
    if (!row) return null;
    if (row.token !== token) return null;
    if (row.fencing_epoch !== expectedEpoch) {
      getGlobalLogger().warn('LeaseManager', 'Fenced: stale epoch', {
        runId,
        expected: expectedEpoch,
        actual: row.fencing_epoch,
      });
      return null;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return {
      token: row.token,
      fencingEpoch: row.fencing_epoch,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      runId,
      holder: row.holder,
    };
  }

  /** Garbage-collect expired leases. */
  evict(): number {
    if (!this.db || !this.stmtEvictExpired) return 0;
    return this.stmtEvictExpired.run(new Date().toISOString()).changes;
  }

  /** Look up the current lease for a run (if any). Does not validate. */
  get(runId: string, options?: { tenantId?: string }): RunLease | null {
    if (!this.db || !this.stmtGet) return null;
    const tenantId = options?.tenantId ?? null;
    const row = this.stmtGet.get(runId, tenantId) as LeaseRow | undefined;
    if (!row) return null;
    return {
      token: row.token,
      fencingEpoch: row.fencing_epoch,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      runId,
      holder: row.holder,
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.stmtGet = null;
    this.stmtInsert = null;
    this.stmtHeartbeat = null;
    this.stmtBumpEpoch = null;
    this.stmtRelease = null;
    this.stmtEvictExpired = null;
    this.inProcess.clear();
  }

  private cacheKey(runId: string, tenantId: string | null): string {
    if (!tenantId) return runId;
    return createHash('sha256').update(`${tenantId}::${runId}`).digest('hex');
  }
}
