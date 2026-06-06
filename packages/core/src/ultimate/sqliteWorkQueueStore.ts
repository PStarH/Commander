import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { getGlobalLogger } from '../logging';
import type { WorkQueueStore } from './workQueueStore';
import type { WorkItem, WorkStatus } from './workCoordinator';

export interface SqliteWorkQueueStoreConfig {
  filePath: string;
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

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3');
} catch {}

interface WorkRow {
  id: string;
  run_id: string;
  parent_node_id: string;
  goal: string;
  tools_json: string;
  depends_on_json: string;
  status: WorkStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  token_budget: number;
  priority: number;
  created_at: string;
  tenant_id: string | null;
  lease_token: string | null;
  fencing_epoch: number;
}

function rowToItem(row: WorkRow): WorkItem {
  return {
    id: row.id,
    runId: row.run_id,
    parentNodeId: row.parent_node_id,
    goal: row.goal,
    tools: JSON.parse(row.tools_json) as string[],
    dependsOn: JSON.parse(row.depends_on_json) as string[],
    status: row.status,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error ?? undefined,
    tokenBudget: row.token_budget,
    priority: row.priority,
    createdAt: row.created_at,
    leaseToken: row.lease_token ?? undefined,
    fencingEpoch: row.fencing_epoch,
  };
}

function itemToParams(item: WorkItem, tenantId: string | null = null): unknown[] {
  return [
    item.id,
    item.runId,
    item.parentNodeId,
    item.goal,
    JSON.stringify(item.tools),
    JSON.stringify(item.dependsOn),
    item.status,
    item.claimedBy ?? null,
    item.claimedAt ?? null,
    item.completedAt ?? null,
    item.failedAt ?? null,
    item.attempts,
    item.maxAttempts,
    item.lastError ?? null,
    item.tokenBudget,
    item.priority,
    item.createdAt,
    tenantId,
    item.leaseToken ?? null,
    item.fencingEpoch ?? 0,
  ];
}

export class SqliteWorkQueueStore implements WorkQueueStore {
  private db: BetterSqlite3DB | null = null;
  private config: SqliteWorkQueueStoreConfig;

  private stmtLoadAll: BetterSqlite3Stmt | null = null;
  private stmtEnqueue: BetterSqlite3Stmt | null = null;
  private stmtUpdate: BetterSqlite3Stmt | null = null;
  private stmtRemove: BetterSqlite3Stmt | null = null;
  private stmtTryClaim: BetterSqlite3Stmt | null = null;
  private stmtReleaseClaim: BetterSqlite3Stmt | null = null;
  private stmtColumnExists: BetterSqlite3Stmt | null = null;

  constructor(config: SqliteWorkQueueStoreConfig) {
    this.config = config;
    this.openDb();
    this.prepareStatements();
  }

  private openDb(): void {
    if (!BetterSqlite3) {
      throw new Error(
        'SqliteWorkQueueStore requires better-sqlite3. Install it: pnpm add better-sqlite3',
      );
    }
    if (this.config.filePath !== ':memory:') {
      mkdirSync(dirname(this.config.filePath), { recursive: true });
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

  private migrate(): void {
    if (!this.db) return;
    this.stmtColumnExists = this.db.prepare(`PRAGMA table_info(work_items)`);
    const cols = (this.stmtColumnExists.all() as Array<{ name: string }>).map(c => c.name);
    if (!cols.includes('lease_token')) {
      this.db.exec(`ALTER TABLE work_items ADD COLUMN lease_token TEXT`);
    }
    if (!cols.includes('fencing_epoch')) {
      this.db.exec(`ALTER TABLE work_items ADD COLUMN fencing_epoch INTEGER NOT NULL DEFAULT 0`);
    }
    this.stmtColumnExists = null;
  }

  private prepareStatements(): void {
    if (!this.db) return;
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

  loadAll(): WorkItem[] {
    if (!this.db || !this.stmtLoadAll) {
      throw new Error('SqliteWorkQueueStore not initialized');
    }
    const rows = this.stmtLoadAll.all() as WorkRow[];
    return rows.map(rowToItem);
  }

  enqueue(item: WorkItem): void {
    if (!this.db || !this.stmtEnqueue) {
      throw new Error('SqliteWorkQueueStore not initialized');
    }
    this.stmtEnqueue.run(...itemToParams(item));
  }

  update(item: WorkItem): void {
    if (!this.db || !this.stmtUpdate) {
      throw new Error('SqliteWorkQueueStore not initialized');
    }
    this.stmtUpdate.run(
      item.status,
      item.claimedBy ?? null,
      item.claimedAt ?? null,
      item.completedAt ?? null,
      item.failedAt ?? null,
      item.attempts,
      item.lastError ?? null,
      item.leaseToken ?? null,
      item.fencingEpoch ?? 0,
      item.id,
    );
  }

  updateMany(items: WorkItem[]): void {
    if (!this.db || !this.stmtUpdate) {
      throw new Error('SqliteWorkQueueStore not initialized');
    }
    if (!this.db.transaction) {
      for (const item of items) this.update(item);
      return;
    }
    type BatchTx = (fn: (batch: WorkItem[]) => void) => (batch: WorkItem[]) => void;
    const txFn = this.db.transaction as BatchTx;
    const tx = txFn((batch: WorkItem[]) => {
      for (const item of batch) this.update(item);
    });
    tx(items);
  }

  remove(predicate: (item: WorkItem) => boolean): number {
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

  tryClaim(agentId: string, workId: string, leaseToken: string, nowIso: string): boolean {
    if (!this.db || !this.stmtTryClaim) {
      throw new Error('SqliteWorkQueueStore not initialized');
    }
    const result = this.stmtTryClaim.run(agentId, nowIso, leaseToken, workId);
    return result.changes === 1;
  }

  releaseClaim(leaseToken: string): void {
    if (!this.db || !this.stmtReleaseClaim) {
      throw new Error('SqliteWorkQueueStore not initialized');
    }
    this.stmtReleaseClaim.run(leaseToken);
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.stmtLoadAll = null;
    this.stmtEnqueue = null;
    this.stmtUpdate = null;
    this.stmtRemove = null;
    this.stmtTryClaim = null;
    this.stmtReleaseClaim = null;
    this.stmtColumnExists = null;
    getGlobalLogger().debug('SqliteWorkQueueStore', 'closed', { filePath: this.config.filePath });
  }
}
