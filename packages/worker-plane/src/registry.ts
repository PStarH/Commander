import type { WorkerDefinition, WorkerRecord, WorkerRegistry } from './types.js';

export const WORKER_PLANE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS commander_workers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DRAINING','OFFLINE')),
  generation BIGINT NOT NULL DEFAULT 0,
  active_steps INTEGER NOT NULL DEFAULT 0 CHECK (active_steps >= 0),
  identity_subject TEXT NOT NULL,
  tenant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commander_workers_active_idx ON commander_workers (status, last_heartbeat_at);
`;

export interface SqlQueryResult<T = Record<string, unknown>> { rows: T[]; rowCount: number | null; }
export interface SqlClient { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult<T>>; release(): void; }
export interface SqlPool { connect(): Promise<SqlClient>; }

type DbWorker = Omit<WorkerRecord, 'maxConcurrency' | 'activeSteps' | 'identitySubject' | 'tenantIds' | 'registeredAt' | 'lastHeartbeatAt'> & {
  max_concurrency: number; active_steps: number; identity_subject: string; tenant_ids: string[];
  registered_at: Date | string; last_heartbeat_at: Date | string;
};
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const row = (value: DbWorker): WorkerRecord => ({ id: value.id, kind: value.kind, version: value.version, capabilities: value.capabilities ?? [], maxConcurrency: Number(value.max_concurrency), labels: value.labels ?? {}, status: value.status, generation: Number(value.generation), activeSteps: Number(value.active_steps), identitySubject: value.identity_subject, tenantIds: value.tenant_ids ?? [], registeredAt: iso(value.registered_at), lastHeartbeatAt: iso(value.last_heartbeat_at) });

/** Shared Postgres worker registry. A stale process cannot heartbeat a newer generation. */
export class PostgresWorkerRegistry implements WorkerRegistry {
  constructor(private readonly pool: SqlPool) {}
  async initialize(): Promise<void> { const client = await this.pool.connect(); try { await client.query(WORKER_PLANE_SCHEMA_SQL); } finally { client.release(); } }
  async register(definition: WorkerDefinition, identitySubject: string, tenantIds: string[]): Promise<WorkerRecord> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<DbWorker>(
        `INSERT INTO commander_workers (id,kind,version,capabilities,labels,max_concurrency,status,generation,active_steps,identity_subject,tenant_ids)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,'ACTIVE',1,0,$7,$8::jsonb)
         ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,version=EXCLUDED.version,capabilities=EXCLUDED.capabilities,labels=EXCLUDED.labels,max_concurrency=EXCLUDED.max_concurrency,status='ACTIVE',generation=commander_workers.generation+1,active_steps=0,identity_subject=EXCLUDED.identity_subject,tenant_ids=EXCLUDED.tenant_ids,registered_at=now(),last_heartbeat_at=now()
         RETURNING *`, [definition.id, definition.kind, definition.version, JSON.stringify(definition.capabilities), JSON.stringify(definition.labels ?? {}), definition.maxConcurrency, identitySubject, JSON.stringify(tenantIds)]);
      return row(result.rows[0]!);
    } finally { client.release(); }
  }
  async heartbeat(workerId: string, generation: number, activeSteps: number): Promise<WorkerRecord | null> {
    const client = await this.pool.connect();
    try { const result = await client.query<DbWorker>(`UPDATE commander_workers SET active_steps=$1,last_heartbeat_at=now() WHERE id=$2 AND generation=$3 AND status='ACTIVE' RETURNING *`, [activeSteps, workerId, generation]); return result.rows[0] ? row(result.rows[0]) : null; }
    finally { client.release(); }
  }
  async drain(workerId: string, generation: number): Promise<boolean> { const client = await this.pool.connect(); try { const result = await client.query(`UPDATE commander_workers SET status='DRAINING',last_heartbeat_at=now() WHERE id=$1 AND generation=$2 AND status='ACTIVE'`, [workerId, generation]); return (result.rowCount ?? 0) === 1; } finally { client.release(); } }
  async markStale(before: Date): Promise<number> { const client = await this.pool.connect(); try { const result = await client.query(`UPDATE commander_workers SET status='OFFLINE' WHERE status IN ('ACTIVE','DRAINING') AND last_heartbeat_at < $1`, [before.toISOString()]); return result.rowCount ?? 0; } finally { client.release(); } }
  async get(workerId: string): Promise<WorkerRecord | null> { const client = await this.pool.connect(); try { const result = await client.query<DbWorker>('SELECT * FROM commander_workers WHERE id=$1', [workerId]); return result.rows[0] ? row(result.rows[0]) : null; } finally { client.release(); } }
}

/** Test-only registry; it is deliberately not exported from the package root. */
export class InMemoryWorkerRegistry implements WorkerRegistry {
  private workers = new Map<string, WorkerRecord>();
  async initialize(): Promise<void> {}
  async register(definition: WorkerDefinition, identitySubject: string, tenantIds: string[]): Promise<WorkerRecord> { const previous = this.workers.get(definition.id); const time = new Date().toISOString(); const value: WorkerRecord = { ...definition, labels: definition.labels ?? {}, status: 'ACTIVE', generation: (previous?.generation ?? 0) + 1, activeSteps: 0, identitySubject, tenantIds, registeredAt: time, lastHeartbeatAt: time }; this.workers.set(value.id, value); return structuredClone(value); }
  async heartbeat(workerId: string, generation: number, activeSteps: number): Promise<WorkerRecord | null> { const value = this.workers.get(workerId); if (!value || value.generation !== generation || value.status !== 'ACTIVE') return null; value.activeSteps = activeSteps; value.lastHeartbeatAt = new Date().toISOString(); return structuredClone(value); }
  async drain(workerId: string, generation: number): Promise<boolean> { const value = this.workers.get(workerId); if (!value || value.generation !== generation || value.status !== 'ACTIVE') return false; value.status = 'DRAINING'; return true; }
  async markStale(before: Date): Promise<number> { let count = 0; for (const value of this.workers.values()) if (value.status !== 'OFFLINE' && Date.parse(value.lastHeartbeatAt) < before.getTime()) { value.status = 'OFFLINE'; count++; } return count; }
  async get(workerId: string): Promise<WorkerRecord | null> { const value = this.workers.get(workerId); return value ? structuredClone(value) : null; }
}
