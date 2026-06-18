"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdempotencyStore = void 0;
exports.getIdempotencyStore = getIdempotencyStore;
exports.resetIdempotencyStore = resetIdempotencyStore;
exports.newLeaseToken = newLeaseToken;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const logging_1 = require("../logging");
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const DEFAULT_CONFIG = {
    maxRecords: 100000,
    defaultTtlSeconds: 24 * 60 * 60,
    evictEveryOps: 1000,
};
function defaultFilePath() {
    var _a;
    return (_a = process.env.COMMANDER_ATR_IDEMPOTENCY_PATH) !== null && _a !== void 0 ? _a : '.commander/atr_idempotency.db';
}
let BetterSqlite3 = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BetterSqlite3 = require('better-sqlite3');
}
catch { }
class IdempotencyStore {
    constructor(config) {
        this.db = null;
        this.opCount = 0;
        this.stmtGet = null;
        this.stmtGetRaw = null;
        this.stmtInsertIgnore = null;
        this.stmtReclaim = null;
        this.stmtComplete = null;
        this.stmtFail = null;
        this.stmtEvictExpired = null;
        this.stmtCount = null;
        this.stmtTrimOldest = null;
        this.config = { ...DEFAULT_CONFIG, filePath: defaultFilePath(), ...config };
        this.openDb();
        this.prepareStatements();
    }
    openDb() {
        if (!BetterSqlite3) {
            throw new Error('IdempotencyStore requires better-sqlite3. Install it: pnpm add better-sqlite3');
        }
        if (this.config.filePath !== ':memory:') {
            (0, fs_1.mkdirSync)((0, path_1.dirname)(this.config.filePath), { recursive: true });
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
    prepareStatements() {
        if (!this.db)
            return;
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
    begin(key, options) {
        var _a, _b, _c, _d;
        if (!this.db || !this.stmtGetRaw || !this.stmtInsertIgnore || !this.stmtReclaim) {
            throw new Error('IdempotencyStore not initialized');
        }
        this.maybeEvict();
        const opts = {
            ttlSeconds: (_a = options === null || options === void 0 ? void 0 : options.ttlSeconds) !== null && _a !== void 0 ? _a : this.config.defaultTtlSeconds,
            tenantId: options === null || options === void 0 ? void 0 : options.tenantId,
            runId: options === null || options === void 0 ? void 0 : options.runId,
            toolName: options === null || options === void 0 ? void 0 : options.toolName,
        };
        const now = new Date();
        const nowIso = now.toISOString();
        const expiresIso = new Date(now.getTime() + opts.ttlSeconds * 1000).toISOString();
        const namespacedKey = this.namespaceKey(key, opts.tenantId);
        const insertResult = this.stmtInsertIgnore.run(namespacedKey, nowIso, expiresIso, (_b = opts.tenantId) !== null && _b !== void 0 ? _b : null, (_c = opts.runId) !== null && _c !== void 0 ? _c : null, (_d = opts.toolName) !== null && _d !== void 0 ? _d : null);
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
        const isExpired = new Date(existing.expires_at).getTime() <= now.getTime();
        const existingState = existing.state;
        if (isExpired && existingState !== 'in_progress') {
            const reclaimResult = this.stmtReclaim.run(nowIso, expiresIso, namespacedKey, nowIso);
            if (reclaimResult.changes === 1) {
                const reclaimed = this.stmtGetRaw.get(namespacedKey);
                if (reclaimed)
                    return { acquired: true, record: this.rowToRecord(reclaimed) };
            }
            const afterRace = this.stmtGetRaw.get(namespacedKey);
            if (!afterRace) {
                throw new Error('IdempotencyStore.begin: row vanished after reclaim (eviction race)');
            }
            return { acquired: false, record: this.rowToRecord(afterRace) };
        }
        return { acquired: false, record: this.rowToRecord(existing) };
    }
    complete(key, result, opts) {
        var _a;
        if (!this.db || !this.stmtComplete)
            return;
        const ttl = (_a = opts === null || opts === void 0 ? void 0 : opts.ttlSeconds) !== null && _a !== void 0 ? _a : this.config.defaultTtlSeconds;
        const now = new Date();
        this.stmtComplete.run(result, now.toISOString(), new Date(now.getTime() + ttl * 1000).toISOString(), this.namespaceKey(key, opts === null || opts === void 0 ? void 0 : opts.tenantId));
    }
    fail(key, error, opts) {
        var _a;
        if (!this.db || !this.stmtFail)
            return;
        const ttl = (_a = opts === null || opts === void 0 ? void 0 : opts.ttlSeconds) !== null && _a !== void 0 ? _a : this.config.defaultTtlSeconds;
        const now = new Date();
        this.stmtFail.run(error, now.toISOString(), new Date(now.getTime() + ttl * 1000).toISOString(), this.namespaceKey(key, opts === null || opts === void 0 ? void 0 : opts.tenantId));
    }
    get(key, opts) {
        if (!this.db || !this.stmtGet)
            return null;
        const row = this.stmtGet.get(this.namespaceKey(key, opts === null || opts === void 0 ? void 0 : opts.tenantId), new Date().toISOString());
        return row ? this.rowToRecord(row) : null;
    }
    evict() {
        if (!this.db || !this.stmtEvictExpired)
            return 0;
        return this.stmtEvictExpired.run(new Date().toISOString()).changes;
    }
    size() {
        var _a;
        if (!this.db || !this.stmtCount)
            return 0;
        const row = this.stmtCount.get();
        return (_a = row === null || row === void 0 ? void 0 : row.c) !== null && _a !== void 0 ? _a : 0;
    }
    close() {
        var _a;
        (_a = this.db) === null || _a === void 0 ? void 0 : _a.close();
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
    namespaceKey(key, tenantId) {
        if (!tenantId)
            return key;
        return (0, crypto_1.createHash)('sha256').update(`${tenantId}::${key}`).digest('hex');
    }
    enforceSizeCap() {
        if (!this.stmtTrimOldest)
            return;
        try {
            const overage = this.size() - this.config.maxRecords;
            if (overage > 0)
                this.stmtTrimOldest.run(overage);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('IdempotencyStore', 'Trim failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    maybeEvict() {
        this.opCount++;
        if (this.opCount < this.config.evictEveryOps)
            return;
        this.opCount = 0;
        try {
            this.evict();
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('IdempotencyStore', 'Evict failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    rowToRecord(row) {
        var _a, _b, _c, _d, _e, _f;
        return {
            key: row.key,
            state: row.state,
            result: (_a = row.result) !== null && _a !== void 0 ? _a : undefined,
            error: (_b = row.error) !== null && _b !== void 0 ? _b : undefined,
            attemptCount: row.attempt_count,
            startedAt: row.started_at,
            completedAt: (_c = row.completed_at) !== null && _c !== void 0 ? _c : undefined,
            expiresAt: row.expires_at,
            tenantId: (_d = row.tenant_id) !== null && _d !== void 0 ? _d : undefined,
            runId: (_e = row.run_id) !== null && _e !== void 0 ? _e : undefined,
            toolName: (_f = row.tool_name) !== null && _f !== void 0 ? _f : undefined,
        };
    }
}
exports.IdempotencyStore = IdempotencyStore;
const idempotencyStoreSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new IdempotencyStore(process.env.COMMANDER_ATR_MEMORY === '1'
    ? { filePath: ':memory:' }
    : process.env.COMMANDER_ATR_IDEMPOTENCY_PATH
        ? { filePath: process.env.COMMANDER_ATR_IDEMPOTENCY_PATH }
        : undefined), { dispose: (store) => store.close() });
function getIdempotencyStore() {
    return idempotencyStoreSingleton.get();
}
function resetIdempotencyStore() {
    idempotencyStoreSingleton.reset();
}
function newLeaseToken() {
    return (0, crypto_1.randomUUID)();
}
