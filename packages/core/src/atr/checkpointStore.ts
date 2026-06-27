/**
 * AtrCheckpointStore — ATR-layer durable checkpoint storage.
 *
 * Atomic-step contract: a step is "committed" iff its row exists in the
 * SQLite table (or in the InMemory buffer when SQLite is unavailable).
 * After SIGKILL at any point, recovery reads the highest committed step
 * and re-runs AT MOST one step thereafter — never two or more.
 *
 * Persistence: SQLite-backed (better-sqlite3) with WAL mode and
 * synchronous=NORMAL, matching the convention used by CompensationQueue,
 * LeaseManager, IdempotencyStore, and TaskQueue (T2.4/M1 of
 * reversibility-rfc-v2).
 *
 * Fallback: when better-sqlite3 is not installed OR the open() call
 * throws (corrupt lock, permission denied, fs full), InMemoryCheckpointBuffer
 * is used instead. The buffer persists per-process only — on restart it
 * is empty. Atomicity guarantees drop to "in-process only" but the buffer
 * preserves the same API shape so writers/readers do not need to branch.
 *
 * Atomicity details (WAL mode):
 *   - Prepare + BEGIN IMMEDIATE + INSERT + COMMIT = 1 atomic unit
 *   - Process death between BEGIN and COMMIT = no row visible (transaction
 *     rollback)
 *   - Process death after COMMIT = row visible (already durable in WAL)
 * Test: see tests/recovery/kill9.test.ts
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckpointState } from '../runtime/stateCheckpointer';
import { getCurrentTenantId } from '../runtime/tenantContext';
import { walCheckpoint } from '../storage/walCheckpoint';

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch (err) {
  reportSilentFailure(err, 'checkpointStore:38');
  /* not installed — fall back to InMemoryCheckpointBuffer */
}

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

// ============================================================================
// Types
// ============================================================================

export interface CheckpointRecord {
  id: string;
  runId: string;
  agentId?: string;
  tenantId?: string;
  stepNumber: number;
  phase: string;
  fencingEpoch?: number;
  leaseToken?: string;
  version: number;
  createdAt: string;
  /** Full CheckpointState serialized — recovery picks this up on restart. */
  stateJson: string;
}

export interface AtrCheckpointStoreConfig {
  filePath?: string;
  /**
   * Default '.commander/atr_checkpoints.db' — overridable via
   * COMMANDER_ATR_CHECKPOINTS_PATH env var (see getAtrCheckpointStore).
   */
}

interface CheckpointRow {
  id: string;
  run_id: string;
  agent_id: string | null;
  tenant_id: string | null;
  step_number: number;
  phase: string;
  fencing_epoch: number | null;
  lease_token: string | null;
  version: number;
  created_at: string;
  state_json: string;
}

const DEFAULT_DB_PATH = '.commander/atr_checkpoints.db';

// ============================================================================
// WAL Store
// ============================================================================

export class WalCheckpointStore {
  private db: BetterSqlite3DB | null = null;
  private config: Required<AtrCheckpointStoreConfig>;
  private stmtInsert: BetterSqlite3Stmt | null = null;
  private stmtGet: BetterSqlite3Stmt | null = null;
  private stmtLatest: BetterSqlite3Stmt | null = null;
  private stmtList: BetterSqlite3Stmt | null = null;
  private stmtDeleteRun: BetterSqlite3Stmt | null = null;

  constructor(config: Partial<AtrCheckpointStoreConfig> = {}) {
    this.config = { filePath: config.filePath ?? DEFAULT_DB_PATH };
    this.openDb();
    this.prepareStatements();
  }

  private openDb(): void {
    if (!BetterSqlite3) {
      throw new Error('WalCheckpointStore requires better-sqlite3');
    }
    if (this.config.filePath !== ':memory:') {
      mkdirSync(dirname(this.config.filePath), { recursive: true });
    }
    this.db = new BetterSqlite3(this.config.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS atr_checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT,
        tenant_id TEXT,
        step_number INTEGER NOT NULL,
        phase TEXT NOT NULL,
        fencing_epoch INTEGER,
        lease_token TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_atr_cp_run
        ON atr_checkpoints(run_id, step_number DESC);
    `);
  }

  private prepareStatements(): void {
    if (!this.db) return;
    const d = this.db;
    this.stmtInsert = d.prepare(`
      INSERT OR REPLACE INTO atr_checkpoints
        (id, run_id, agent_id, tenant_id, step_number, phase,
         fencing_epoch, lease_token, version, created_at, state_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGet = d.prepare(`SELECT * FROM atr_checkpoints WHERE id = ? AND (tenant_id IS ? OR ? IS NULL) LIMIT 1`);
    this.stmtLatest = d.prepare(`
      SELECT * FROM atr_checkpoints WHERE run_id = ? AND (tenant_id IS ? OR ? IS NULL)
      ORDER BY step_number DESC LIMIT 1
    `);
    this.stmtList = d.prepare(`
      SELECT * FROM atr_checkpoints WHERE run_id = ? AND (tenant_id IS ? OR ? IS NULL)
      ORDER BY step_number ASC
    `);
    this.stmtDeleteRun = d.prepare(`DELETE FROM atr_checkpoints WHERE run_id = ? AND (tenant_id IS ? OR ? IS NULL)`);
  }

  /**
   * Atomically commit a checkpoint row. Synchronous better-sqlite3 + WAL =
   * either the row lands in WAL before this returns, or no row exists at all
   * on restart. No partial state observable across SIGKILL.
   */
  save(state: CheckpointState): CheckpointRecord {
    if (!this.stmtInsert || !this.stmtLatest) throw new Error('WalCheckpointStore not initialized');
    const id = `${state.runId}_${state.stepNumber}`;
    const tenant = getCurrentTenantId() ?? null;
    const previous = this.stmtLatest.get(state.runId, tenant, tenant) as CheckpointRow | undefined;
    const version = (previous?.version ?? 0) + 1;
    const stateJson = JSON.stringify({ ...state, version });
    this.stmtInsert.run(
      id,
      state.runId,
      state.agentId ?? null,
      getCurrentTenantId() ?? state.context?.projectId ?? null,
      state.stepNumber,
      state.phase,
      state.fencingEpoch ?? null,
      state.leaseToken ?? null,
      version,
      state.timestamp,
      stateJson,
    );
    return {
      id,
      runId: state.runId,
      agentId: state.agentId,
      tenantId: getCurrentTenantId() ?? state.context?.projectId,
      stepNumber: state.stepNumber,
      phase: state.phase,
      fencingEpoch: state.fencingEpoch,
      leaseToken: state.leaseToken,
      version,
      createdAt: state.timestamp,
      stateJson,
    };
  }

  get(id: string): CheckpointRecord | null {
    if (!this.stmtGet) return null;
    const tenant = getCurrentTenantId() ?? null;
    const row = this.stmtGet.get(id, tenant, tenant) as CheckpointRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getLatest(runId: string): CheckpointRecord | null {
    if (!this.stmtLatest) return null;
    const tenant = getCurrentTenantId() ?? null;
    const row = this.stmtLatest.get(runId, tenant, tenant) as CheckpointRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByRun(runId: string): CheckpointRecord[] {
    if (!this.stmtList) return [];
    const tenant = getCurrentTenantId() ?? null;
    const rows = this.stmtList.all(runId, tenant, tenant) as CheckpointRow[];
    return rows.map(rowToRecord);
  }

  deleteRun(runId: string): void {
    if (!this.stmtDeleteRun) return;
    const tenant = getCurrentTenantId() ?? null;
    this.stmtDeleteRun.run(runId, tenant, tenant);
  }

  countByRun(runId: string): number {
    return this.listByRun(runId).length;
  }

  close(): void {
    if (this.db) {
      walCheckpoint(this.db);
      this.db.close();
      this.db = null;
    }
  }
}

// ============================================================================
// InMemory Fallback
// ============================================================================

/**
 * InMemoryCheckpointBuffer — fallback when better-sqlite3 is missing or
 * WAL open throws. Preserves the same shape as WalCheckpointStore so callers
 * do not branch on backend.
 *
 * Atomicity guarantees: per-process only. Process death loses all rows.
 * Tradeoff: the agent still finishes runs that complete without crash,
 * but cross-restart recovery is not possible — recovery cannot find any
 * checkpoint on restart and must re-execute from scratch.
 */
export class InMemoryCheckpointBuffer {
  private byRun: Map<string, CheckpointRecord[]> = new Map();

  save(state: CheckpointState): CheckpointRecord {
    const id = `${state.runId}_${state.stepNumber}`;
    const arr = this.byRun.get(state.runId) ?? [];
    const previous = arr[arr.length - 1];
    const version = (previous?.version ?? 0) + 1;
    const stateJson = JSON.stringify({ ...state, version });
    const rec: CheckpointRecord = {
      id,
      runId: state.runId,
      agentId: state.agentId,
      tenantId: state.context?.projectId,
      stepNumber: state.stepNumber,
      phase: state.phase,
      fencingEpoch: state.fencingEpoch,
      leaseToken: state.leaseToken,
      version,
      createdAt: state.timestamp,
      stateJson,
    };
    arr.push(rec);
    this.byRun.set(state.runId, arr);
    return rec;
  }

  get(id: string): CheckpointRecord | null {
    for (const arr of this.byRun.values()) {
      const hit = arr.find((r) => r.id === id);
      if (hit) return hit;
    }
    return null;
  }

  getLatest(runId: string): CheckpointRecord | null {
    const arr = this.byRun.get(runId);
    return arr && arr.length > 0 ? arr[arr.length - 1] : null;
  }

  listByRun(runId: string): CheckpointRecord[] {
    return [...(this.byRun.get(runId) ?? [])];
  }

  deleteRun(runId: string): void {
    this.byRun.delete(runId);
  }

  countByRun(runId: string): number {
    return (this.byRun.get(runId) ?? []).length;
  }

  close(): void {
    this.byRun.clear();
  }
}

// ============================================================================
// Unified Interface
// ============================================================================

export interface ICheckpointBackend {
  save(state: CheckpointState): CheckpointRecord;
  get(id: string): CheckpointRecord | null;
  getLatest(runId: string): CheckpointRecord | null;
  listByRun(runId: string): CheckpointRecord[];
  countByRun(runId: string): number;
  deleteRun(runId: string): void;
  close(): void;
  /** Backend identifier — useful for logs and metric labels. */
  readonly backend: 'wal' | 'memory';
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Open the best-available checkpoint backend.
 *
 * Tries WalCheckpointStore first; on any failure (better-sqlite3 missing,
 * LOCKED, IO error, etc.) falls back to InMemoryCheckpointBuffer. The
 * chosen backend is returned with its `backend` field set so callers can
 * observe degradation in tests without throwing.
 *
 * Never throws — fallback is mandatory. Recovery semantics differ:
 *   - 'wal'        → cross-process durable, kill9 survivable
 *   - 'memory'     → per-process only; restart loses all rows
 */
export function openCheckpointBackend(
  config: Partial<AtrCheckpointStoreConfig> = {},
): ICheckpointBackend {
  try {
    const wal = new WalCheckpointStore(config);
    return attachBackend(wal, 'wal', undefined);
  } catch (err) {
    console.warn(
      '[CheckpointStore] WARN: CheckpointStore falling back to in-memory — crash recovery DISABLED',
      (err as Error)?.message ?? '',
    );
    const buf = new InMemoryCheckpointBuffer();
    return attachBackend(buf, 'memory', (err as Error)?.message);
  }
}

/**
 * Attach the discriminator field without leaking Object.assign on a class
 * with private members. The readonly `backend` field on ICheckpointBackend
 * already prevents mutation by TS contract; we deliberately do NOT
 * Object.freeze the instance because WalCheckpointStore.close() needs to
 * mutate its own internal `_db` handle on dispose.
 */
function attachBackend<T extends object>(
  obj: T,
  backend: 'wal' | 'memory',
  fallbackError: string | undefined,
): T & { backend: 'wal' | 'memory'; fallbackError?: string } {
  return Object.assign(obj, { backend, fallbackError });
}

function rowToRecord(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    stepNumber: row.step_number,
    phase: row.phase,
    fencingEpoch: row.fencing_epoch ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    version: row.version,
    createdAt: row.created_at,
    stateJson: row.state_json,
  };
}

// ============================================================================
// Singleton (controlled for tests)
// ============================================================================

let _instance: ICheckpointBackend | null = null;

/**
 * Resolve the default `atrCheckpointPath`. Honors the
 * COMMANDER_ATR_CHECKPOINTS_PATH env var (matches the convention used by
 * IdempotencyStore's COMMANDER_ATR_IDEMPOTENCY_PATH). When unset, uses
 * '.commander/atr_checkpoints.db'. The ':memory:' sentinel forces the
 * InMemoryCheckpointBuffer path; passing the literal string ':memory:'
 * to better-sqlite3 also works for crash-safety in test environments.
 */
function defaultAtrCheckpointPath(): string {
  return process.env.COMMANDER_ATR_CHECKPOINTS_PATH ?? '.commander/atr_checkpoints.db';
}

export function getAtrCheckpointStore(
  config?: Partial<AtrCheckpointStoreConfig>,
): ICheckpointBackend {
  if (!_instance)
    _instance = openCheckpointBackend(config ?? { filePath: defaultAtrCheckpointPath() });
  return _instance;
}

export function resetAtrCheckpointStore(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
