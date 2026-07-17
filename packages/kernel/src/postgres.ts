import { createHash, randomUUID } from 'node:crypto';
import type { KernelRepository } from './repository.js';
import type {
  AdmitEffectRequest,
  AdmitEffectResult,
  AnswerInteractionRequest,
  ClaimStepRequest,
  CompleteStepRequest,
  CreateInteractionRequest,
  CreateKernelRun,
  CreateTimerRequest,
  FailStepRequest,
  KernelDlqEntry,
  KernelEffect,
  KernelEvent,
  KernelInteraction,
  KernelLease,
  KernelOutboxMessage,
  KernelRun,
  KernelRunState,
  KernelStep,
  KernelStepState,
  KernelTimer,
  MarkEffectCompletionUnknownRequest,
  ReconcileEffectRequest,
  TenantExecutionControl,
} from './types.js';
import { KernelInvariantError } from './types.js';
import { assertRunTransition, assertStepTransition } from './transitionValidation.js';

/** Minimal pg-compatible interfaces; callers can inject pg.Pool without a hard runtime coupling. */
export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult<T>>;
  release(): void | Promise<void>;
}
export interface SqlPool {
  connect(): Promise<SqlClient>;
}

/**
 * Wrap a pool so every non-scheduler connection is downgraded to the
 * least-privilege `commander_app` role. This guarantees that application
 * queries are evaluated against the tenant isolation policies even when the
 * connection string still authenticates as the migration owner.
 *
 * If the `commander_app` role does not exist (legacy / test environments) the
 * wrapper logs a warning once and continues without downgrading.
 */
function enforceAppRole(pool: SqlPool): SqlPool {
  let state: 'unchecked' | 'exists' | 'missing' = 'unchecked';
  let warned = false;

  return {
    connect: async () => {
      const client = await pool.connect();

      if (state === 'unchecked') {
        try {
          const result = await client.query<{ exists: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') AS exists"
          );
          state = result.rows[0]?.exists ? 'exists' : 'missing';
        } catch {
          state = 'missing';
        }
      }

      if (state === 'exists') {
        try {
          await client.query('SET ROLE commander_app');
        } catch (err) {
          throw new Error(
            `PostgresKernelRepository failed to SET ROLE commander_app: ${(err as Error).message}`
          );
        }
      } else if (state === 'missing') {
        // AUTH-7: without the commander_app downgrade, application queries run as
        // the (BYPASSRLS) migration owner and tenant isolation is silently off.
        // Fail closed in production rather than degrade to a cross-tenant read.
        // COMMANDER_ALLOW_RLS_BYPASS=1 is an explicit, documented escape hatch
        // for single-tenant/legacy deployments that intentionally lack the role.
        const bypassAllowed =
          process.env.NODE_ENV !== 'production' ||
          ['1', 'true', 'yes'].includes(
            (process.env.COMMANDER_ALLOW_RLS_BYPASS ?? '').toLowerCase(),
          );
        if (!bypassAllowed) {
          await client.release();
          throw new Error(
            '[PostgresKernelRepository] commander_app role not found in production. ' +
              'Refusing to run application queries as the migration owner (RLS would be bypassed). ' +
              'Create the commander_app role, or set COMMANDER_ALLOW_RLS_BYPASS=1 to explicitly accept the risk.',
          );
        }
        if (!warned) {
          warned = true;
          console.warn(
            '[PostgresKernelRepository] commander_app role not found; continuing without role downgrade. ' +
              'Application queries may bypass RLS if connected as the migration owner.'
          );
        }
      }

      return {
        query: client.query.bind(client),
        release: async () => {
          if (state === 'exists') {
            try {
              await client.query('SET ROLE NONE');
            } catch {
              // Ignore reset errors; the connection is being released anyway.
            }
          }
          client.release();
        },
      };
    },
  };
}

type DbRun = Omit<KernelRun, 'createdAt' | 'updatedAt' | 'pausedAt' | 'terminalAt'> & {
  created_at: string | Date;
  updated_at: string | Date;
  paused_at: string | Date | null;
  terminal_at: string | Date | null;
  tenant_id: string;
  intent_hash: string;
  work_graph_hash: string;
  work_graph_version: string;
  policy_snapshot_id: string;
};
type DbStep = Omit<KernelStep, 'createdAt' | 'updatedAt' | 'scheduledAt' | 'runId' | 'tenantId' | 'maxAttempts'> & {
  run_id: string;
  tenant_id: string;
  max_attempts: number;
  scheduled_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
  lease_worker_id: string | null;
  lease_worker_generation: number;
  lease_token: string | null;
  fencing_epoch: number;
  lease_expires_at: string | Date | null;
};
type DbEffect = Omit<KernelEffect, 'runId' | 'stepId' | 'tenantId' | 'idempotencyKey' | 'policyDecisionId' | 'createdAt' | 'completedAt'> & {
  run_id: string; step_id: string; tenant_id: string; idempotency_key: string; request_hash: string; policy_decision_id: string;
  created_at: string | Date; completed_at: string | Date | null;
};
type DbTenantExecutionControl = {
  tenant_id: string;
  paused: boolean;
  generation: number | string;
  actor: string;
  reason: string | null;
  paused_at: string | Date | null;
  resumed_at: string | Date | null;
};

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function json(value: unknown): string { return JSON.stringify(value ?? {}); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function requestHash(value: Record<string, unknown>): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function fromTenantExecutionControl(row: DbTenantExecutionControl): TenantExecutionControl {
  return {
    tenantId: row.tenant_id,
    paused: row.paused,
    generation: Number(row.generation),
    actor: row.actor,
    reason: row.reason ?? undefined,
    pausedAt: row.paused_at ? iso(row.paused_at) : undefined,
    resumedAt: row.resumed_at ? iso(row.resumed_at) : undefined,
  };
}
function fromRun(row: DbRun): KernelRun {
  return { id: row.id, tenantId: row.tenant_id, intentHash: row.intent_hash, workGraphHash: row.work_graph_hash,
    workGraphVersion: row.work_graph_version, state: row.state, version: Number(row.version), policySnapshotId: row.policy_snapshot_id,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), pausedAt: row.paused_at ? iso(row.paused_at) : undefined,
    terminalAt: row.terminal_at ? iso(row.terminal_at) : undefined, metadata: row.metadata ?? {} };
}
function fromStep(row: DbStep): KernelStep {
  const lease = row.lease_token && row.lease_worker_id && row.lease_expires_at
    ? { workerId: row.lease_worker_id, workerGeneration: Number(row.lease_worker_generation ?? 0), token: row.lease_token, fencingEpoch: Number(row.fencing_epoch), expiresAt: iso(row.lease_expires_at) }
    : undefined;
  return { id: row.id, runId: row.run_id, tenantId: row.tenant_id, kind: row.kind, state: row.state,
    version: Number(row.version), attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts), priority: Number(row.priority),
    dependencies: row.dependencies ?? [], input: row.input ?? {}, output: row.output ?? undefined, error: row.error ?? undefined,
    scheduledAt: iso(row.scheduled_at), lease, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function fromEffect(row: DbEffect): KernelEffect {
  return { id: row.id, runId: row.run_id, stepId: row.step_id, tenantId: row.tenant_id, type: row.type,
    idempotencyKey: row.idempotency_key, policyDecisionId: row.policy_decision_id, state: row.state,
    requestHash: row.request_hash, request: row.request ?? {}, response: row.response ?? undefined, createdAt: iso(row.created_at), completedAt: row.completed_at ? iso(row.completed_at) : undefined };
}

export interface PostgresKernelRepositoryOptions {
  /**
   * When true, the repository may perform cross-tenant operations such as
   * reclaiming expired leases, sweeping the outbox DLQ, and claiming timers.
   * The backing connection must be authenticated as the commander_scheduler
   * role, which has BYPASSRLS. API replicas must leave this false.
   */
  schedulerMode?: boolean;
}

/** Shared PostgreSQL implementation. No fallback exists: inability to connect is an operational failure. */
export class PostgresKernelRepository implements KernelRepository {
  private readonly pool: SqlPool;

  constructor(
    pool: SqlPool,
    private readonly options: PostgresKernelRepositoryOptions = {},
  ) {
    // Scheduler/recovery pools are assumed to authenticate as commander_scheduler
    // (BYPASSRLS). All other pools are downgraded to commander_app so that every
    // application query is subject to tenant isolation policies.
    this.pool = options.schedulerMode ? pool : enforceAppRole(pool);
  }

  async initialize(): Promise<void> {
    // Migrations are applied by the dedicated migration job (packages/kernel/src/migrate.ts)
    // or by test harnesses that explicitly call runKernelMigrations(). API replicas must not
    // bootstrap the schema, so this method is intentionally a no-op.
  }

  async createRun(command: CreateKernelRun, actor: string): Promise<KernelRun> {
    this.assertGraph(command);
    return this.withTransaction(async (client) => {
      let created: SqlQueryResult<DbRun>;
      try {
        created = await client.query<DbRun>(
          `INSERT INTO commander_runs (id, tenant_id, intent_hash, work_graph_hash, work_graph_version, policy_snapshot_id, state, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7::jsonb) RETURNING *`,
          [command.id, command.tenantId, command.intentHash, command.workGraphHash, command.workGraphVersion, command.policySnapshotId, json(command.metadata)],
        );
      } catch (error) {
        if ((error as { code?: string; constraint?: string }).code === '23505') {
          throw new KernelInvariantError('DUPLICATE_RUN', `Run ${command.id} already exists`);
        }
        throw error;
      }
      const run = fromRun(created.rows[0]!);
      await client.query(`INSERT INTO commander_tenant_execution_usage (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [command.tenantId]);
      await client.query(
        `INSERT INTO commander_tenant_execution_control (tenant_id, actor)
         VALUES ($1, 'kernel') ON CONFLICT DO NOTHING`,
        [command.tenantId],
      );
      try {
        for (const step of command.steps) {
          await client.query(
            `INSERT INTO commander_steps (id, run_id, tenant_id, kind, state, max_attempts, priority, dependencies, input, scheduled_at)
             VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7::jsonb,$8::jsonb,$9)`,
            [step.id, command.id, command.tenantId, step.kind, step.maxAttempts ?? 1, step.priority ?? 0, json(step.dependencies ?? []), json(step.input), step.scheduledAt ?? new Date().toISOString()],
          );
        }
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new KernelInvariantError('DUPLICATE_STEP', `A step in run ${command.id} already exists`);
        throw error;
      }
      await this.appendEvent(client, { aggregateType: 'run', aggregateId: command.id, sequence: 1, type: 'run.created', tenantId: command.tenantId, runId: command.id, actor, payload: { workGraphHash: command.workGraphHash, stepCount: command.steps.length } });
      return run;
    }, [command.tenantId]);
  }

  async setTenantConcurrencyLimit(tenantId: string, maxConcurrentSteps: number): Promise<void> {
    if (!Number.isInteger(maxConcurrentSteps) || maxConcurrentSteps <= 0) {
      throw new Error('maxConcurrentSteps must be a positive integer');
    }
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO commander_tenant_execution_usage (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO commander_tenant_execution_limits (tenant_id,max_concurrent_steps) VALUES ($1,$2)
         ON CONFLICT (tenant_id) DO UPDATE SET max_concurrent_steps=EXCLUDED.max_concurrent_steps, updated_at=now()`,
        [tenantId, maxConcurrentSteps],
      );
    }, [tenantId]);
  }

  async getRun(runId: string, tenantId: string): Promise<KernelRun | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbRun>('SELECT * FROM commander_runs WHERE id=$1 AND tenant_id=$2', [runId, tenantId]);
      return result.rows[0] ? fromRun(result.rows[0]) : null;
    }, [tenantId]);
  }
  async getStep(stepId: string, tenantId: string): Promise<KernelStep | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep>('SELECT * FROM commander_steps WHERE id=$1 AND tenant_id=$2', [stepId, tenantId]);
      return result.rows[0] ? fromStep(result.rows[0]) : null;
    }, [tenantId]);
  }

  async claimNextStep(request: ClaimStepRequest): Promise<KernelStep | null> {
    const now = request.now ?? new Date();
    const expiry = new Date(now.getTime() + request.leaseTtlMs);
    const token = randomUUID();
    const workerGeneration = request.workerGeneration ?? -1;
    const tenantIds = request.tenantIds ?? (request.tenantId ? [request.tenantId] : []);
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep & { previous_state: KernelStepState }>(
        `WITH candidate AS (
           SELECT s.id, s.state AS previous_state FROM commander_steps s JOIN commander_runs r ON r.id=s.run_id AND r.tenant_id=s.tenant_id
           JOIN commander_workers w ON w.id=$4 AND w.generation=$5 AND w.status='ACTIVE'
           JOIN commander_tenant_execution_usage u ON u.tenant_id=s.tenant_id
           JOIN commander_tenant_execution_control c ON c.tenant_id=s.tenant_id
           LEFT JOIN commander_tenant_execution_limits l ON l.tenant_id=s.tenant_id
           WHERE s.state IN ('PENDING','RETRY_WAIT') AND s.scheduled_at <= $1
             AND r.state IN ('PENDING','RUNNING') AND (cardinality($2::text[]) = 0 OR s.tenant_id = ANY($2::text[]))
             AND c.paused=false
             AND (cardinality($3::text[]) = 0 OR s.kind = ANY($3::text[]))
             AND u.running_steps < COALESCE(l.max_concurrent_steps, 2147483647)
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(s.dependencies) d
               JOIN commander_steps prerequisite ON prerequisite.id=d.value AND prerequisite.tenant_id=s.tenant_id
               WHERE prerequisite.state NOT IN ('SUCCEEDED','SKIPPED')
             )
           ORDER BY u.running_steps ASC,
                    -- Aging: boost priority by +1 per minute of waiting, capped at 1000.
                    -- This prevents starvation: even a priority=-1000 step will eventually
                    -- outrank new steps after enough time.
                    GREATEST(s.priority + FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - s.scheduled_at)) / 60), 1000) DESC,
                    s.scheduled_at ASC, s.created_at ASC FOR UPDATE OF s, u, c SKIP LOCKED LIMIT 1
         ), claimed AS (
           UPDATE commander_steps s SET state='RUNNING', attempt=s.attempt+1, version=s.version+1,
             lease_worker_id=$4, lease_worker_generation=$5, lease_token=$6, fencing_epoch=s.fencing_epoch+1, lease_expires_at=$7, updated_at=$1
           FROM candidate WHERE s.id=candidate.id RETURNING s.*, candidate.previous_state
         ) SELECT * FROM claimed`, [now.toISOString(), tenantIds, request.capabilities ?? [], request.workerId, workerGeneration, token, expiry.toISOString()]);
      const row = result.rows[0];
      if (!row) return null;
      const step = fromStep(row);
      assertStepTransition(row.previous_state, step.state);
      await client.query(
        `UPDATE commander_tenant_execution_usage SET running_steps=running_steps+1, updated_at=$1 WHERE tenant_id=$2`,
        [now.toISOString(), step.tenantId],
      );
      assertRunTransition('PENDING', 'RUNNING');
      await client.query(`UPDATE commander_runs SET state='RUNNING', version=version+1, updated_at=$1 WHERE id=$2 AND tenant_id=$3 AND state='PENDING'`, [now.toISOString(), step.runId, step.tenantId]);
      await this.appendEvent(client, { aggregateType: 'step', aggregateId: step.id, sequence: step.version, type: 'step.claimed', tenantId: step.tenantId, runId: step.runId, stepId: step.id, actor: request.workerId, payload: { attempt: step.attempt, fencingEpoch: step.lease!.fencingEpoch } });
      return step;
    }, tenantIds);
  }

  async heartbeatStep(stepId: string, tenantId: string, lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>, leaseTtlMs: number): Promise<KernelStep | null> {
    const expiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep>(
        `UPDATE commander_steps SET lease_expires_at=$1, updated_at=now()
         WHERE id=$2 AND tenant_id=$3 AND state='RUNNING' AND lease_worker_id=$4 AND lease_worker_generation=$5 AND lease_token=$6 AND fencing_epoch=$7 AND lease_expires_at > now()
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
         RETURNING *`,
        [expiresAt, stepId, tenantId, lease.workerId, lease.workerGeneration ?? -1, lease.token, lease.fencingEpoch]);
      return result.rows[0] ? fromStep(result.rows[0]) : null;
    }, [tenantId]);
  }

  async reclaimExpiredLeases(now = new Date(), limit = 100): Promise<KernelStep[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep>(
        `WITH expired AS (
           SELECT id FROM commander_steps WHERE state='RUNNING' AND lease_expires_at <= $1
           ORDER BY lease_expires_at ASC FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE commander_steps s SET
           state=CASE WHEN s.attempt < s.max_attempts THEN 'RETRY_WAIT' ELSE 'FAILED' END,
           scheduled_at=CASE WHEN s.attempt < s.max_attempts THEN $1 ELSE s.scheduled_at END,
           error=jsonb_build_object('code','LEASE_EXPIRED','message','Worker lease expired before terminal transition','retryable', s.attempt < s.max_attempts),
           version=s.version+1, updated_at=$1, lease_worker_id=NULL, lease_worker_generation=0, lease_token=NULL, lease_expires_at=NULL
         FROM expired WHERE s.id=expired.id RETURNING s.*`, [now.toISOString(), limit]);
      const reclaimed = result.rows.map(fromStep);
      for (const step of reclaimed) {
        assertStepTransition('RUNNING', step.state);
        await this.releaseTenantSlot(client, step.tenantId);
        const retryable = step.state === 'RETRY_WAIT';
        await this.appendEvent(client, { aggregateType: 'step', aggregateId: step.id, sequence: step.version, type: retryable ? 'step.lease_expired_requeued' : 'step.lease_expired_failed', tenantId: step.tenantId, runId: step.runId, stepId: step.id, actor: 'kernel.recovery', payload: { attempt: step.attempt } });
        const uncertain = await client.query<{ id: string }>(
          `UPDATE commander_effects SET
             state='COMPLETION_UNKNOWN', response=jsonb_build_object('reason','lease_expired')
           WHERE step_id=$1 AND tenant_id=$2 AND state='ADMITTED'
           RETURNING id`,
          [step.id, step.tenantId],
        );
        for (const effect of uncertain.rows) {
          await this.appendEvent(client, {
            aggregateType: 'effect', aggregateId: effect.id, sequence: 2,
            type: 'effect.completion_unknown', tenantId: step.tenantId,
            runId: step.runId, stepId: step.id, actor: 'kernel.recovery',
            payload: { reason: 'lease_expired' },
          });
        }
        if (!retryable) {
          const completed = await client.query<{ id: string }>(
            `SELECT id FROM commander_effects
             WHERE run_id=$1 AND tenant_id=$2 AND state='COMPLETED'
             ORDER BY created_at DESC`,
            [step.runId, step.tenantId],
          );
          if (completed.rows.length > 0) {
            const runState = await this.lockRunState(client, step.runId, step.tenantId);
            if (runState && runState !== 'COMPENSATING') {
              assertRunTransition(runState, 'COMPENSATING');
              const updated = await client.query<DbRun>(
                `UPDATE commander_runs SET state='COMPENSATING', version=version+1, updated_at=$1
                 WHERE id=$2 AND tenant_id=$3 RETURNING *`,
                [now.toISOString(), step.runId, step.tenantId],
              );
              const run = fromRun(updated.rows[0]!);
              const source = result.rows.find((row) => row.id === step.id);
              await this.appendEvent(client, {
                aggregateType: 'run', aggregateId: run.id, sequence: run.version,
                type: 'run.compensating', tenantId: run.tenantId,
                runId: run.id, stepId: step.id, actor: 'kernel.recovery',
                payload: { fencingEpoch: Number(source?.fencing_epoch ?? 0) },
              });
              const compensationKey = `${run.tenantId}/${run.id}/${Number(source?.fencing_epoch ?? 0)}`;
              await this.appendEvent(client, {
                aggregateType: 'effect', aggregateId: `compensation:${compensationKey}`, sequence: 1,
                type: 'kernel.compensation.requested', tenantId: run.tenantId,
                runId: run.id, stepId: step.id, actor: 'kernel.recovery',
                payload: {
                  effectIds: completed.rows.map((effect) => effect.id),
                  fencingEpoch: Number(source?.fencing_epoch ?? 0),
                },
              }, compensationKey);
            }
          } else {
            await this.finishRunIfTerminal(client, step.runId, step.tenantId, 'kernel.recovery');
          }
        }
      }
      return reclaimed;
    });
  }

  async completeStep(request: CompleteStepRequest): Promise<KernelStep | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep>(
        `UPDATE commander_steps SET state='SUCCEEDED', output=$1::jsonb, version=version+1, updated_at=now(), lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=$2 AND tenant_id=$3 AND state='RUNNING' AND version=$4 AND lease_worker_id=$5 AND lease_worker_generation=$6 AND lease_token=$7 AND fencing_epoch=$8 AND lease_expires_at > now()
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$5 AND w.generation=$6)
         RETURNING *`,
        [json(request.output), request.stepId, request.tenantId, request.expectedVersion, request.lease.workerId, request.lease.workerGeneration ?? -1, request.lease.token, request.lease.fencingEpoch]);
      if (!result.rows[0]) return null;
      const step = fromStep(result.rows[0]);
      assertStepTransition('RUNNING', step.state);
      await this.releaseTenantSlot(client, step.tenantId);
      await this.appendEvent(client, { aggregateType: 'step', aggregateId: step.id, sequence: step.version, type: 'step.succeeded', tenantId: step.tenantId, runId: step.runId, stepId: step.id, actor: request.actor, payload: { attempt: step.attempt } });
      await this.finishRunIfTerminal(client, step.runId, step.tenantId, request.actor);
      return step;
    }, [request.tenantId]);
  }

  async failStep(request: FailStepRequest): Promise<KernelStep | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep>(
        `UPDATE commander_steps SET
           state=CASE WHEN $1::boolean AND attempt < max_attempts THEN 'RETRY_WAIT' ELSE 'FAILED' END,
           error=$2::jsonb,
           scheduled_at=CASE WHEN $1::boolean AND attempt < max_attempts THEN $3 ELSE scheduled_at END,
           version=version+1, updated_at=now(), lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=$4 AND tenant_id=$5 AND state='RUNNING' AND version=$6 AND lease_worker_id=$7 AND lease_worker_generation=$8 AND lease_token=$9 AND fencing_epoch=$10 AND lease_expires_at > now()
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$7 AND w.generation=$8)
         RETURNING *`,
        [request.error.retryable && Boolean(request.retryAt), json(request.error), request.retryAt?.toISOString() ?? null, request.stepId, request.tenantId, request.expectedVersion, request.lease.workerId, request.lease.workerGeneration ?? -1, request.lease.token, request.lease.fencingEpoch]);
      if (!result.rows[0]) return null;
      const step = fromStep(result.rows[0]);
      assertStepTransition('RUNNING', step.state);
      await this.releaseTenantSlot(client, step.tenantId);
      await this.appendEvent(client, { aggregateType: 'step', aggregateId: step.id, sequence: step.version, type: step.state === 'RETRY_WAIT' ? 'step.retry_scheduled' : 'step.failed', tenantId: step.tenantId, runId: step.runId, stepId: step.id, actor: request.actor, payload: { error: request.error } });
      if (step.state === 'FAILED') await this.finishRunIfTerminal(client, step.runId, step.tenantId, request.actor);
      return step;
    }, [request.tenantId]);
  }

  async wakeRetryStep(stepId: string, tenantId: string, actor: string): Promise<KernelStep | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep>(
        `UPDATE commander_steps SET scheduled_at=now(), version=version+1, updated_at=now(), lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND state='RETRY_WAIT' RETURNING *`,
        [stepId, tenantId],
      );
      if (!result.rows[0]) return null;
      const step = fromStep(result.rows[0]);
      await this.appendEvent(client, { aggregateType: 'step', aggregateId: step.id, sequence: step.version, type: 'step.retry_woken', tenantId: step.tenantId, runId: step.runId, stepId: step.id, actor, payload: {} });
      return step;
    }, [tenantId]);
  }

  async failStepByTimer(stepId: string, tenantId: string, error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }, actor: string): Promise<KernelStep | null> {
    return this.withTransaction(async (client) => {
      const previous = await client.query<{ state: KernelStepState }>(
        `SELECT state FROM commander_steps
         WHERE id=$1 AND tenant_id=$2 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED')
         FOR UPDATE`,
        [stepId, tenantId],
      );
      const previousState = previous.rows[0]?.state;
      if (!previousState) return null;
      assertStepTransition(previousState, 'FAILED');
      const result = await client.query<DbStep>(
        `UPDATE commander_steps SET state='FAILED', error=$1::jsonb, version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=$2 AND tenant_id=$3 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED') RETURNING *`,
        [json(error), stepId, tenantId],
      );
      if (!result.rows[0]) return null;
      const step = fromStep(result.rows[0]);
      if (previousState === 'RUNNING') await this.releaseTenantSlot(client, step.tenantId);
      await this.appendEvent(client, { aggregateType: 'step', aggregateId: step.id, sequence: step.version, type: 'step.failed', tenantId: step.tenantId, runId: step.runId, stepId: step.id, actor, payload: { error } });
      await this.finishRunIfTerminal(client, step.runId, step.tenantId, actor);
      return step;
    }, [tenantId]);
  }

  async pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.withTransaction(async (client) => {
      const previousRunState = await this.lockRunState(client, runId, tenantId);
      if (!previousRunState || !['PENDING', 'RUNNING'].includes(previousRunState)) return null;
      assertRunTransition(previousRunState, 'PAUSED');
      const runResult = await client.query<DbRun>(
        `UPDATE commander_runs SET state='PAUSED', version=version+1, updated_at=now(), paused_at=now()
         WHERE id=$1 AND tenant_id=$2 AND state IN ('PENDING','RUNNING') RETURNING *`,
        [runId, tenantId],
      );
      if (!runResult.rows[0]) return null;
      const run = fromRun(runResult.rows[0]);
      assertStepTransition('RUNNING', 'RETRY_WAIT');
      const pausedSteps = await client.query<DbStep>(
        `UPDATE commander_steps SET state='RETRY_WAIT', version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE run_id=$1 AND tenant_id=$2 AND state='RUNNING' RETURNING *`,
        [runId, tenantId],
      );
      for (const row of pausedSteps.rows) {
        const step = fromStep(row);
        await this.releaseTenantSlot(client, step.tenantId);
        await this.appendEvent(client, { aggregateType: 'step', aggregateId: step.id, sequence: step.version, type: 'step.paused', tenantId: step.tenantId, runId: step.runId, stepId: step.id, actor, payload: { previousState: 'RUNNING' } });
      }
      await this.appendEvent(client, { aggregateType: 'run', aggregateId: run.id, sequence: run.version, type: 'run.paused', tenantId, runId, actor, payload: {} });
      return run;
    }, [tenantId]);
  }

  async resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.withTransaction(async (client) => {
      const previousRunState = await this.lockRunState(client, runId, tenantId);
      if (previousRunState !== 'PAUSED') return null;
      assertRunTransition(previousRunState, 'RUNNING');
      const runResult = await client.query<DbRun>(
        `UPDATE commander_runs SET state='RUNNING', version=version+1, updated_at=now(), paused_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND state='PAUSED' RETURNING *`,
        [runId, tenantId],
      );
      if (!runResult.rows[0]) return null;
      const run = fromRun(runResult.rows[0]);
      await this.appendEvent(client, { aggregateType: 'run', aggregateId: run.id, sequence: run.version, type: 'run.resumed', tenantId, runId, actor, payload: {} });
      return run;
    }, [tenantId]);
  }

  async cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.withTransaction(async (client) => {
      const previousRunState = await this.lockRunState(client, runId, tenantId);
      if (!previousRunState || !['PENDING', 'RUNNING', 'PAUSED'].includes(previousRunState)) return null;
      assertRunTransition(previousRunState, 'CANCELLED');
      const previousSteps = await this.lockStepStates(client, runId, tenantId);
      for (const step of previousSteps) {
        if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
          assertStepTransition(step.state, 'CANCELLED');
        }
      }
      const previousStepStates = new Map(previousSteps.map((step) => [step.id, step.state]));
      const runResult = await client.query<DbRun>(
        `UPDATE commander_runs SET state='CANCELLED', version=version+1, updated_at=now(), terminal_at=now()
         WHERE id=$1 AND tenant_id=$2 AND state IN ('PENDING','RUNNING','PAUSED') RETURNING *`,
        [runId, tenantId],
      );
      if (!runResult.rows[0]) return null;
      const run = fromRun(runResult.rows[0]);
      const cancelledSteps = await client.query<DbStep>(
        `UPDATE commander_steps SET state='CANCELLED', version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE run_id=$1 AND tenant_id=$2 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED') RETURNING *`,
        [runId, tenantId],
      );
      for (const row of cancelledSteps.rows) {
        const step = fromStep(row);
        await this.releaseTenantSlot(client, step.tenantId);
        await this.appendEvent(client, { aggregateType: 'step', aggregateId: step.id, sequence: step.version, type: 'step.cancelled', tenantId: step.tenantId, runId: step.runId, stepId: step.id, actor, payload: { previousState: previousStepStates.get(step.id) } });
      }
      await this.appendEvent(client, { aggregateType: 'run', aggregateId: run.id, sequence: run.version, type: 'run.cancelled', tenantId, runId, actor, payload: {} });
      return run;
    }, [tenantId]);
  }

  async pauseTenant(tenantId: string, actor: string, reason?: string): Promise<TenantExecutionControl> {
    return this.withTransaction(async (client) => {
      const controlResult = await client.query<DbTenantExecutionControl>(
        `INSERT INTO commander_tenant_execution_control
           (tenant_id, paused, generation, actor, reason, paused_at, resumed_at, updated_at)
         VALUES ($1, true, 1, $2, $3, now(), NULL, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           paused=true,
           generation=commander_tenant_execution_control.generation+1,
           actor=EXCLUDED.actor,
           reason=EXCLUDED.reason,
           paused_at=now(),
           resumed_at=NULL,
           updated_at=now()
         RETURNING *`,
        [tenantId, actor, reason ?? null],
      );
      assertStepTransition('RUNNING', 'RETRY_WAIT');
      const affected = await client.query<DbStep>(
        `UPDATE commander_steps SET
           state='RETRY_WAIT', scheduled_at=now(), version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_worker_generation=0, lease_token=NULL, lease_expires_at=NULL
         WHERE tenant_id=$1 AND state='RUNNING'
         RETURNING *`,
        [tenantId],
      );
      if (affected.rows.length > 0) {
        await client.query(
          `UPDATE commander_tenant_execution_usage SET
             running_steps=GREATEST(0, running_steps-$1), updated_at=now()
           WHERE tenant_id=$2`,
          [affected.rows.length, tenantId],
        );
      }
      for (const row of affected.rows) {
        const step = fromStep(row);
        await this.appendEvent(client, {
          aggregateType: 'step', aggregateId: step.id, sequence: step.version,
          type: 'step.tenant_paused', tenantId, runId: step.runId, stepId: step.id,
          actor, payload: { reason },
        });
      }
      const control = fromTenantExecutionControl(controlResult.rows[0]!);
      await this.appendEvent(client, {
        aggregateType: 'tenant', aggregateId: tenantId, sequence: control.generation,
        type: 'tenant.paused', tenantId, runId: `tenant:${tenantId}`, actor,
        payload: { reason },
      });
      return control;
    }, [tenantId]);
  }

  async resumeTenant(tenantId: string, actor: string): Promise<TenantExecutionControl> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbTenantExecutionControl>(
        `INSERT INTO commander_tenant_execution_control
           (tenant_id, paused, generation, actor, reason, paused_at, resumed_at, updated_at)
         VALUES ($1, false, 1, $2, NULL, NULL, now(), now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           paused=false,
           generation=commander_tenant_execution_control.generation+1,
           actor=EXCLUDED.actor,
           reason=NULL,
           resumed_at=now(),
           updated_at=now()
         RETURNING *`,
        [tenantId, actor],
      );
      const control = fromTenantExecutionControl(result.rows[0]!);
      await this.appendEvent(client, {
        aggregateType: 'tenant', aggregateId: tenantId, sequence: control.generation,
        type: 'tenant.resumed', tenantId, runId: `tenant:${tenantId}`, actor, payload: {},
      });
      return control;
    }, [tenantId]);
  }

  async getTenantExecutionControl(tenantId: string): Promise<TenantExecutionControl> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbTenantExecutionControl>(
        'SELECT * FROM commander_tenant_execution_control WHERE tenant_id=$1',
        [tenantId],
      );
      return result.rows[0]
        ? fromTenantExecutionControl(result.rows[0])
        : { tenantId, paused: false, generation: 0, actor: 'kernel' };
    }, [tenantId]);
  }

  async admitEffect(request: AdmitEffectRequest): Promise<AdmitEffectResult> {
    return this.withTransaction(async (client) => {
      let step = await client.query<DbStep>(
        `SELECT * FROM commander_steps WHERE id=$1 AND run_id=$2 AND tenant_id=$3 AND state='RUNNING' AND lease_worker_id=$4 AND lease_worker_generation=$5 AND lease_token=$6 AND fencing_epoch=$7 AND lease_expires_at > now()
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
         FOR UPDATE`,
        [request.stepId, request.runId, request.tenantId, request.lease.workerId, request.lease.workerGeneration ?? -1, request.lease.token, request.lease.fencingEpoch]);
      if (!step.rows[0] && request.type.startsWith('compensate.')) {
        // Compensation effects run after the forward step lease is gone; require COMPENSATING run.
        const run = await client.query<{ state: string }>(
          `SELECT state FROM commander_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
          [request.runId, request.tenantId],
        );
        if (run.rows[0]?.state === 'COMPENSATING') {
          step = await client.query<DbStep>(
            `SELECT * FROM commander_steps WHERE id=$1 AND run_id=$2 AND tenant_id=$3 FOR UPDATE`,
            [request.stepId, request.runId, request.tenantId],
          );
        }
      }
      if (!step.rows[0]) return { admitted: false, reason: 'LEASE_LOST' };
      const fingerprint = requestHash(request.request);
      const existing = await client.query<DbEffect>('SELECT * FROM commander_effects WHERE tenant_id=$1 AND idempotency_key=$2', [request.tenantId, request.idempotencyKey]);
      if (existing.rows[0]) {
        const prior = existing.rows[0];
        if (prior.run_id !== request.runId || prior.step_id !== request.stepId || prior.type !== request.type || prior.request_hash !== fingerprint || prior.policy_decision_id !== request.policyDecisionId) {
          return { admitted: false, reason: 'IDEMPOTENCY_CONFLICT' };
        }
        return { admitted: true, replayed: true, effect: fromEffect(prior) };
      }
      const inserted = await client.query<DbEffect>(
        `INSERT INTO commander_effects (id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,policy_decision_id,state,request)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ADMITTED',$9::jsonb) RETURNING *`,
        [request.id, request.runId, request.stepId, request.tenantId, request.type, request.idempotencyKey, fingerprint, request.policyDecisionId, json(request.request)]);
      const effect = fromEffect(inserted.rows[0]!);
      await this.appendEvent(client, { aggregateType: 'effect', aggregateId: effect.id, sequence: 1, type: 'effect.admitted', tenantId: effect.tenantId, runId: effect.runId, stepId: effect.stepId, actor: request.actor, payload: { type: effect.type, policyDecisionId: effect.policyDecisionId } });
      return { admitted: true, replayed: false, effect };
    }, [request.tenantId]);
  }

  async completeEffect(effectId: string, tenantId: string, lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>, response: Record<string, unknown>, actor: string): Promise<KernelEffect | null> {
    return this.withTransaction(async (client) => {
      let result = await client.query<DbEffect>(
        `UPDATE commander_effects e SET state='COMPLETED', response=$1::jsonb, completed_at=now()
         WHERE e.id=$2 AND e.tenant_id=$3 AND e.state='ADMITTED'
           AND EXISTS (SELECT 1 FROM commander_steps s WHERE s.id=e.step_id AND s.run_id=e.run_id AND s.tenant_id=e.tenant_id AND s.state='RUNNING' AND s.lease_worker_id=$4 AND s.lease_worker_generation=$5 AND s.lease_token=$6 AND s.fencing_epoch=$7 AND s.lease_expires_at > now())
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
         RETURNING e.*`,
        [json(response), effectId, tenantId, lease.workerId, lease.workerGeneration ?? -1, lease.token, lease.fencingEpoch],
      );
      if (!result.rows[0]) {
        // compensate.* may complete while the run is COMPENSATING and the step lease is gone.
        result = await client.query<DbEffect>(
          `UPDATE commander_effects e SET state='COMPLETED', response=$1::jsonb, completed_at=now()
           WHERE e.id=$2 AND e.tenant_id=$3 AND e.state='ADMITTED' AND e.type LIKE 'compensate.%'
             AND EXISTS (SELECT 1 FROM commander_runs r WHERE r.id=e.run_id AND r.tenant_id=e.tenant_id AND r.state='COMPENSATING')
           RETURNING e.*`,
          [json(response), effectId, tenantId],
        );
      }
      if (!result.rows[0]) return null;
      const effect = fromEffect(result.rows[0]);
      await this.appendEvent(client, { aggregateType: 'effect', aggregateId: effect.id, sequence: 2, type: 'effect.completed', tenantId, runId: effect.runId, stepId: effect.stepId, actor, payload: {} });
      return effect;
    }, [tenantId]);
  }

  async markEffectCompletionUnknown(request: MarkEffectCompletionUnknownRequest): Promise<KernelEffect | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbEffect>(
        `UPDATE commander_effects SET state='COMPLETION_UNKNOWN', response=jsonb_build_object('reason',$1::text)
         WHERE id=$2 AND tenant_id=$3 AND state='ADMITTED' RETURNING *`,
        [request.reason, request.effectId, request.tenantId],
      );
      if (!result.rows[0]) return null;
      const effect = fromEffect(result.rows[0]);
      await this.appendEvent(client, { aggregateType: 'effect', aggregateId: effect.id, sequence: 2, type: 'effect.completion_unknown', tenantId: effect.tenantId, runId: effect.runId, stepId: effect.stepId, actor: request.actor, payload: { reason: request.reason } });
      return effect;
    }, [request.tenantId]);
  }

  async getEffect(effectId: string, tenantId: string): Promise<KernelEffect | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbEffect>(
        'SELECT * FROM commander_effects WHERE id=$1 AND tenant_id=$2',
        [effectId, tenantId],
      );
      return result.rows[0] ? fromEffect(result.rows[0]) : null;
    }, [tenantId]);
  }

  async reconcileEffect(request: ReconcileEffectRequest): Promise<KernelEffect | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbEffect>(
        `UPDATE commander_effects SET state=$1, response=$2::jsonb, completed_at=now()
         WHERE id=$3 AND tenant_id=$4 AND state='COMPLETION_UNKNOWN'
         RETURNING *`,
        [request.state, json(request.response), request.effectId, request.tenantId],
      );
      if (!result.rows[0]) return null;
      const effect = fromEffect(result.rows[0]);
      await this.appendEvent(client, {
        aggregateType: 'effect',
        aggregateId: effect.id,
        sequence: 3,
        type: request.state === 'COMPLETED' ? 'effect.reconciled_completed' : 'effect.reconciled_failed',
        tenantId: effect.tenantId,
        runId: effect.runId,
        stepId: effect.stepId,
        actor: request.actor,
        payload: {},
      });
      return effect;
    }, [request.tenantId]);
  }

  async claimOutbox(limit: number, now = new Date()): Promise<KernelOutboxMessage[]> {
    return this.withTransaction(async (client) => {
      const token = randomUUID();
      const result = await client.query<{ id: string; event_id: string; tenant_id: string; topic: string; key: string; payload: Record<string, unknown>; attempts: number; available_at: Date | string; published_at: Date | string | null; created_at: Date | string }>(
        `WITH candidate AS (SELECT id FROM commander_outbox WHERE published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts AND available_at <= $1 AND (claimed_at IS NULL OR claimed_at < $2) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $3)
         UPDATE commander_outbox o SET claimed_at=$1, claim_token=$4, attempts=o.attempts+1 FROM candidate WHERE o.id=candidate.id RETURNING o.*`,
        [now.toISOString(), new Date(now.getTime() - 60_000).toISOString(), limit, token]);
      return result.rows.map((row) => ({ id: row.id, eventId: row.event_id, tenantId: row.tenant_id, topic: row.topic, key: row.key, payload: row.payload ?? {}, attempts: Number(row.attempts), availableAt: iso(row.available_at), publishedAt: row.published_at ? iso(row.published_at) : undefined, claimToken: token, createdAt: iso(row.created_at) }));
    });
  }
  async markOutboxPublished(messageId: string, claimToken: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(`UPDATE commander_outbox SET published_at=now(), claim_token=NULL, claimed_at=NULL WHERE id=$1 AND claim_token=$2 AND published_at IS NULL`, [messageId, claimToken]);
      return (result.rowCount ?? 0) === 1;
    });
  }

  async retryOutbox(messageId: string, claimToken: string, error: { code: string; message: string }, now = new Date()): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE commander_outbox SET
           available_at=$1::timestamptz + (POWER(2, GREATEST(0, attempts-1)) * interval '1 second'),
           last_error=$2::jsonb, claim_token=NULL, claimed_at=NULL
         WHERE id=$3 AND claim_token=$4 AND published_at IS NULL`,
        [now.toISOString(), json(error), messageId, claimToken],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  // ── WS2 EffectBroker monopoly ─────────────────────────────────────────────

  async claimOutboxByTopic(topic: string, limit: number, now = new Date()): Promise<KernelOutboxMessage[]> {
    return this.withTransaction(async (client) => {
      const token = randomUUID();
      const result = await client.query<{ id: string; event_id: string; tenant_id: string; topic: string; key: string; payload: Record<string, unknown>; attempts: number; available_at: Date | string; published_at: Date | string | null; created_at: Date | string }>(
        `WITH candidate AS (SELECT id FROM commander_outbox WHERE topic=$1 AND published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts AND available_at <= $2 AND (claimed_at IS NULL OR claimed_at < $3) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $4)
         UPDATE commander_outbox o SET claimed_at=$2, claim_token=$5, attempts=o.attempts+1 FROM candidate WHERE o.id=candidate.id RETURNING o.*`,
        [topic, now.toISOString(), new Date(now.getTime() - 60_000).toISOString(), limit, token]);
      return result.rows.map((row) => ({ id: row.id, eventId: row.event_id, tenantId: row.tenant_id, topic: row.topic, key: row.key, payload: row.payload ?? {}, attempts: Number(row.attempts), availableAt: iso(row.available_at), publishedAt: row.published_at ? iso(row.published_at) : undefined, claimToken: token, createdAt: iso(row.created_at) }));
    });
  }

  async isCapabilityRevoked(jti: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(`SELECT 1 FROM commander_capability_revocations WHERE jti=$1 AND expires_at > now()`, [jti]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async revokeCapability(input: { jti: string; tenantId: string; expiresAt: string; reason?: string }): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO commander_capability_revocations (jti, tenant_id, expires_at, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
        [input.jti, input.tenantId, input.expiresAt, input.reason ?? null],
      );
    });
  }

  async isActionAllowed(tenantId: string, action: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      // Match exact + wildcard patterns. A row is considered a match if
      // action = action_pattern OR action_pattern ends with '.*' and action
      // starts with the prefix. Fail-closed: no matching row ⇒ deny.
      const result = await client.query<{ allowed: boolean }>(
        `SELECT allowed FROM commander_effect_allowlist
         WHERE tenant_id=$1 AND ($2 = action_pattern OR (action_pattern LIKE '%.*' AND $2 LIKE replace(action_pattern, '*', '%')))
         ORDER BY (action_pattern = $2) DESC, length(action_pattern) DESC LIMIT 1`,
        [tenantId, action],
      );
      if (!result.rows[0]) return false;
      return result.rows[0].allowed;
    });
  }

  async setAllowlistEntry(tenantId: string, actionPattern: string, allowed: boolean): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO commander_effect_allowlist (tenant_id, action_pattern, allowed) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, action_pattern) DO UPDATE SET allowed = EXCLUDED.allowed`,
        [tenantId, actionPattern, allowed],
      );
    });
  }

  async ensureAllowlistDefault(tenantId: string, actionPattern: string, allowed: boolean): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO commander_effect_allowlist (tenant_id, action_pattern, allowed) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, action_pattern) DO NOTHING`,
        [tenantId, actionPattern, allowed],
      );
    });
  }

  async incrementQuota(input: { tenantId: string; actionClass: string; tokensUsed?: number; now?: Date }): Promise<{ countUsed: number; tokensUsed: number }> {
    const day = (input.now ?? new Date()).toISOString().slice(0, 10);
    const tokens = input.tokensUsed ?? 0;
    return this.withTransaction(async (client) => {
      const result = await client.query<{ count_used: number; tokens_used: string }>(
        `INSERT INTO commander_effect_quota (tenant_id, action_class, day, count_used, tokens_used) VALUES ($1, $2, $3::date, 1, $4)
         ON CONFLICT (tenant_id, action_class, day) DO UPDATE SET count_used = commander_effect_quota.count_used + 1, tokens_used = commander_effect_quota.tokens_used + $4
         RETURNING count_used, tokens_used`,
        [input.tenantId, input.actionClass, day, tokens],
      );
      return { countUsed: result.rows[0]!.count_used, tokensUsed: Number(result.rows[0]!.tokens_used) };
    });
  }

  async getQuota(tenantId: string, actionClass: string, now?: Date): Promise<{ countUsed: number; tokensUsed: number }> {
    const day = (now ?? new Date()).toISOString().slice(0, 10);
    return this.withTransaction(async (client) => {
      const result = await client.query<{ count_used: number; tokens_used: string }>(
        `SELECT count_used, tokens_used FROM commander_effect_quota WHERE tenant_id=$1 AND action_class=$2 AND day=$3::date`,
        [tenantId, actionClass, day],
      );
      if (!result.rows[0]) return { countUsed: 0, tokensUsed: 0 };
      return { countUsed: result.rows[0].count_used, tokensUsed: Number(result.rows[0].tokens_used) };
    });
  }

  async listEvents(runId: string, tenantId: string): Promise<KernelEvent[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{ id: string; aggregate_type: KernelEvent['aggregateType']; aggregate_id: string; sequence: number; type: string; tenant_id: string; run_id: string; step_id: string | null; causation_id: string | null; correlation_id: string | null; actor: string; schema_version: string; payload: Record<string, unknown> | null; occurred_at: Date | string }>(`SELECT * FROM commander_events WHERE run_id=$1 AND tenant_id=$2 ORDER BY occurred_at, sequence`, [runId, tenantId]);
      return result.rows.map((row) => ({ eventId: row.id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, sequence: Number(row.sequence), type: row.type, tenantId: row.tenant_id, runId: row.run_id, stepId: row.step_id ?? undefined, causationId: row.causation_id ?? undefined, correlationId: row.correlation_id ?? undefined, actor: row.actor, schemaVersion: row.schema_version, payload: row.payload ?? {}, occurredAt: iso(row.occurred_at) }));
    }, [tenantId]);
  }

  // ── Durable Timers ─────────────────────────────────────────────────────────

  async createTimer(request: CreateTimerRequest, actor: string): Promise<KernelTimer> {
    const id = `tmr_${randomUUID()}`;
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string; run_id: string; step_id: string; tenant_id: string;
        fires_at: Date | string; timer_type: string; state: string;
        payload: Record<string, unknown>; created_at: Date | string; fired_at: Date | string | null;
      }>(`INSERT INTO commander_timers (id,run_id,step_id,tenant_id,fires_at,timer_type,payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
        [id, request.runId, request.stepId, request.tenantId, request.firesAt, request.timerType, json(request.payload ?? {})]);
      await this.appendEvent(client, { aggregateType: 'run', aggregateId: request.runId, sequence: 0, type: 'timer.created', tenantId: request.tenantId, runId: request.runId, stepId: request.stepId, actor, payload: { timerId: id, timerType: request.timerType, firesAt: request.firesAt.toISOString() } });
      return mapTimer(result.rows[0]!);
    }, [request.tenantId]);
  }

  async cancelTimer(timerId: string, tenantId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE commander_timers SET state='CANCELLED' WHERE id=$1 AND tenant_id=$2 AND state='PENDING'`,
        [timerId, tenantId],
      );
      return (result.rowCount ?? 0) === 1;
    }, [tenantId]);
  }

  async claimExpiredTimers(now: Date = new Date(), limit: number = 100): Promise<KernelTimer[]> {
    return this.withTransaction(async (client) => {
      const claimToken = randomUUID();
      const result = await client.query<{
        id: string; run_id: string; step_id: string; tenant_id: string;
        fires_at: Date | string; timer_type: string; state: string;
        payload: Record<string, unknown>; created_at: Date | string; fired_at: Date | string | null; claim_token: string | null;
      }>(`UPDATE commander_timers SET state='PROCESSING', claim_token=$3, claimed_at=$1
          WHERE id IN (
            SELECT id FROM commander_timers
            WHERE (state='PENDING' OR (state='PROCESSING' AND claimed_at <= $1::timestamptz - interval '60 seconds')) AND fires_at <= $1
            ORDER BY fires_at LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [now, limit, claimToken]);
      return result.rows.map(mapTimer);
    });
  }

  async acknowledgeTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE commander_timers SET state='FIRED', fired_at=now(), claim_token=NULL, claimed_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND state='PROCESSING' AND claim_token=$3`,
        [timerId, tenantId, claimToken],
      );
      return (result.rowCount ?? 0) === 1;
    }, [tenantId]);
  }

  async retryTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE commander_timers SET state='PENDING', claim_token=NULL, claimed_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND state='PROCESSING' AND claim_token=$3`,
        [timerId, tenantId, claimToken],
      );
      return (result.rowCount ?? 0) === 1;
    }, [tenantId]);
  }

  // ── Interactions ───────────────────────────────────────────────────────────

  async createInteraction(request: CreateInteractionRequest, actor: string): Promise<KernelInteraction> {
    const id = `itr_${randomUUID()}`;
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string; run_id: string; step_id: string; tenant_id: string;
        status: string; prompt: string; response: Record<string, unknown> | null;
        created_at: Date | string; answered_at: Date | string | null; expires_at: Date | string | null;
      }>(`INSERT INTO commander_interactions (id,run_id,step_id,tenant_id,prompt,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, request.runId, request.stepId, request.tenantId, request.prompt, request.expiresAt ?? null]);
      await this.appendEvent(client, { aggregateType: 'interaction', aggregateId: id, sequence: 0, type: 'interaction.created', tenantId: request.tenantId, runId: request.runId, stepId: request.stepId, actor, payload: { interactionId: id } });
      return mapInteraction(result.rows[0]!);
    }, [request.tenantId]);
  }

  async answerInteraction(request: AnswerInteractionRequest): Promise<KernelInteraction> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string; run_id: string; step_id: string; tenant_id: string;
        status: string; prompt: string; response: Record<string, unknown> | null;
        created_at: Date | string; answered_at: Date | string | null; expires_at: Date | string | null;
      }>(`UPDATE commander_interactions
          SET status='answered', response=$1::jsonb, answered_at=now()
          WHERE id=$2 AND run_id=$3 AND tenant_id=$4 AND status='pending'
          RETURNING *`,
        [json(request.response), request.interactionId, request.runId, request.tenantId]);
      if (!result.rows[0]) {
        throw new KernelInvariantError('INTERACTION_NOT_FOUND', `Interaction ${request.interactionId} not found or already answered`);
      }
      await this.appendEvent(client, { aggregateType: 'interaction', aggregateId: request.interactionId, sequence: 1, type: 'interaction.answered', tenantId: request.tenantId, runId: request.runId, stepId: result.rows[0]!.step_id, actor: request.actor, payload: { response: request.response } });
      return mapInteraction(result.rows[0]!);
    }, [request.tenantId]);
  }

  async getInteraction(interactionId: string, tenantId: string): Promise<KernelInteraction | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string; run_id: string; step_id: string; tenant_id: string;
        status: string; prompt: string; response: Record<string, unknown> | null;
        created_at: Date | string; answered_at: Date | string | null; expires_at: Date | string | null;
      }>('SELECT * FROM commander_interactions WHERE id=$1 AND tenant_id=$2', [interactionId, tenantId]);
      return result.rows[0] ? mapInteraction(result.rows[0]) : null;
    }, [tenantId]);
  }

  async listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string; run_id: string; step_id: string; tenant_id: string;
        status: string; prompt: string; response: Record<string, unknown> | null;
        created_at: Date | string; answered_at: Date | string | null; expires_at: Date | string | null;
      }>('SELECT * FROM commander_interactions WHERE run_id=$1 AND tenant_id=$2 ORDER BY created_at', [runId, tenantId]);
      return result.rows.map(mapInteraction);
    }, [tenantId]);
  }

  async expireStaleInteractions(now: Date = new Date(), limit: number = 100): Promise<KernelInteraction[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string; run_id: string; step_id: string; tenant_id: string;
        status: string; prompt: string; response: Record<string, unknown> | null;
        created_at: Date | string; answered_at: Date | string | null; expires_at: Date | string | null;
      }>(`UPDATE commander_interactions SET status='expired'
          WHERE id IN (
            SELECT id FROM commander_interactions
            WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= $1
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [now, limit]);
      return result.rows.map(mapInteraction);
    });
  }

  // ── Outbox DLQ ─────────────────────────────────────────────────────────────

  async sweepOutboxDlq(now: Date = new Date(), limit: number = 50): Promise<{ movedToDlq: number; backoffApplied: number }> {
    return this.withTransaction(async (client) => {
      let movedToDlq = 0;
      let backoffApplied = 0;

      // 1. Move messages that exceeded max_attempts to DLQ
      const expired = await client.query<{
        id: string; event_id: string; tenant_id: string; topic: string; key: string;
        payload: Record<string, unknown>; attempts: number; max_attempts: number;
        created_at: Date | string;
      }>(`SELECT id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, created_at
          FROM commander_outbox
          WHERE published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts >= max_attempts
            AND (claimed_at IS NULL OR claimed_at <= $2::timestamptz - interval '60 seconds')
          ORDER BY created_at LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit, now]);
      for (const row of expired.rows) {
        const dlqId = `dlq_${randomUUID()}`;
        await client.query(
        `INSERT INTO commander_outbox_dlq (id, original_id, event_id, tenant_id, topic, key, payload, attempts, dlq_reason, original_created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'max_attempts_exceeded',$9)`,
          [dlqId, row.id, row.event_id, row.tenant_id, row.topic, row.key, json(row.payload), row.attempts, row.created_at],
        );
        await client.query(
          `UPDATE commander_outbox SET dlq_reason='max_attempts_exceeded', moved_to_dlq_at=now() WHERE id=$1`,
          [row.id],
        );
        movedToDlq++;
      }

      // 2. Apply exponential backoff to messages below threshold
      //    available_at = now() + (2^attempts * 1000ms)
      const backoff = await client.query<{
        id: string; attempts: number;
      }>(`UPDATE commander_outbox
           SET available_at = now() + (POWER(2, attempts) * INTERVAL '1 second'),
               claim_token = NULL,
               claimed_at = NULL
           WHERE id IN (
             SELECT id FROM commander_outbox
             WHERE published_at IS NULL
               AND moved_to_dlq_at IS NULL
               AND attempts > 0
               AND attempts < max_attempts
               AND available_at <= $1
               AND (claimed_at IS NULL OR claimed_at <= $1::timestamptz - interval '60 seconds')
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id, attempts`,
        [now, limit]);
      backoffApplied = backoff.rowCount ?? 0;

      return { movedToDlq, backoffApplied };
    });
  }

  async listDlqEntries(limit: number = 100, topic?: string): Promise<KernelDlqEntry[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string; original_id: string; event_id: string; tenant_id: string; topic: string; key: string;
        payload: Record<string, unknown>; attempts: number; dlq_reason: string | null;
        original_created_at: Date | string; moved_to_dlq_at: Date | string;
      }>(topic
        ? 'SELECT * FROM commander_outbox_dlq WHERE topic=$1 ORDER BY moved_to_dlq_at DESC LIMIT $2'
        : 'SELECT * FROM commander_outbox_dlq ORDER BY moved_to_dlq_at DESC LIMIT $1',
        topic ? [topic, limit] : [limit]);
      return result.rows.map((row) => ({
        id: row.id,
        originalId: row.original_id,
        eventId: row.event_id,
        tenantId: row.tenant_id,
        topic: row.topic,
        key: row.key,
        payload: row.payload ?? {},
        attempts: row.attempts,
        dlqReason: row.dlq_reason ?? undefined,
        originalCreatedAt: iso(row.original_created_at),
        movedToDlqAt: iso(row.moved_to_dlq_at),
      }));
    });
  }

  async replayDlqEntry(dlqId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const dlq = await client.query<{
        id: string; original_id: string; event_id: string; tenant_id: string; topic: string; key: string;
        payload: Record<string, unknown>;
      }>(`SELECT * FROM commander_outbox_dlq WHERE id=$1 FOR UPDATE`, [dlqId]);
      if (!dlq.rows[0]) return false;

      const row = dlq.rows[0]!;
      const newOutboxId = randomUUID();
      await client.query(
        `INSERT INTO commander_outbox (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,0,10)`,
        [newOutboxId, row.event_id, row.tenant_id, row.topic, row.key, json(row.payload)],
      );
      await client.query(`DELETE FROM commander_outbox_dlq WHERE id=$1`, [dlqId]);
      return true;
    });
  }

  private async lockRunState(client: SqlClient, runId: string, tenantId: string): Promise<KernelRunState | null> {
    const result = await client.query<{ state: KernelRunState }>(
      'SELECT state FROM commander_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [runId, tenantId],
    );
    return result.rows[0]?.state ?? null;
  }

  private async lockStepStates(client: SqlClient, runId: string, tenantId: string): Promise<Array<{ id: string; state: KernelStepState }>> {
    const result = await client.query<{ id: string; state: KernelStepState }>(
      'SELECT id, state FROM commander_steps WHERE run_id=$1 AND tenant_id=$2 FOR UPDATE',
      [runId, tenantId],
    );
    return result.rows;
  }

  private async finishRunIfTerminal(client: SqlClient, runId: string, tenantId: string, actor: string): Promise<void> {
    const previousState = await this.lockRunState(client, runId, tenantId);
    if (!previousState) return;
    const states = await client.query<{ state: string }>('SELECT state FROM commander_steps WHERE run_id=$1 AND tenant_id=$2 FOR UPDATE', [runId, tenantId]);
    if (states.rows.some((row) => row.state === 'FAILED')) {
      if (previousState === 'FAILED') return;
      assertRunTransition(previousState, 'FAILED');
      const updated = await client.query<DbRun>(`UPDATE commander_runs SET state='FAILED', version=version+1, updated_at=now(), terminal_at=now() WHERE id=$1 AND tenant_id=$2 AND state NOT IN ('FAILED','SUCCEEDED') RETURNING *`, [runId, tenantId]);
      if (updated.rows[0]) await this.appendEvent(client, { aggregateType: 'run', aggregateId: runId, sequence: Number(updated.rows[0].version), type: 'run.failed', tenantId, runId, actor, payload: {} });
    } else if (states.rows.length > 0 && states.rows.every((row) => ['SUCCEEDED', 'SKIPPED'].includes(row.state))) {
      if (previousState === 'SUCCEEDED') return;
      assertRunTransition(previousState, 'SUCCEEDED');
      const updated = await client.query<DbRun>(`UPDATE commander_runs SET state='SUCCEEDED', version=version+1, updated_at=now(), terminal_at=now() WHERE id=$1 AND tenant_id=$2 AND state NOT IN ('FAILED','SUCCEEDED') RETURNING *`, [runId, tenantId]);
      if (updated.rows[0]) await this.appendEvent(client, { aggregateType: 'run', aggregateId: runId, sequence: Number(updated.rows[0].version), type: 'run.succeeded', tenantId, runId, actor, payload: {} });
    }
  }
  private async releaseTenantSlot(client: SqlClient, tenantId: string): Promise<void> {
    await client.query(
      `UPDATE commander_tenant_execution_usage
       SET running_steps=GREATEST(0, running_steps-1), updated_at=now() WHERE tenant_id=$1`,
      [tenantId],
    );
  }
  private async appendEvent(client: SqlClient, event: Omit<KernelEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>, outboxKey = event.runId): Promise<void> {
    const eventId = randomUUID();
    await client.query(`INSERT INTO commander_events (id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,step_id,causation_id,correlation_id,actor,schema_version,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'v2',$12::jsonb)`, [eventId, event.aggregateType, event.aggregateId, event.sequence, event.type, event.tenantId, event.runId, event.stepId ?? null, event.causationId ?? null, event.correlationId ?? null, event.actor, json(event.payload)]);
    await client.query(`INSERT INTO commander_outbox (id,event_id,tenant_id,topic,key,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [randomUUID(), eventId, event.tenantId, `commander.${event.type}`, outboxKey, json({ ...event.payload, eventId, type: event.type, runId: event.runId, stepId: event.stepId ?? null, tenantId: event.tenantId })]);
  }
  private assertGraph(command: CreateKernelRun): void {
    const ids = new Set<string>();
    for (const step of command.steps) {
      if (ids.has(step.id)) throw new KernelInvariantError('DUPLICATE_STEP', `Duplicate step ${step.id}`);
      ids.add(step.id);
    }
    for (const step of command.steps) for (const dependency of step.dependencies ?? []) if (!ids.has(dependency)) throw new KernelInvariantError('INVALID_GRAPH', `Step ${step.id} depends on unknown step ${dependency}`);
  }
  private async withTransaction<T>(fn: (client: SqlClient) => Promise<T>, tenantIds: string[] = []): Promise<T> {
    if (tenantIds.length === 0 && !this.options.schedulerMode) {
      throw new Error('Kernel write must explicitly carry tenant scope (or use a scheduler-mode repository)');
    }
    const scope = tenantIds.length > 0 ? tenantIds.join(',') : '*';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_scope',$1,true)", [scope]);
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    }
    catch (error) { try { await client.query('ROLLBACK'); } catch { /* preserve root cause */ } throw error; }
    finally { await client.release(); }
  }
}

// ── Row mappers ──────────────────────────────────────────────────────────────

function mapTimer(row: {
  id: string; run_id: string; step_id: string; tenant_id: string;
  fires_at: Date | string; timer_type: string; state: string;
  payload: Record<string, unknown>; created_at: Date | string; fired_at: Date | string | null; claim_token?: string | null;
}): KernelTimer {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    tenantId: row.tenant_id,
    firesAt: iso(row.fires_at),
    timerType: row.timer_type as KernelTimer['timerType'],
    state: row.state as KernelTimer['state'],
    payload: row.payload ?? {},
    createdAt: iso(row.created_at),
    firedAt: row.fired_at ? iso(row.fired_at) : undefined,
    claimToken: row.claim_token ?? undefined,
  };
}

function mapInteraction(row: {
  id: string; run_id: string; step_id: string; tenant_id: string;
  status: string; prompt: string; response: Record<string, unknown> | null;
  created_at: Date | string; answered_at: Date | string | null; expires_at: Date | string | null;
}): KernelInteraction {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    tenantId: row.tenant_id,
    status: row.status as KernelInteraction['status'],
    prompt: row.prompt,
    response: row.response ?? undefined,
    createdAt: iso(row.created_at),
    answeredAt: row.answered_at ? iso(row.answered_at) : undefined,
    expiresAt: row.expires_at ? iso(row.expires_at) : undefined,
  };
}
