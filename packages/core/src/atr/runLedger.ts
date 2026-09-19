import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalEventSourcingEngine } from '../runtime/eventSourcingEngine';
/**
 * RunLedger — P0-2 ATR worker settlement component.
 *
 * **Not the /v1 durable run authority.** Enterprise durable runs live in
 * `packages/kernel` (Postgres) and are submitted/read via Gateway `/v1/runs*`.
 * This ledger is worker-local SQLite settlement for idempotency and compensation
 * within a single agent execution — it must never back Gateway `/v1` routes.
 *
 * The "settlement" half of the ATR runtime. Coordinates the run state machine
 * (PENDING → EXECUTING → VERIFYING → COMMITTED / ABORTED → COMPENSATED),
 * persists every CompensableAction, and integrates with:
 *
 *   - LeaseManager      → process fencing (zombie rejection)
 *   - IdempotencyStore  → tool-call dedup across retries/replays
 *   - CompensationRegistry (runtime) → saga-style undo
 *
 * Why a separate ledger and not just "use CompensationRegistry"?
 *   CompensationRegistry is in-memory and per-AgentRuntime. The ledger is
 *   crash-safe (SQLite) and is the **worker settlement** source of truth for
 *   "what side effects have we already taken on behalf of this runId?" —
 *   across process restarts / worker migrations. It is **not** the durable
 *   `/v1` run authority (that remains kernel Postgres).
 *
 * The ledger's compensateAll() iterates the persisted action list in
 * REVERSE execution order, calling the registered compensation handler for
 * each. This is the actual saga semantics the old CompensationRegistry
 * never delivered.
 *
 * Tenancy: the SQLite key is SHA256(tenantId || "::" || runId), so each
 * tenant's run records are physically isolated.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { CompensableAction, RunState, RunTransaction } from './types';
import { LeaseManager, type AcquireResult } from './leaseManager';
import { IdempotencyStore, getIdempotencyStore } from './idempotencyStore';
import { getGlobalLogger } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const nodeRequire = createRequire(import.meta.url);

export interface RunLedgerConfig {
  filePath: string;
  defaultTtlSeconds: number;
  defaultHolder: string;
  defaultIdempotencyTtlSeconds: number;
}

const DEFAULT_CONFIG: RunLedgerConfig = {
  filePath: '.commander/atr_ledger.db',
  defaultTtlSeconds: 30,
  defaultHolder: `unknown-${process.pid}`,
  defaultIdempotencyTtlSeconds: 24 * 60 * 60,
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
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  BetterSqlite3 = nodeRequire('better-sqlite3');
} catch (_silentE_) {
  reportSilentFailure(_silentE_, 'runLedger:67');
}

export type CompensationHandler = (
  action: CompensableAction,
) => Promise<{ success: boolean; error?: string }>;

interface ActionRow {
  action_id: string;
  run_id: string;
  tool_name: string;
  args_json: string;
  external_system: string;
  idempotency_key: string;
  result: string | null;
  error: string | null;
  executed_at: string;
  compensated_at: string | null;
  compensable: number;
  tags_json: string;
  description: string;
}

interface TxRow {
  run_id: string;
  tenant_id: string | null;
  state: RunState;
  intent_hash: string;
  lease_token: string;
  fencing_epoch: number;
  actions_json: string;
  created_at: string;
  committed_at: string | null;
  aborted_at: string | null;
  error: string | null;
  metadata_json: string | null;
  resume_at: string | null;
  pause_reason: string | null;
}

export interface StartRunInput {
  runId?: string;
  intentHash: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
  holder?: string;
}

export interface RecordActionInput {
  runId: string;
  leaseToken: string;
  fencingEpoch: number;
  tenantId?: string;
  actionId?: string;
  toolName: string;
  externalSystem: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  compensable: boolean;
  tags?: string[];
  description?: string;
}

export interface CompensationOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ actionId: string; toolName: string; error: string }>;
}

/**
 * Raised when a run id is re-bound to a different intent. Idempotent begin is
 * only idempotent for the SAME intent; a different intent for an existing run
 * id is refused (AS-04).
 */
export class RunIntentMismatchError extends Error {
  constructor(runId: string, expected: string, actual: string) {
    super(
      `Run ${runId} already exists with a different intent (existing=${expected}, requested=${actual}); refusing to re-bind`,
    );
    this.name = 'RunIntentMismatchError';
  }
}

export class RunLedger {
  private db: BetterSqlite3DB | null = null;
  private config: RunLedgerConfig;
  private leaseManager: LeaseManager;
  private idempotencyStore: IdempotencyStore;
  private handlers = new Map<string, CompensationHandler>();

  private stmtGetTx: BetterSqlite3Stmt | null = null;
  private stmtInsertTx: BetterSqlite3Stmt | null = null;
  /**
   * State-transition statements keyed by `${targetState}|${sourceStates}`.
   * Built lazily because the legal source-state set differs per transition
   * (idempotent begin vs. exclusive claim).
   */
  private stmtGuardedState = new Map<string, BetterSqlite3Stmt>();
  private stmtAppendAction: BetterSqlite3Stmt | null = null;
  private stmtListActions: BetterSqlite3Stmt | null = null;
  private stmtGetAction: BetterSqlite3Stmt | null = null;
  private stmtUpdateActionResult: BetterSqlite3Stmt | null = null;
  private stmtUpdateActionError: BetterSqlite3Stmt | null = null;
  private stmtMarkCompensated: BetterSqlite3Stmt | null = null;
  private stmtListUncompensated: BetterSqlite3Stmt | null = null;
  private stmtListByState: BetterSqlite3Stmt | null = null;
  private stmtSyncLeaseCredentials: BetterSqlite3Stmt | null = null;
  private stmtRevokeLease: BetterSqlite3Stmt | null = null;
  private stmtPauseTx: BetterSqlite3Stmt | null = null;
  private stmtListRunnablePaused: BetterSqlite3Stmt | null = null;

  constructor(config?: Partial<RunLedgerConfig>);
  constructor(
    leaseManager: LeaseManager,
    idempotencyStore: IdempotencyStore,
    config?: Partial<RunLedgerConfig>,
  );
  constructor(
    arg1?: Partial<RunLedgerConfig> | LeaseManager,
    arg2?: IdempotencyStore,
    arg3?: Partial<RunLedgerConfig>,
  ) {
    if (arg1 instanceof LeaseManager) {
      this.config = { ...DEFAULT_CONFIG, ...arg3 };
      this.leaseManager = arg1;
      this.idempotencyStore = arg2 ?? new IdempotencyStore();
    } else {
      const cfg = { ...DEFAULT_CONFIG, ...arg1 };
      this.config = cfg;
      this.leaseManager = new LeaseManager({
        filePath: cfg.filePath,
        defaultTtlSeconds: cfg.defaultTtlSeconds,
        defaultHolder: cfg.defaultHolder,
      });
      this.idempotencyStore = new IdempotencyStore({
        filePath: cfg.filePath,
        defaultTtlSeconds: cfg.defaultIdempotencyTtlSeconds,
      });
    }
    this.openDb();
    this.prepareStatements();
  }

  private openDb(): void {
    if (!BetterSqlite3) {
      throw new Error('RunLedger requires better-sqlite3. Install it: pnpm add better-sqlite3');
    }
    if (this.config.filePath !== ':memory:') {
      mkdirSync(dirname(this.config.filePath), { recursive: true });
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
        lease_expires_at TEXT,
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
    // V2 additive columns for durable wake / HITL. IF NOT EXISTS via try/catch
    // because SQLite lacks ADD COLUMN IF NOT EXISTS on older builds.
    for (const ddl of [
      `ALTER TABLE run_transactions ADD COLUMN resume_at TEXT`,
      `ALTER TABLE run_transactions ADD COLUMN pause_reason TEXT`,
      `ALTER TABLE run_transactions ADD COLUMN lease_expires_at TEXT`,
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column already exists */
      }
    }
    try {
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tx_resume ON run_transactions(state, resume_at)`,
      );
    } catch {
      /* best-effort */
    }
  }

  private prepareStatements(): void {
    if (!this.db) return;
    this.stmtGetTx = this.db.prepare(`
      SELECT run_id, tenant_id, state, intent_hash, lease_token, fencing_epoch,
             created_at, committed_at, aborted_at, error, metadata_json,
             resume_at, pause_reason,
             '[]' AS actions_json
      FROM run_transactions WHERE run_id = ? AND tenant_id IS ? LIMIT 1
    `);
    this.stmtInsertTx = this.db.prepare(`
      INSERT OR REPLACE INTO run_transactions
        (run_id, tenant_id, state, intent_hash, lease_token, fencing_epoch,
         created_at, metadata_json, lease_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtAppendAction = this.db.prepare(`
      INSERT INTO run_actions
        (action_id, run_id, tenant_id, tool_name, args_json, external_system,
         idempotency_key, executed_at, compensable, tags_json, description)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM run_transactions
        WHERE run_id = ? AND tenant_id IS ? AND lease_token = ? AND fencing_epoch = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
          AND state IN ('PENDING', 'EXECUTING', 'VERIFYING')
      )
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
             created_at, committed_at, aborted_at, error, metadata_json,
             resume_at, pause_reason
      FROM run_transactions WHERE state = ? AND (tenant_id IS ? OR ? IS NULL)
    `);
    this.stmtPauseTx = this.db.prepare(`
      UPDATE run_transactions
      SET state = 'PAUSED', resume_at = ?, pause_reason = ?, error = COALESCE(?, error)
      WHERE run_id = ? AND tenant_id IS ? AND lease_token = ? AND fencing_epoch = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
        AND state IN ('PENDING', 'EXECUTING', 'VERIFYING', 'PAUSED')
    `);
    this.stmtListRunnablePaused = this.db.prepare(`
      SELECT run_id, tenant_id, state, intent_hash, lease_token, fencing_epoch,
             created_at, committed_at, aborted_at, error, metadata_json,
             resume_at, pause_reason
      FROM run_transactions
      WHERE state = 'PAUSED'
        AND resume_at IS NOT NULL
        AND resume_at <= ?
        AND (tenant_id IS ? OR ? IS NULL)
      ORDER BY resume_at ASC
    `);
    this.stmtSyncLeaseCredentials = this.db.prepare(`
      UPDATE run_transactions SET lease_token = ?, fencing_epoch = ?, lease_expires_at = ?
      WHERE run_id = ? AND tenant_id IS ?
        AND state NOT IN ('COMMITTED', 'ABORTED', 'COMPENSATED')
    `);
    this.stmtRevokeLease = this.db.prepare(`
      UPDATE run_transactions SET lease_expires_at = ?
      WHERE run_id = ? AND tenant_id IS ? AND lease_token = ? AND fencing_epoch = ?
    `);
  }

  /**
   * Atomically apply a state transition guarded by ownership, a live lease and
   * the legal source state — all in one condition on the authoritative run
   * row. `lease_expires_at` on the run row is the denormalized lease expiry
   * kept in sync by start() / syncLeaseCredentials().
   */
  private guardedStateUpdate(state: RunState, from: RunState[]): BetterSqlite3Stmt | null {
    if (!this.db) return null;
    const key = `${state}|${from.join(',')}`;
    let stmt = this.stmtGuardedState.get(key);
    if (!stmt) {
      const placeholders = from.map(() => '?').join(', ');
      stmt = this.db.prepare(`
        UPDATE run_transactions
        SET state = ?, committed_at = COALESCE(?, committed_at),
            aborted_at = COALESCE(?, aborted_at), error = COALESCE(?, error)
        WHERE run_id = ? AND tenant_id IS ? AND lease_token = ? AND fencing_epoch = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
          AND state IN (${placeholders})
      `);
      this.stmtGuardedState.set(key, stmt);
    }
    return stmt;
  }

  private applyGuardedState(
    state: RunState,
    from: RunState[],
    runId: string,
    tenantId: string | null,
    leaseToken: string,
    fencingEpoch: number,
    fields?: { committedAt?: string; abortedAt?: string; error?: string },
  ): boolean {
    const stmt = this.guardedStateUpdate(state, from);
    if (!stmt) return false;
    const result = stmt.run(
      state,
      fields?.committedAt ?? null,
      fields?.abortedAt ?? null,
      fields?.error ?? null,
      runId,
      tenantId,
      leaseToken,
      fencingEpoch,
      new Date().toISOString(),
      ...from,
    );
    return result.changes === 1;
  }

  /**
   * Register a compensation handler for a tool. The handler is invoked by
   * abortAndCompensate() in reverse execution order. A handler that returns
   * success=false (or throws) is retried up to maxAttempts; persistent failure
   * is reported in the CompensationOutcome.
   */
  registerCompensation(toolName: string, handler: CompensationHandler): void {
    this.handlers.set(toolName, handler);
  }

  // ── P0: Event Sourcing Integration ────────────────────────────────
  // Every state transition is mirrored to the EventSourcingEngine WAL
  // with a SHA-256 hash chain, enabling state reconstruction from the
  // event log. Fire-and-forget: observability must never break the
  // critical path.
  private emitSourcingEvent(type: string, payload: Record<string, unknown>): void {
    try {
      const engine = getGlobalEventSourcingEngine();
      engine.append({ type, payload }).catch((err: unknown) => {
        reportSilentFailure(err, 'runLedger:emitSourcingEvent');
      });
    } catch (err) {
      reportSilentFailure(err, 'runLedger:emitSourcingEvent:init');
    }
  }

  /**
   * Start a new run. Acquires a lease and persists a PENDING transaction.
   * If the runId already exists, returns the existing transaction (idempotent).
   */
  start(input: StartRunInput): { lease: AcquireResult; tx: RunTransaction } {
    if (!this.db || !this.stmtInsertTx || !this.stmtGetTx) {
      throw new Error('RunLedger not initialized');
    }
    const runId = input.runId ?? `run_${randomUUID()}`;
    const tenantId = input.tenantId ?? null;

    const existing = this.stmtGetTx.get(runId, tenantId) as TxRow | undefined;
    if (existing) {
      // AS-04: idempotent begin is bound to the intent — the same run id may
      // only be re-opened for the same intent.
      if (existing.intent_hash !== input.intentHash) {
        throw new RunIntentMismatchError(runId, existing.intent_hash, input.intentHash);
      }
      const tx = this.rowToTx({ ...existing, tenant_id: tenantId }, true);
      const liveLease = this.leaseManager.get(runId, { tenantId: input.tenantId });
      return {
        lease: {
          acquired: false,
          lease: {
            token: existing.lease_token,
            fencingEpoch: existing.fencing_epoch,
            acquiredAt: existing.created_at,
            expiresAt: liveLease?.expiresAt ?? '',
            runId,
            holder: liveLease?.holder ?? '',
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
    this.stmtInsertTx.run(
      runId,
      tenantId,
      'PENDING',
      input.intentHash,
      acquireResult.lease.token,
      acquireResult.lease.fencingEpoch,
      createdAt,
      input.metadata ? JSON.stringify(input.metadata) : null,
      acquireResult.lease.expiresAt,
    );

    const tx: RunTransaction = {
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

    this.emitSourcingEvent('run.started', {
      runId,
      tenantId: input.tenantId ?? null,
      intentHash: input.intentHash,
      createdAt,
    });

    return { lease: acquireResult, tx };
  }

  /**
   * Transition a run to EXECUTING. Ownership, a live lease and the legal
   * source state are checked in one atomic condition on the run row.
   *
   * `from` defaults to PENDING+EXECUTING so a repeat begin with the same
   * credentials is idempotent. Callers that must win exclusively (a claim)
   * pass an exact source set such as `['PENDING']` or `['PAUSED']`.
   */
  beginExecuting(
    runId: string,
    leaseToken: string,
    fencingEpoch: number,
    options?: { tenantId?: string; from?: RunState[] },
  ): boolean {
    if (!this.db) return false;
    const tenantId = options?.tenantId ?? null;
    const from = options?.from ?? ['PENDING', 'EXECUTING'];
    const ok = this.applyGuardedState('EXECUTING', from, runId, tenantId, leaseToken, fencingEpoch);
    if (ok) {
      this.emitSourcingEvent('run.executing', { runId, tenantId });
    }
    return ok;
  }

  /**
   * Transition a run to VERIFYING. Same atomic lease/state guard as
   * beginExecuting; the only legal source state is EXECUTING.
   */
  beginVerifying(
    runId: string,
    leaseToken: string,
    fencingEpoch: number,
    options?: { tenantId?: string },
  ): boolean {
    if (!this.db) return false;
    const tenantId = options?.tenantId ?? null;
    const ok = this.applyGuardedState(
      'VERIFYING',
      ['EXECUTING'],
      runId,
      tenantId,
      leaseToken,
      fencingEpoch,
    );
    if (ok) {
      this.emitSourcingEvent('run.verifying', { runId, tenantId });
    }
    return ok;
  }

  /**
   * Mark the run as committed (terminal success). No compensation runs.
   * A terminal run is read-only: only EXECUTING/VERIFYING may commit.
   */
  commit(
    runId: string,
    leaseToken: string,
    fencingEpoch: number,
    options?: { tenantId?: string },
  ): boolean {
    if (!this.db) return false;
    const tenantId = options?.tenantId ?? null;
    const now = new Date().toISOString();
    const ok = this.applyGuardedState(
      'COMMITTED',
      ['EXECUTING', 'VERIFYING'],
      runId,
      tenantId,
      leaseToken,
      fencingEpoch,
      { committedAt: now },
    );
    if (ok) {
      this.emitSourcingEvent('run.committed', { runId, tenantId });
    }
    return ok;
  }

  /**
   * Record a compensable action against the run. Persists immediately so
   * even a synchronous crash leaves the side-effect on the books for later
   * compensation.
   *
   * AS-04: the write is a single conditional INSERT ... SELECT guarded by
   * ownership, a live lease and a non-terminal run state on the authoritative
   * run row, so an expired/killed lease or a terminal run cannot register a
   * new side effect. The pre-read below only produces a useful log message.
   */
  recordAction(input: RecordActionInput): CompensableAction | null {
    if (!this.db || !this.stmtAppendAction || !this.stmtGetTx) return null;
    const tenantId = input.tenantId ?? null;
    const txRow = this.stmtGetTx.get(input.runId, tenantId) as TxRow | undefined;
    if (!txRow) {
      getGlobalLogger().warn('RunLedger', 'recordAction: transaction not found', {
        runId: input.runId,
      });
      return null;
    }
    if (txRow.lease_token !== input.leaseToken || txRow.fencing_epoch !== input.fencingEpoch) {
      getGlobalLogger().warn('RunLedger', 'recordAction: fenced (stale lease)', {
        runId: input.runId,
        expectedEpoch: txRow.fencing_epoch,
        callerEpoch: input.fencingEpoch,
      });
      return null;
    }

    const actionId = input.actionId ?? `act_${randomUUID()}`;
    const executedAt = new Date().toISOString();
    const appended = this.stmtAppendAction.run(
      actionId,
      input.runId,
      tenantId,
      input.toolName,
      JSON.stringify(input.args),
      input.externalSystem,
      input.idempotencyKey,
      executedAt,
      input.compensable ? 1 : 0,
      JSON.stringify(input.tags ?? []),
      input.description ?? `${input.toolName}`,
      input.runId,
      tenantId,
      input.leaseToken,
      input.fencingEpoch,
      new Date().toISOString(),
    );
    if (appended.changes !== 1) {
      getGlobalLogger().warn('RunLedger', 'recordAction: refused (expired lease or terminal run)', {
        runId: input.runId,
        state: txRow.state,
      });
      return null;
    }

    this.emitSourcingEvent('action.recorded', {
      runId: input.runId,
      tenantId,
      actionId,
      toolName: input.toolName,
      compensable: input.compensable,
      executedAt,
    });

    return {
      actionId,
      runId: input.runId,
      toolName: input.toolName,
      args: input.args,
      externalSystem: input.externalSystem,
      idempotencyKey: input.idempotencyKey,
      executedAt,
      compensable: input.compensable,
      tags: input.tags ?? [],
      description: input.description ?? '',
    };
  }

  /**
   * Persist a tool's result (or error) on its action record. Idempotent.
   */
  recordResult(actionId: string, result: string): void {
    if (!this.db || !this.stmtUpdateActionResult) return;
    this.stmtUpdateActionResult.run(result, actionId);
  }

  recordError(actionId: string, error: string): void {
    if (!this.db || !this.stmtUpdateActionError) return;
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
  async abortAndCompensate(
    runId: string,
    leaseToken: string,
    fencingEpoch: number,
    errorMessage: string,
    options?: { tenantId?: string; maxAttempts?: number },
  ): Promise<{ aborted: boolean; outcome: CompensationOutcome }> {
    const tenantId = options?.tenantId ?? null;
    const maxAttempts = options?.maxAttempts ?? 3;
    const outcome: CompensationOutcome = { attempted: 0, succeeded: 0, failed: 0, errors: [] };

    const validated = this.leaseManager.validate(runId, leaseToken, fencingEpoch, {
      tenantId: options?.tenantId,
    });
    if (!validated) {
      getGlobalLogger().warn('RunLedger', 'abortAndCompensate: caller is fenced', { runId });
      return { aborted: false, outcome };
    }

    if (this.db) {
      // AS-04: abort is itself a guarded transition — a terminal run is
      // read-only and the run row must still carry a live lease.
      this.applyGuardedState(
        'ABORTED',
        ['PENDING', 'EXECUTING', 'VERIFYING', 'PAUSED'],
        runId,
        tenantId,
        leaseToken,
        fencingEpoch,
        { abortedAt: new Date().toISOString(), error: errorMessage },
      );

      this.emitSourcingEvent('run.aborted', {
        runId,
        tenantId,
        errorMessage,
      });
    }
    // No handler → log and treat as success (idempotent no-op). This is the
    // safe default for tools we can't undo (e.g. side effects to systems with
    // no inverse API) — better to log than to crash mid-compensation.

    if (!this.db || !this.stmtListUncompensated) {
      return { aborted: true, outcome };
    }
    const rows = this.stmtListUncompensated.all(runId, tenantId) as ActionRow[];

    for (const row of rows) {
      const action = this.rowToAction(row);
      const handler = this.handlers.get(action.toolName);
      outcome.attempted++;
      if (!handler) {
        // No handler — log and treat as success (idempotent no-op)
        getGlobalLogger().info(
          'RunLedger',
          `No compensation handler for ${action.toolName}; skipping`,
          {
            actionId: action.actionId,
          },
        );
        this.stmtMarkCompensated?.run(new Date().toISOString(), action.actionId);
        outcome.succeeded++;
        continue;
      }
      let attempts = 0;
      let success = false;
      let lastError: string | undefined;
      while (attempts < maxAttempts && !success) {
        attempts++;
        try {
          const res = await handler(action);
          if (res.success) {
            success = true;
            outcome.succeeded++;
            this.stmtMarkCompensated?.run(new Date().toISOString(), action.actionId);
            this.idempotencyStore.fail(action.idempotencyKey, `compensated:${action.actionId}`, {
              tenantId: options?.tenantId,
            });
          } else {
            lastError = res.error;
          }
        } catch (err) {
          lastError = (err as Error).message;
        }
      }
      if (!success) {
        outcome.failed++;
        outcome.errors.push({
          actionId: action.actionId,
          toolName: action.toolName,
          error: lastError ?? 'unknown',
        });
        getGlobalLogger().error(
          'RunLedger',
          `Compensation failed after ${maxAttempts} attempts`,
          lastError ? new Error(lastError) : undefined,
          {
            actionId: action.actionId,
            toolName: action.toolName,
          },
        );
      }
    }

    if (this.db) {
      // The run was just moved to ABORTED above; settle it as COMPENSATED
      // when every compensation succeeded, otherwise leave it ABORTED with
      // the failure recorded. Both are guarded, so a fenced/expired caller
      // cannot settle the row.
      this.applyGuardedState(
        outcome.failed === 0 ? 'COMPENSATED' : 'ABORTED',
        ['ABORTED'],
        runId,
        tenantId,
        leaseToken,
        fencingEpoch,
        {
          abortedAt: new Date().toISOString(),
          error: outcome.failed > 0 ? `${outcome.failed} compensations failed` : undefined,
        },
      );
    }

    return { aborted: true, outcome };
  }

  /**
   * Transition EXECUTING/VERIFYING/PENDING → PAUSED (HITL, budget, timer).
   * Optionally set resumeAt for delayed wake. Returns false if fenced.
   */
  pause(
    runId: string,
    leaseToken: string,
    fencingEpoch: number,
    options?: {
      tenantId?: string;
      resumeAt?: string | null;
      reason?: string;
      error?: string;
    },
  ): boolean {
    if (!this.db || !this.stmtPauseTx) return false;
    const tenantId = options?.tenantId ?? null;
    const result = this.stmtPauseTx.run(
      options?.resumeAt ?? null,
      options?.reason ?? 'paused',
      options?.error ?? null,
      runId,
      tenantId,
      leaseToken,
      fencingEpoch,
      new Date().toISOString(),
    );
    if (result.changes === 1) {
      this.emitSourcingEvent('run.paused', {
        runId,
        tenantId,
        resumeAt: options?.resumeAt ?? null,
        reason: options?.reason ?? 'paused',
      });
    }
    return result.changes === 1;
  }

  /**
   * List PAUSED runs whose resume_at <= now (eligible for wake).
   */
  listRunnablePaused(options?: { tenantId?: string; nowIso?: string }): RunTransaction[] {
    if (!this.db || !this.stmtListRunnablePaused) return [];
    const tenantId = options?.tenantId ?? null;
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const rows = this.stmtListRunnablePaused.all(nowIso, tenantId, tenantId) as TxRow[];
    return rows.map((row) => this.rowToTx(row, /* loadActions */ false));
  }

  private rowToTx(row: TxRow, loadActions: boolean): RunTransaction {
    return {
      runId: row.run_id,
      state: row.state,
      intentHash: row.intent_hash,
      leaseToken: row.lease_token,
      fencingEpoch: row.fencing_epoch,
      actions: loadActions ? this.loadActions(row.run_id, row.tenant_id) : [],
      createdAt: row.created_at,
      committedAt: row.committed_at ?? undefined,
      abortedAt: row.aborted_at ?? undefined,
      error: row.error ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      resumeAt: row.resume_at ?? undefined,
      pauseReason: row.pause_reason ?? undefined,
    };
  }

  /** Load a run transaction by id. */
  getTransaction(runId: string, options?: { tenantId?: string }): RunTransaction | null {
    if (!this.db || !this.stmtGetTx) return null;
    const tenantId = options?.tenantId ?? null;
    const row = this.stmtGetTx.get(runId, tenantId) as TxRow | undefined;
    if (!row) return null;
    return this.rowToTx({ ...row, tenant_id: tenantId }, true);
  }

  /** List all runs in a given state (e.g. 'ABORTED' for ops triage). */
  listByState(state: RunState, options?: { tenantId?: string }): RunTransaction[] {
    if (!this.db || !this.stmtListByState) return [];
    const tenantId = options?.tenantId ?? null;
    const rows = this.stmtListByState.all(state, tenantId, tenantId) as TxRow[];
    return rows.map((row) => this.rowToTx(row, false));
  }

  private loadActions(runId: string, tenantId: string | null): CompensableAction[] {
    if (!this.stmtListActions) return [];
    return (this.stmtListActions.all(runId, tenantId) as ActionRow[]).map((r) =>
      this.rowToAction(r),
    );
  }

  private rowToAction(row: ActionRow): CompensableAction {
    return {
      actionId: row.action_id,
      runId: row.run_id,
      toolName: row.tool_name,
      args: row.args_json ? JSON.parse(row.args_json) : {},
      externalSystem: row.external_system,
      idempotencyKey: row.idempotency_key,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      executedAt: row.executed_at,
      compensatedAt: row.compensated_at ?? undefined,
      compensable: row.compensable === 1,
      tags: row.tags_json ? JSON.parse(row.tags_json) : [],
      description: row.description,
    };
  }

  /**
   * Sync the lease token, fencing epoch and expiry into the ledger row.
   * Called after RecoveryBootstrapper / a claim acquires a new lease on a run
   * so that subsequent scheduler operations validate against the new
   * credentials.
   *
   * AS-04: the caller must present credentials that the lease authority (the
   * LeaseManager) currently considers live; an arbitrary caller therefore
   * cannot overwrite another owner's row credentials.
   */
  syncLeaseCredentials(
    runId: string,
    leaseToken: string,
    fencingEpoch: number,
    options?: { tenantId?: string; expiresAt?: string },
  ): boolean {
    if (!this.db || !this.stmtSyncLeaseCredentials) return false;
    const tenantId = options?.tenantId ?? null;
    const live = this.leaseManager.get(runId, { tenantId: options?.tenantId });
    if (!live || live.token !== leaseToken || live.fencingEpoch !== fencingEpoch) {
      getGlobalLogger().warn('RunLedger', 'syncLeaseCredentials: refused (not the live lease)', {
        runId,
      });
      return false;
    }
    const result = this.stmtSyncLeaseCredentials.run(
      leaseToken,
      fencingEpoch,
      options?.expiresAt ?? live.expiresAt,
      runId,
      tenantId,
    );
    return result.changes === 1;
  }

  /**
   * Invalidate the run row's lease credentials on release/kill so a surviving
   * writer can no longer pass the guarded write conditions. The stored row
   * token is never handed out again for recovery.
   */
  revokeLease(
    runId: string,
    leaseToken: string,
    fencingEpoch: number,
    options?: { tenantId?: string },
  ): boolean {
    if (!this.db || !this.stmtRevokeLease) return false;
    const tenantId = options?.tenantId ?? null;
    const result = this.stmtRevokeLease.run(
      '1970-01-01T00:00:00.000Z',
      runId,
      tenantId,
      leaseToken,
      fencingEpoch,
    );
    return result.changes === 1;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.stmtGuardedState.clear();
    this.handlers.clear();
  }

  /** Close the owned LeaseManager and IdempotencyStore (when this ledger owns them). */
  closeOwnedResources(): void {
    this.leaseManager.close();
    this.idempotencyStore.close();
  }
}

/**
 * Tenant-aware singleton accessor. See tenantAwareSingleton for the
 * global-fallback / per-tenant split semantics. The ledger is heavy (SQLite)
 * and is only instantiated when an agent actually uses the ATR kernel.
 */
const runLedgerSingleton = createLedgerSingleton();

function createLedgerSingleton() {
  interface Bundle {
    lease: LeaseManager;
    idempotency: IdempotencyStore;
    ledger: RunLedger;
  }

  return createTenantAwareSingleton<Bundle>(
    () => {
      const memory = process.env.COMMANDER_ATR_MEMORY === '1';
      const lease = memory
        ? new LeaseManager({ filePath: ':memory:', defaultHolder: 'test' })
        : new LeaseManager();
      const idempotency = getIdempotencyStore();
      const ledger = memory
        ? new RunLedger(lease, idempotency, {
            filePath: ':memory:',
            defaultTtlSeconds: 60,
            defaultHolder: 'test',
            defaultIdempotencyTtlSeconds: 60,
          })
        : new RunLedger(lease, idempotency);
      return { lease, idempotency, ledger };
    },
    {
      dispose: ({ lease, ledger }) => {
        lease.close();
        ledger.close();
      },
    },
  );
}

export function getRunLedgerBundle(): {
  lease: LeaseManager;
  idempotency: IdempotencyStore;
  ledger: RunLedger;
} {
  return runLedgerSingleton.get();
}

export function resetRunLedgerBundle(): void {
  runLedgerSingleton.reset();
}
