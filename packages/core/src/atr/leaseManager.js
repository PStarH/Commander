"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LeaseManager = void 0;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const logging_1 = require("../logging");
const DEFAULT_CONFIG = {
    filePath: '.commander/atr_leases.db',
    defaultTtlSeconds: 30,
    defaultHolder: `unknown-${process.pid}`,
};
let BetterSqlite3 = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BetterSqlite3 = require('better-sqlite3');
}
catch { }
class LeaseManager {
    constructor(config) {
        this.db = null;
        /** In-process cache: token → epoch. Faster than SQLite for heartbeat calls. */
        this.inProcess = new Map();
        this.stmtGet = null;
        this.stmtInsert = null;
        this.stmtHeartbeat = null;
        this.stmtBumpEpoch = null;
        this.stmtRelease = null;
        this.stmtEvictExpired = null;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.openDb();
        this.prepareStatements();
    }
    openDb() {
        if (!BetterSqlite3) {
            throw new Error('LeaseManager requires better-sqlite3. Install it: pnpm add better-sqlite3');
        }
        if (this.config.filePath !== ':memory:') {
            (0, fs_1.mkdirSync)((0, path_1.dirname)(this.config.filePath), { recursive: true });
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
    prepareStatements() {
        if (!this.db)
            return;
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
    acquire(runId, options) {
        var _a, _b, _c;
        if (!this.db || !this.stmtGet || !this.stmtInsert || !this.stmtBumpEpoch) {
            throw new Error('LeaseManager not initialized');
        }
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const holder = (_b = options === null || options === void 0 ? void 0 : options.holder) !== null && _b !== void 0 ? _b : this.config.defaultHolder;
        const ttlSeconds = (_c = options === null || options === void 0 ? void 0 : options.ttlSeconds) !== null && _c !== void 0 ? _c : this.config.defaultTtlSeconds;
        const existing = this.stmtGet.get(runId, tenantId);
        const now = new Date();
        if (existing) {
            const isExpired = new Date(existing.expires_at).getTime() <= now.getTime();
            if (isExpired) {
                // Bump epoch: any zombie process holding the old token is now fenced.
                const newToken = (0, crypto_1.randomUUID)();
                const newEpoch = existing.fencing_epoch + 1;
                const newAcquired = now.toISOString();
                const newExpires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
                this.stmtBumpEpoch.run(newToken, newAcquired, newExpires, holder, runId, tenantId, existing.token);
                const lease = {
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
            const lease = {
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
        const token = (0, crypto_1.randomUUID)();
        const lease = {
            token,
            fencingEpoch: 1,
            acquiredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
            runId,
            holder,
        };
        this.stmtInsert.run(runId, tenantId, token, lease.fencingEpoch, lease.acquiredAt, lease.expiresAt, holder);
        this.inProcess.set(this.cacheKey(runId, tenantId), lease);
        return { acquired: true, lease };
    }
    /**
     * Refresh a lease's expiry. Returns true if the heartbeat succeeded; false
     * if the lease was lost (token mismatch / fenced / evicted).
     */
    heartbeat(runId, token, options) {
        var _a, _b;
        if (!this.db || !this.stmtHeartbeat)
            return false;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const ttlSeconds = (_b = options === null || options === void 0 ? void 0 : options.ttlSeconds) !== null && _b !== void 0 ? _b : this.config.defaultTtlSeconds;
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
    release(runId, token, options) {
        var _a;
        if (!this.db || !this.stmtRelease)
            return false;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const result = this.stmtRelease.run(runId, tenantId, token);
        this.inProcess.delete(this.cacheKey(runId, tenantId));
        return result.changes === 1;
    }
    /**
     * Validate that a (token, epoch) pair is still the current owner of a run.
     * Returns the live lease if valid; null if the caller is fenced (stale epoch)
     * or the lease has been released / evicted.
     */
    validate(runId, token, expectedEpoch, options) {
        var _a;
        if (!this.db || !this.stmtGet)
            return null;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const row = this.stmtGet.get(runId, tenantId);
        if (!row)
            return null;
        if (row.token !== token)
            return null;
        if (row.fencing_epoch !== expectedEpoch) {
            (0, logging_1.getGlobalLogger)().warn('LeaseManager', 'Fenced: stale epoch', {
                runId,
                expected: expectedEpoch,
                actual: row.fencing_epoch,
            });
            return null;
        }
        if (new Date(row.expires_at).getTime() <= Date.now())
            return null;
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
    evict() {
        if (!this.db || !this.stmtEvictExpired)
            return 0;
        return this.stmtEvictExpired.run(new Date().toISOString()).changes;
    }
    /** Look up the current lease for a run (if any). Does not validate. */
    get(runId, options) {
        var _a;
        if (!this.db || !this.stmtGet)
            return null;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const row = this.stmtGet.get(runId, tenantId);
        if (!row)
            return null;
        return {
            token: row.token,
            fencingEpoch: row.fencing_epoch,
            acquiredAt: row.acquired_at,
            expiresAt: row.expires_at,
            runId,
            holder: row.holder,
        };
    }
    close() {
        var _a;
        (_a = this.db) === null || _a === void 0 ? void 0 : _a.close();
        this.db = null;
        this.stmtGet = null;
        this.stmtInsert = null;
        this.stmtHeartbeat = null;
        this.stmtBumpEpoch = null;
        this.stmtRelease = null;
        this.stmtEvictExpired = null;
        this.inProcess.clear();
    }
    cacheKey(runId, tenantId) {
        if (!tenantId)
            return runId;
        return (0, crypto_1.createHash)('sha256').update(`${tenantId}::${runId}`).digest('hex');
    }
}
exports.LeaseManager = LeaseManager;
