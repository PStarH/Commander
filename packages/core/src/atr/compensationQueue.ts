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

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3');
} catch {}

export type CompensationStatus = 'pending' | 'in_progress' | 'escalated';

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
  // Tag for the compensation handler that should run (matches
  // CompensationRegistry's key). The bridge between queue and
  // registry happens in agentRuntime/compensationBridge.
  compensationHandlerKey: string;
}

export interface CompensationQueueConfig {
  filePath?: string;
  /** Default 10. After this many attempts, item is escalated. */
  defaultMaxAttempts?: number;
  /** Backoff base in ms. Actual delay = base * 2^(attempt-1), capped. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. */
  backoffMaxMs?: number;
}

const DEFAULT_DB_PATH = join(process.cwd(), '.commander', 'compensation_queue.db');

export function defaultCompensationQueuePath(): string {
  return DEFAULT_DB_PATH;
}

export class CompensationQueue {
  private db: BetterSqlite3DB | null = null;
  private config: Required<CompensationQueueConfig>;
  private stmtEnqueue: BetterSqlite3Stmt | null = null;
  private stmtGet: BetterSqlite3Stmt | null = null;
  private stmtList: BetterSqlite3Stmt | null = null;
  private stmtListPending: BetterSqlite3Stmt | null = null;
  private stmtClaim: BetterSqlite3Stmt | null = null;
  private stmtComplete: BetterSqlite3Stmt | null = null;
  private stmtFail: BetterSqlite3Stmt | null = null;
  private stmtEscalate: BetterSqlite3Stmt | null = null;
  private stmtRetry: BetterSqlite3Stmt | null = null;
  private stmtCount: BetterSqlite3Stmt | null = null;
  private stmtDelete: BetterSqlite3Stmt | null = null;

  constructor(config: Partial<CompensationQueueConfig> = {}) {
    this.config = {
      filePath: config.filePath ?? DEFAULT_DB_PATH,
      defaultMaxAttempts: config.defaultMaxAttempts ?? 10,
      backoffBaseMs: config.backoffBaseMs ?? 1000,
      backoffMaxMs: config.backoffMaxMs ?? 5 * 60 * 1000,
    };
    this.openDb();
    this.prepareStatements();
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

  private prepareStatements(): void {
    if (!this.db) return;
    this.stmtEnqueue = this.db.prepare(`
      INSERT INTO compensation_queue (
        id, run_id, agent_id, tenant_id, tool_name, args, compensation_handler_key,
        attempt_count, max_attempts, status, enqueued_at, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?)
    `);
    this.stmtGet = this.db.prepare(`SELECT * FROM compensation_queue WHERE id = ?`);
    this.stmtList = this.db.prepare(
      `SELECT * FROM compensation_queue ORDER BY enqueued_at DESC LIMIT ?`,
    );
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
    if (!this.stmtEnqueue) throw new Error('CompensationQueue not initialized');
    const now = new Date().toISOString();
    this.stmtEnqueue.run(
      input.id,
      input.runId,
      input.agentId ?? null,
      input.tenantId ?? null,
      input.toolName,
      JSON.stringify(input.args),
      input.compensationHandlerKey,
      input.maxAttempts ?? this.config.defaultMaxAttempts,
      now,
      now,
    );
  }

  /**
   * Atomically claim the next due item for processing. Returns null if
   * no item is due. The atomic UPDATE prevents two processes from
   * compensating the same action.
   */
  claimNext(): CompensationQueueItem | null {
    if (!this.stmtListPending || !this.stmtClaim) return null;
    const now = new Date().toISOString();
    const candidates = this.stmtListPending.all(now, 1) as Array<Record<string, unknown>>;
    if (candidates.length === 0) return null;
    const id = candidates[0].id as string;
    const result = this.stmtClaim.run(now, id);
    if (result.changes === 0) {
      // Lost the race; another process claimed it.
      return null;
    }
    return this.get(id);
  }

  markCompleted(id: string): void {
    if (!this.stmtComplete) return;
    this.stmtComplete.run(id);
  }

  markFailed(id: string, error: string, currentAttempt: number): 'pending' | 'escalated' {
    if (!this.stmtFail || !this.stmtEscalate) throw new Error('not initialized');
    const item = this.get(id);
    if (!item) return 'escalated';
    if (currentAttempt >= item.maxAttempts) {
      this.stmtEscalate.run(error, new Date().toISOString(), id);
      return 'escalated';
    }
    // Backoff: base * 2^(attempt-1), capped.
    const delay = Math.min(
      this.config.backoffBaseMs * Math.pow(2, currentAttempt - 1),
      this.config.backoffMaxMs,
    );
    const next = new Date(Date.now() + delay).toISOString();
    this.stmtFail.run(error, next, new Date().toISOString(), id);
    return 'pending';
  }

  markEscalated(id: string, error: string): void {
    if (!this.stmtEscalate) return;
    this.stmtEscalate.run(error, new Date().toISOString(), id);
  }

  /**
   * Force-retry an escalated item. Resets attempt_count to 0 and
   * schedules immediate next attempt.
   */
  retry(id: string): boolean {
    if (!this.stmtRetry) return false;
    const result = this.stmtRetry.run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  get(id: string): CompensationQueueItem | null {
    if (!this.stmtGet) return null;
    const row = this.stmtGet.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToItem(row);
  }

  list(opts: { limit?: number; status?: CompensationStatus } = {}): CompensationQueueItem[] {
    if (!this.stmtList) return [];
    const limit = opts.limit ?? 100;
    if (opts.status) {
      // Ad-hoc filtered query
      const rows = this.db!.prepare(
        `SELECT * FROM compensation_queue WHERE status = ? ORDER BY enqueued_at DESC LIMIT ?`,
      ).all(opts.status, limit) as Array<Record<string, unknown>>;
      return rows.map(rowToItem);
    }
    const rows = this.stmtList.all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToItem);
  }

  countByStatus(): Record<CompensationStatus, number> {
    if (!this.stmtCount) return { pending: 0, in_progress: 0, escalated: 0 };
    const rows = this.stmtCount.all() as Array<{ status: string; count: number }>;
    const result: Record<CompensationStatus, number> = { pending: 0, in_progress: 0, escalated: 0 };
    for (const r of rows) {
      if (r.status in result) result[r.status as CompensationStatus] = r.count;
    }
    return result;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
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
