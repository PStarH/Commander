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
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { RunLease } from './types';
import { getGlobalLogger } from '../logging';

const nodeRequire = createRequire(import.meta.url);

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
  BetterSqlite3 = nodeRequire('better-sqlite3');
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
  private stmtInsertIfAbsent: BetterSqlite3Stmt | null = null;
  private stmtHeartbeat: BetterSqlite3Stmt | null = null;
  private stmtReclaimExpired: BetterSqlite3Stmt | null = null;
  private stmtNextGeneration: BetterSqlite3Stmt | null = null;
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
    this.db.pragma('busy_timeout = 5000');
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

      -- AL-01: SQLite treats NULLs as distinct inside a composite PRIMARY KEY,
      -- so "PRIMARY KEY (run_id, tenant_id)" does NOT make (run_id, NULL)
      -- unique. Without this partial index two connections can both insert a
      -- null-tenant lease for the same run, which defeats the CAS below.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_leases_run_null_tenant
        ON leases (run_id) WHERE tenant_id IS NULL;

      -- AL-01: fencing epochs are allocated from this authority, which is
      -- never deleted. release()/evict() delete the lease row, but the
      -- generation survives, so a later acquire() cannot restart the epoch.
      CREATE TABLE IF NOT EXISTS lease_generations (
        run_id TEXT NOT NULL,
        tenant_key TEXT NOT NULL,
        last_epoch INTEGER NOT NULL,
        PRIMARY KEY (run_id, tenant_key)
      );
    `);
  }

  private prepareStatements(): void {
    if (!this.db) return;
    this.stmtGet = this.db.prepare(`
      SELECT run_id, tenant_id, token, fencing_epoch, acquired_at, expires_at, holder
      FROM leases WHERE run_id = ? AND tenant_id IS ? LIMIT 1
    `);
    // AL-01: the owner key is unique for null and non-null tenants alike (see
    // the partial index in openDb), so OR IGNORE makes "insert only if the run
    // is unleased" a single atomic compare-and-set. changes===1 means we won.
    this.stmtInsertIfAbsent = this.db.prepare(`
      INSERT OR IGNORE INTO leases
        (run_id, tenant_id, token, fencing_epoch, acquired_at, expires_at, holder)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // AL-01: expires_at > ? is the liveness guard; an expired lease cannot be
    // resurrected by its old holder. The trailing epoch predicate is bound to
    // NULL by callers that do not track an epoch — because a token is minted
    // once per acquisition, a matching token already implies a matching epoch.
    this.stmtHeartbeat = this.db.prepare(`
      UPDATE leases SET expires_at = ?
      WHERE run_id = ? AND tenant_id IS ? AND token = ? AND expires_at > ?
        AND (? IS NULL OR fencing_epoch = ?)
    `);
    // AL-01: single-statement CAS for reclamation. `expires_at <= ?` and the
    // observed `fencing_epoch` decide the race: SQLite serialises the writers,
    // so a loser's changes is 0 and it must not report success.
    this.stmtReclaimExpired = this.db.prepare(`
      UPDATE leases
      SET token = ?, acquired_at = ?, expires_at = ?, holder = ?, fencing_epoch = ?
      WHERE run_id = ? AND tenant_id IS ? AND fencing_epoch = ? AND expires_at <= ?
    `);
    this.stmtNextGeneration = this.db.prepare(`
      INSERT INTO lease_generations (run_id, tenant_key, last_epoch)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, tenant_key) DO UPDATE
        SET last_epoch = MAX(last_epoch + 1, excluded.last_epoch)
      RETURNING last_epoch AS epoch
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
   * AL-01: acquisition is an atomic compare-and-set. A fresh acquire is an
   * `INSERT OR IGNORE` against the unique owner key and a reclaim is a single
   * `UPDATE ... WHERE expires_at <= ?`. Both inspect the affected row count, so
   * only the connection whose write actually changed the row reports
   * `acquired: true`. Every loser reads back and returns the current owner
   * instead of a fabricated success.
   *
   * Reclamation takes its fencing epoch from the durable lease_generations
   * authority, which `release`/`evict` never delete, so an epoch stays
   * monotonic across a run's whole life.
   */
  acquire(
    runId: string,
    options?: { tenantId?: string; holder?: string; ttlSeconds?: number },
  ): AcquireResult {
    if (
      !this.db ||
      !this.stmtGet ||
      !this.stmtInsertIfAbsent ||
      !this.stmtReclaimExpired ||
      !this.stmtNextGeneration
    ) {
      throw new Error('LeaseManager not initialized');
    }
    const tenantId = options?.tenantId ?? null;
    const holder = options?.holder ?? this.config.defaultHolder;
    const ttlSeconds = options?.ttlSeconds ?? this.config.defaultTtlSeconds;
    const cacheKey = this.cacheKey(runId, tenantId);

    // A release racing this acquire can delete the row between the CAS and the
    // read-back; retry rather than invent a lease.
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = new Date();
      const acquiredAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      const existing = this.stmtGet.get(runId, tenantId) as LeaseRow | undefined;

      if (existing === undefined) {
        const token = randomUUID();
        const fencingEpoch = this.nextEpoch(runId, tenantId, 1);
        const inserted = this.stmtInsertIfAbsent.run(
          runId,
          tenantId,
          token,
          fencingEpoch,
          acquiredAt,
          expiresAt,
          holder,
        );
        if (inserted.changes === 1) {
          const lease: RunLease = { token, fencingEpoch, acquiredAt, expiresAt, runId, holder };
          this.inProcess.set(cacheKey, lease);
          return { acquired: true, lease };
        }
      } else if (new Date(existing.expires_at).getTime() <= now.getTime()) {
        const token = randomUUID();
        // Floor of existing+1 keeps the epoch strictly increasing even for a
        // row that predates the generation authority (legacy / seeded rows).
        const fencingEpoch = this.nextEpoch(runId, tenantId, existing.fencing_epoch + 1);
        const reclaimed = this.stmtReclaimExpired.run(
          token,
          acquiredAt,
          expiresAt,
          holder,
          fencingEpoch,
          runId,
          tenantId,
          existing.fencing_epoch,
          acquiredAt,
        );
        if (reclaimed.changes === 1) {
          const lease: RunLease = { token, fencingEpoch, acquiredAt, expiresAt, runId, holder };
          this.inProcess.set(cacheKey, lease);
          return { acquired: true, lease, reclaimed: true };
        }
      }

      // The row was live, or another connection won the CAS. Return the
      // authoritative current state instead of a lease we do not own.
      const current = this.stmtGet.get(runId, tenantId) as LeaseRow | undefined;
      if (current) {
        const lease = this.rowToLease(current, runId);
        this.inProcess.set(cacheKey, lease);
        return { acquired: false, lease };
      }
    }

    throw new Error(
      `LeaseManager.acquire: no lease row could be established or read for run ${runId} after repeated CAS attempts`,
    );
  }

  /**
   * Refresh a lease's expiry. Returns true only when the caller is still the
   * current, unexpired holder.
   *
   * AL-01: `expires_at > ?` makes an expired lease unrefreshable, so an old
   * holder cannot resurrect it before a takeover; a token/epoch mismatch also
   * fails closed.
   */
  heartbeat(
    runId: string,
    token: string,
    options?: { tenantId?: string; ttlSeconds?: number; epoch?: number },
  ): boolean {
    if (!this.db || !this.stmtHeartbeat) return false;
    const tenantId = options?.tenantId ?? null;
    const ttlSeconds = options?.ttlSeconds ?? this.config.defaultTtlSeconds;
    const epoch = options?.epoch ?? null;
    const nowIso = new Date().toISOString();
    const newExpires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const result = this.stmtHeartbeat.run(newExpires, runId, tenantId, token, nowIso, epoch, epoch);
    const cacheKey = this.cacheKey(runId, tenantId);
    if (result.changes === 1) {
      const cached = this.inProcess.get(cacheKey);
      if (cached && cached.token === token) {
        cached.expiresAt = newExpires;
      }
      return true;
    }
    // Failed closed: expired, fenced, or released. Drop any stale cached copy
    // so the next acquire re-reads authoritative state.
    const cached = this.inProcess.get(cacheKey);
    if (cached && cached.token === token) {
      this.inProcess.delete(cacheKey);
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
    this.stmtInsertIfAbsent = null;
    this.stmtHeartbeat = null;
    this.stmtReclaimExpired = null;
    this.stmtNextGeneration = null;
    this.stmtRelease = null;
    this.stmtEvictExpired = null;
    this.inProcess.clear();
  }

  private rowToLease(row: LeaseRow, runId: string): RunLease {
    return {
      token: row.token,
      fencingEpoch: row.fencing_epoch,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      runId,
      holder: row.holder,
    };
  }

  /**
   * Allocate the next fencing epoch from the durable generation authority.
   * `floor` is the smallest value the allocator may return, which lets a
   * reclaim outrank an epoch that was written before the authority existed.
   */
  private nextEpoch(runId: string, tenantId: string | null, floor: number): number {
    if (!this.stmtNextGeneration) throw new Error('LeaseManager not initialized');
    const row = this.stmtNextGeneration.get(runId, this.generationKey(tenantId), floor) as
      { epoch: number } | undefined;
    if (!row) {
      throw new Error(`LeaseManager: could not allocate a fencing epoch for run ${runId}`);
    }
    return row.epoch;
  }

  /**
   * NOT-NULL generation key. SQLite treats NULLs as distinct inside a composite
   * PRIMARY KEY, so the null tenant needs its own non-null encoding; the "!"
   * prefix cannot collide with the "t:" prefixed real-tenant keys.
   */
  private generationKey(tenantId: string | null): string {
    return tenantId === null ? '!' : `t:${tenantId}`;
  }

  private cacheKey(runId: string, tenantId: string | null): string {
    if (tenantId === null) return runId;
    return createHash('sha256').update(`${tenantId}::${runId}`).digest('hex');
  }
}
