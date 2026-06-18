"use strict";
/**
 * CompensationQueue — durable, cross-process compensation retry queue.
 *
 * Closes the "in-memory compensation lost on crash" gap from the
 * reversibility audit. The legacy CompensationRegistry retries failed
 * compensations in-process only; if the process crashes mid-retry, the
 * compensation is lost. The ledger-based saga compensator (see RunLedger)
 * is crash-safe but requires the run to reach the ABORTED state via the
 * scheduler. This queue handles the edge case where:
 *   1. A mutation tool completed (side effect applied)
 *   2. A subsequent tool failed and the registry's in-memory retry
 *      exhausted
 *   3. The process crashed BEFORE the saga abort path ran
 *   4. A new process starts and needs to compensate the orphan mutation
 *
 * Behavior:
 *   - enqueue(): persist a new pending compensation
 *   - markInProgress(): atomically claim it (prevents double-compensation
 *     across processes)
 *   - markCompleted(): success — delete row
 *   - markFailed(): schedule next attempt with backoff
 *   - markEscalated(): after maxAttempts, move to escalated state for
 *     manual review via commander compensation list/retry <id>
 *   - retry(): force re-attempt of an escalated item
 *
 * Persistence: SQLite-backed (better-sqlite3). Per-tenant isolation via
 * tenant_id column. WAL mode for crash safety.
 *
 * Tier 2.4 of reversibility-rfc-v2 (M1 + M11).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompensationQueue = void 0;
exports.defaultCompensationQueuePath = defaultCompensationQueuePath;
exports.getCompensationQueue = getCompensationQueue;
exports.resetCompensationQueueForTesting = resetCompensationQueueForTesting;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
let BetterSqlite3 = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BetterSqlite3 = require('better-sqlite3');
}
catch { }
const DEFAULT_DB_PATH = (0, node_path_1.join)(process.cwd(), '.commander', 'compensation_queue.db');
function defaultCompensationQueuePath() {
    return DEFAULT_DB_PATH;
}
class CompensationQueue {
    constructor(config = {}) {
        var _a, _b, _c, _d;
        this.db = null;
        this.stmtEnqueue = null;
        this.stmtGet = null;
        this.stmtList = null;
        this.stmtListPending = null;
        this.stmtClaim = null;
        this.stmtComplete = null;
        this.stmtFail = null;
        this.stmtEscalate = null;
        this.stmtRetry = null;
        this.stmtCount = null;
        this.stmtDelete = null;
        this.config = {
            filePath: (_a = config.filePath) !== null && _a !== void 0 ? _a : DEFAULT_DB_PATH,
            defaultMaxAttempts: (_b = config.defaultMaxAttempts) !== null && _b !== void 0 ? _b : 10,
            backoffBaseMs: (_c = config.backoffBaseMs) !== null && _c !== void 0 ? _c : 1000,
            backoffMaxMs: (_d = config.backoffMaxMs) !== null && _d !== void 0 ? _d : 5 * 60 * 1000,
        };
        this.openDb();
        this.prepareStatements();
    }
    openDb() {
        if (!BetterSqlite3) {
            throw new Error('CompensationQueue requires better-sqlite3. Install it: pnpm add better-sqlite3');
        }
        if (this.config.filePath !== ':memory:') {
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(this.config.filePath), { recursive: true });
        }
        this.db = new BetterSqlite3(this.config.filePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS compensation_queue (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT,
        tenant_id TEXT,
        tool_name TEXT NOT NULL,
        args TEXT NOT NULL,
        compensation_handler_key TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        enqueued_at TEXT NOT NULL,
        last_attempt_at TEXT,
        next_attempt_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compensation_status
        ON compensation_queue(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_compensation_run
        ON compensation_queue(run_id);
    `);
    }
    prepareStatements() {
        if (!this.db)
            return;
        this.stmtEnqueue = this.db.prepare(`
      INSERT INTO compensation_queue (
        id, run_id, agent_id, tenant_id, tool_name, args, compensation_handler_key,
        attempt_count, max_attempts, status, enqueued_at, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?)
    `);
        this.stmtGet = this.db.prepare(`SELECT * FROM compensation_queue WHERE id = ?`);
        this.stmtList = this.db.prepare(`SELECT * FROM compensation_queue ORDER BY enqueued_at DESC LIMIT ?`);
        this.stmtListPending = this.db.prepare(`
      SELECT * FROM compensation_queue
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC LIMIT ?
    `);
        this.stmtClaim = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'in_progress', last_attempt_at = ?, attempt_count = attempt_count + 1
      WHERE id = ? AND status = 'pending'
    `);
        this.stmtComplete = this.db.prepare(`DELETE FROM compensation_queue WHERE id = ?`);
        this.stmtFail = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'pending', last_error = ?, next_attempt_at = ?, last_attempt_at = ?
      WHERE id = ?
    `);
        this.stmtEscalate = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'escalated', last_error = ?, last_attempt_at = ?
      WHERE id = ?
    `);
        this.stmtRetry = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'pending', last_error = NULL, next_attempt_at = ?, attempt_count = 0
      WHERE id = ? AND status = 'escalated'
    `);
        this.stmtCount = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM compensation_queue GROUP BY status
    `);
        this.stmtDelete = this.db.prepare(`DELETE FROM compensation_queue WHERE id = ?`);
    }
    enqueue(input) {
        var _a, _b, _c;
        if (!this.stmtEnqueue)
            throw new Error('CompensationQueue not initialized');
        const now = new Date().toISOString();
        this.stmtEnqueue.run(input.id, input.runId, (_a = input.agentId) !== null && _a !== void 0 ? _a : null, (_b = input.tenantId) !== null && _b !== void 0 ? _b : null, input.toolName, JSON.stringify(input.args), input.compensationHandlerKey, (_c = input.maxAttempts) !== null && _c !== void 0 ? _c : this.config.defaultMaxAttempts, now, now);
    }
    /**
     * Atomically claim the next due item for processing. Returns null if
     * no item is due. The atomic UPDATE prevents two processes from
     * compensating the same action.
     */
    claimNext() {
        if (!this.stmtListPending || !this.stmtClaim)
            return null;
        const now = new Date().toISOString();
        const candidates = this.stmtListPending.all(now, 1);
        if (candidates.length === 0)
            return null;
        const id = candidates[0].id;
        const result = this.stmtClaim.run(now, id);
        if (result.changes === 0) {
            // Lost the race; another process claimed it.
            return null;
        }
        return this.get(id);
    }
    markCompleted(id) {
        if (!this.stmtComplete)
            return;
        this.stmtComplete.run(id);
    }
    markFailed(id, error, currentAttempt) {
        if (!this.stmtFail || !this.stmtEscalate)
            throw new Error('not initialized');
        const item = this.get(id);
        if (!item)
            return 'escalated';
        if (currentAttempt >= item.maxAttempts) {
            this.stmtEscalate.run(error, new Date().toISOString(), id);
            return 'escalated';
        }
        // Backoff: base * 2^(attempt-1), capped.
        const delay = Math.min(this.config.backoffBaseMs * Math.pow(2, currentAttempt - 1), this.config.backoffMaxMs);
        const next = new Date(Date.now() + delay).toISOString();
        this.stmtFail.run(error, next, new Date().toISOString(), id);
        return 'pending';
    }
    markEscalated(id, error) {
        if (!this.stmtEscalate)
            return;
        this.stmtEscalate.run(error, new Date().toISOString(), id);
    }
    /**
     * Force-retry an escalated item. Resets attempt_count to 0 and
     * schedules immediate next attempt.
     */
    retry(id) {
        if (!this.stmtRetry)
            return false;
        const result = this.stmtRetry.run(new Date().toISOString(), id);
        return result.changes > 0;
    }
    get(id) {
        if (!this.stmtGet)
            return null;
        const row = this.stmtGet.get(id);
        if (!row)
            return null;
        return rowToItem(row);
    }
    list(opts = {}) {
        var _a;
        if (!this.stmtList)
            return [];
        const limit = (_a = opts.limit) !== null && _a !== void 0 ? _a : 100;
        if (opts.status) {
            // Ad-hoc filtered query
            const rows = this.db.prepare(`SELECT * FROM compensation_queue WHERE status = ? ORDER BY enqueued_at DESC LIMIT ?`).all(opts.status, limit);
            return rows.map(rowToItem);
        }
        const rows = this.stmtList.all(limit);
        return rows.map(rowToItem);
    }
    countByStatus() {
        if (!this.stmtCount)
            return { pending: 0, in_progress: 0, escalated: 0 };
        const rows = this.stmtCount.all();
        const result = { pending: 0, in_progress: 0, escalated: 0 };
        for (const r of rows) {
            if (r.status in result)
                result[r.status] = r.count;
        }
        return result;
    }
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
exports.CompensationQueue = CompensationQueue;
function rowToItem(row) {
    return {
        id: row.id,
        runId: row.run_id,
        agentId: row.agent_id,
        tenantId: row.tenant_id,
        toolName: row.tool_name,
        args: row.args,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        status: row.status,
        lastError: row.last_error,
        enqueuedAt: row.enqueued_at,
        lastAttemptAt: row.last_attempt_at,
        nextAttemptAt: row.next_attempt_at,
        compensationHandlerKey: row.compensation_handler_key,
    };
}
let _instance = null;
function getCompensationQueue() {
    if (!_instance)
        _instance = new CompensationQueue();
    return _instance;
}
function resetCompensationQueueForTesting() {
    if (_instance) {
        _instance.close();
        _instance = null;
    }
}
