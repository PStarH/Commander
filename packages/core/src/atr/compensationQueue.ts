import { reportSilentFailure } from '../silentFailureReporter';
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
 *   - enqueue(): persist a new pending compensation, bound to the
 *     authenticated (ambient) tenant — a caller cannot choose the owner
 *   - claimNext(): atomically claim the next due item for the authenticated
 *     tenant, stamping a monotonic claim generation and a bounded claim
 *     expiry
 *   - markCompleted(): success — CAS on (tenant, generation, in_progress);
 *     keeps a minimal receipt for idempotency + audit
 *   - markFailed(): CAS-scheduled next attempt with backoff
 *   - markEscalated(): after maxAttempts, move to escalated state for
 *     manual review via commander compensation list/retry <id>
 *   - retry(): force re-attempt of an escalated item
 *
 * Ownership model (AR-03): reads and writes are always scoped to a single
 * tenant; there is no "no tenant context means every tenant" path. Every
 * mutation carries the tenant, the claim generation issued by claimNext()
 * and the expected state, and is applied as one conditional UPDATE. An
 * expired in-progress claim is escalated for reconciliation — it is never
 * blindly replayed, because the external effect of the previous attempt is
 * unknown.
 *
 * Persistence: SQLite-backed (better-sqlite3). WAL mode for crash safety.
 *
 * Tier 2.4 of reversibility-rfc-v2 (M1 + M11).
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getCurrentTenantId } from '../runtime/tenantContext';

const nodeRequire = createRequire(import.meta.url);

interface BetterSqlite3Stmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
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
  reportSilentFailure(_silentE_, 'compensationQueue:52');
}

export type CompensationStatus = 'pending' | 'in_progress' | 'escalated';

/** Outcome of a claim-bound write. `refused` means the CAS did not match. */
export type CompensationWriteOutcome = 'pending' | 'escalated' | 'refused';

/**
 * Trusted ownership tuple for a claimed item. `claimGeneration` is the
 * monotonic token returned by claimNext(); a stale worker presenting an
 * older generation can no longer mutate the row.
 */
export interface CompensationClaim {
  tenantId: string;
  claimGeneration: number;
}

export interface CompensationQueueItem {
  id: string;
  runId: string;
  agentId?: string;
  tenantId?: string;
  toolName: string;
  args: string; // JSON-serialized args (idempotency key source)
  attemptCount: number;
  maxAttempts: number;
  status: CompensationStatus;
  lastError?: string;
  enqueuedAt: string;
  lastAttemptAt?: string;
  nextAttemptAt: string; // earliest time retry can run
  /** Monotonic claim generation; 0 until first claimed. */
  claimGeneration: number;
  /** Bounded expiry of the in-progress claim (undefined when not claimed). */
  claimExpiresAt?: string;
  // Tag for the compensation handler that should run (matches
  // CompensationRegistry's key). The bridge between queue and
  // registry happens in agentRuntime/compensationBridge.
  compensationHandlerKey: string;
}

/** Minimal audit/idempotency receipt kept after a compensation completes. */
export interface CompensationReceipt {
  id: string;
  tenantId: string;
  runId: string;
  claimGeneration: number;
  completedAt: string;
}

export interface CompensationQueueConfig {
  filePath?: string;
  /** Default 10. After this many attempts, item is escalated. */
  defaultMaxAttempts?: number;
  /** Backoff base in ms. Actual delay = base * 2^(attempt-1), capped. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. */
  backoffMaxMs?: number;
  /** Bounded lifetime of an in-progress claim, in seconds. Default 60. */
  claimTtlSeconds?: number;
}

const DEFAULT_DB_PATH = join(process.cwd(), '.commander', 'compensation_queue.db');

/** Reason recorded when an in-progress claim expired without a settlement. */
export const CLAIM_EXPIRED_REASON = 'claim_expired_requires_reconciliation';

export function defaultCompensationQueuePath(): string {
  return DEFAULT_DB_PATH;
}

export class CompensationQueue {
  private db: BetterSqlite3DB | null = null;
  private config: Required<CompensationQueueConfig>;
  private stmtEnqueue: BetterSqlite3Stmt | null = null;
  private stmtGet: BetterSqlite3Stmt | null = null;
  private stmtList: BetterSqlite3Stmt | null = null;
  private stmtListByStatus: BetterSqlite3Stmt | null = null;
  private stmtListPending: BetterSqlite3Stmt | null = null;
  private stmtClaim: BetterSqlite3Stmt | null = null;
  private stmtReapExpired: BetterSqlite3Stmt | null = null;
  private stmtCompleteReceipt: BetterSqlite3Stmt | null = null;
  private stmtReceiptFor: BetterSqlite3Stmt | null = null;
  private stmtReceiptGet: BetterSqlite3Stmt | null = null;
  private stmtDelete: BetterSqlite3Stmt | null = null;
  private stmtFail: BetterSqlite3Stmt | null = null;
  private stmtEscalate: BetterSqlite3Stmt | null = null;
  private stmtRetry: BetterSqlite3Stmt | null = null;
  private stmtCount: BetterSqlite3Stmt | null = null;

  constructor(config: Partial<CompensationQueueConfig> = {}) {
    this.config = {
      filePath: config.filePath ?? DEFAULT_DB_PATH,
      defaultMaxAttempts: config.defaultMaxAttempts ?? 10,
      backoffBaseMs: config.backoffBaseMs ?? 1000,
      backoffMaxMs: config.backoffMaxMs ?? 5 * 60 * 1000,
      claimTtlSeconds: config.claimTtlSeconds ?? 60,
    };
    this.openDb();
    this.prepareStatements();
  }

  private assertOpen(): BetterSqlite3DB {
    if (!this.db) {
      throw new Error('CompensationQueue is closed: further operations are refused');
    }
    return this.db;
  }

  private openDb(): void {
    if (!BetterSqlite3) {
      throw new Error(
        'CompensationQueue requires better-sqlite3. Install it: pnpm add better-sqlite3',
      );
    }
    if (this.config.filePath !== ':memory:') {
      mkdirSync(dirname(this.config.filePath), { recursive: true });
    }
    this.db = new BetterSqlite3(this.config.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS compensation_queue (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT,
        tenant_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args TEXT NOT NULL,
        compensation_handler_key TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        enqueued_at TEXT NOT NULL,
        last_attempt_at TEXT,
        next_attempt_at TEXT NOT NULL,
        claim_generation INTEGER NOT NULL DEFAULT 0,
        claim_expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_compensation_status
        ON compensation_queue(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_compensation_run
        ON compensation_queue(run_id);
      CREATE TABLE IF NOT EXISTS compensation_receipts (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        claim_generation INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (id, tenant_id)
      );
    `);
    // Additive columns for databases created before AR-03. SQLite has no
    // ADD COLUMN IF NOT EXISTS on older builds, so probe with try/catch.
    for (const ddl of [
      `ALTER TABLE compensation_queue ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE compensation_queue ADD COLUMN claim_expires_at TEXT`,
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column already exists */
      }
    }
  }

  private prepareStatements(): void {
    if (!this.db) return;
    this.stmtEnqueue = this.db.prepare(`
      INSERT INTO compensation_queue (
        id, run_id, agent_id, tenant_id, tool_name, args, compensation_handler_key,
        attempt_count, max_attempts, status, enqueued_at, next_attempt_at, claim_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?, 0)
    `);
    this.stmtGet = this.db.prepare(
      `SELECT * FROM compensation_queue WHERE id = ? AND tenant_id = ?`,
    );
    this.stmtList = this.db.prepare(
      `SELECT * FROM compensation_queue WHERE tenant_id = ? ORDER BY enqueued_at DESC LIMIT ?`,
    );
    this.stmtListByStatus = this.db.prepare(
      `SELECT * FROM compensation_queue WHERE tenant_id = ? AND status = ? ORDER BY enqueued_at DESC LIMIT ?`,
    );
    this.stmtListPending = this.db.prepare(`
      SELECT * FROM compensation_queue
      WHERE tenant_id = ? AND status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC LIMIT 1
    `);
    this.stmtClaim = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'in_progress',
          last_attempt_at = ?,
          attempt_count = attempt_count + 1,
          claim_generation = claim_generation + 1,
          claim_expires_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'pending' AND next_attempt_at <= ?
    `);
    this.stmtReapExpired = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'escalated', last_error = ?, last_attempt_at = ?, claim_expires_at = NULL
      WHERE tenant_id = ? AND status = 'in_progress'
        AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
    `);
    this.stmtCompleteReceipt = this.db.prepare(`
      INSERT INTO compensation_receipts (id, tenant_id, run_id, claim_generation, completed_at)
      SELECT id, tenant_id, run_id, claim_generation, ?
      FROM compensation_queue
      WHERE id = ? AND tenant_id = ? AND status = 'in_progress' AND claim_generation = ?
    `);
    this.stmtReceiptFor = this.db.prepare(
      `SELECT 1 FROM compensation_receipts WHERE id = ? AND tenant_id = ?`,
    );
    this.stmtReceiptGet = this.db.prepare(
      `SELECT id, tenant_id, run_id, claim_generation, completed_at
       FROM compensation_receipts WHERE id = ? AND tenant_id = ?`,
    );
    this.stmtDelete = this.db.prepare(
      `DELETE FROM compensation_queue WHERE id = ? AND tenant_id = ?`,
    );
    this.stmtFail = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'pending', last_error = ?, next_attempt_at = ?, last_attempt_at = ?,
          claim_expires_at = NULL
      WHERE id = ? AND tenant_id = ? AND status = 'in_progress' AND claim_generation = ?
    `);
    this.stmtEscalate = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'escalated', last_error = ?, last_attempt_at = ?, claim_expires_at = NULL
      WHERE id = ? AND tenant_id = ? AND status = 'in_progress' AND claim_generation = ?
    `);
    this.stmtRetry = this.db.prepare(`
      UPDATE compensation_queue
      SET status = 'pending', last_error = NULL, next_attempt_at = ?, attempt_count = 0,
          claim_expires_at = NULL
      WHERE id = ? AND tenant_id = ? AND status = 'escalated'
    `);
    this.stmtCount = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM compensation_queue
      WHERE tenant_id = ? GROUP BY status
    `);
  }

  /**
   * The trusted tenant for this operation. Reads and writes are always
   * single-tenant; a missing context yields no rows rather than every
   * tenant's rows.
   */
  private currentTenant(): string | null {
    return getCurrentTenantId() ?? null;
  }

  /**
   * Persist a pending compensation bound to the authenticated owner. The
   * owner is the ambient tenant context, never a caller-supplied value: an
   * `input.tenantId` that disagrees with the context is rejected.
   */
  enqueue(input: {
    id: string;
    runId: string;
    agentId?: string;
    tenantId?: string;
    toolName: string;
    args: unknown;
    compensationHandlerKey: string;
    maxAttempts?: number;
  }): void {
    this.assertOpen();
    if (!this.stmtEnqueue) throw new Error('CompensationQueue not initialized');
    const owner = this.currentTenant();
    if (!owner) {
      throw new Error(
        'CompensationQueue.enqueue refused: no authenticated tenant context to bind the owner',
      );
    }
    if (input.tenantId && input.tenantId !== owner) {
      throw new Error(
        `CompensationQueue.enqueue refused: input.tenantId (${input.tenantId}) does not match the authenticated tenant (${owner})`,
      );
    }
    const now = new Date().toISOString();
    this.stmtEnqueue.run(
      input.id,
      input.runId,
      input.agentId ?? null,
      owner,
      input.toolName,
      JSON.stringify(input.args),
      input.compensationHandlerKey,
      input.maxAttempts ?? this.config.defaultMaxAttempts,
      now,
      now,
    );
  }

  /**
   * Atomically claim the next due item for the authenticated tenant. An
   * in-progress claim whose bounded expiry has passed is escalated for
   * reconciliation first — it is never replayed, because the previous
   * attempt's external effect is unknown. Returns null when nothing is due
   * or when there is no tenant context.
   */
  claimNext(): CompensationQueueItem | null {
    this.assertOpen();
    if (!this.stmtListPending || !this.stmtClaim || !this.stmtReapExpired) return null;
    const tenantId = this.currentTenant();
    if (!tenantId) return null;
    const now = new Date().toISOString();

    // Bounded claims: an expired in-progress row is not replayed; it becomes
    // an explicit manual-reconciliation record for this tenant.
    this.stmtReapExpired.run(CLAIM_EXPIRED_REASON, now, tenantId, now);

    const candidates = this.stmtListPending.all(tenantId, now) as Array<Record<string, unknown>>;
    if (candidates.length === 0) return null;
    const id = candidates[0].id as string;
    const claimExpiresAt = new Date(Date.now() + this.config.claimTtlSeconds * 1000).toISOString();
    const result = this.stmtClaim.run(now, claimExpiresAt, id, tenantId, now);
    if (result.changes === 0) {
      // Lost the race; another process claimed it.
      return null;
    }
    return this.getInternal(id, tenantId);
  }

  /**
   * Mark a claimed item completed. The receipt row is the idempotency +
   * audit record; a repeated completion returns true without a second
   * side effect, and a stale generation or wrong tenant is refused.
   */
  markCompleted(id: string, claim: CompensationClaim): boolean;
  /** @deprecated Legacy shape without a claim is refused — it carries no ownership. */
  markCompleted(id: string): boolean;
  markCompleted(id: string, claim?: CompensationClaim): boolean {
    this.assertOpen();
    if (!this.stmtCompleteReceipt || !this.stmtReceiptFor || !this.stmtDelete) return false;
    if (!claim || !claim.tenantId) return false;
    const now = new Date().toISOString();
    const txn = this.assertOpen().transaction(() => {
      const inserted = this.stmtCompleteReceipt!.run(
        now,
        id,
        claim.tenantId,
        claim.claimGeneration,
      );
      if (inserted.changes === 1) {
        this.stmtDelete!.run(id, claim.tenantId);
        return true;
      }
      // Not our claim/state — only an existing receipt makes this a success.
      return this.stmtReceiptFor!.get(id, claim.tenantId) !== undefined;
    });
    return txn();
  }

  /**
   * Schedule the next attempt (with backoff) or escalate once maxAttempts is
   * reached. CAS-bound to the claim generation and in-progress state.
   */
  markFailed(id: string, error: string, claim: CompensationClaim): CompensationWriteOutcome;
  /** @deprecated Legacy shape without a claim is refused — it carries no ownership. */
  markFailed(id: string, error: string, currentAttempt: number): CompensationWriteOutcome;
  markFailed(
    id: string,
    error: string,
    claim?: CompensationClaim | number,
  ): CompensationWriteOutcome {
    this.assertOpen();
    if (!this.stmtFail || !this.stmtEscalate) throw new Error('not initialized');
    if (!isClaim(claim)) return 'refused';
    const item = this.getInternal(id, claim.tenantId);
    if (!item) return 'refused';

    const now = new Date().toISOString();
    if (item.attemptCount >= item.maxAttempts) {
      const escalated = this.stmtEscalate.run(
        error,
        now,
        id,
        claim.tenantId,
        claim.claimGeneration,
      );
      return escalated.changes === 1 ? 'escalated' : 'refused';
    }
    // Backoff: base * 2^(attempt-1), capped.
    const delay = Math.min(
      this.config.backoffBaseMs * Math.pow(2, item.attemptCount - 1),
      this.config.backoffMaxMs,
    );
    const next = new Date(Date.now() + delay).toISOString();
    const failed = this.stmtFail.run(error, next, now, id, claim.tenantId, claim.claimGeneration);
    return failed.changes === 1 ? 'pending' : 'refused';
  }

  /** Escalate a claimed item for manual handling. CAS-bound to the claim. */
  markEscalated(id: string, error: string, claim: CompensationClaim): boolean;
  /** @deprecated Legacy shape without a claim is refused — it carries no ownership. */
  markEscalated(id: string, error: string): boolean;
  markEscalated(id: string, error: string, claim?: CompensationClaim): boolean {
    this.assertOpen();
    if (!this.stmtEscalate) return false;
    if (!claim || !claim.tenantId) return false;
    const result = this.stmtEscalate.run(
      error,
      new Date().toISOString(),
      id,
      claim.tenantId,
      claim.claimGeneration,
    );
    return result.changes === 1;
  }

  /**
   * Force-retry an escalated item for an explicit tenant. Resets
   * attempt_count to 0 and schedules an immediate next attempt. The
   * escalated state is the CAS source state, so a live claim can never be
   * reset by this operator action.
   */
  retry(id: string, tenantId: string): boolean;
  /** @deprecated Legacy shape without a tenant is refused — no implicit admin. */
  retry(id: string): boolean;
  retry(id: string, tenantId?: string): boolean {
    this.assertOpen();
    if (!this.stmtRetry) return false;
    if (!tenantId) return false;
    const result = this.stmtRetry.run(new Date().toISOString(), id, tenantId);
    return result.changes > 0;
  }

  get(id: string): CompensationQueueItem | null {
    this.assertOpen();
    const tenantId = this.currentTenant();
    if (!tenantId) return null;
    return this.getInternal(id, tenantId);
  }

  /** Tenant-scoped lookup with the tenant already resolved. */
  private getInternal(id: string, tenantId: string): CompensationQueueItem | null {
    if (!this.stmtGet) return null;
    const row = this.stmtGet.get(id, tenantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToItem(row);
  }

  /** Minimal completion receipt (idempotency + audit) for the current tenant. */
  getReceipt(id: string): CompensationReceipt | null {
    this.assertOpen();
    if (!this.stmtReceiptGet) return null;
    const tenantId = this.currentTenant();
    if (!tenantId) return null;
    const row = this.stmtReceiptGet.get(id, tenantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      runId: row.run_id as string,
      claimGeneration: row.claim_generation as number,
      completedAt: row.completed_at as string,
    };
  }

  list(opts: { limit?: number; status?: CompensationStatus } = {}): CompensationQueueItem[] {
    this.assertOpen();
    const tenantId = this.currentTenant();
    if (!tenantId) return [];
    const limit = opts.limit ?? 100;
    if (opts.status) {
      if (!this.stmtListByStatus) return [];
      const rows = this.stmtListByStatus.all(tenantId, opts.status, limit) as Array<
        Record<string, unknown>
      >;
      return rows.map(rowToItem);
    }
    if (!this.stmtList) return [];
    const rows = this.stmtList.all(tenantId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToItem);
  }

  countByStatus(): Record<CompensationStatus, number> {
    this.assertOpen();
    const result: Record<CompensationStatus, number> = { pending: 0, in_progress: 0, escalated: 0 };
    const tenantId = this.currentTenant();
    if (!tenantId || !this.stmtCount) return result;
    const rows = this.stmtCount.all(tenantId) as Array<{ status: string; count: number }>;
    for (const r of rows) {
      if (r.status in result) result[r.status as CompensationStatus] = r.count;
    }
    return result;
  }

  /**
   * Release every prepared statement and the database handle. Any later
   * operation is refused explicitly instead of hitting a closed handle.
   */
  close(): void {
    this.stmtEnqueue = null;
    this.stmtGet = null;
    this.stmtList = null;
    this.stmtListByStatus = null;
    this.stmtListPending = null;
    this.stmtClaim = null;
    this.stmtReapExpired = null;
    this.stmtCompleteReceipt = null;
    this.stmtReceiptFor = null;
    this.stmtReceiptGet = null;
    this.stmtDelete = null;
    this.stmtFail = null;
    this.stmtEscalate = null;
    this.stmtRetry = null;
    this.stmtCount = null;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function isClaim(value: CompensationClaim | number | undefined): value is CompensationClaim {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CompensationClaim).tenantId === 'string' &&
    (value as CompensationClaim).tenantId.length > 0 &&
    typeof (value as CompensationClaim).claimGeneration === 'number'
  );
}

function rowToItem(row: Record<string, unknown>): CompensationQueueItem {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    agentId: row.agent_id as string | undefined,
    tenantId: row.tenant_id as string | undefined,
    toolName: row.tool_name as string,
    args: row.args as string,
    attemptCount: row.attempt_count as number,
    maxAttempts: row.max_attempts as number,
    status: row.status as CompensationStatus,
    lastError: row.last_error as string | undefined,
    enqueuedAt: row.enqueued_at as string,
    lastAttemptAt: row.last_attempt_at as string | undefined,
    nextAttemptAt: row.next_attempt_at as string,
    claimGeneration: (row.claim_generation as number) ?? 0,
    claimExpiresAt: (row.claim_expires_at as string | null) ?? undefined,
    compensationHandlerKey: row.compensation_handler_key as string,
  };
}

let _instance: CompensationQueue | null = null;

export function getCompensationQueue(): CompensationQueue {
  if (!_instance) _instance = new CompensationQueue();
  return _instance;
}

export function resetCompensationQueueForTesting(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
