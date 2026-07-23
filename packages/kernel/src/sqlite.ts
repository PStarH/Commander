import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { SqlClient } from './postgres.js';
import { PostgresKernelRepository } from './postgres.js';
import { generateWorkerClaimSecret, hashWorkerClaimSecret, verifyWorkerClaimSecret } from './claimSecret.js';
import type { ClaimStepRequest, KernelStep, KernelStepState } from './types.js';
import { assertRunTransition, assertStepTransition } from './transitionValidation.js';
import { SQLITE_KERNEL_SCHEMA_SQL, SQLITE_KERNEL_SCHEMA_VERSION } from './sqliteSchema.js';
import { createSqlitePool } from './sqlitePool.js';
import { KERNEL_COMPENSATION_TOPIC, LEGACY_COMPENSATION_TOPIC } from './ops/compensationConsumer.js';

export interface SqliteKernelRepositoryOptions {
  /** File path; :memory: only in tests when allowMemory=true */
  path: string;
  allowMemory?: boolean;
  wal?: boolean;
  busyTimeoutMs?: number;
  synchronous?: 'FULL' | 'NORMAL';
  schedulerMode?: boolean;
}

function fromStepAdapter(row: Record<string, unknown>): KernelStep {
  const lease = row.lease_token && row.lease_worker_id && row.lease_expires_at
    ? {
        workerId: row.lease_worker_id as string,
        workerGeneration: Number(row.lease_worker_generation ?? 0),
        token: row.lease_token as string,
        fencingEpoch: Number(row.fencing_epoch),
        expiresAt: String(row.lease_expires_at),
      }
    : undefined;
  const parseJson = (v: unknown) => {
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return {}; }
    }
    return v ?? {};
  };
  return {
    id: row.id as string,
    runId: row.run_id as string,
    tenantId: row.tenant_id as string,
    kind: row.kind as string,
    state: row.state as KernelStep['state'],
    version: Number(row.version),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    priority: Number(row.priority),
    dependencies: parseJson(row.dependencies) as string[],
    input: parseJson(row.input) as Record<string, unknown>,
    output: row.output ? parseJson(row.output) as Record<string, unknown> : undefined,
    error: row.error ? parseJson(row.error) as KernelStep['error'] : undefined,
    scheduledAt: String(row.scheduled_at),
    lease,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** SQLite implementation of KernelRepository — single-writer, BEGIN IMMEDIATE claims. */
export class SqliteKernelRepository extends PostgresKernelRepository {
  private readonly db: Database.Database;
  /**
   * Claim-path scheduler flag. Distinct from parent `options.schedulerMode`, which
   * must stay true so Postgres `enforceAppRole` (session_user::text) is never
   * applied to the SQLite pool.
   */
  private readonly claimSchedulerMode: boolean;

  constructor(private readonly sqliteOptions: SqliteKernelRepositoryOptions) {
    if (sqliteOptions.path === ':memory:' && !sqliteOptions.allowMemory) {
      throw new Error(':memory: SQLite path requires explicit allowMemory test flag');
    }
    const parentDir = dirname(sqliteOptions.path);
    if (sqliteOptions.path !== ':memory:' && parentDir && parentDir !== '.') {
      mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    }
    const db = new Database(sqliteOptions.path);
    const claimSchedulerMode = sqliteOptions.schedulerMode ?? true;
    // Always pass schedulerMode:true to parent — enforceAppRole is PG-LOGIN only.
    super(createSqlitePool(db), { schedulerMode: true });
    this.db = db;
    this.claimSchedulerMode = claimSchedulerMode;
  }

  async initialize(): Promise<void> {
    const wal = this.sqliteOptions.wal ?? true;
    const busyTimeoutMs = this.sqliteOptions.busyTimeoutMs ?? 5000;
    const synchronous = this.sqliteOptions.synchronous ?? 'NORMAL';
    this.db.pragma('foreign_keys = ON');
    if (wal && this.sqliteOptions.path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    this.db.pragma(`synchronous = ${synchronous}`);
    this.db.exec(SQLITE_KERNEL_SCHEMA_SQL);
    this.migrateCapabilityRevocationsPk();
    this.db.prepare(
      `INSERT OR IGNORE INTO commander_kernel_schema (version) VALUES (?)`,
    ).run(SQLITE_KERNEL_SCHEMA_VERSION);
    if (this.sqliteOptions.path !== ':memory:' && existsSync(this.sqliteOptions.path)) {
      chmodSync(this.sqliteOptions.path, 0o600);
      const dir = dirname(this.sqliteOptions.path);
      if (dir && existsSync(dir)) chmodSync(dir, 0o700);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Rebuild capability revocations when legacy global-jti PRIMARY KEY is present.
   * New installs already use PRIMARY KEY (tenant_id, jti) from SQLITE_KERNEL_SCHEMA_SQL.
   */
  private migrateCapabilityRevocationsPk(): void {
    const cols = this.db.prepare(`PRAGMA table_info(commander_capability_revocations)`).all() as Array<{
      name: string;
      pk: number;
    }>;
    if (cols.length === 0) return;
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (!(pkCols.length === 1 && pkCols[0] === 'jti')) return;
    this.db.exec(`
      CREATE TABLE commander_capability_revocations_new (
        tenant_id TEXT NOT NULL,
        jti TEXT NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (tenant_id, jti)
      );
      INSERT OR IGNORE INTO commander_capability_revocations_new (tenant_id, jti, revoked_at, expires_at, reason)
        SELECT tenant_id, jti, revoked_at, expires_at, reason FROM commander_capability_revocations;
      DROP TABLE commander_capability_revocations;
      ALTER TABLE commander_capability_revocations_new RENAME TO commander_capability_revocations;
      CREATE INDEX IF NOT EXISTS commander_capability_revocations_exp_idx
        ON commander_capability_revocations (expires_at);
    `);
  }

  /**
   * Test helper: register/replace a worker row for claim/fencing contract tests.
   * `tenantIds` is the durable authz set read by worker-mode `claimNextStep`.
   * Returns the plaintext claim secret (required on worker-mode claims).
   */
  seedTestWorker(
    workerId: string,
    tenantIds: string[],
    generation = 1,
    options?: { status?: 'ACTIVE' | 'DRAINING' | 'OFFLINE'; claimSecret?: string },
  ): string {
    const status = options?.status ?? 'ACTIVE';
    const claimSecret = options?.claimSecret ?? generateWorkerClaimSecret();
    this.db.prepare(
      `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,active_steps,identity_subject,tenant_ids)
       VALUES (?,?,?,?,?,?,?,0,?,?)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status,
         generation=excluded.generation,
         tenant_ids=excluded.tenant_ids,
         last_heartbeat_at=datetime('now')`,
    ).run(
      workerId,
      'agent',
      'test',
      JSON.stringify(['agent', 'tool']),
      10,
      status,
      generation,
      workerId,
      JSON.stringify(tenantIds),
    );
    this.db.prepare(
      `INSERT INTO commander_worker_claim_secrets (worker_id, generation, secret_hash, updated_at)
       VALUES (?,?,?,datetime('now'))
       ON CONFLICT(worker_id) DO UPDATE SET
         generation=excluded.generation,
         secret_hash=excluded.secret_hash,
         updated_at=datetime('now')`,
    ).run(workerId, generation, hashWorkerClaimSecret(claimSecret));
    return claimSecret;
  }

  protected override async withTransaction<T>(
    fn: (client: SqlClient) => Promise<T>,
    tenantIds: string[] = [],
  ): Promise<T> {
    if (tenantIds.length === 0 && !this.claimSchedulerMode) {
      throw new Error('Kernel write must explicitly carry tenant scope (or use a scheduler-mode repository)');
    }
    this.db.prepare('BEGIN IMMEDIATE').run();
    const client = await this.pool.connect();
    try {
      const value = await fn(client);
      this.db.prepare('COMMIT').run();
      return value;
    } catch (error) {
      try { this.db.prepare('ROLLBACK').run(); } catch { /* preserve root cause */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resolve durable worker tenant scope (PG claim_next_step parity).
   * Returns null when fail-closed (missing/inactive/stale/empty/`*` authz).
   * Open-ended durable `*` is forbidden — do not expand.
   */
  private resolveDurableWorkerTenantScope(
    workerId: string,
    workerGeneration: number,
    claimSecret?: string,
  ): { tenantIds: string[]; openEnded: boolean } | null {
    if (!claimSecret || claimSecret.length === 0) return null;
    const secretRow = this.db.prepare(
      `SELECT secret_hash FROM commander_worker_claim_secrets WHERE worker_id = ? AND generation = ?`,
    ).get(workerId, workerGeneration) as { secret_hash: Buffer | Uint8Array } | undefined;
    if (!secretRow || !verifyWorkerClaimSecret(claimSecret, Buffer.from(secretRow.secret_hash))) {
      return null;
    }
    const worker = this.db.prepare(
      `SELECT tenant_ids, status, generation FROM commander_workers WHERE id = ?`,
    ).get(workerId) as { tenant_ids: string; status: string; generation: number } | undefined;
    if (
      !worker ||
      worker.status !== 'ACTIVE' ||
      Number(worker.generation) !== workerGeneration
    ) {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(worker.tenant_ids || '[]');
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const parsed = raw.filter((t): t is string => typeof t === 'string' && t.length > 0);
    // Product decision: durable '*' fail-closed (parity with claim_* DEFINER).
    if (parsed.includes('*')) return null;
    if (parsed.length === 0) return null;
    return { tenantIds: parsed, openEnded: false };
  }

  override async claimNextStep(request: ClaimStepRequest): Promise<KernelStep | null> {
    const now = request.now ?? new Date();
    const expiry = new Date(now.getTime() + request.leaseTtlMs);
    const token = randomUUID();
    const workerGeneration = request.workerGeneration ?? -1;
    const capabilities = request.capabilities ?? [];
    const capsJson = JSON.stringify(capabilities);

    // Worker path (PG claim_next_step parity): ignore caller tenantIds/tenantId;
    // authorize solely from durable commander_workers.tenant_ids.
    let tenantIds: string[];
    let openEnded: boolean;
    if (!this.claimSchedulerMode) {
      const scope = this.resolveDurableWorkerTenantScope(
        request.workerId,
        workerGeneration,
        request.claimSecret,
      );
      if (!scope) return null;
      tenantIds = scope.tenantIds;
      openEnded = scope.openEnded;
    } else {
      tenantIds = request.tenantIds ?? (request.tenantId ? [request.tenantId] : []);
      openEnded = tenantIds.length === 0;
    }

    const txScope = openEnded ? ['*'] : tenantIds;
    return this.withTransaction(async (client) => {
      // Re-check durable authz inside the transaction (worker-mode).
      if (!this.claimSchedulerMode) {
        const scope = this.resolveDurableWorkerTenantScope(
          request.workerId,
          workerGeneration,
          request.claimSecret,
        );
        if (!scope) return null;
        if (!scope.openEnded && scope.tenantIds.length === 0) return null;
        tenantIds = scope.tenantIds;
        openEnded = scope.openEnded;
      }

      const filterTenants = openEnded ? [] : tenantIds;
      const tenantClause = filterTenants.length === 0
        ? ''
        : ` AND s.tenant_id IN (${filterTenants.map(() => '?').join(',')})`;
      const selectSql = `SELECT s.id, s.state AS previous_state FROM commander_steps s JOIN commander_runs r ON r.id=s.run_id AND r.tenant_id=s.tenant_id
           JOIN commander_workers w ON w.id=? AND w.generation=? AND w.status='ACTIVE'
           JOIN commander_tenant_execution_usage u ON u.tenant_id=s.tenant_id
           JOIN commander_tenant_execution_control c ON c.tenant_id=s.tenant_id
           LEFT JOIN commander_tenant_execution_limits l ON l.tenant_id=s.tenant_id
           WHERE s.state IN ('PENDING','RETRY_WAIT') AND s.scheduled_at <= ?
             AND r.state IN ('PENDING','RUNNING')${tenantClause}
             AND c.paused=0
             AND (? = '[]' OR s.kind IN (SELECT value FROM json_each(?)))
             AND u.running_steps < COALESCE(l.max_concurrent_steps, 2147483647)
             AND NOT EXISTS (
               SELECT 1 FROM json_each(s.dependencies) d
               JOIN commander_steps prerequisite ON prerequisite.id=d.value AND prerequisite.tenant_id=s.tenant_id
               WHERE prerequisite.state NOT IN ('SUCCEEDED','SKIPPED')
             )
           ORDER BY u.running_steps ASC,
                    MAX(s.priority + CAST((julianday(?) - julianday(s.scheduled_at)) * 24 * 60 AS INTEGER), 1000) DESC,
                    s.scheduled_at ASC, s.created_at ASC LIMIT 1`;

      const selectValues: unknown[] = [
        request.workerId,
        workerGeneration,
        now.toISOString(),
        ...filterTenants,
        capsJson,
        capsJson,
        now.toISOString(),
      ];

      const candidate = await client.query<{ id: string; previous_state: KernelStepState }>(selectSql, selectValues);
      if (!candidate.rows[0]) return null;
      const previousState = candidate.rows[0].previous_state;
      const stepId = candidate.rows[0].id;

      const updateResult = await client.query<Record<string, unknown>>(
        `UPDATE commander_steps SET state='RUNNING', attempt=attempt+1, version=version+1,
           lease_worker_id=?, lease_worker_generation=?, lease_token=?, fencing_epoch=fencing_epoch+1, lease_expires_at=?, updated_at=?
         WHERE id=? AND state IN ('PENDING','RETRY_WAIT') RETURNING *`,
        [request.workerId, workerGeneration, token, expiry.toISOString(), now.toISOString(), stepId],
      );
      const row = updateResult.rows[0];
      if (!row) return null;
      const step = fromStepAdapter(row);
      assertStepTransition(previousState, step.state);
      await client.query(
        `UPDATE commander_tenant_execution_usage SET running_steps=running_steps+1, updated_at=? WHERE tenant_id=?`,
        [now.toISOString(), step.tenantId],
      );
      assertRunTransition('PENDING', 'RUNNING');
      await client.query(
        `UPDATE commander_runs SET state='RUNNING', version=version+1, updated_at=? WHERE id=? AND tenant_id=? AND state='PENDING'`,
        [now.toISOString(), step.runId, step.tenantId],
      );
      await this.appendEvent(client, {
        aggregateType: 'step',
        aggregateId: step.id,
        sequence: step.version,
        type: 'step.claimed',
        tenantId: step.tenantId,
        runId: step.runId,
        stepId: step.id,
        actor: request.workerId,
        payload: { attempt: step.attempt, fencingEpoch: step.lease!.fencingEpoch },
      });
      return step;
    }, txScope);
  }

  override async claimOutbox(limit: number, now = new Date()): Promise<import('./types.js').KernelOutboxMessage[]> {
    const token = randomUUID();
    const staleBefore = new Date(now.getTime() - 60_000).toISOString();
    return this.withTransaction(async (client) => {
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM commander_outbox
         WHERE published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts
           AND topic NOT IN (?, ?) AND available_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
         ORDER BY created_at LIMIT ?`,
        [KERNEL_COMPENSATION_TOPIC, LEGACY_COMPENSATION_TOPIC, now.toISOString(), staleBefore, limit],
      );
      if (candidates.rows.length === 0) return [];
      const ids = candidates.rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE commander_outbox SET claimed_at=?, claim_token=?, attempts=attempts+1
         WHERE id IN (${placeholders}) RETURNING *`,
        [now.toISOString(), token, ...ids],
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        eventId: row.event_id as string,
        tenantId: row.tenant_id as string,
        topic: row.topic as string,
        key: row.key as string,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>) ?? {},
        attempts: Number(row.attempts),
        availableAt: String(row.available_at),
        publishedAt: row.published_at ? String(row.published_at) : undefined,
        claimToken: token,
        createdAt: String(row.created_at),
      }));
    });
  }

  override async claimOutboxByTopic(
    topic: string,
    limit: number,
    now = new Date(),
    authz?: { workerId: string; workerGeneration: number; claimSecret: string },
  ): Promise<import('./types.js').KernelOutboxMessage[]> {
    const token = randomUUID();
    const staleBefore = new Date(now.getTime() - 60_000).toISOString();

    let tenantFilter: string[] | null = null;
    let txScope: string[];
    if (!this.claimSchedulerMode) {
      const workerId = authz?.workerId?.trim();
      if (!workerId) {
        throw new Error('claimOutboxByTopic requires workerId on the worker LOGIN path');
      }
      if (typeof authz?.workerGeneration !== 'number' || !Number.isFinite(authz.workerGeneration)) {
        throw new Error('claimOutboxByTopic requires finite workerGeneration on the worker LOGIN path');
      }
      if (!authz.claimSecret) {
        throw new Error('claimOutboxByTopic requires claimSecret on the worker LOGIN path');
      }
      const scope = this.resolveDurableWorkerTenantScope(
        workerId,
        authz.workerGeneration,
        authz.claimSecret,
      );
      if (!scope) return [];
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
      if (tenantFilter !== null && tenantFilter.length === 0) return [];
      txScope = scope.openEnded ? ['*'] : scope.tenantIds;
    } else {
      txScope = ['*'];
    }

    return this.withTransaction(async (client) => {
      const candidates = await client.query<{ id: string }>(
        tenantFilter === null
          ? `SELECT id FROM commander_outbox
             WHERE topic=? AND published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts
               AND available_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
             ORDER BY created_at LIMIT ?`
          : `SELECT id FROM commander_outbox
             WHERE topic=? AND published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts
               AND available_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
               AND tenant_id IN (${tenantFilter.map(() => '?').join(',')})
             ORDER BY created_at LIMIT ?`,
        tenantFilter === null
          ? [topic, now.toISOString(), staleBefore, limit]
          : [topic, now.toISOString(), staleBefore, ...tenantFilter, limit],
      );
      if (candidates.rows.length === 0) return [];
      const ids = candidates.rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE commander_outbox SET claimed_at=?, claim_token=?, attempts=attempts+1
         WHERE id IN (${placeholders}) RETURNING *`,
        [now.toISOString(), token, ...ids],
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        eventId: row.event_id as string,
        tenantId: row.tenant_id as string,
        topic: row.topic as string,
        key: row.key as string,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>) ?? {},
        attempts: Number(row.attempts),
        availableAt: String(row.available_at),
        publishedAt: row.published_at ? String(row.published_at) : undefined,
        claimToken: token,
        createdAt: String(row.created_at),
      }));
    }, txScope);
  }

  override async claimReconcileEffects(input: import('./types.js').ClaimReconcileEffectsInput): Promise<import('./types.js').ClaimedReconcileEffect[]> {
    const at = input.now ?? new Date();
    const claimTtlMs = input.claimTtlMs ?? 60_000;
    const claimToken = randomUUID();
    const claimExpiresAt = new Date(at.getTime() + claimTtlMs).toISOString();
    const workerGeneration = input.workerGeneration ?? -1;

    // Worker path (PG claim_reconcile_effects parity): authorize solely from
    // durable commander_workers.tenant_ids — fail-closed when missing/empty/stale.
    let tenantFilter: string[] | null = null; // null = open-ended (*)
    let txScope: string[];
    if (!this.claimSchedulerMode) {
      const workerId = input.workerId?.trim();
      if (!workerId) {
        throw new Error('claimReconcileEffects requires workerId on the worker LOGIN path');
      }
      const scope = this.resolveDurableWorkerTenantScope(
        workerId,
        workerGeneration,
        input.claimSecret,
      );
      if (!scope) return [];
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
      if (tenantFilter !== null && tenantFilter.length === 0) return [];
      txScope = scope.openEnded ? ['*'] : scope.tenantIds;
    } else {
      txScope = ['*'];
    }

    return this.withTransaction(async (client) => {
      if (!this.claimSchedulerMode) {
        const workerId = input.workerId!.trim();
        const scope = this.resolveDurableWorkerTenantScope(
          workerId,
          workerGeneration,
          input.claimSecret,
        );
        if (!scope) return [];
        tenantFilter = scope.openEnded ? null : scope.tenantIds;
        if (tenantFilter !== null && tenantFilter.length === 0) return [];
      }

      const filterTenants = tenantFilter ?? [];
      const tenantClause = tenantFilter === null
        ? ''
        : ` AND tenant_id IN (${filterTenants.map(() => '?').join(',')})`;
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM commander_effects
         WHERE state='COMPLETION_UNKNOWN' AND reconcile_escalated_at IS NULL
           AND reconcile_after IS NOT NULL AND reconcile_after <= ?
           AND (reconcile_claim_expires_at IS NULL OR reconcile_claim_expires_at < ?)${tenantClause}
         ORDER BY reconcile_after ASC LIMIT ?`,
        [at.toISOString(), at.toISOString(), ...filterTenants, input.limit],
      );
      if (candidates.rows.length === 0) return [];
      const ids = candidates.rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE commander_effects SET reconcile_claim_token=?, reconcile_claim_expires_at=?
         WHERE id IN (${placeholders}) RETURNING *`,
        [claimToken, claimExpiresAt, ...ids],
      );
      return result.rows.map((row) => ({
        effect: {
          id: row.id as string,
          runId: row.run_id as string,
          stepId: row.step_id as string,
          tenantId: row.tenant_id as string,
          type: row.type as string,
          idempotencyKey: row.idempotency_key as string,
          policyDecisionId: row.policy_decision_id as string,
          policySnapshotId: (row.policy_snapshot_id as string) || 'legacy-unbound',
          actionDigest: (row.action_digest as string) || (row.request_hash as string),
          leaseWorkerId: (row.lease_worker_id as string) || 'legacy-unbound',
          leaseWorkerGeneration: Number(row.lease_worker_generation ?? 0),
          leaseFencingEpoch: Number(row.lease_fencing_epoch ?? 0),
          state: row.state as import('./types.js').KernelEffect['state'],
          requestHash: row.request_hash as string,
          request: typeof row.request === 'string' ? JSON.parse(row.request) : row.request as Record<string, unknown>,
          response: row.response ? (typeof row.response === 'string' ? JSON.parse(row.response) : row.response as Record<string, unknown>) : undefined,
          createdAt: String(row.created_at),
          completedAt: row.completed_at ? String(row.completed_at) : undefined,
          reconcileAttempts: Number(row.reconcile_attempts ?? 0),
          reconcileAfter: row.reconcile_after ? String(row.reconcile_after) : null,
          reconcileClaimToken: (row.reconcile_claim_token as string | null) ?? null,
          reconcileClaimExpiresAt: row.reconcile_claim_expires_at ? String(row.reconcile_claim_expires_at) : null,
          reconcileLastError: row.reconcile_last_error ? (typeof row.reconcile_last_error === 'string' ? JSON.parse(row.reconcile_last_error) : row.reconcile_last_error as Record<string, unknown>) : null,
          reconcileEscalatedAt: row.reconcile_escalated_at ? String(row.reconcile_escalated_at) : null,
        },
        claimToken,
      }));
    }, txScope);
  }

  override async claimExpiredTimers(now: Date = new Date(), limit: number = 100): Promise<import('./types.js').KernelTimer[]> {
    const claimToken = randomUUID();
    const staleBefore = new Date(now.getTime() - 60_000).toISOString();
    return this.withTransaction(async (client) => {
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM commander_timers
         WHERE (state='PENDING' OR (state='PROCESSING' AND claimed_at <= ?)) AND fires_at <= ?
         ORDER BY fires_at LIMIT ?`,
        [staleBefore, now.toISOString(), limit],
      );
      if (candidates.rows.length === 0) return [];
      const ids = candidates.rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE commander_timers SET state='PROCESSING', claim_token=?, claimed_at=?
         WHERE id IN (${placeholders}) RETURNING *`,
        [claimToken, now.toISOString(), ...ids],
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        runId: row.run_id as string,
        stepId: row.step_id as string,
        tenantId: row.tenant_id as string,
        firesAt: String(row.fires_at),
        timerType: row.timer_type as import('./types.js').KernelTimer['timerType'],
        state: row.state as import('./types.js').KernelTimer['state'],
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>) ?? {},
        createdAt: String(row.created_at),
        firedAt: row.fired_at ? String(row.fired_at) : undefined,
        claimToken: row.claim_token as string | undefined,
      }));
    });
  }
}
