/**
 * SLO Persistence — stores SLO definitions and violation records in PostgreSQL.
 *
 * This module provides:
 * - `PostgresSLOStore` — durable SLO definitions + violation records
 * - `InMemorySLOStore` — test/dev fallback
 *
 * The SLOOperationsManager uses this store to persist SLO configurations
 * and violation history across process restarts.
 */

import { randomUUID } from 'node:crypto';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface PersistentSLODefinition {
  id: string;
  name: string;
  targetPercent: number;
  metric: string;
  threshold: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersistentSLOViolation {
  id: string;
  sloId: string;
  tenantId?: string;
  runId?: string;
  measuredValue: number;
  threshold: number;
  severity: 'warning' | 'critical' | 'page';
  message: string;
  occurredAt: string;
  resolvedAt?: string;
}

export interface SLOStore {
  saveSLO(
    slo: Omit<PersistentSLODefinition, 'createdAt' | 'updatedAt'>,
  ): Promise<PersistentSLODefinition>;
  getSLO(id: string): Promise<PersistentSLODefinition | null>;
  listSLOs(): Promise<PersistentSLODefinition[]>;
  deleteSLO(id: string): Promise<boolean>;

  recordViolation(
    violation: Omit<PersistentSLOViolation, 'id' | 'occurredAt'>,
  ): Promise<PersistentSLOViolation>;
  resolveViolation(violationId: string): Promise<boolean>;
  listViolations(input: {
    sloId?: string;
    limit?: number;
    since?: string;
  }): Promise<PersistentSLOViolation[]>;
}

// ──────────────────────────────────────────────────────────────────────────
// SQL Schema (for PostgreSQL implementation)
// ──────────────────────────────────────────────────────────────────────────

export const SLO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS commander_slo_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_percent NUMERIC(5,2) NOT NULL,
  metric TEXT NOT NULL,
  threshold NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commander_slo_violations (
  id TEXT PRIMARY KEY,
  slo_id TEXT NOT NULL REFERENCES commander_slo_definitions(id) ON DELETE CASCADE,
  tenant_id TEXT,
  run_id TEXT,
  measured_value NUMERIC NOT NULL,
  threshold NUMERIC NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical','page')),
  message TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS commander_slo_violations_slo_idx ON commander_slo_violations (slo_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS commander_slo_violations_unresolved_idx ON commander_slo_violations (slo_id) WHERE resolved_at IS NULL;
`;

// ──────────────────────────────────────────────────────────────────────────
// In-memory implementation (test/dev fallback)
// ──────────────────────────────────────────────────────────────────────────

export class InMemorySLOStore implements SLOStore {
  private readonly sloDefs: Record<string, PersistentSLODefinition> = {};
  private readonly violations: PersistentSLOViolation[] = [];

  async saveSLO(
    slo: Omit<PersistentSLODefinition, 'createdAt' | 'updatedAt'>,
  ): Promise<PersistentSLODefinition> {
    const now = new Date().toISOString();
    const existing = this.sloDefs[slo.id];
    const def: PersistentSLODefinition = {
      ...slo,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sloDefs[slo.id] = def;
    return def;
  }

  async getSLO(id: string): Promise<PersistentSLODefinition | null> {
    return this.sloDefs[id] ?? null;
  }

  async listSLOs(): Promise<PersistentSLODefinition[]> {
    return Object.values(this.sloDefs);
  }

  async deleteSLO(id: string): Promise<boolean> {
    return delete this.sloDefs[id];
  }

  async recordViolation(
    v: Omit<PersistentSLOViolation, 'id' | 'occurredAt'>,
  ): Promise<PersistentSLOViolation> {
    const violation: PersistentSLOViolation = {
      ...v,
      id: `vln_${randomUUID()}`,
      occurredAt: new Date().toISOString(),
    };
    this.violations.push(violation);
    return violation;
  }

  async resolveViolation(violationId: string): Promise<boolean> {
    const v = this.violations.find((v) => v.id === violationId);
    if (!v || v.resolvedAt) return false;
    v.resolvedAt = new Date().toISOString();
    return true;
  }

  async listViolations(input: {
    sloId?: string;
    limit?: number;
    since?: string;
  }): Promise<PersistentSLOViolation[]> {
    let result = this.violations;
    if (input.sloId) result = result.filter((v) => v.sloId === input.sloId);
    if (input.since) result = result.filter((v) => v.occurredAt >= input.since!);
    const limit = input.limit ?? 100;
    return result.slice(-limit).reverse();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// PostgreSQL implementation
// ──────────────────────────────────────────────────────────────────────────

export class PostgresSLOStore implements SLOStore {
  constructor(
    private readonly pool: { connect(): Promise<{ query: Function; release(): void }> },
  ) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(SLO_SCHEMA_SQL);
    } finally {
      client.release();
    }
  }

  async saveSLO(
    slo: Omit<PersistentSLODefinition, 'createdAt' | 'updatedAt'>,
  ): Promise<PersistentSLODefinition> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO commander_slo_definitions (id, name, target_percent, metric, threshold)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name=$2, target_percent=$3, metric=$4, threshold=$5, updated_at=now()
         RETURNING *`,
        [slo.id, slo.name, slo.targetPercent, slo.metric, slo.threshold],
      );
      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        targetPercent: Number(row.target_percent),
        metric: row.metric,
        threshold: Number(row.threshold),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    } finally {
      client.release();
    }
  }

  async getSLO(id: string): Promise<PersistentSLODefinition | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT * FROM commander_slo_definitions WHERE id=$1', [
        id,
      ]);
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        targetPercent: Number(row.target_percent),
        metric: row.metric,
        threshold: Number(row.threshold),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    } finally {
      client.release();
    }
  }

  async listSLOs(): Promise<PersistentSLODefinition[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM commander_slo_definitions ORDER BY created_at',
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        name: row.name as string,
        targetPercent: Number(row.target_percent),
        metric: row.metric as string,
        threshold: Number(row.threshold),
        createdAt: (row.created_at as Date).toISOString(),
        updatedAt: (row.updated_at as Date).toISOString(),
      }));
    } finally {
      client.release();
    }
  }

  async deleteSLO(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query('DELETE FROM commander_slo_definitions WHERE id=$1', [id]);
      return (result.rowCount ?? 0) === 1;
    } finally {
      client.release();
    }
  }

  async recordViolation(
    v: Omit<PersistentSLOViolation, 'id' | 'occurredAt'>,
  ): Promise<PersistentSLOViolation> {
    const client = await this.pool.connect();
    try {
      const id = `vln_${randomUUID()}`;
      const result = await client.query(
        `INSERT INTO commander_slo_violations (id, slo_id, tenant_id, run_id, measured_value, threshold, severity, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          id,
          v.sloId,
          v.tenantId ?? null,
          v.runId ?? null,
          v.measuredValue,
          v.threshold,
          v.severity,
          v.message,
        ],
      );
      const row = result.rows[0];
      return {
        id: row.id,
        sloId: row.slo_id,
        tenantId: row.tenant_id ?? undefined,
        runId: row.run_id ?? undefined,
        measuredValue: Number(row.measured_value),
        threshold: Number(row.threshold),
        severity: row.severity,
        message: row.message,
        occurredAt: row.occurred_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString(),
      };
    } finally {
      client.release();
    }
  }

  async resolveViolation(violationId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE commander_slo_violations SET resolved_at=now() WHERE id=$1 AND resolved_at IS NULL`,
        [violationId],
      );
      return (result.rowCount ?? 0) === 1;
    } finally {
      client.release();
    }
  }

  async listViolations(input: {
    sloId?: string;
    limit?: number;
    since?: string;
  }): Promise<PersistentSLOViolation[]> {
    const client = await this.pool.connect();
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;
      if (input.sloId) {
        conditions.push(`slo_id = $${paramIdx++}`);
        params.push(input.sloId);
      }
      if (input.since) {
        conditions.push(`occurred_at >= $${paramIdx++}`);
        params.push(input.since);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = input.limit ?? 100;
      params.push(limit);
      const result = await client.query(
        `SELECT * FROM commander_slo_violations ${where} ORDER BY occurred_at DESC LIMIT $${paramIdx}`,
        params,
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        sloId: row.slo_id as string,
        tenantId: (row.tenant_id as string | null) ?? undefined,
        runId: (row.run_id as string | null) ?? undefined,
        measuredValue: Number(row.measured_value),
        threshold: Number(row.threshold),
        severity: row.severity as PersistentSLOViolation['severity'],
        message: row.message as string,
        occurredAt: (row.occurred_at as Date).toISOString(),
        resolvedAt: (row.resolved_at as Date | null)?.toISOString(),
      }));
    } finally {
      client.release();
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────

let storeInstance: SLOStore | null = null;

export function getSLOStore(): SLOStore {
  if (!storeInstance) {
    storeInstance = new InMemorySLOStore();
  }
  return storeInstance;
}

export function setSLOStore(store: SLOStore): void {
  storeInstance = store;
}

export function resetSLOStore(): void {
  storeInstance = null;
}
