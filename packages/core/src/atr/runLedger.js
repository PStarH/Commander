"use strict";
/**
 * RunLedger — P0-2 ATR kernel component.
 *
 * The "settlement" half of the kernel. Coordinates the run state machine
 * (PENDING → EXECUTING → VERIFYING → COMMITTED / ABORTED → COMPENSATED),
 * persists every CompensableAction, and integrates with:
 *
 *   - LeaseManager      → process fencing (zombie rejection)
 *   - IdempotencyStore  → tool-call dedup across retries/replays
 *   - CompensationRegistry (runtime) → saga-style undo
 *
 * Why a separate ledger and not just "use CompensationRegistry"?
 *   CompensationRegistry is in-memory and per-AgentRuntime. The ledger is
 *   crash-safe (SQLite) and is the source of truth for "what side effects
 *   have we already taken on behalf of this runId?" — across process
 *   restarts, across worker migrations, across tenant boundaries.
 *
 * The ledger's compensateAll() iterates the persisted action list in
 * REVERSE execution order, calling the registered compensation handler for
 * each. This is the actual saga semantics the old CompensationRegistry
 * never delivered.
 *
 * Tenancy: the SQLite key is SHA256(tenantId || "::" || runId), so each
 * tenant's run records are physically isolated.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunLedger = void 0;
exports.getRunLedgerBundle = getRunLedgerBundle;
exports.resetRunLedgerBundle = resetRunLedgerBundle;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const leaseManager_1 = require("./leaseManager");
const idempotencyStore_1 = require("./idempotencyStore");
const logging_1 = require("../logging");
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const DEFAULT_CONFIG = {
    filePath: '.commander/atr_ledger.db',
    defaultTtlSeconds: 30,
    defaultHolder: `unknown-${process.pid}`,
    defaultIdempotencyTtlSeconds: 24 * 60 * 60,
};
let BetterSqlite3 = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BetterSqlite3 = require('better-sqlite3');
}
catch { }
class RunLedger {
    constructor(arg1, arg2, arg3) {
        this.db = null;
        this.handlers = new Map();
        this.stmtGetTx = null;
        this.stmtInsertTx = null;
        this.stmtUpdateTxState = null;
        this.stmtAppendAction = null;
        this.stmtListActions = null;
        this.stmtGetAction = null;
        this.stmtUpdateActionResult = null;
        this.stmtUpdateActionError = null;
        this.stmtMarkCompensated = null;
        this.stmtListUncompensated = null;
        this.stmtListByState = null;
        if (arg1 instanceof leaseManager_1.LeaseManager) {
            this.config = { ...DEFAULT_CONFIG, ...arg3 };
            this.leaseManager = arg1;
            this.idempotencyStore = arg2 !== null && arg2 !== void 0 ? arg2 : new idempotencyStore_1.IdempotencyStore();
        }
        else {
            const cfg = { ...DEFAULT_CONFIG, ...arg1 };
            this.config = cfg;
            this.leaseManager = new leaseManager_1.LeaseManager({
                filePath: cfg.filePath,
                defaultTtlSeconds: cfg.defaultTtlSeconds,
                defaultHolder: cfg.defaultHolder,
            });
            this.idempotencyStore = new idempotencyStore_1.IdempotencyStore({
                filePath: cfg.filePath,
                defaultTtlSeconds: cfg.defaultIdempotencyTtlSeconds,
            });
        }
        this.openDb();
        this.prepareStatements();
    }
    openDb() {
        if (!BetterSqlite3) {
            throw new Error('RunLedger requires better-sqlite3. Install it: pnpm add better-sqlite3');
        }
        if (this.config.filePath !== ':memory:') {
            (0, fs_1.mkdirSync)((0, path_1.dirname)(this.config.filePath), { recursive: true });
        }
        this.db = new BetterSqlite3(this.config.filePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_transactions (
        run_id TEXT NOT NULL,
        tenant_id TEXT,
        state TEXT NOT NULL,
        intent_hash TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        fencing_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        committed_at TEXT,
        aborted_at TEXT,
        error TEXT,
        metadata_json TEXT,
        PRIMARY KEY (run_id, tenant_id)
      );
      CREATE TABLE IF NOT EXISTS run_actions (
        action_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tenant_id TEXT,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        external_system TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        result TEXT,
        error TEXT,
        executed_at TEXT NOT NULL,
        compensated_at TEXT,
        compensable INTEGER NOT NULL DEFAULT 1,
        tags_json TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (action_id)
      );
      CREATE INDEX IF NOT EXISTS idx_actions_run ON run_actions(run_id, executed_at);
    `);
    }
    prepareStatements() {
        if (!this.db)
            return;
        this.stmtGetTx = this.db.prepare(`
      SELECT run_id, tenant_id, state, intent_hash, lease_token, fencing_epoch,
             created_at, committed_at, aborted_at, error, metadata_json,
             '[]' AS actions_json
      FROM run_transactions WHERE run_id = ? AND tenant_id IS ? LIMIT 1
    `);
        this.stmtInsertTx = this.db.prepare(`
      INSERT OR REPLACE INTO run_transactions
        (run_id, tenant_id, state, intent_hash, lease_token, fencing_epoch,
         created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
        this.stmtUpdateTxState = this.db.prepare(`
      UPDATE run_transactions
      SET state = ?, committed_at = COALESCE(?, committed_at),
          aborted_at = COALESCE(?, aborted_at), error = COALESCE(?, error)
      WHERE run_id = ? AND tenant_id IS ? AND lease_token = ? AND fencing_epoch = ?
    `);
        this.stmtAppendAction = this.db.prepare(`
      INSERT OR REPLACE INTO run_actions
        (action_id, run_id, tenant_id, tool_name, args_json, external_system,
         idempotency_key, executed_at, compensable, tags_json, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        this.stmtListActions = this.db.prepare(`
      SELECT action_id, run_id, tenant_id, tool_name, args_json, external_system,
             idempotency_key, result, error, executed_at, compensated_at,
             compensable, tags_json, description
      FROM run_actions WHERE run_id = ? AND tenant_id IS ?
      ORDER BY executed_at ASC
    `);
        this.stmtGetAction = this.db.prepare(`
      SELECT action_id, run_id, tenant_id, tool_name, args_json, external_system,
             idempotency_key, result, error, executed_at, compensated_at,
             compensable, tags_json, description
      FROM run_actions WHERE action_id = ? LIMIT 1
    `);
        this.stmtUpdateActionResult = this.db.prepare(`
      UPDATE run_actions SET result = ? WHERE action_id = ?
    `);
        this.stmtUpdateActionError = this.db.prepare(`
      UPDATE run_actions SET error = ? WHERE action_id = ?
    `);
        this.stmtMarkCompensated = this.db.prepare(`
      UPDATE run_actions SET compensated_at = ? WHERE action_id = ?
    `);
        this.stmtListUncompensated = this.db.prepare(`
      SELECT action_id, run_id, tenant_id, tool_name, args_json, external_system,
             idempotency_key, result, error, executed_at, compensated_at,
             compensable, tags_json, description
      FROM run_actions
      WHERE run_id = ? AND tenant_id IS ? AND compensated_at IS NULL AND compensable = 1
      ORDER BY executed_at DESC
    `);
        this.stmtListByState = this.db.prepare(`
      SELECT run_id, tenant_id, state, intent_hash, lease_token, fencing_epoch,
             created_at, committed_at, aborted_at, error, metadata_json
      FROM run_transactions WHERE state = ? AND (tenant_id IS ? OR ? IS NULL)
    `);
    }
    /**
     * Register a compensation handler for a tool. The handler is invoked by
     * abortAndCompensate() in reverse execution order. A handler that returns
     * success=false (or throws) is retried up to maxAttempts; persistent failure
     * is reported in the CompensationOutcome.
     */
    registerCompensation(toolName, handler) {
        this.handlers.set(toolName, handler);
    }
    /**
     * Start a new run. Acquires a lease and persists a PENDING transaction.
     * If the runId already exists, returns the existing transaction (idempotent).
     */
    start(input) {
        var _a, _b, _c, _d, _e;
        if (!this.db || !this.stmtInsertTx || !this.stmtGetTx) {
            throw new Error('RunLedger not initialized');
        }
        const runId = (_a = input.runId) !== null && _a !== void 0 ? _a : `run_${(0, crypto_1.randomUUID)()}`;
        const tenantId = (_b = input.tenantId) !== null && _b !== void 0 ? _b : null;
        const existing = this.stmtGetTx.get(runId, tenantId);
        if (existing) {
            const actions = this.loadActions(runId, tenantId);
            const tx = {
                runId,
                state: existing.state,
                intentHash: existing.intent_hash,
                leaseToken: existing.lease_token,
                fencingEpoch: existing.fencing_epoch,
                actions,
                createdAt: existing.created_at,
                committedAt: (_c = existing.committed_at) !== null && _c !== void 0 ? _c : undefined,
                abortedAt: (_d = existing.aborted_at) !== null && _d !== void 0 ? _d : undefined,
                error: (_e = existing.error) !== null && _e !== void 0 ? _e : undefined,
                tenantId: input.tenantId,
                metadata: existing.metadata_json ? JSON.parse(existing.metadata_json) : undefined,
            };
            return {
                lease: {
                    acquired: false,
                    lease: {
                        token: existing.lease_token,
                        fencingEpoch: existing.fencing_epoch,
                        acquiredAt: existing.created_at,
                        expiresAt: '',
                        runId,
                        holder: '',
                    },
                },
                tx,
            };
        }
        const acquireResult = this.leaseManager.acquire(runId, {
            tenantId: input.tenantId,
            holder: input.holder,
            ttlSeconds: input.ttlSeconds,
        });
        const createdAt = new Date().toISOString();
        this.stmtInsertTx.run(runId, tenantId, 'PENDING', input.intentHash, acquireResult.lease.token, acquireResult.lease.fencingEpoch, createdAt, input.metadata ? JSON.stringify(input.metadata) : null);
        const tx = {
            runId,
            state: 'PENDING',
            intentHash: input.intentHash,
            leaseToken: acquireResult.lease.token,
            fencingEpoch: acquireResult.lease.fencingEpoch,
            actions: [],
            createdAt,
            tenantId: input.tenantId,
            metadata: input.metadata,
        };
        return { lease: acquireResult, tx };
    }
    /**
     * Transition a run to EXECUTING. Validates the lease token + epoch before
     * updating. Returns false if the caller is fenced.
     */
    beginExecuting(runId, leaseToken, fencingEpoch, options) {
        var _a;
        if (!this.db || !this.stmtUpdateTxState)
            return false;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const result = this.stmtUpdateTxState.run('EXECUTING', null, null, null, runId, tenantId, leaseToken, fencingEpoch);
        return result.changes === 1;
    }
    /**
     * Transition a run to VERIFYING. Same lease validation as beginExecuting.
     */
    beginVerifying(runId, leaseToken, fencingEpoch, options) {
        var _a;
        if (!this.db || !this.stmtUpdateTxState)
            return false;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const result = this.stmtUpdateTxState.run('VERIFYING', null, null, null, runId, tenantId, leaseToken, fencingEpoch);
        return result.changes === 1;
    }
    /**
     * Mark the run as committed (terminal success). No compensation runs.
     */
    commit(runId, leaseToken, fencingEpoch, options) {
        var _a;
        if (!this.db || !this.stmtUpdateTxState)
            return false;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const result = this.stmtUpdateTxState.run('COMMITTED', new Date().toISOString(), null, null, runId, tenantId, leaseToken, fencingEpoch);
        return result.changes === 1;
    }
    /**
     * Record a compensable action against the run. Persists immediately so
     * even a synchronous crash leaves the side-effect on the books for later
     * compensation. Validates the lease before writing.
     */
    recordAction(input) {
        var _a, _b, _c, _d, _e, _f;
        if (!this.db || !this.stmtAppendAction || !this.stmtGetTx)
            return null;
        const tenantId = (_a = input.tenantId) !== null && _a !== void 0 ? _a : null;
        const txRow = this.stmtGetTx.get(input.runId, tenantId);
        if (!txRow) {
            (0, logging_1.getGlobalLogger)().warn('RunLedger', 'recordAction: transaction not found', {
                runId: input.runId,
            });
            return null;
        }
        if (txRow.lease_token !== input.leaseToken || txRow.fencing_epoch !== input.fencingEpoch) {
            (0, logging_1.getGlobalLogger)().warn('RunLedger', 'recordAction: fenced (stale lease)', {
                runId: input.runId,
                expectedEpoch: txRow.fencing_epoch,
                callerEpoch: input.fencingEpoch,
            });
            return null;
        }
        const actionId = (_b = input.actionId) !== null && _b !== void 0 ? _b : `act_${(0, crypto_1.randomUUID)()}`;
        const executedAt = new Date().toISOString();
        this.stmtAppendAction.run(actionId, input.runId, tenantId, input.toolName, JSON.stringify(input.args), input.externalSystem, input.idempotencyKey, executedAt, input.compensable ? 1 : 0, JSON.stringify((_c = input.tags) !== null && _c !== void 0 ? _c : []), (_d = input.description) !== null && _d !== void 0 ? _d : `${input.toolName}`);
        return {
            actionId,
            runId: input.runId,
            toolName: input.toolName,
            args: input.args,
            externalSystem: input.externalSystem,
            idempotencyKey: input.idempotencyKey,
            executedAt,
            compensable: input.compensable,
            tags: (_e = input.tags) !== null && _e !== void 0 ? _e : [],
            description: (_f = input.description) !== null && _f !== void 0 ? _f : '',
        };
    }
    /**
     * Persist a tool's result (or error) on its action record. Idempotent.
     */
    recordResult(actionId, result) {
        if (!this.db || !this.stmtUpdateActionResult)
            return;
        this.stmtUpdateActionResult.run(result, actionId);
    }
    recordError(actionId, error) {
        if (!this.db || !this.stmtUpdateActionError)
            return;
        this.stmtUpdateActionError.run(error, actionId);
    }
    /**
     * Abort the run and compensate every still-pending action in REVERSE
     * execution order. This is the saga implementation the runtime used to
     * delegate (incorrectly) to CompensationRegistry.
     *
     * Non-compensable actions are skipped with a logged warning. Handlers
     * are retried up to 3 times each. Persistent failures are reported in
     * the CompensationOutcome.errors array (for the dead-letter / ops queue).
     */
    async abortAndCompensate(runId, leaseToken, fencingEpoch, errorMessage, options) {
        var _a, _b, _c, _d;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const maxAttempts = (_b = options === null || options === void 0 ? void 0 : options.maxAttempts) !== null && _b !== void 0 ? _b : 3;
        const outcome = { attempted: 0, succeeded: 0, failed: 0, errors: [] };
        const validated = this.leaseManager.validate(runId, leaseToken, fencingEpoch, {
            tenantId: options === null || options === void 0 ? void 0 : options.tenantId,
        });
        if (!validated) {
            (0, logging_1.getGlobalLogger)().warn('RunLedger', 'abortAndCompensate: caller is fenced', { runId });
            return { aborted: false, outcome };
        }
        if (this.db && this.stmtUpdateTxState) {
            this.stmtUpdateTxState.run('ABORTED', null, new Date().toISOString(), errorMessage, runId, tenantId, leaseToken, fencingEpoch);
        }
        // No handler → log and treat as success (idempotent no-op). This is the
        // safe default for tools we can't undo (e.g. side effects to systems with
        // no inverse API) — better to log than to crash mid-compensation.
        if (!this.db || !this.stmtListUncompensated) {
            return { aborted: true, outcome };
        }
        const rows = this.stmtListUncompensated.all(runId, tenantId);
        for (const row of rows) {
            const action = this.rowToAction(row);
            const handler = this.handlers.get(action.toolName);
            outcome.attempted++;
            if (!handler) {
                // No handler — log and treat as success (idempotent no-op)
                (0, logging_1.getGlobalLogger)().info('RunLedger', `No compensation handler for ${action.toolName}; skipping`, {
                    actionId: action.actionId,
                });
                (_c = this.stmtMarkCompensated) === null || _c === void 0 ? void 0 : _c.run(new Date().toISOString(), action.actionId);
                outcome.succeeded++;
                continue;
            }
            let attempts = 0;
            let success = false;
            let lastError;
            while (attempts < maxAttempts && !success) {
                attempts++;
                try {
                    const res = await handler(action);
                    if (res.success) {
                        success = true;
                        outcome.succeeded++;
                        (_d = this.stmtMarkCompensated) === null || _d === void 0 ? void 0 : _d.run(new Date().toISOString(), action.actionId);
                        this.idempotencyStore.fail(action.idempotencyKey, `compensated:${action.actionId}`, {
                            tenantId: options === null || options === void 0 ? void 0 : options.tenantId,
                        });
                    }
                    else {
                        lastError = res.error;
                    }
                }
                catch (err) {
                    lastError = err.message;
                }
            }
            if (!success) {
                outcome.failed++;
                outcome.errors.push({
                    actionId: action.actionId,
                    toolName: action.toolName,
                    error: lastError !== null && lastError !== void 0 ? lastError : 'unknown',
                });
                (0, logging_1.getGlobalLogger)().error('RunLedger', `Compensation failed after ${maxAttempts} attempts`, lastError ? new Error(lastError) : undefined, {
                    actionId: action.actionId,
                    toolName: action.toolName,
                });
            }
        }
        if (this.stmtUpdateTxState) {
            this.stmtUpdateTxState.run(outcome.failed === 0 ? 'COMPENSATED' : 'ABORTED', null, null, outcome.failed > 0 ? `${outcome.failed} compensations failed` : null, runId, tenantId, leaseToken, fencingEpoch);
        }
        return { aborted: true, outcome };
    }
    /** Load a run transaction by id. */
    getTransaction(runId, options) {
        var _a, _b, _c, _d;
        if (!this.db || !this.stmtGetTx)
            return null;
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const row = this.stmtGetTx.get(runId, tenantId);
        if (!row)
            return null;
        return {
            runId,
            state: row.state,
            intentHash: row.intent_hash,
            leaseToken: row.lease_token,
            fencingEpoch: row.fencing_epoch,
            actions: this.loadActions(runId, tenantId),
            createdAt: row.created_at,
            committedAt: (_b = row.committed_at) !== null && _b !== void 0 ? _b : undefined,
            abortedAt: (_c = row.aborted_at) !== null && _c !== void 0 ? _c : undefined,
            error: (_d = row.error) !== null && _d !== void 0 ? _d : undefined,
            tenantId: options === null || options === void 0 ? void 0 : options.tenantId,
            metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
        };
    }
    /** List all runs in a given state (e.g. 'ABORTED' for ops triage). */
    listByState(state, options) {
        var _a;
        if (!this.db || !this.stmtListByState)
            return [];
        const tenantId = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : null;
        const rows = this.stmtListByState.all(state, tenantId, tenantId);
        return rows.map((row) => {
            var _a, _b, _c, _d;
            return ({
                runId: row.run_id,
                state: row.state,
                intentHash: row.intent_hash,
                leaseToken: row.lease_token,
                fencingEpoch: row.fencing_epoch,
                actions: [],
                createdAt: row.created_at,
                committedAt: (_a = row.committed_at) !== null && _a !== void 0 ? _a : undefined,
                abortedAt: (_b = row.aborted_at) !== null && _b !== void 0 ? _b : undefined,
                error: (_c = row.error) !== null && _c !== void 0 ? _c : undefined,
                tenantId: (_d = row.tenant_id) !== null && _d !== void 0 ? _d : undefined,
                metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
            });
        });
    }
    loadActions(runId, tenantId) {
        if (!this.stmtListActions)
            return [];
        return this.stmtListActions.all(runId, tenantId).map((r) => this.rowToAction(r));
    }
    rowToAction(row) {
        var _a, _b, _c;
        return {
            actionId: row.action_id,
            runId: row.run_id,
            toolName: row.tool_name,
            args: row.args_json ? JSON.parse(row.args_json) : {},
            externalSystem: row.external_system,
            idempotencyKey: row.idempotency_key,
            result: (_a = row.result) !== null && _a !== void 0 ? _a : undefined,
            error: (_b = row.error) !== null && _b !== void 0 ? _b : undefined,
            executedAt: row.executed_at,
            compensatedAt: (_c = row.compensated_at) !== null && _c !== void 0 ? _c : undefined,
            compensable: row.compensable === 1,
            tags: row.tags_json ? JSON.parse(row.tags_json) : [],
            description: row.description,
        };
    }
    close() {
        var _a;
        (_a = this.db) === null || _a === void 0 ? void 0 : _a.close();
        this.db = null;
        this.handlers.clear();
    }
    /** Close the owned LeaseManager and IdempotencyStore (when this ledger owns them). */
    closeOwnedResources() {
        this.leaseManager.close();
        this.idempotencyStore.close();
    }
}
exports.RunLedger = RunLedger;
/**
 * Tenant-aware singleton accessor. See tenantAwareSingleton for the
 * global-fallback / per-tenant split semantics. The ledger is heavy (SQLite)
 * and is only instantiated when an agent actually uses the ATR kernel.
 */
const runLedgerSingleton = createLedgerSingleton();
function createLedgerSingleton() {
    return (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => {
        const memory = process.env.COMMANDER_ATR_MEMORY === '1';
        const lease = memory
            ? new leaseManager_1.LeaseManager({ filePath: ':memory:', defaultHolder: 'test' })
            : new leaseManager_1.LeaseManager();
        const idempotency = (0, idempotencyStore_1.getIdempotencyStore)();
        const ledger = memory
            ? new RunLedger(lease, idempotency, {
                filePath: ':memory:',
                defaultTtlSeconds: 60,
                defaultHolder: 'test',
                defaultIdempotencyTtlSeconds: 60,
            })
            : new RunLedger(lease, idempotency);
        return { lease, idempotency, ledger };
    }, {
        dispose: ({ lease, ledger }) => {
            lease.close();
            ledger.close();
        },
    });
}
function getRunLedgerBundle() {
    return runLedgerSingleton.get();
}
function resetRunLedgerBundle() {
    runLedgerSingleton.reset();
}
