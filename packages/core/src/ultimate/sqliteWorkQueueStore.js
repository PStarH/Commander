"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteWorkQueueStore = void 0;
const fs_1 = require("fs");
const path_1 = require("path");
const logging_1 = require("../logging");
let BetterSqlite3 = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BetterSqlite3 = require('better-sqlite3');
}
catch { }
function rowToItem(row) {
    var _a, _b, _c, _d, _e, _f;
    return {
        id: row.id,
        runId: row.run_id,
        parentNodeId: row.parent_node_id,
        goal: row.goal,
        tools: JSON.parse(row.tools_json),
        dependsOn: JSON.parse(row.depends_on_json),
        status: row.status,
        claimedBy: (_a = row.claimed_by) !== null && _a !== void 0 ? _a : undefined,
        claimedAt: (_b = row.claimed_at) !== null && _b !== void 0 ? _b : undefined,
        completedAt: (_c = row.completed_at) !== null && _c !== void 0 ? _c : undefined,
        failedAt: (_d = row.failed_at) !== null && _d !== void 0 ? _d : undefined,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        lastError: (_e = row.last_error) !== null && _e !== void 0 ? _e : undefined,
        tokenBudget: row.token_budget,
        priority: row.priority,
        createdAt: row.created_at,
        leaseToken: (_f = row.lease_token) !== null && _f !== void 0 ? _f : undefined,
        fencingEpoch: row.fencing_epoch,
    };
}
function itemToParams(item, tenantId = null) {
    var _a, _b, _c, _d, _e, _f, _g;
    return [
        item.id,
        item.runId,
        item.parentNodeId,
        item.goal,
        JSON.stringify(item.tools),
        JSON.stringify(item.dependsOn),
        item.status,
        (_a = item.claimedBy) !== null && _a !== void 0 ? _a : null,
        (_b = item.claimedAt) !== null && _b !== void 0 ? _b : null,
        (_c = item.completedAt) !== null && _c !== void 0 ? _c : null,
        (_d = item.failedAt) !== null && _d !== void 0 ? _d : null,
        item.attempts,
        item.maxAttempts,
        (_e = item.lastError) !== null && _e !== void 0 ? _e : null,
        item.tokenBudget,
        item.priority,
        item.createdAt,
        tenantId,
        (_f = item.leaseToken) !== null && _f !== void 0 ? _f : null,
        (_g = item.fencingEpoch) !== null && _g !== void 0 ? _g : 0,
    ];
}
class SqliteWorkQueueStore {
    constructor(config) {
        this.db = null;
        this.stmtLoadAll = null;
        this.stmtEnqueue = null;
        this.stmtUpdate = null;
        this.stmtRemove = null;
        this.stmtTryClaim = null;
        this.stmtReleaseClaim = null;
        this.stmtColumnExists = null;
        this.config = config;
        this.openDb();
        this.prepareStatements();
    }
    openDb() {
        if (!BetterSqlite3) {
            throw new Error('SqliteWorkQueueStore requires better-sqlite3. Install it: pnpm add better-sqlite3');
        }
        if (this.config.filePath !== ':memory:') {
            (0, fs_1.mkdirSync)((0, path_1.dirname)(this.config.filePath), { recursive: true });
        }
        this.db = new BetterSqlite3(this.config.filePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_node_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'REASSIGNED')),
        claimed_by TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        last_error TEXT,
        token_budget INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        tenant_id TEXT,
        lease_token TEXT,
        fencing_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_work_run_status
        ON work_items(run_id, status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_work_claimed_by
        ON work_items(claimed_by) WHERE status IN ('CLAIMED', 'RUNNING');
      CREATE INDEX IF NOT EXISTS idx_work_tenant
        ON work_items(tenant_id) WHERE tenant_id IS NOT NULL;
    `);
        this.migrate();
    }
    migrate() {
        if (!this.db)
            return;
        this.stmtColumnExists = this.db.prepare(`PRAGMA table_info(work_items)`);
        const cols = this.stmtColumnExists.all().map((c) => c.name);
        if (!cols.includes('lease_token')) {
            this.db.exec(`ALTER TABLE work_items ADD COLUMN lease_token TEXT`);
        }
        if (!cols.includes('fencing_epoch')) {
            this.db.exec(`ALTER TABLE work_items ADD COLUMN fencing_epoch INTEGER NOT NULL DEFAULT 0`);
        }
        this.stmtColumnExists = null;
    }
    prepareStatements() {
        if (!this.db)
            return;
        this.stmtLoadAll = this.db.prepare(`
      SELECT id, run_id, parent_node_id, goal, tools_json, depends_on_json,
             status, claimed_by, claimed_at, completed_at, failed_at,
             attempts, max_attempts, last_error, token_budget, priority,
             created_at, tenant_id, lease_token, fencing_epoch
      FROM work_items
    `);
        this.stmtEnqueue = this.db.prepare(`
      INSERT OR REPLACE INTO work_items
        (id, run_id, parent_node_id, goal, tools_json, depends_on_json,
         status, claimed_by, claimed_at, completed_at, failed_at,
         attempts, max_attempts, last_error, token_budget, priority,
         created_at, tenant_id, lease_token, fencing_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        this.stmtUpdate = this.db.prepare(`
      UPDATE work_items SET
        status = ?,
        claimed_by = ?,
        claimed_at = ?,
        completed_at = ?,
        failed_at = ?,
        attempts = ?,
        last_error = ?,
        lease_token = ?,
        fencing_epoch = ?
      WHERE id = ?
    `);
        this.stmtRemove = this.db.prepare(`DELETE FROM work_items WHERE id = ?`);
        this.stmtTryClaim = this.db.prepare(`
      UPDATE work_items
      SET status = 'CLAIMED',
          claimed_by = ?,
          claimed_at = ?,
          lease_token = ?,
          fencing_epoch = fencing_epoch + 1
      WHERE id = ? AND status = 'PENDING'
    `);
        this.stmtReleaseClaim = this.db.prepare(`
      UPDATE work_items SET lease_token = NULL WHERE lease_token = ?
    `);
    }
    loadAll() {
        if (!this.db || !this.stmtLoadAll) {
            throw new Error('SqliteWorkQueueStore not initialized');
        }
        const rows = this.stmtLoadAll.all();
        return rows.map(rowToItem);
    }
    enqueue(item) {
        if (!this.db || !this.stmtEnqueue) {
            throw new Error('SqliteWorkQueueStore not initialized');
        }
        this.stmtEnqueue.run(...itemToParams(item));
    }
    update(item) {
        var _a, _b, _c, _d, _e, _f, _g;
        if (!this.db || !this.stmtUpdate) {
            throw new Error('SqliteWorkQueueStore not initialized');
        }
        this.stmtUpdate.run(item.status, (_a = item.claimedBy) !== null && _a !== void 0 ? _a : null, (_b = item.claimedAt) !== null && _b !== void 0 ? _b : null, (_c = item.completedAt) !== null && _c !== void 0 ? _c : null, (_d = item.failedAt) !== null && _d !== void 0 ? _d : null, item.attempts, (_e = item.lastError) !== null && _e !== void 0 ? _e : null, (_f = item.leaseToken) !== null && _f !== void 0 ? _f : null, (_g = item.fencingEpoch) !== null && _g !== void 0 ? _g : 0, item.id);
    }
    updateMany(items) {
        if (!this.db || !this.stmtUpdate) {
            throw new Error('SqliteWorkQueueStore not initialized');
        }
        if (!this.db.transaction) {
            for (const item of items)
                this.update(item);
            return;
        }
        // Use db.transaction directly (not extracted) to preserve `this` binding.
        // The transaction callback receives unknown[] args from better-sqlite3's wrapper;
        // we cast at the call site since we know we pass WorkItem[] as the only argument.
        const tx = this.db.transaction((...args) => {
            const batch = args[0];
            for (const item of batch)
                this.update(item);
        });
        tx(items);
    }
    remove(predicate) {
        if (!this.db || !this.stmtLoadAll || !this.stmtRemove) {
            throw new Error('SqliteWorkQueueStore not initialized');
        }
        const all = this.loadAll();
        let removed = 0;
        for (const item of all) {
            if (predicate(item)) {
                this.stmtRemove.run(item.id);
                removed++;
            }
        }
        return removed;
    }
    tryClaim(agentId, workId, leaseToken, nowIso) {
        if (!this.db || !this.stmtTryClaim) {
            throw new Error('SqliteWorkQueueStore not initialized');
        }
        const result = this.stmtTryClaim.run(agentId, nowIso, leaseToken, workId);
        return result.changes === 1;
    }
    releaseClaim(leaseToken) {
        if (!this.db || !this.stmtReleaseClaim) {
            throw new Error('SqliteWorkQueueStore not initialized');
        }
        this.stmtReleaseClaim.run(leaseToken);
    }
    close() {
        var _a;
        (_a = this.db) === null || _a === void 0 ? void 0 : _a.close();
        this.db = null;
        this.stmtLoadAll = null;
        this.stmtEnqueue = null;
        this.stmtUpdate = null;
        this.stmtRemove = null;
        this.stmtTryClaim = null;
        this.stmtReleaseClaim = null;
        this.stmtColumnExists = null;
        (0, logging_1.getGlobalLogger)().debug('SqliteWorkQueueStore', 'closed', { filePath: this.config.filePath });
    }
}
exports.SqliteWorkQueueStore = SqliteWorkQueueStore;
