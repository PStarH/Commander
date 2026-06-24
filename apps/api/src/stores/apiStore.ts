import { reportSilentFailure } from '@commander/core';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), '.commander', 'api_state.db');

export type ApiStoreBackend = 'sqlite' | 'memory';

export interface ApiTaskRow {
  id: string;
  client_id: string;
  agent_id: string | null;
  description: string;
  priority: string;
  status: string;
  input_json: string;
  artifact_id: string | null;
  progress: number;
  error: string | null;
  messages_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface ApiArtifactRow {
  id: string;
  task_id: string;
  content_type: string;
  content: string;
  url: string | null;
  metadata_json: string;
  created_at: string;
}

export interface ApiCheckpointRow {
  id: string;
  mission_id: string | null;
  task_id: string;
  type: string;
  status: string;
  risk_score: number;
  risk_level: string;
  required_approvals_json: string;
  current_approvals_json: string;
  created_at: string;
  expires_at: string | null;
  approved_at: string | null;
  fallback_action: string;
  context_json: string;
}

export interface ApiCheckpointConfigRow {
  mission_id: string;
  mode: string;
  risk_threshold: number | null;
  approvers_json: string;
  timeout: number | null;
  fallback_on_timeout: string;
}

export interface SqliteApiStore {
  readonly backend: ApiStoreBackend;
  readonly dbPath: string;
  close(): void;
  listTasksByStatus(status: string): ApiTaskRow[];
  listTasksByClient(clientId: string): ApiTaskRow[];
  listTasksByAgent(agentId: string): ApiTaskRow[];
  listAllTasks(): ApiTaskRow[];
  getTask(id: string): ApiTaskRow | null;
  putTask(row: ApiTaskRow): ApiTaskRow;
  deleteTask(id: string): void;
  getArtifact(id: string): ApiArtifactRow | null;
  putArtifact(row: ApiArtifactRow): ApiArtifactRow;
  getArtifactsByTask(taskId: string): ApiArtifactRow[];
  getCheckpoint(id: string): ApiCheckpointRow | null;
  putCheckpoint(row: ApiCheckpointRow): ApiCheckpointRow;
  listCheckpoints(missionId?: string): ApiCheckpointRow[];
  getPendingCheckpointsForApprover(approverId: string): ApiCheckpointRow[];
  getPendingCheckpointsByMission(missionId: string): ApiCheckpointRow[];
  approveCheckpoint(
    checkpointId: string,
    reviewerId: string,
    reason?: string,
    conditions?: string[],
  ): ApiCheckpointRow | null;
  rejectCheckpoint(
    checkpointId: string,
    reviewerId: string,
    reason: string,
  ): ApiCheckpointRow | null;
  expireCheckpoints(now: Date): ApiCheckpointRow[];
  addCheckpointEvidence(
    checkpointId: string,
    evidence: { type: string; timestamp: string; content: string; source: string },
  ): ApiCheckpointRow | null;
  getCheckpointConfig(missionId: string): ApiCheckpointConfigRow | null;
  putCheckpointConfig(row: ApiCheckpointConfigRow): ApiCheckpointConfigRow;
  getCheckpointStats(missionId?: string): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    mandatoryCount: number;
    conditionalCount: number;
    automaticCount: number;
    averageApprovalTime: number | null;
  };
  cleanup(): void;
}

function createMemoryApiStore(dbPath: string): SqliteApiStore {
  const tasks = new Map<string, ApiTaskRow>();
  const artifacts = new Map<string, ApiArtifactRow>();
  const checkpoints = new Map<string, ApiCheckpointRow>();
  const configs = new Map<string, ApiCheckpointConfigRow>();

  const store: SqliteApiStore = {
    backend: 'memory',
    dbPath,
    close() {},
    listTasksByStatus(status: string) {
      return Array.from(tasks.values()).filter((t) => t.status === status);
    },
    listTasksByClient(clientId: string) {
      return Array.from(tasks.values()).filter((t) => t.client_id === clientId);
    },
    listTasksByAgent(agentId: string) {
      return Array.from(tasks.values()).filter((t) => t.agent_id === agentId);
    },
    listAllTasks() {
      return Array.from(tasks.values());
    },
    getTask(id: string) {
      return tasks.get(id) ?? null;
    },
    putTask(row: ApiTaskRow) {
      tasks.set(row.id, row);
      return row;
    },
    deleteTask(id: string) {
      tasks.delete(id);
    },
    getArtifact(id: string) {
      return artifacts.get(id) ?? null;
    },
    putArtifact(row: ApiArtifactRow) {
      artifacts.set(row.id, row);
      return row;
    },
    getArtifactsByTask(taskId: string) {
      return Array.from(artifacts.values()).filter((a) => a.task_id === taskId);
    },
    getCheckpoint(id: string) {
      return checkpoints.get(id) ?? null;
    },
    putCheckpoint(row: ApiCheckpointRow) {
      checkpoints.set(row.id, row);
      return row;
    },
    listCheckpoints(missionId?: string) {
      const rows = Array.from(checkpoints.values());
      if (!missionId) return rows;
      return rows.filter((c) => c.mission_id === missionId);
    },
    getPendingCheckpointsForApprover(approverId: string) {
      return Array.from(checkpoints.values()).filter((c) => {
        if (c.status !== 'pending') return false;
        let required: string[] = [];
        try {
          required = JSON.parse(c.required_approvals_json);
        } catch (err) {
          reportSilentFailure(err, 'apiStore:174');
          required = [];
        }
        return required.includes(approverId);
      });
    },
    getPendingCheckpointsByMission(missionId: string) {
      return Array.from(checkpoints.values()).filter(
        (c) => c.mission_id === missionId && c.status === 'pending',
      );
    },
    approveCheckpoint(
      checkpointId: string,
      reviewerId: string,
      reason?: string,
      conditions?: string[],
    ) {
      const checkpoint = checkpoints.get(checkpointId);
      if (!checkpoint) return null;
      const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
      approvals.push({
        approved: true,
        reviewerId,
        reviewedAt: new Date().toISOString(),
        reason,
        conditions,
      });
      const required = JSON.parse(checkpoint.required_approvals_json || '[]');
      checkpoint.current_approvals_json = JSON.stringify(approvals);
      if (approvals.length >= required.length) {
        checkpoint.status = 'approved';
        checkpoint.approved_at = new Date().toISOString();
      }
      checkpoints.set(checkpointId, checkpoint);
      return checkpoint;
    },
    rejectCheckpoint(checkpointId: string, reviewerId: string, reason: string) {
      const checkpoint = checkpoints.get(checkpointId);
      if (!checkpoint) return null;
      const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
      approvals.push({ approved: false, reviewerId, reviewedAt: new Date().toISOString(), reason });
      checkpoint.current_approvals_json = JSON.stringify(approvals);
      checkpoint.status = 'rejected';
      checkpoints.set(checkpointId, checkpoint);
      return checkpoint;
    },
    expireCheckpoints(now: Date) {
      const expired: ApiCheckpointRow[] = [];
      for (const checkpoint of checkpoints.values()) {
        if (checkpoint.status !== 'pending' || !checkpoint.expires_at) continue;
        if (new Date(checkpoint.expires_at) < now) {
          checkpoint.status = checkpoint.fallback_action === 'proceed' ? 'approved' : 'expired';
          if (checkpoint.status === 'approved') checkpoint.approved_at = new Date().toISOString();
          checkpoints.set(checkpoint.id, checkpoint);
          expired.push(checkpoint);
        }
      }
      return expired;
    },
    addCheckpointEvidence(
      checkpointId: string,
      evidence: { type: string; timestamp: string; content: string; source: string },
    ) {
      const checkpoint = checkpoints.get(checkpointId);
      if (!checkpoint) return null;
      const context = JSON.parse(checkpoint.context_json || '{}');
      context.evidence = context.evidence || [];
      context.evidence.push(evidence);
      checkpoint.context_json = JSON.stringify(context);
      checkpoints.set(checkpoint.id, checkpoint);
      return checkpoint;
    },
    getCheckpointConfig(missionId: string) {
      return configs.get(missionId) ?? null;
    },
    putCheckpointConfig(row: ApiCheckpointConfigRow) {
      configs.set(row.mission_id, row);
      return row;
    },
    getCheckpointStats(missionId?: string) {
      const rows = missionId ? checkpointsForMission(missionId) : Array.from(checkpoints.values());
      return statsFromRows(rows);
    },
    cleanup() {
      tasks.clear();
      artifacts.clear();
      checkpoints.clear();
      configs.clear();
    },
  };
  return store;
}

function createSqliteApiStore(dbPath: string): SqliteApiStore {
  let Database: new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
      all<T = Record<string, unknown>>(...params: unknown[]): T[];
    };
    pragma(pragma: string): unknown;
    close(): void;
  };
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    reportSilentFailure(err, 'apiStore:281');
    throw new Error(
      'SqliteApiStore requires "better-sqlite3". Install it with: pnpm add better-sqlite3',
    );
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tasks (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      agent_id TEXT,
      description TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      input_json TEXT NOT NULL DEFAULT '{}',
      artifact_id TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      messages_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content TEXT NOT NULL,
      url TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_governance_checkpoints (
      id TEXT PRIMARY KEY,
      mission_id TEXT,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      risk_score INTEGER NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL DEFAULT 'LOW',
      required_approvals_json TEXT NOT NULL DEFAULT '[]',
      current_approvals_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      approved_at TEXT,
      fallback_action TEXT NOT NULL DEFAULT 'abort',
      context_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS api_governance_configs (
      mission_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      risk_threshold INTEGER,
      approvers_json TEXT NOT NULL DEFAULT '[]',
      timeout INTEGER,
      fallback_on_timeout TEXT NOT NULL DEFAULT 'abort'
    );

    CREATE INDEX IF NOT EXISTS idx_api_tasks_status ON api_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_api_tasks_client ON api_tasks(client_id);
    CREATE INDEX IF NOT EXISTS idx_api_tasks_agent ON api_tasks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_api_artifacts_task ON api_artifacts(task_id);
    CREATE INDEX IF NOT EXISTS idx_api_ck_mission ON api_governance_checkpoints(mission_id);
    CREATE INDEX IF NOT EXISTS idx_api_ck_status ON api_governance_checkpoints(status);
  `);

  const stmtListByStatus = db.prepare(
    `SELECT * FROM api_tasks WHERE status = ? ORDER BY created_at ASC`,
  );
  const stmtListByClient = db.prepare(
    `SELECT * FROM api_tasks WHERE client_id = ? ORDER BY created_at ASC`,
  );
  const stmtListByAgent = db.prepare(
    `SELECT * FROM api_tasks WHERE agent_id = ? ORDER BY created_at ASC`,
  );
  const stmtListAll = db.prepare(`SELECT * FROM api_tasks ORDER BY created_at ASC`);
  const stmtGetTask = db.prepare(`SELECT * FROM api_tasks WHERE id = ? LIMIT 1`);
  const stmtPutTask = db.prepare(`
    INSERT OR REPLACE INTO api_tasks
      (id, client_id, agent_id, description, priority, status, input_json, artifact_id, progress, error, messages_json, created_at, started_at, completed_at, updated_at)
    VALUES (@id, @clientId, @agentId, @description, @priority, @status, @inputJson, @artifactId, @progress, @error, @messagesJson, @createdAt, @startedAt, @completedAt, @updatedAt)
  `);
  const stmtDeleteTask = db.prepare(`DELETE FROM api_tasks WHERE id = ?`);
  const stmtGetArtifact = db.prepare(`SELECT * FROM api_artifacts WHERE id = ? LIMIT 1`);
  const stmtPutArtifact = db.prepare(`
    INSERT OR REPLACE INTO api_artifacts (id, task_id, content_type, content, url, metadata_json, created_at)
    VALUES (@id, @taskId, @contentType, @content, @url, @metadataJson, @createdAt)
  `);
  const stmtArtifactsByTask = db.prepare(
    `SELECT * FROM api_artifacts WHERE task_id = ? ORDER BY created_at ASC`,
  );
  const stmtGetCheckpoint = db.prepare(
    `SELECT * FROM api_governance_checkpoints WHERE id = ? LIMIT 1`,
  );
  const stmtPutCheckpoint = db.prepare(`
    INSERT OR REPLACE INTO api_governance_checkpoints
      (id, mission_id, task_id, type, status, risk_score, risk_level, required_approvals_json, current_approvals_json, created_at, expires_at, approved_at, fallback_action, context_json)
    VALUES (@id, @missionId, @taskId, @type, @status, @riskScore, @riskLevel, @requiredApprovalsJson, @currentApprovalsJson, @createdAt, @expiresAt, @approvedAt, @fallbackAction, @contextJson)
  `);
  const stmtListCheckpoints = db.prepare(
    `SELECT * FROM api_governance_checkpoints ORDER BY created_at ASC`,
  );
  const stmtPendingByApprover = db.prepare(`
    SELECT * FROM api_governance_checkpoints
    WHERE status = 'pending' AND json_extract(required_approvals_json, '$') LIKE ?
    ORDER BY created_at ASC
  `);
  const stmtPendingByMission = db.prepare(`
    SELECT * FROM api_governance_checkpoints
    WHERE mission_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `);
  const stmtGetConfig = db.prepare(
    `SELECT * FROM api_governance_configs WHERE mission_id = ? LIMIT 1`,
  );
  const stmtPutConfig = db.prepare(`
    INSERT OR REPLACE INTO api_governance_configs (mission_id, mode, risk_threshold, approvers_json, timeout, fallback_on_timeout)
    VALUES (@missionId, @mode, @riskThreshold, @approversJson, @timeout, @fallbackOnTimeout)
  `);
  const stmtStats = db.prepare(`SELECT * FROM api_governance_checkpoints`);

  const store: SqliteApiStore = {
    backend: 'sqlite',
    dbPath,
    close() {
      try {
        db.close();
      } catch (err) {
        reportSilentFailure(err, 'apiStore:417');
      }
    },
    listTasksByStatus(status: string) {
      return stmtListByStatus.all(status) as ApiTaskRow[];
    },
    listTasksByClient(clientId: string) {
      return stmtListByClient.all(clientId) as ApiTaskRow[];
    },
    listTasksByAgent(agentId: string) {
      return stmtListByAgent.all(agentId) as ApiTaskRow[];
    },
    listAllTasks() {
      return stmtListAll.all() as ApiTaskRow[];
    },
    getTask(id: string) {
      return (stmtGetTask.get(id) as ApiTaskRow | undefined) ?? null;
    },
    putTask(row: ApiTaskRow) {
      stmtPutTask.run(row);
      return row;
    },
    deleteTask(id: string) {
      stmtDeleteTask.run(id);
    },
    getArtifact(id: string) {
      return (stmtGetArtifact.get(id) as ApiArtifactRow | undefined) ?? null;
    },
    putArtifact(row: ApiArtifactRow) {
      stmtPutArtifact.run(row);
      return row;
    },
    getArtifactsByTask(taskId: string) {
      return stmtArtifactsByTask.all(taskId) as ApiArtifactRow[];
    },
    getCheckpoint(id: string) {
      return (stmtGetCheckpoint.get(id) as ApiCheckpointRow | undefined) ?? null;
    },
    putCheckpoint(row: ApiCheckpointRow) {
      stmtPutCheckpoint.run(row);
      return row;
    },
    listCheckpoints(missionId?: string) {
      const rows = stmtListCheckpoints.all() as ApiCheckpointRow[];
      if (!missionId) return rows;
      return rows.filter((c) => c.mission_id === missionId);
    },
    getPendingCheckpointsForApprover(approverId: string) {
      const rows = stmtListCheckpoints.all() as ApiCheckpointRow[];
      return rows.filter((c) => {
        if (c.status !== 'pending') return false;
        try {
          const required = JSON.parse(c.required_approvals_json || '[]');
          return required.includes(approverId);
        } catch (err) {
          reportSilentFailure(err, 'apiStore:472');
          return false;
        }
      });
    },
    getPendingCheckpointsByMission(missionId: string) {
      return stmtPendingByMission.all(missionId) as ApiCheckpointRow[];
    },
    approveCheckpoint(
      checkpointId: string,
      reviewerId: string,
      reason?: string,
      conditions?: string[],
    ) {
      const checkpoint = stmtGetCheckpoint.get(checkpointId) as ApiCheckpointRow | undefined;
      if (!checkpoint) return null;
      const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
      approvals.push({
        approved: true,
        reviewerId,
        reviewedAt: new Date().toISOString(),
        reason,
        conditions,
      });
      const required = JSON.parse(checkpoint.required_approvals_json || '[]');
      checkpoint.current_approvals_json = JSON.stringify(approvals);
      if (approvals.length >= required.length) {
        checkpoint.status = 'approved';
        checkpoint.approved_at = new Date().toISOString();
      }
      stmtPutCheckpoint.run(checkpoint);
      return checkpoint;
    },
    rejectCheckpoint(checkpointId: string, reviewerId: string, reason: string) {
      const checkpoint = stmtGetCheckpoint.get(checkpointId) as ApiCheckpointRow | undefined;
      if (!checkpoint) return null;
      const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
      approvals.push({ approved: false, reviewerId, reviewedAt: new Date().toISOString(), reason });
      checkpoint.current_approvals_json = JSON.stringify(approvals);
      checkpoint.status = 'rejected';
      stmtPutCheckpoint.run(checkpoint);
      return checkpoint;
    },
    expireCheckpoints(now: Date) {
      const expired: ApiCheckpointRow[] = [];
      const rows = stmtListCheckpoints.all() as ApiCheckpointRow[];
      for (const checkpoint of rows) {
        if (checkpoint.status !== 'pending' || !checkpoint.expires_at) continue;
        if (new Date(checkpoint.expires_at) < now) {
          checkpoint.status = checkpoint.fallback_action === 'proceed' ? 'approved' : 'expired';
          if (checkpoint.status === 'approved') checkpoint.approved_at = new Date().toISOString();
          stmtPutCheckpoint.run(checkpoint);
          expired.push(checkpoint);
        }
      }
      return expired;
    },
    addCheckpointEvidence(
      checkpointId: string,
      evidence: { type: string; timestamp: string; content: string; source: string },
    ) {
      const rows = stmtListCheckpoints.all() as ApiCheckpointRow[];
      const checkpoint = rows.find((c) => c.id === checkpointId);
      if (!checkpoint) return null;
      const context = JSON.parse(checkpoint.context_json || '{}');
      context.evidence = context.evidence || [];
      context.evidence.push(evidence);
      checkpoint.context_json = JSON.stringify(context);
      stmtPutCheckpoint.run(checkpoint);
      return checkpoint;
    },
    getCheckpointConfig(missionId: string) {
      return (stmtGetConfig.get(missionId) as ApiCheckpointConfigRow | undefined) ?? null;
    },
    putCheckpointConfig(row: ApiCheckpointConfigRow) {
      stmtPutConfig.run(row);
      return row;
    },
    getCheckpointStats(missionId?: string) {
      const rows = missionId ? (stmtListCheckpoints.all() as ApiCheckpointRow[]) : [];
      return statsFromRows(rows);
    },
    cleanup() {
      db.exec('DELETE FROM api_tasks');
      db.exec('DELETE FROM api_artifacts');
      db.exec('DELETE FROM api_governance_checkpoints');
      db.exec('DELETE FROM api_governance_configs');
    },
  };
  return store;
}

export function createApiStore(options?: {
  dbPath?: string;
  forceMemory?: boolean;
}): SqliteApiStore {
  const dbPath = options?.dbPath ?? DEFAULT_DB_PATH;
  if (options?.forceMemory) {
    return createMemoryApiStore(dbPath);
  }
  return createSqliteApiStore(dbPath);
}

function checkpointsForMission(missionId: string): ApiCheckpointRow[] {
  throw new Error('Not implemented for direct SQLite rows');
}

function statsFromRows(rows: ApiCheckpointRow[]) {
  const approved = rows.filter((c) => c.status === 'approved').length;
  const approvalTimes = rows
    .filter((c) => c.status === 'approved' && c.approved_at)
    .map((c) => new Date(c.approved_at!).getTime() - new Date(c.created_at).getTime());
  const averageApprovalTime =
    approvalTimes.length === 0
      ? null
      : approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length;
  return {
    total: rows.length,
    pending: rows.filter((c) => c.status === 'pending').length,
    approved,
    rejected: rows.filter((c) => c.status === 'rejected').length,
    expired: rows.filter((c) => c.status === 'expired').length,
    mandatoryCount: rows.filter((c) => c.type === 'mandatory').length,
    conditionalCount: rows.filter((c) => c.type === 'conditional').length,
    automaticCount: rows.filter((c) => c.type === 'automatic').length,
    averageApprovalTime,
  };
}
