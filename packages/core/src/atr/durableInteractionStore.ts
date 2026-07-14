/**
 * DurableApprovalInteractionStore — SQLite-backed persistence for approval interactions.
 *
 * Records every side effect that has been gated with `require_approval`, including
 * an external request hash (idempotency key) so that approvals can be reconciled
 * against the original request without re-executing the external write.
 */

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface ApprovalInteraction {
  interactionId: string;
  actionId: string;
  runId: string;
  tenantId: string;
  toolName: string;
  externalRequestHash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  resolvedAt?: string;
}

export interface DurableInteractionStore {
  create(interaction: ApprovalInteraction): Promise<ApprovalInteraction>;
  getByActionId(actionId: string): Promise<ApprovalInteraction | null>;
  resolve(interactionId: string, status: 'approved' | 'denied'): Promise<void>;
  listPending(runId?: string): Promise<ApprovalInteraction[]>;
}

export class SqliteInteractionStore implements DurableInteractionStore {
  private db: InstanceType<typeof Database>;

  constructor(path: string = process.env.COMMANDER_INTERACTION_DB ?? ':memory:') {
    // GOV-13: HITL approvals must survive a restart and be visible across
    // replicas. An in-memory store silently loses pending approvals, so refuse
    // it in production — operators must set COMMANDER_INTERACTION_DB to a durable
    // path (or construct with an explicit non-:memory: path).
    if (path === ':memory:' && process.env.NODE_ENV === 'production') {
      throw new Error(
        '[SqliteInteractionStore] A durable interaction-store path is required in production ' +
          '(set COMMANDER_INTERACTION_DB); refusing :memory:, which loses pending HITL approvals on restart.',
      );
    }
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_interactions (
        interactionId TEXT PRIMARY KEY,
        actionId TEXT UNIQUE NOT NULL,
        runId TEXT NOT NULL,
        tenantId TEXT NOT NULL,
        toolName TEXT NOT NULL,
        externalRequestHash TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        resolvedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending ON approval_interactions(runId, status);
      CREATE INDEX IF NOT EXISTS idx_action_id ON approval_interactions(actionId);
    `);
  }

  async create(interaction: ApprovalInteraction): Promise<ApprovalInteraction> {
    const stmt = this.db.prepare(`
      INSERT INTO approval_interactions (
        interactionId, actionId, runId, tenantId, toolName,
        externalRequestHash, status, createdAt, resolvedAt
      ) VALUES (
        :interactionId, :actionId, :runId, :tenantId, :toolName,
        :externalRequestHash, :status, :createdAt, :resolvedAt
      )
    `);
    stmt.run({
      interactionId: interaction.interactionId,
      actionId: interaction.actionId,
      runId: interaction.runId,
      tenantId: interaction.tenantId,
      toolName: interaction.toolName,
      externalRequestHash: interaction.externalRequestHash,
      status: interaction.status,
      createdAt: interaction.createdAt,
      resolvedAt: interaction.resolvedAt ?? null,
    });
    return interaction;
  }

  async getByActionId(actionId: string): Promise<ApprovalInteraction | null> {
    const stmt = this.db.prepare('SELECT * FROM approval_interactions WHERE actionId = ?');
    const row = stmt.get(actionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToInteraction(row);
  }

  async resolve(interactionId: string, status: 'approved' | 'denied'): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE approval_interactions
      SET status = ?, resolvedAt = ?
      WHERE interactionId = ?
    `);
    const result = stmt.run(status, new Date().toISOString(), interactionId);
    if (result.changes === 0) {
      throw new Error(`Interaction not found: ${interactionId}`);
    }
  }

  async listPending(runId?: string): Promise<ApprovalInteraction[]> {
    if (runId) {
      const stmt = this.db.prepare(
        'SELECT * FROM approval_interactions WHERE runId = ? AND status = ? ORDER BY createdAt ASC',
      );
      const rows = stmt.all(runId, 'pending') as Record<string, unknown>[];
      return rows.map(rowToInteraction);
    }
    const stmt = this.db.prepare(
      "SELECT * FROM approval_interactions WHERE status = 'pending' ORDER BY createdAt ASC",
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(rowToInteraction);
  }

  close(): void {
    this.db.close();
  }
}

function rowToInteraction(row: Record<string, unknown>): ApprovalInteraction {
  return {
    interactionId: String(row.interactionId),
    actionId: String(row.actionId),
    runId: String(row.runId),
    tenantId: String(row.tenantId),
    toolName: String(row.toolName),
    externalRequestHash: String(row.externalRequestHash),
    status: row.status as ApprovalInteraction['status'],
    createdAt: String(row.createdAt),
    resolvedAt: row.resolvedAt ? String(row.resolvedAt) : undefined,
  };
}

/**
 * Generate a stable interaction id. Exposed so callers can override in tests.
 */
export function generateInteractionId(): string {
  return `apv-${randomUUID()}`;
}
