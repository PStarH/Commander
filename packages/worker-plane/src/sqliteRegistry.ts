import type Database from 'better-sqlite3';
import type { WorkerDefinition, WorkerRecord, WorkerRegistry } from './types.js';

type DbWorker = {
  id: string;
  kind: string;
  version: string;
  capabilities: string;
  labels: string;
  max_concurrency: number;
  status: WorkerRecord['status'];
  generation: number;
  active_steps: number;
  identity_subject: string;
  tenant_ids: string;
  registered_at: string;
  last_heartbeat_at: string;
};

const row = (value: DbWorker): WorkerRecord => ({
  id: value.id,
  kind: value.kind as WorkerRecord['kind'],
  version: value.version,
  capabilities: JSON.parse(value.capabilities || '[]') as string[],
  maxConcurrency: Number(value.max_concurrency),
  labels: JSON.parse(value.labels || '{}') as Record<string, string>,
  status: value.status,
  generation: Number(value.generation),
  activeSteps: Number(value.active_steps),
  identitySubject: value.identity_subject,
  tenantIds: JSON.parse(value.tenant_ids || '[]') as string[],
  registeredAt: value.registered_at,
  lastHeartbeatAt: value.last_heartbeat_at,
});

/** Shared SQLite worker registry on the kernel.sqlite file. */
export class SqliteWorkerRegistry implements WorkerRegistry {
  constructor(private readonly db: Database.Database) {}

  async initialize(): Promise<void> {
    /* schema owned by kernel SqliteKernelRepository */
  }

  async register(definition: WorkerDefinition, identitySubject: string, tenantIds: string[]): Promise<WorkerRecord> {
    const existing = this.db.prepare('SELECT generation FROM commander_workers WHERE id = ?').get(definition.id) as { generation: number } | undefined;
    const generation = (existing?.generation ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO commander_workers (id,kind,version,capabilities,labels,max_concurrency,status,generation,active_steps,identity_subject,tenant_ids,registered_at,last_heartbeat_at)
       VALUES (?,?,?,?,?,?,?,?,0,?,?,datetime('now'),datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         kind=excluded.kind, version=excluded.version, capabilities=excluded.capabilities,
         labels=excluded.labels, max_concurrency=excluded.max_concurrency, status='ACTIVE',
         generation=?, active_steps=0, identity_subject=excluded.identity_subject,
         tenant_ids=excluded.tenant_ids, registered_at=datetime('now'), last_heartbeat_at=datetime('now')`,
    ).run(
      definition.id,
      definition.kind,
      definition.version,
      JSON.stringify(definition.capabilities),
      JSON.stringify(definition.labels ?? {}),
      definition.maxConcurrency,
      'ACTIVE',
      generation,
      identitySubject,
      JSON.stringify(tenantIds),
      generation,
    );
    const result = this.db.prepare('SELECT * FROM commander_workers WHERE id = ?').get(definition.id) as DbWorker;
    return row(result);
  }

  async heartbeat(workerId: string, generation: number, activeSteps: number): Promise<WorkerRecord | null> {
    const info = this.db.prepare(
      `UPDATE commander_workers SET active_steps=?, last_heartbeat_at=datetime('now')
       WHERE id=? AND generation=? AND status='ACTIVE'`,
    ).run(activeSteps, workerId, generation);
    if (info.changes !== 1) return null;
    const result = this.db.prepare('SELECT * FROM commander_workers WHERE id = ?').get(workerId) as DbWorker;
    return row(result);
  }

  async drain(workerId: string, generation: number): Promise<boolean> {
    const info = this.db.prepare(
      `UPDATE commander_workers SET status='DRAINING', last_heartbeat_at=datetime('now')
       WHERE id=? AND generation=? AND status='ACTIVE'`,
    ).run(workerId, generation);
    return info.changes === 1;
  }

  async markStale(before: Date): Promise<number> {
    const info = this.db.prepare(
      `UPDATE commander_workers SET status='OFFLINE'
       WHERE status IN ('ACTIVE','DRAINING') AND last_heartbeat_at < ?`,
    ).run(before.toISOString());
    return info.changes;
  }

  async get(workerId: string): Promise<WorkerRecord | null> {
    const result = this.db.prepare('SELECT * FROM commander_workers WHERE id = ?').get(workerId) as DbWorker | undefined;
    return result ? row(result) : null;
  }
}
