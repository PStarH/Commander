/**
 * CheckpointStore — SQLite-backed persistent checkpoint storage.
 *
 * Serves as the persistence backend for both CheckpointManager
 * (conversation backtracking) and StateCheckpointer (execution state).
 *
 * Schema:
 *   checkpoints           — One row per checkpoint with metadata flex-column
 *   checkpoint_messages   — Ordered messages per checkpoint (CASCADE delete)
 *   checkpoint_files      — File read/modified tracking (CASCADE delete)
 *
 * Matches sqliteWorkQueueStore.ts conventions:
 *   - Lazy require('better-sqlite3') with try/catch
 *   - PRAGMA journal_mode = WAL, synchronous = NORMAL
 *   - Prepared statements at init, migrations via PRAGMA table_info
 *   - Transactions for multi-table writes
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getGlobalLogger } from '../logging';
import type { LLMMessage } from './types/llm';
import { walCheckpoint } from '../storage/walCheckpoint';
import { getCurrentTenantId } from './tenantContext';

// ============================================================================
// SQLite Interface Types
// ============================================================================

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
  BetterSqlite3 = require('better-sqlite3');
} catch (err) {
  reportSilentFailure(err, 'checkpointStore:48');
  /* better-sqlite3 not installed — operations throw at runtime */
}

// ============================================================================
// Public Types
// ============================================================================

export interface CheckpointRecord {
  id: string;
  runId: string;
  label: string;
  phase?: string;
  stepNumber: number;
  tokenCount: number;
  agentId?: string;
  tenantId?: string;
  createdAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  version: number;
}

export interface CheckpointSnapshot {
  checkpoint: CheckpointRecord;
  messages: LLMMessage[];
  filesRead: string[];
  filesModified: string[];
}

export interface CheckpointSummary {
  id: string;
  runId: string;
  label: string;
  phase?: string;
  stepNumber: number;
  tokenCount: number;
  messageCount: number;
  createdAt: string;
}

export interface CheckpointStoreConfig {
  filePath: string;
  maxPerRun?: number;
}

// ============================================================================
// Row Types
// ============================================================================

interface CheckpointRow {
  id: string;
  run_id: string;
  label: string;
  phase: string | null;
  step_number: number;
  token_count: number;
  agent_id: string | null;
  tenant_id: string | null;
  created_at: string;
  expires_at: string | null;
  metadata_json: string | null;
  version: number;
}

interface MessageRow {
  checkpoint_id: string;
  msg_index: number;
  role: string;
  content: string | null;
  tool_calls_json: string | null;
}

interface FileRow {
  checkpoint_id: string;
  path: string;
  type: string;
}

// ============================================================================
// CheckpointStore
// ============================================================================

export class CheckpointStore {
  private db: BetterSqlite3DB | null = null;
  private config: CheckpointStoreConfig;
  private initialized = false;

  private stmtInsertCheckpoint!: BetterSqlite3Stmt;
  private stmtInsertMessage!: BetterSqlite3Stmt;
  private stmtInsertFile!: BetterSqlite3Stmt;
  private stmtGetCheckpoint!: BetterSqlite3Stmt;
  private stmtGetMessages!: BetterSqlite3Stmt;
  private stmtGetFiles!: BetterSqlite3Stmt;
  private stmtListByRun!: BetterSqlite3Stmt;
  private stmtLatestByRun!: BetterSqlite3Stmt;
  private stmtDeleteRun!: BetterSqlite3Stmt;
  private stmtDeleteMessages!: BetterSqlite3Stmt;
  private stmtDeleteFiles!: BetterSqlite3Stmt;
  private stmtCountByRun!: BetterSqlite3Stmt;
  private stmtDeleteExpired!: BetterSqlite3Stmt;
  private stmtDeleteAfter!: BetterSqlite3Stmt;
  private stmtPruneRun!: BetterSqlite3Stmt;
  private stmtPruneColumnInfo!: BetterSqlite3Stmt;

  constructor(config: CheckpointStoreConfig) {
    this.config = {
      maxPerRun: 50,
      ...config,
    };
    this.openDb();
    this.createSchema();
    this.prepareStatements();
    this.initialized = true;
  }

  // ========================================================================
  // Initialization
  // ========================================================================

  private openDb(): void {
    if (!BetterSqlite3) {
      throw new Error(
        'CheckpointStore requires better-sqlite3. Install it: pnpm add better-sqlite3',
      );
    }
    if (this.config.filePath !== ':memory:') {
      mkdirSync(dirname(this.config.filePath), { recursive: true });
    }
    this.db = new BetterSqlite3(this.config.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  private createSchema(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        label TEXT NOT NULL,
        phase TEXT,
        step_number INTEGER NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT,
        tenant_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        metadata_json TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_cp_run
        ON checkpoints(run_id, step_number DESC);
      CREATE INDEX IF NOT EXISTS idx_cp_tenant
        ON checkpoints(tenant_id) WHERE tenant_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_cp_expires
        ON checkpoints(expires_at) WHERE expires_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS checkpoint_messages (
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
        msg_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls_json TEXT,
        PRIMARY KEY (checkpoint_id, msg_index)
      );

      CREATE TABLE IF NOT EXISTS checkpoint_files (
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('read', 'modified')),
        PRIMARY KEY (checkpoint_id, path)
      );
    `);
    this.migrate();
  }

  private migrate(): void {
    if (!this.db) return;
    /* Column-based migrations via PRAGMA table_info — add ALTER TABLE below */
  }

  private prepareStatements(): void {
    if (!this.db) return;
    const d = this.db;

    this.stmtInsertCheckpoint = d.prepare(`
      INSERT OR REPLACE INTO checkpoints
        (id, run_id, label, phase, step_number, token_count,
         agent_id, tenant_id, created_at, expires_at, metadata_json, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertMessage = d.prepare(`
      INSERT OR REPLACE INTO checkpoint_messages
        (checkpoint_id, msg_index, role, content, tool_calls_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtInsertFile = d.prepare(`
      INSERT OR REPLACE INTO checkpoint_files
        (checkpoint_id, path, type)
      VALUES (?, ?, ?)
    `);

    this.stmtGetCheckpoint = d.prepare(`
      SELECT id, run_id, label, phase, step_number, token_count,
             agent_id, tenant_id, created_at, expires_at, metadata_json, version
      FROM checkpoints WHERE id = ? AND (tenant_id IS ? OR ? IS NULL)
    `);

    this.stmtGetMessages = d.prepare(`
      SELECT checkpoint_id, msg_index, role, content, tool_calls_json
      FROM checkpoint_messages
      WHERE checkpoint_id = ?
      ORDER BY msg_index ASC
    `);

    this.stmtGetFiles = d.prepare(`
      SELECT checkpoint_id, path, type
      FROM checkpoint_files
      WHERE checkpoint_id = ?
    `);

    this.stmtListByRun = d.prepare(`
      SELECT c.id, c.run_id, c.label, c.phase, c.step_number, c.token_count,
             c.created_at,
             (SELECT COUNT(*) FROM checkpoint_messages m WHERE m.checkpoint_id = c.id) AS message_count
      FROM checkpoints c
      WHERE c.run_id = ? AND (c.tenant_id IS ? OR ? IS NULL)
      ORDER BY c.step_number DESC
    `);

    this.stmtLatestByRun = d.prepare(`
      SELECT id, run_id, label, phase, step_number, token_count,
             agent_id, tenant_id, created_at, expires_at, metadata_json, version
      FROM checkpoints
      WHERE run_id = ? AND (tenant_id IS ? OR ? IS NULL)
      ORDER BY step_number DESC
      LIMIT 1
    `);

    this.stmtDeleteRun = d.prepare(
      `DELETE FROM checkpoints WHERE run_id = ? AND (tenant_id IS ? OR ? IS NULL)`,
    );

    this.stmtDeleteMessages = d.prepare(`DELETE FROM checkpoint_messages WHERE checkpoint_id = ?`);

    this.stmtDeleteFiles = d.prepare(`DELETE FROM checkpoint_files WHERE checkpoint_id = ?`);

    this.stmtCountByRun = d.prepare(
      `SELECT COUNT(*) AS cnt FROM checkpoints WHERE run_id = ? AND (tenant_id IS ? OR ? IS NULL)`,
    );

    this.stmtDeleteAfter = d.prepare(`
      DELETE FROM checkpoints
      WHERE run_id = ? AND step_number >= ? AND id != ? AND (tenant_id IS ? OR ? IS NULL)
    `);

    this.stmtPruneRun = d.prepare(`
      DELETE FROM checkpoints
      WHERE id IN (
        SELECT id FROM checkpoints
        WHERE run_id = ? AND (tenant_id IS ? OR ? IS NULL)
        ORDER BY step_number ASC
        LIMIT ?
      )
    `);

    this.stmtDeleteExpired = d.prepare(
      `DELETE FROM checkpoints WHERE expires_at IS NOT NULL AND expires_at < ?`,
    );
  }

  // ========================================================================
  // Public API
  // ========================================================================

  save(snapshot: CheckpointSnapshot): CheckpointRecord {
    if (!this.db) throw new Error('CheckpointStore not initialized');

    const { checkpoint, messages, filesRead, filesModified } = snapshot;

    const tenant = getCurrentTenantId() ?? null;
    const latest = this.stmtLatestByRun.get<CheckpointRow>(checkpoint.runId, tenant, tenant);
    const version = (latest?.version ?? 0) + 1;

    const txFn = this.db.transaction(() => {
      this.stmtInsertCheckpoint.run(
        checkpoint.id,
        checkpoint.runId,
        checkpoint.label,
        checkpoint.phase ?? null,
        checkpoint.stepNumber,
        checkpoint.tokenCount,
        checkpoint.agentId ?? null,
        checkpoint.tenantId ?? null,
        checkpoint.createdAt,
        checkpoint.expiresAt ?? null,
        checkpoint.metadata ? JSON.stringify(checkpoint.metadata) : null,
        version,
      );

      this.stmtDeleteMessages.run(checkpoint.id);
      this.stmtDeleteFiles.run(checkpoint.id);

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        this.stmtInsertMessage.run(
          checkpoint.id,
          i,
          msg.role,
          msg.content ?? null,
          msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        );
      }

      for (const f of filesRead) {
        this.stmtInsertFile.run(checkpoint.id, f, 'read');
      }
      for (const f of filesModified) {
        this.stmtInsertFile.run(checkpoint.id, f, 'modified');
      }
    });

    txFn();
    this.pruneRun(checkpoint.runId, this.config.maxPerRun!);

    return { ...checkpoint, version };
  }

  getCheckpoint(id: string): CheckpointRecord | null {
    if (!this.db) throw new Error('CheckpointStore not initialized');
    const tenant = getCurrentTenantId() ?? null;
    const row = this.stmtGetCheckpoint.get<CheckpointRow>(id, tenant, tenant);
    return row ? this.rowToRecord(row) : null;
  }

  getSnapshot(id: string): CheckpointSnapshot | null {
    if (!this.db) throw new Error('CheckpointStore not initialized');

    const tenant = getCurrentTenantId() ?? null;
    const row = this.stmtGetCheckpoint.get<CheckpointRow>(id, tenant, tenant);
    if (!row) return null;

    const messages = this.stmtGetMessages.all<MessageRow>(id).map((m) => this.rowToMessage(m));
    const files = this.stmtGetFiles.all<FileRow>(id);
    const filesRead = files.filter((f) => f.type === 'read').map((f) => f.path);
    const filesModified = files.filter((f) => f.type === 'modified').map((f) => f.path);

    return {
      checkpoint: this.rowToRecord(row),
      messages,
      filesRead,
      filesModified,
    };
  }

  listByRun(runId: string): CheckpointSummary[] {
    if (!this.db) throw new Error('CheckpointStore not initialized');

    const tenant = getCurrentTenantId() ?? null;
    const rows = this.stmtListByRun.all<CheckpointRow & { message_count: number }>(
      runId,
      tenant,
      tenant,
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      label: r.label,
      phase: r.phase ?? undefined,
      stepNumber: r.step_number,
      tokenCount: r.token_count,
      messageCount: r.message_count,
      createdAt: r.created_at,
    }));
  }

  getLatestByRun(runId: string): CheckpointRecord | null {
    if (!this.db) throw new Error('CheckpointStore not initialized');
    const tenant = getCurrentTenantId() ?? null;
    const row = this.stmtLatestByRun.get<CheckpointRow>(runId, tenant, tenant);
    return row ? this.rowToRecord(row) : null;
  }

  rewindTo(id: string): LLMMessage[] | null {
    if (!this.db) throw new Error('CheckpointStore not initialized');

    const tenant = getCurrentTenantId() ?? null;
    const row = this.stmtGetCheckpoint.get<CheckpointRow>(id, tenant, tenant);
    if (!row) return null;

    const txFn = this.db.transaction(() => {
      this.stmtDeleteAfter.run(row.run_id, row.step_number, id, tenant, tenant);
    });
    txFn();

    const messages = this.stmtGetMessages.all<MessageRow>(id).map((m) => this.rowToMessage(m));
    return messages;
  }

  deleteRun(runId: string): void {
    if (!this.db) throw new Error('CheckpointStore not initialized');
    const tenant = getCurrentTenantId() ?? null;
    this.stmtDeleteRun.run(runId, tenant, tenant);
  }

  pruneRun(runId: string, keepCount: number): void {
    if (!this.db) return;
    const tenant = getCurrentTenantId() ?? null;
    const row = this.stmtCountByRun.get<{ cnt: number }>(runId, tenant, tenant);
    if (!row || row.cnt <= keepCount) return;
    this.stmtPruneRun.run(runId, tenant, tenant, row.cnt - keepCount);
  }

  deleteExpired(): number {
    if (!this.db) return 0;
    const result = this.stmtDeleteExpired.run(new Date().toISOString());
    return result.changes;
  }

  isHealthy(): boolean {
    if (!this.db) return false;
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch (err) {
      reportSilentFailure(err, 'checkpointStore:461');
      return false;
    }
  }

  close(): void {
    if (this.db) {
      walCheckpoint(this.db);
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
    getGlobalLogger().debug('CheckpointStore', 'closed', {
      filePath: this.config.filePath,
    });
  }

  // ========================================================================
  // Internal Helpers
  // ========================================================================

  private rowToRecord(row: CheckpointRow): CheckpointRecord {
    return {
      id: row.id,
      runId: row.run_id,
      label: row.label,
      phase: row.phase ?? undefined,
      stepNumber: row.step_number,
      tokenCount: row.token_count,
      agentId: row.agent_id ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      version: row.version,
    };
  }

  private rowToMessage(row: MessageRow): LLMMessage {
    const msg: LLMMessage = {
      role: row.role as LLMMessage['role'],
      content: row.content ?? '',
    };
    if (row.tool_calls_json) {
      try {
        msg.tool_calls = JSON.parse(row.tool_calls_json);
      } catch (err) {
        reportSilentFailure(err, 'checkpointStore:508');
        /* skip malformed tool_calls */
      }
    }
    return msg;
  }
}

// ============================================================================
// Factory Helpers
// ============================================================================

const storeInstances = new Map<string, CheckpointStore>();

export function getCheckpointStore(filePath: string): CheckpointStore {
  if (!storeInstances.has(filePath)) {
    storeInstances.set(filePath, new CheckpointStore({ filePath }));
  }
  return storeInstances.get(filePath)!;
}

export function resetCheckpointStores(): void {
  for (const store of storeInstances.values()) {
    try {
      store.close();
    } catch (err) {
      reportSilentFailure(err, 'checkpointStore:534');
      /* best-effort */
    }
  }
  storeInstances.clear();
}
