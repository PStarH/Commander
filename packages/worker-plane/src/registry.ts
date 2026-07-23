import { randomBytes } from 'node:crypto';
import type { WorkerDefinition, WorkerKind, WorkerRecord, WorkerRegistry } from './types.js';

/**
 * Durable `commander_workers.tenant_ids` must be an explicit tenant list.
 * Open-ended `*` is forbidden: single-tenant RLS (`tenant_ids ?| {tenant}`) rejects
 * `['*']`, while claim DEFINER historically expanded `*` — inconsistent fail-open.
 * Env bootstrap already fail-closes `COMMANDER_WORKER_TENANTS=*`.
 * Server-side `register_worker` also rejects `*` and tenants not in allowlist.
 */
export const WORKER_OPEN_ENDED_TENANTS_FORBIDDEN = 'WORKER_OPEN_ENDED_TENANTS_FORBIDDEN';

export const WORKER_CLAIM_SECRET_REGISTER_FAILED = 'WORKER_CLAIM_SECRET_REGISTER_FAILED';

export const WORKER_TENANT_NOT_ALLOWED = 'WORKER_TENANT_NOT_ALLOWED';

export const WORKER_REREGISTER_REQUIRES_SECRET = 'WORKER_REREGISTER_REQUIRES_SECRET';

export const WORKER_REREGISTER_SECRET_MISMATCH = 'WORKER_REREGISTER_SECRET_MISMATCH';

function assertExplicitDurableTenantIds(tenantIds: string[]): void {
  if (tenantIds.length === 0) {
    throw new Error('Worker register requires non-empty tenantIds for RLS scope');
  }
  if (tenantIds.includes('*')) {
    throw new Error(
      `${WORKER_OPEN_ENDED_TENANTS_FORBIDDEN}: durable commander_workers.tenant_ids must be an ` +
        "explicit tenant list; open-ended '*' is forbidden (env and claim authz fail-closed)",
    );
  }
}

/**
 * Schema DDL for commander_workers — owned by kernel migrations / table owner only.
 * Exported for tests and documentation; never execute from worker LOGIN (no CREATE).
 */
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

export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}
export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>>;
  release(): void;
}
export interface SqlPool {
  connect(): Promise<SqlClient>;
}

type DbWorkerJson = {
  id: string;
  kind: WorkerKind | string;
  version: string;
  capabilities?: string[];
  labels?: Record<string, string>;
  max_concurrency: number;
  status: WorkerRecord['status'];
  generation: number;
  active_steps: number;
  identity_subject: string;
  tenant_ids: string[];
  registered_at: Date | string;
  last_heartbeat_at: Date | string;
  claim_secret?: string;
};

const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const rowFromJson = (value: DbWorkerJson): WorkerRecord => ({
  id: value.id,
  kind: value.kind as WorkerKind,
  version: value.version,
  capabilities: value.capabilities ?? [],
  maxConcurrency: Number(value.max_concurrency),
  labels: value.labels ?? {},
  status: value.status,
  generation: Number(value.generation),
  activeSteps: Number(value.active_steps),
  identitySubject: value.identity_subject,
  tenantIds: value.tenant_ids ?? [],
  registeredAt: iso(value.registered_at),
  lastHeartbeatAt: iso(value.last_heartbeat_at),
  ...(value.claim_secret ? { claimSecret: value.claim_secret } : {}),
});

/**
 * Shared Postgres worker registry. A stale process cannot heartbeat a newer generation.
 *
 * Worker LOGIN cannot INSERT/UPDATE `commander_workers` — mutations go through
 * SECURITY DEFINER RPCs (`register_worker` / `heartbeat_worker` / `drain_worker`).
 * `get` still uses SELECT under FORCE RLS with `app.tenant_scope`.
 *
 * `markStale` is cross-tenant and must run on a BYPASSRLS connection (scheduler/owner).
 * `WorkerService` never calls `markStale` — only ops/scheduler paths may invoke it.
 */
export class PostgresWorkerRegistry implements WorkerRegistry {
  /** Last-known tenant scope from register(); used by get() under FORCE RLS. */
  private scopedTenantIds: string[] = [];

  constructor(private readonly pool: SqlPool) {}

  /** Verify table exists — no DDL. Schema is migration/owner owned. */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ok: string | null }>(
        `SELECT to_regclass('public.commander_workers')::text AS ok`,
      );
      if (!result.rows[0]?.ok) {
        throw new Error(
          'commander_workers table is missing; run kernel migrations as table owner before starting workers',
        );
      }
    } finally {
      client.release();
    }
  }

  async register(
    definition: WorkerDefinition,
    identitySubject: string,
    tenantIds: string[],
    previousClaimSecret?: string,
  ): Promise<WorkerRecord> {
    assertExplicitDurableTenantIds(tenantIds);
    if (!definition.capabilities?.length) {
      throw new Error('Worker register requires non-empty capabilities');
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ register_worker: DbWorkerJson | null }>(
        `SELECT register_worker(
           $1::text, $2::text, $3::text, $4::jsonb, $5::jsonb, $6::integer, $7::text, $8::jsonb, $9::text
         ) AS register_worker`,
        [
          definition.id,
          definition.kind,
          definition.version,
          JSON.stringify(definition.capabilities),
          JSON.stringify(definition.labels ?? {}),
          definition.maxConcurrency,
          identitySubject,
          JSON.stringify(tenantIds),
          previousClaimSecret ?? null,
        ],
      );
      const payload = result.rows[0]?.register_worker;
      if (!payload || !payload.claim_secret) {
        throw new Error(
          `${WORKER_CLAIM_SECRET_REGISTER_FAILED}: register_worker returned no row/secret for id=${definition.id}`,
        );
      }
      this.scopedTenantIds = [...tenantIds];
      return rowFromJson(payload);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith(WORKER_CLAIM_SECRET_REGISTER_FAILED)) throw error;
      if (msg.includes(WORKER_REREGISTER_REQUIRES_SECRET)) {
        throw new Error(
          `${WORKER_REREGISTER_REQUIRES_SECRET}: active worker requires previousClaimSecret or drain first ` +
            `(id=${definition.id})`,
          { cause: error instanceof Error ? error : undefined },
        );
      }
      if (msg.includes(WORKER_REREGISTER_SECRET_MISMATCH)) {
        throw new Error(
          `${WORKER_REREGISTER_SECRET_MISMATCH}: previousClaimSecret does not match durable hash ` +
            `(id=${definition.id})`,
          { cause: error instanceof Error ? error : undefined },
        );
      }
      if (msg.includes(WORKER_TENANT_NOT_ALLOWED) || msg.includes('WORKER_TENANT_NOT_ALLOWED')) {
        throw new Error(
          `${WORKER_TENANT_NOT_ALLOWED}: register rejected — tenant not in commander_worker_allowed_tenants ` +
            `(id=${definition.id} tenants=[${tenantIds.join(',')}])`,
          { cause: error instanceof Error ? error : undefined },
        );
      }
      if (msg.includes(WORKER_OPEN_ENDED_TENANTS_FORBIDDEN)) {
        throw new Error(
          `${WORKER_OPEN_ENDED_TENANTS_FORBIDDEN}: durable commander_workers.tenant_ids must be an ` +
            "explicit tenant list; open-ended '*' is forbidden (env and claim authz fail-closed)",
          { cause: error instanceof Error ? error : undefined },
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(
    workerId: string,
    generation: number,
    activeSteps: number,
    claimSecret: string,
  ): Promise<WorkerRecord | null> {
    this.requireScopedTenants('heartbeat');
    if (!claimSecret) return null;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ heartbeat_worker: DbWorkerJson | null }>(
        'SELECT heartbeat_worker($1::text, $2::bigint, $3::integer, $4::text) AS heartbeat_worker',
        [workerId, generation, activeSteps, claimSecret],
      );
      const payload = result.rows[0]?.heartbeat_worker;
      return payload ? rowFromJson(payload) : null;
    } finally {
      client.release();
    }
  }

  async drain(workerId: string, generation: number, claimSecret: string): Promise<boolean> {
    this.requireScopedTenants('drain');
    if (!claimSecret) return false;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ drain_worker: boolean }>(
        'SELECT drain_worker($1::text, $2::bigint, $3::text) AS drain_worker',
        [workerId, generation, claimSecret],
      );
      return result.rows[0]?.drain_worker === true;
    } finally {
      client.release();
    }
  }

  /**
   * Cross-tenant stale sweep. Requires BYPASSRLS (scheduler/owner); worker LOGIN
   * under FORCE RLS cannot see/update other tenants' rows without a DEFINER RPC.
   *
   * Not invoked by `WorkerService` — workers must not call this on a worker LOGIN pool.
   * Under worker LOGIN + FORCE RLS (no tenant_scope), this updates 0 rows (fail-closed no-op)
   * and also lacks UPDATE privilege on commander_workers after P0 REVOKE.
   */
  async markStale(before: Date): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE commander_workers SET status='OFFLINE' WHERE status IN ('ACTIVE','DRAINING') AND last_heartbeat_at < $1`,
        [before.toISOString()],
      );
      return result.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  async get(workerId: string): Promise<WorkerRecord | null> {
    return this.withTenantScope(this.requireScopedTenants('get'), async (client) => {
      const result = await client.query<DbWorkerJson>(
        'SELECT * FROM commander_workers WHERE id=$1',
        [workerId],
      );
      const row0 = result.rows[0];
      return row0 ? rowFromJson(row0) : null;
    });
  }

  private requireScopedTenants(op: string): string[] {
    if (this.scopedTenantIds.length === 0) {
      throw new Error(
        `Worker registry ${op} requires tenant scope; call register() first so app.tenant_scope can be set`,
      );
    }
    return this.scopedTenantIds;
  }

  /**
   * KERNEL_RLS_SQL uses comma-separated `app.tenant_scope` (not JSON).
   * is_local=true requires an open transaction or the GUC is discarded immediately.
   */
  private async withTenantScope<T>(
    tenantIds: string[],
    fn: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    const scope = tenantIds.join(',');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_scope',$1,true)", [scope]);
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* preserve root cause */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Test-only registry; it is deliberately not exported from the package root. */
export class InMemoryWorkerRegistry implements WorkerRegistry {
  private workers = new Map<string, WorkerRecord>();
  private secrets = new Map<string, string>();
  async initialize(): Promise<void> {}
  async register(
    definition: WorkerDefinition,
    identitySubject: string,
    tenantIds: string[],
    previousClaimSecret?: string,
  ): Promise<WorkerRecord> {
    assertExplicitDurableTenantIds(tenantIds);
    if (!definition.capabilities?.length) {
      throw new Error('Worker register requires non-empty capabilities');
    }
    const previous = this.workers.get(definition.id);
    if (previous) {
      if (previous.status === 'ACTIVE') {
        const expected = this.secrets.get(definition.id);
        if (!previousClaimSecret) {
          throw new Error(
            `${WORKER_REREGISTER_REQUIRES_SECRET}: active worker requires previousClaimSecret (drain first)`,
          );
        }
        if (!expected || previousClaimSecret !== expected) {
          throw new Error(`${WORKER_REREGISTER_SECRET_MISMATCH}: previousClaimSecret mismatch`);
        }
      }
    }
    const time = new Date().toISOString();
    const claimSecret = randomBytes(32).toString('base64url');
    const value: WorkerRecord = {
      ...definition,
      labels: definition.labels ?? {},
      status: 'ACTIVE',
      generation: (previous?.generation ?? 0) + 1,
      activeSteps: 0,
      identitySubject,
      tenantIds,
      registeredAt: time,
      lastHeartbeatAt: time,
      claimSecret,
    };
    this.workers.set(value.id, value);
    this.secrets.set(value.id, claimSecret);
    // Clone without stripping claimSecret — callers need it once from register().
    return structuredClone(value);
  }
  async heartbeat(
    workerId: string,
    generation: number,
    activeSteps: number,
    claimSecret: string,
  ): Promise<WorkerRecord | null> {
    const value = this.workers.get(workerId);
    const expected = this.secrets.get(workerId);
    if (
      !value ||
      value.generation !== generation ||
      value.status !== 'ACTIVE' ||
      !claimSecret ||
      claimSecret !== expected
    ) {
      return null;
    }
    value.activeSteps = activeSteps;
    value.lastHeartbeatAt = new Date().toISOString();
    // Match Postgres heartbeat_worker: never re-issue claimSecret on heartbeat.
    const clone = structuredClone(value);
    delete clone.claimSecret;
    return clone;
  }
  async drain(workerId: string, generation: number, claimSecret: string): Promise<boolean> {
    const value = this.workers.get(workerId);
    const expected = this.secrets.get(workerId);
    if (
      !value ||
      value.generation !== generation ||
      value.status !== 'ACTIVE' ||
      !claimSecret ||
      claimSecret !== expected
    ) {
      return false;
    }
    value.status = 'DRAINING';
    return true;
  }
  async markStale(before: Date): Promise<number> {
    let count = 0;
    for (const value of this.workers.values()) {
      if (value.status !== 'OFFLINE' && Date.parse(value.lastHeartbeatAt) < before.getTime()) {
        value.status = 'OFFLINE';
        count++;
      }
    }
    return count;
  }
  async get(workerId: string): Promise<WorkerRecord | null> {
    const value = this.workers.get(workerId);
    return value ? structuredClone(value) : null;
  }
}
