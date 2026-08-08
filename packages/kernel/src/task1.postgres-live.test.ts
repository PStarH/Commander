import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { runKernelMigrations, runTask1ClosureMigrations } from './migrations.js';
import { PostgresKernelRepository, PostgresTenantContextAuthority } from './postgres.js';
import { seedWorkerAllowedTenants } from './seedWorkerClaimSecret.js';

const ownerUrl = process.env.COMMANDER_TASK1_PG_URL;
let liveOwnerUrl: string | undefined;

function roleUrl(role: string): string {
  const url = new URL(liveOwnerUrl ?? ownerUrl!);
  url.username = role;
  url.password = role;
  return url.toString();
}

function databaseIdentifier(databaseName: string): string {
  if (!/^commander_task1_live_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('unsafe Task 1 live database identifier');
  }
  return `"${databaseName}"`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function requestHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

const ADMISSION_ARGUMENTS_SQL = `
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
`;

async function bindAuthenticatedTenant(
  client: PoolClient,
  authorityPool: Pool,
  tenantId: string,
): Promise<string> {
  const target = await client.query<{
    database_oid: number;
    backend_pid: number;
    xid: string;
  }>(`
    SELECT database.oid AS database_oid,
           pg_catalog.pg_backend_pid() AS backend_pid,
           pg_catalog.pg_current_xact_id()::text AS xid
      FROM pg_catalog.pg_database AS database
     WHERE database.datname = pg_catalog.current_database()
  `);
  const issued = await authorityPool.query<{ context_id: string }>(
    `SELECT context_id::text
       FROM public.issue_app_tenant_context($1::text, $2::oid, $3::integer, $4::xid8)`,
    [tenantId, target.rows[0]!.database_oid, target.rows[0]!.backend_pid, target.rows[0]!.xid],
  );
  const contextId = issued.rows[0]!.context_id;
  await client.query('SELECT public.bind_app_tenant_context($1::uuid)', [contextId]);
  return contextId;
}

async function admitNonClassA(
  pool: Pool,
  tenantId: string,
  args: readonly unknown[],
  authorityPool?: Pool,
): Promise<{ admitted: boolean; reason: string | null }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const contextId = authorityPool
      ? await bindAuthenticatedTenant(client, authorityPool, tenantId)
      : null;
    if (!contextId) {
      await client.query(`SELECT set_config('app.tenant_scope',$1,true)`, [tenantId]);
    }
    const result = await client.query<{ admitted: boolean; reason: string | null }>(
      `SELECT admitted, reason FROM admit_non_class_a_effect(${ADMISSION_ARGUMENTS_SQL})`,
      [...args],
    );
    if (contextId) {
      await client.query('SELECT public.close_app_tenant_context($1::uuid)', [contextId]);
    }
    await client.query('COMMIT');
    return result.rows[0]!;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function admitClassA(
  pool: Pool,
  tenantId: string,
  args: readonly unknown[],
  authorityPool?: Pool,
): Promise<{ admitted: boolean; reason: string | null; replayed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const contextId = authorityPool
      ? await bindAuthenticatedTenant(client, authorityPool, tenantId)
      : null;
    if (!contextId) {
      await client.query(`SELECT set_config('app.tenant_scope',$1,true)`, [tenantId]);
    }
    const result = await client.query<{
      admitted: boolean;
      reason: string | null;
      replayed: boolean;
    }>(`SELECT admitted, reason, replayed FROM admit_class_a_effect(${ADMISSION_ARGUMENTS_SQL})`, [
      ...args,
    ]);
    if (contextId) {
      await client.query('SELECT public.close_app_tenant_context($1::uuid)', [contextId]);
    }
    await client.query('COMMIT');
    return result.rows[0]!;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('Task 1 real PostgreSQL role and admission authority', { skip: !ownerUrl }, () => {
  const tenantId = `task1-live-${process.pid}-${Date.now()}`;
  const otherTenantId = `${tenantId}-other`;
  const suffix = randomUUID().slice(0, 8);
  const workerId = `task1-worker-${suffix}`;
  const otherWorkerId = `task1-worker-other-${suffix}`;
  const instanceId = `task1-ops-${suffix}`;
  const reconcileId = `reconcile:${instanceId}`;
  const compensationId = `compensation:${instanceId}`;
  const forgedReconcileId = `forged-reconcile-${suffix}`;
  const forgedCompensationId = `forged-compensation-${suffix}`;
  const liveDatabaseName = `commander_task1_live_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  let ownerPool: Pool;
  let adminPool: Pool;
  let appPool: Pool;
  let workerPool: Pool;
  let adapterPool: Pool;
  let schedulerPool: Pool;
  let tenantAuthorityPool: Pool;
  let appRepo: PostgresKernelRepository;
  let adapterRepo: PostgresKernelRepository;
  let workerRepo: PostgresKernelRepository;
  let workerGeneration: number;
  let workerSecret: string;
  let otherWorkerGeneration: number;
  let otherWorkerSecret: string;
  let reconcileGeneration: number;
  let reconcileSecret: string;
  let compensationGeneration: number;
  let compensationSecret: string;

  before(async () => {
    adminPool = new Pool({ connectionString: ownerUrl, max: 2 });
    await adminPool.query(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'commander_owner') THEN
          CREATE ROLE commander_owner;
        END IF;
      END
      $role$
    `);
    const ownerPassword = `owner-${randomUUID()}`;
    await adminPool.query(
      `ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS PASSWORD '${ownerPassword}'`,
    );
    await adminPool.query(
      `CREATE DATABASE ${databaseIdentifier(liveDatabaseName)} OWNER commander_owner`,
    );
    const ownerDsn = new URL(ownerUrl!);
    ownerDsn.pathname = `/${liveDatabaseName}`;
    ownerDsn.username = 'commander_owner';
    ownerDsn.password = ownerPassword;
    liveOwnerUrl = ownerDsn.toString();
    ownerPool = new Pool({ connectionString: liveOwnerUrl, max: 6 });
    await runKernelMigrations(ownerPool);
    await runTask1ClosureMigrations(ownerPool, 'expand');
    await runTask1ClosureMigrations(ownerPool, 'enforce');
    for (const role of [
      'commander_app',
      'commander_worker',
      'commander_adapter_ops',
      'commander_scheduler',
      'commander_tenant_authority',
    ]) {
      await ownerPool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${role}'`);
    }
    await seedWorkerAllowedTenants(ownerPool, [tenantId, otherTenantId]);
    await ownerPool.query(
      `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
       VALUES ($1), ($2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, otherTenantId],
    );
    appPool = new Pool({ connectionString: roleUrl('commander_app'), max: 4 });
    workerPool = new Pool({ connectionString: roleUrl('commander_worker'), max: 4 });
    adapterPool = new Pool({ connectionString: roleUrl('commander_adapter_ops'), max: 4 });
    schedulerPool = new Pool({ connectionString: roleUrl('commander_scheduler'), max: 2 });
    tenantAuthorityPool = new Pool({
      connectionString: roleUrl('commander_tenant_authority'),
      max: 4,
    });
    appRepo = new PostgresKernelRepository(appPool, {
      tenantContextAuthority: new PostgresTenantContextAuthority(tenantAuthorityPool),
      tenantContextPhase: 'enforce',
    });
    adapterRepo = new PostgresKernelRepository(adapterPool, { adapterOpsMode: true });
    workerRepo = new PostgresKernelRepository(workerPool);

    const worker = await workerPool.query<{
      registration: { generation: number; claim_secret: string };
    }>(
      `SELECT register_worker($1,'agent','v1','["agent"]','{}',4,$1,$2::jsonb,NULL) AS registration`,
      [workerId, JSON.stringify([tenantId])],
    );
    workerGeneration = Number(worker.rows[0]!.registration.generation);
    workerSecret = worker.rows[0]!.registration.claim_secret;
    const otherWorker = await workerPool.query<{
      registration: { generation: number; claim_secret: string };
    }>(
      `SELECT register_worker($1,'agent','v1','["agent"]','{}',4,$1,$2::jsonb,NULL) AS registration`,
      [otherWorkerId, JSON.stringify([otherTenantId])],
    );
    otherWorkerGeneration = Number(otherWorker.rows[0]!.registration.generation);
    otherWorkerSecret = otherWorker.rows[0]!.registration.claim_secret;

    const reconcile = await adapterPool.query<{
      registration: { generation: number; claim_secret: string };
    }>(`SELECT register_adapter_ops_worker('reconcile',$1,$2::jsonb,NULL) AS registration`, [
      instanceId,
      JSON.stringify([tenantId, otherTenantId]),
    ]);
    reconcileGeneration = Number(reconcile.rows[0]!.registration.generation);
    reconcileSecret = reconcile.rows[0]!.registration.claim_secret;
    const compensation = await adapterPool.query<{
      registration: { generation: number; claim_secret: string };
    }>(`SELECT register_adapter_ops_worker('compensation',$1,$2::jsonb,NULL) AS registration`, [
      instanceId,
      JSON.stringify([tenantId, otherTenantId]),
    ]);
    compensationGeneration = Number(compensation.rows[0]!.registration.generation);
    compensationSecret = compensation.rows[0]!.registration.claim_secret;
  });

  after(async () => {
    if (ownerPool) {
      await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
        [tenantId, otherTenantId],
      ]);
      await ownerPool.query(
        'DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])',
        [
          [
            workerId,
            otherWorkerId,
            reconcileId,
            compensationId,
            forgedReconcileId,
            forgedCompensationId,
          ],
        ],
      );
      await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [
        [
          workerId,
          otherWorkerId,
          reconcileId,
          compensationId,
          forgedReconcileId,
          forgedCompensationId,
        ],
      ]);
      await ownerPool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [otherTenantId]);
      await ownerPool.query('DELETE FROM commander_events WHERE tenant_id=$1', [otherTenantId]);
      await ownerPool.query(
        'DELETE FROM commander_worker_allowed_tenants WHERE tenant_id = ANY($1::text[])',
        [[tenantId, otherTenantId]],
      );
      await ownerPool.query(
        'DELETE FROM commander_app_tenant_contexts WHERE tenant_id = ANY($1::text[])',
        [[tenantId, otherTenantId]],
      );
      await ownerPool.query(
        'DELETE FROM commander_tenant_authority_allowed_tenants WHERE tenant_id = ANY($1::text[])',
        [[tenantId, otherTenantId]],
      );
    }
    const livePools = [
      appPool,
      workerPool,
      adapterPool,
      schedulerPool,
      tenantAuthorityPool,
      ownerPool,
    ].filter((pool): pool is Pool => Boolean(pool));
    // DROP DATABASE ... WITH (FORCE) can report the expected administrator
    // termination asynchronously after pool.end() resolves. Attach a
    // teardown-only listener so the live gate does not turn cleanup noise into
    // an uncaught test failure.
    for (const pool of livePools) pool.on('error', () => undefined);
    await Promise.all(livePools.map((pool) => pool.end()));
    if (adminPool) {
      await adminPool.query(`DROP DATABASE ${databaseIdentifier(liveDatabaseName)} WITH (FORCE)`);
      const configuredOwnerDsn =
        process.env.COMMANDER_OWNER_DATABASE_URL?.trim() || process.env.OWNER_DSN?.trim();
      if (configuredOwnerDsn) {
        const configuredOwnerPassword = new URL(configuredOwnerDsn).password;
        const escapedPassword = configuredOwnerPassword.replaceAll("'", "''");
        await adminPool.query(
          `ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT
           NOREPLICATION BYPASSRLS PASSWORD '${escapedPassword}'`,
        );
      } else {
        await adminPool.query('ALTER ROLE commander_owner NOLOGIN NOCREATEROLE');
      }
      await adminPool.end();
    }
  });

  it('keeps tenant context timestamps ordered when stored timestamps are in the future', async () => {
    const contextIds: string[] = [];

    const runCase = async (mode: 'issued' | 'bound'): Promise<string> => {
      const app = await appPool.connect();
      let contextId: string | undefined;
      try {
        await app.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const target = await app.query<{
          database_oid: number;
          backend_pid: number;
          xid: string;
        }>(`
          SELECT database.oid AS database_oid,
                 pg_catalog.pg_backend_pid() AS backend_pid,
                 pg_catalog.pg_current_xact_id()::text AS xid
            FROM pg_catalog.pg_database AS database
           WHERE database.datname = pg_catalog.current_database()
        `);
        const targetRow = target.rows[0]!;
        const issued = await tenantAuthorityPool.query<{ context_id: string }>(
          `SELECT context_id::text
             FROM public.issue_app_tenant_context($1::text, $2::oid, $3::integer, $4::xid8)`,
          [tenantId, targetRow.database_oid, targetRow.backend_pid, targetRow.xid],
        );
        contextId = issued.rows[0]!.context_id;
        contextIds.push(contextId);

        if (mode === 'issued') {
          await ownerPool.query(
            `UPDATE public.commander_app_tenant_contexts
                SET issued_at = pg_catalog.clock_timestamp() + interval '1 hour',
                    expires_at = pg_catalog.clock_timestamp() + interval '2 hours',
                    bound_at = NULL,
                    closed_at = NULL
              WHERE context_id = $1::uuid`,
            [contextId],
          );
        } else {
          await ownerPool.query(
            `UPDATE public.commander_app_tenant_contexts
                SET issued_at = pg_catalog.clock_timestamp() - interval '1 hour',
                    expires_at = pg_catalog.clock_timestamp() + interval '2 hours',
                    bound_at = pg_catalog.clock_timestamp() + interval '1 hour',
                    closed_at = NULL
              WHERE context_id = $1::uuid`,
            [contextId],
          );
        }

        await app.query('SELECT public.bind_app_tenant_context($1::uuid)', [contextId]);
        await app.query('SELECT public.close_app_tenant_context($1::uuid)', [contextId]);
        await app.query('COMMIT');
        return contextId;
      } catch (error) {
        await app.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        app.release();
      }
    };

    try {
      await runCase('issued');
      await runCase('bound');

      const ordered = await ownerPool.query<{
        bound_ordered: boolean;
        closed_ordered: boolean;
      }>(
        `SELECT issued_at <= bound_at AS bound_ordered,
                bound_at <= closed_at AS closed_ordered
           FROM public.commander_app_tenant_contexts
          WHERE context_id = ANY($1::uuid[])
          ORDER BY context_id`,
        [contextIds],
      );
      assert.equal(ordered.rowCount, 2);
      assert.deepEqual(
        ordered.rows,
        [
          { bound_ordered: true, closed_ordered: true },
          { bound_ordered: true, closed_ordered: true },
        ],
        'database-owned timestamps must satisfy both context ordering checks',
      );
    } finally {
      await ownerPool.query(
        'DELETE FROM public.commander_app_tenant_contexts WHERE context_id = ANY($1::uuid[])',
        [contextIds],
      );
    }
  });

  it('enforces dedicated positive and negative role RPC paths', async () => {
    const registrationOnly = await appRepo.getOperationsReadiness(tenantId);
    assert.equal(registrationOnly.ready, false, 'registration alone must not establish readiness');

    await assert.rejects(
      () =>
        workerPool.query(
          `SELECT register_adapter_ops_worker('reconcile','forged',$1::jsonb,NULL)`,
          [JSON.stringify([tenantId])],
        ),
      /permission denied/i,
    );
    await assert.rejects(
      () =>
        adapterPool.query(
          `SELECT register_worker('forged','agent','v1','["agent"]','{}',1,'forged',$1::jsonb,NULL)`,
          [JSON.stringify([tenantId])],
        ),
      /permission denied/i,
    );
    await assert.rejects(
      () => adapterPool.query(`SELECT claim_next_step('forged',1,1000,'guess','["agent"]')`),
      /permission denied/i,
    );
    await assert.rejects(
      () =>
        workerPool.query(
          `SELECT register_worker('reconcile:forged','adapter-ops','v1','["effect.reconcile"]','{}',1,'db:commander_adapter_ops',$1::jsonb,NULL)`,
          [JSON.stringify([tenantId])],
        ),
      /GENERIC_WORKER_RESERVED_CAPABILITY/i,
    );
    await assert.rejects(
      () =>
        adapterPool.query(
          `SELECT claim_outbox_by_topic($1,$2,'commander.kernel.compensation.requested',1,clock_timestamp(),$3)`,
          [compensationId, compensationGeneration, compensationSecret],
        ),
      /permission denied/i,
    );
    await assert.rejects(
      () =>
        adapterPool.query(
          `SELECT register_adapter_ops_worker('reconcile','INVALID_ID',$1::jsonb,NULL)`,
          [JSON.stringify([tenantId])],
        ),
      /ADAPTER_OPS_INSTANCE_INVALID/i,
      'adapter-ops worker IDs must use the exact server-enforced grammar',
    );
    for (const pool of [appPool, workerPool, schedulerPool]) {
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO commander_effects (
             id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,
             policy_decision_id,policy_snapshot_id,action_digest,
             lease_worker_id,lease_worker_generation,lease_fencing_epoch,state,request
           ) VALUES ('raw-forged','run','step',$1,'http.post','raw','hash','decision','policy','digest','worker',1,1,'ADMITTED','{}')`,
            [tenantId],
          ),
        /permission denied/i,
      );
    }
    for (const pool of [appPool, workerPool, adapterPool]) {
      await assert.rejects(
        () => pool.query('UPDATE commander_workers SET status=status WHERE id=$1', [workerId]),
        /permission denied|TENANT_CONTEXT_INVALID/i,
      );
    }
    await assert.rejects(
      () => adapterPool.query('SELECT id FROM commander_workers WHERE id=$1', [workerId]),
      /permission denied/i,
      'adapter-ops LOGIN must not read worker rows directly',
    );
    const unscopedAdapter = await adapterPool.connect();
    try {
      await unscopedAdapter.query('RESET app.tenant_scope');
      await assert.rejects(
        () => unscopedAdapter.query('SELECT * FROM get_operations_readiness($1)', [tenantId]),
        /TENANT_SCOPE_REQUIRED/i,
        'adapter-ops readiness RPC must reject a LOGIN session without tenant scope',
      );
    } finally {
      unscopedAdapter.release();
    }
    const privateHelperArgs = [
      `private-helper-${suffix}`,
      'run',
      'step',
      tenantId,
      'read.cache',
      'idem',
      'hash',
      'decision',
      'policy',
      'digest',
      workerId,
      workerGeneration,
      'lease',
      1,
      '{}',
    ];
    for (const pool of [appPool, workerPool, adapterPool]) {
      await assert.rejects(
        () =>
          pool.query(
            `SELECT * FROM commander_admit_effect_private(${ADMISSION_ARGUMENTS_SQL})`,
            privateHelperArgs,
          ),
        /permission denied/i,
        'runtime LOGIN must not execute the private admission helper',
      );
    }
    const classMismatchArgs = [
      `class-mismatch-${suffix}`,
      'run',
      'step',
      tenantId,
      'http.post',
      'idem',
      'hash',
      'decision',
      'policy',
      'digest',
      workerId,
      workerGeneration,
      'lease',
      1,
      '{}',
    ];
    await assert.rejects(
      () => admitNonClassA(appPool, tenantId, classMismatchArgs, tenantAuthorityPool),
      /EFFECT_CLASS_MISMATCH/i,
      'non-Class-A RPC must reject a Class A effect before attempting admission',
    );
    classMismatchArgs[4] = 'read.cache';
    await assert.rejects(
      () => admitClassA(workerPool, tenantId, classMismatchArgs),
      /EFFECT_CLASS_MISMATCH/i,
      'Class-A RPC must reject a non-Class-A effect before attempting admission',
    );

    await adapterPool.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      reconcileId,
      reconcileGeneration,
      reconcileSecret,
    ]);
    await adapterPool.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      compensationId,
      compensationGeneration,
      compensationSecret,
    ]);
    await ownerPool.query(
      `INSERT INTO commander_workers (
         id,kind,version,capabilities,max_concurrency,status,generation,active_steps,
         identity_subject,tenant_ids,registered_at,last_heartbeat_at
       ) VALUES
         ($1,'agent','v1','["effect.reconcile"]',1,'ACTIVE',1,0,'db:commander_worker',$3::jsonb,clock_timestamp()-interval '10 seconds',clock_timestamp()),
         ($2,'agent','v1','["effect.compensate"]',1,'ACTIVE',1,0,'db:commander_worker',$3::jsonb,clock_timestamp()-interval '10 seconds',clock_timestamp())`,
      [forgedReconcileId, forgedCompensationId, JSON.stringify([tenantId])],
    );
    const zeroClaim = await adapterPool.query<{ claimed: unknown }>(
      'SELECT claim_reconcile_effects($1,$2,8,clock_timestamp(),60000,$3) AS claimed',
      [reconcileId, reconcileGeneration, reconcileSecret],
    );
    assert.deepEqual(zeroClaim.rows[0]?.claimed, [], 'zero-claim reconciliation tick must succeed');
    const readiness = await appRepo.getOperationsReadiness(tenantId);
    assert.equal(readiness.ready, true);
    assert.equal(
      readiness.reconciliationWorkers,
      1,
      'generic forged operations identity must not count',
    );
    assert.equal(
      readiness.compensationWorkers,
      1,
      'generic forged operations identity must not count',
    );
    const adapterReadiness = await adapterRepo.getOperationsReadiness(tenantId);
    assert.deepEqual(
      {
        ready: adapterReadiness.ready,
        reason: adapterReadiness.reason,
        reconciliationWorkers: adapterReadiness.reconciliationWorkers,
        compensationWorkers: adapterReadiness.compensationWorkers,
      },
      {
        ready: readiness.ready,
        reason: readiness.reason,
        reconciliationWorkers: readiness.reconciliationWorkers,
        compensationWorkers: readiness.compensationWorkers,
      },
      'adapter-ops LOGIN must read the same aggregate readiness without table authority',
    );
    assert.ok(Number.isFinite(Date.parse(adapterReadiness.checkedAt)));
    await assert.rejects(
      () =>
        adapterPool.query('SELECT id FROM commander_outbox WHERE tenant_id=$1 LIMIT 1', [tenantId]),
      /permission denied/i,
      'adapter-ops LOGIN must not gain direct compensation payload visibility',
    );
    const crossTenantBacklogId = `task1-cross-tenant-backlog-${suffix}`;
    const crossTenantEventId = `event-${crossTenantBacklogId}`;
    await ownerPool.query(
      `INSERT INTO commander_events (
         id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,actor,schema_version,payload
       ) VALUES ($1,'run',$2,1,'compensation.requested',$3,$2,'task1-live','v2','{}')`,
      [crossTenantEventId, `run-${crossTenantBacklogId}`, otherTenantId],
    );
    await ownerPool.query(
      `INSERT INTO commander_outbox (
         id,event_id,tenant_id,topic,key,payload,attempts,max_attempts,available_at
       ) VALUES ($1,$2,$3,'commander.kernel.compensation.requested',$4,'{}',0,5,clock_timestamp())`,
      [crossTenantBacklogId, crossTenantEventId, otherTenantId, `run-${crossTenantBacklogId}`],
    );
    const crossTenantHeartbeat = await adapterPool.query<{ heartbeat: unknown | null }>(
      'SELECT heartbeat_adapter_ops_worker($1,$2,$3) AS heartbeat',
      [compensationId, compensationGeneration, compensationSecret],
    );
    assert.notEqual(
      crossTenantHeartbeat.rows[0]?.heartbeat,
      null,
      'one tenant backlog must not suppress the shared worker heartbeat for every tenant',
    );
    assert.equal((await adapterRepo.getOperationsReadiness(tenantId)).ready, true);
    const otherTenantReadiness = await adapterRepo.getOperationsReadiness(otherTenantId);
    assert.deepEqual(
      otherTenantReadiness,
      {
        ready: true,
        reconciliationWorkers: 1,
        compensationWorkers: 1,
        checkedAt: otherTenantReadiness.checkedAt,
      },
      'compensation backlog must not redefine worker readiness counts',
    );
    await ownerPool.query('DELETE FROM commander_outbox WHERE id=$1', [crossTenantBacklogId]);
    const workerIdentity = await ownerPool.query<{ identity_subject: string }>(
      'SELECT identity_subject FROM commander_workers WHERE id=$1',
      [workerId],
    );
    assert.equal(workerIdentity.rows[0]?.identity_subject, 'db:commander_worker');
  });

  it('rejects cross-tenant and unauthorized leases before readiness row locks', async () => {
    await adapterPool.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      reconcileId,
      reconcileGeneration,
      reconcileSecret,
    ]);
    await adapterPool.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      compensationId,
      compensationGeneration,
      compensationSecret,
    ]);

    const runId = `task1-cross-tenant-run-${suffix}`;
    await appRepo.createRun(
      {
        id: runId,
        tenantId: otherTenantId,
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-v1',
        steps: [{ id: `step-cross-tenant-${suffix}`, kind: 'agent' }],
      },
      'task1-live',
    );
    const claimed = await workerRepo.claimNextStep({
      workerId: otherWorkerId,
      workerGeneration: otherWorkerGeneration,
      claimSecret: otherWorkerSecret,
      capabilities: ['agent'],
      leaseTtlMs: 60_000,
    });
    assert.ok(claimed?.lease);

    const request = { payload: 'cross-tenant' };
    const args = [
      `effect-cross-tenant-${suffix}`,
      runId,
      claimed!.id,
      otherTenantId,
      'http.post',
      `idem-cross-tenant-${suffix}`,
      requestHash(request),
      'decision',
      'policy-v1',
      '7'.repeat(64),
      otherWorkerId,
      otherWorkerGeneration,
      claimed!.lease!.token,
      claimed!.lease!.fencingEpoch,
      JSON.stringify(request),
    ];
    const operationsLock = await ownerPool.connect();
    await operationsLock.query('BEGIN');
    await operationsLock.query(
      'SELECT id FROM commander_workers WHERE id = ANY($1::text[]) FOR UPDATE',
      [[reconcileId, compensationId]],
    );
    try {
      await assert.rejects(
        () => admitClassA(appPool, otherTenantId, args),
        /TENANT_CONTEXT_INVALID/i,
        'raw app scope matching the target tenant must not authorize Class A admission',
      );
      await assert.rejects(
        () =>
          admitNonClassA(appPool, otherTenantId, [
            ...args.slice(0, 4),
            'read.cache',
            ...args.slice(5),
          ]),
        /TENANT_CONTEXT_INVALID/i,
        'raw app scope matching the target tenant must not authorize non-Class-A admission',
      );
      for (const pool of [appPool, workerPool]) {
        let settled = false;
        const attack = admitClassA(pool, tenantId, args)
          .then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          )
          .finally(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(settled, true, 'tenant-scope rejection must happen before readiness locks');
        assert.match(
          String((await attack).error),
          pool === appPool ? /TENANT_CONTEXT_INVALID/i : /TENANT_SCOPE_MISMATCH/i,
        );
      }

      for (const pool of [appPool, workerPool]) {
        await assert.rejects(
          () =>
            admitNonClassA(pool, tenantId, [...args.slice(0, 4), 'read.cache', ...args.slice(5)]),
          pool === appPool ? /TENANT_CONTEXT_INVALID/i : /TENANT_SCOPE_MISMATCH/i,
        );
      }

      await ownerPool.query('UPDATE commander_workers SET tenant_ids=$1::jsonb WHERE id=$2', [
        JSON.stringify([tenantId]),
        otherWorkerId,
      ]);
      let unauthorizedSettled = false;
      const unauthorized = admitClassA(workerPool, otherTenantId, [
        `effect-unauthorized-${suffix}`,
        ...args.slice(1, 5),
        `idem-unauthorized-${suffix}`,
        ...args.slice(6),
      ]).finally(() => {
        unauthorizedSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        unauthorizedSettled,
        true,
        'worker tenant authorization must be checked before readiness locks',
      );
      assert.deepEqual(await unauthorized, {
        admitted: false,
        reason: 'LEASE_LOST',
        replayed: false,
      });

      await ownerPool.query('UPDATE commander_workers SET tenant_ids=$1::jsonb WHERE id=$2', [
        JSON.stringify([otherTenantId]),
        otherWorkerId,
      ]);
      const staleGeneration = await admitClassA(workerPool, otherTenantId, [
        `effect-stale-generation-${suffix}`,
        ...args.slice(1, 5),
        `idem-stale-generation-${suffix}`,
        ...args.slice(6, 11),
        otherWorkerGeneration + 1,
        ...args.slice(12),
      ]);
      assert.deepEqual(staleGeneration, { admitted: false, reason: 'LEASE_LOST', replayed: false });
    } finally {
      await operationsLock.query('ROLLBACK');
      operationsLock.release();
    }
  });

  it('atomically serializes drain against owner-owned Class A admission', async () => {
    const runId = `task1-run-${suffix}`;
    await appRepo.createRun(
      {
        id: runId,
        tenantId,
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-v1',
        steps: [
          { id: `step-a-${suffix}`, kind: 'agent' },
          { id: `step-b-${suffix}`, kind: 'agent' },
        ],
      },
      'task1-live',
    );
    const first = await workerRepo.claimNextStep({
      workerId,
      workerGeneration,
      claimSecret: workerSecret,
      capabilities: ['agent'],
      leaseTtlMs: 60_000,
    });
    const second = await workerRepo.claimNextStep({
      workerId,
      workerGeneration,
      claimSecret: workerSecret,
      capabilities: ['agent'],
      leaseTtlMs: 60_000,
    });
    assert.ok(first?.lease && second?.lease);

    const classBRequest = { key: 'safe' };
    const classCRequest = { operation: 'fold', values: [1, 2, 3] };
    const operationsLock = await ownerPool.connect();
    await operationsLock.query('BEGIN');
    await operationsLock.query(
      'SELECT id FROM commander_workers WHERE id = ANY($1::text[]) FOR UPDATE',
      [[reconcileId, compensationId]],
    );
    let nonClassASettled = false;
    let invalidLeaseSettled = false;
    const invalidLeaseRequest = { payload: 'invalid-lease' };
    const invalidLeaseAdmission = admitClassA(
      appPool,
      tenantId,
      [
        `effect-invalid-lease-${suffix}`,
        runId,
        second!.id,
        tenantId,
        'http.post',
        `idem-invalid-lease-${suffix}`,
        requestHash(invalidLeaseRequest),
        'decision',
        'policy-v1',
        'd'.repeat(64),
        workerId,
        workerGeneration,
        'invalid-lease-token',
        second!.lease!.fencingEpoch,
        JSON.stringify(invalidLeaseRequest),
      ],
      tenantAuthorityPool,
    ).finally(() => {
      invalidLeaseSettled = true;
    });
    const nonClassAAdmissions = Promise.all([
      admitNonClassA(
        appPool,
        tenantId,
        [
          `effect-class-b-${suffix}`,
          runId,
          first!.id,
          tenantId,
          'read.cache',
          `idem-class-b-${suffix}`,
          requestHash(classBRequest),
          'decision',
          'policy-v1',
          'c'.repeat(64),
          workerId,
          workerGeneration,
          first!.lease!.token,
          first!.lease!.fencingEpoch,
          JSON.stringify(classBRequest),
        ],
        tenantAuthorityPool,
      ),
      admitNonClassA(workerPool, tenantId, [
        `effect-class-c-${suffix}`,
        runId,
        second!.id,
        tenantId,
        'compute.fold',
        `idem-class-c-${suffix}`,
        requestHash(classCRequest),
        'decision',
        'policy-v1',
        'c'.repeat(64),
        workerId,
        workerGeneration,
        second!.lease!.token,
        second!.lease!.fencingEpoch,
        JSON.stringify(classCRequest),
      ]),
    ]).finally(() => {
      nonClassASettled = true;
    });
    // Leave enough time for a fresh pool connection to complete while the
    // operations-worker row lock remains held. The assertion still runs well
    // before the lock is released below, so a readiness-row lock remains
    // observable as a blocked admission.
    // CI runners can spend several hundred milliseconds establishing the two
    // fresh role connections. Keep the readiness lock held long enough to
    // observe the invariant without turning connection cold-start into a test
    // failure.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const completedBeforeOperationsUnlock = nonClassASettled;
    const invalidLeaseCompletedBeforeOperationsUnlock = invalidLeaseSettled;
    await operationsLock.query('ROLLBACK');
    operationsLock.release();
    const [classB, classC] = await nonClassAAdmissions;
    const invalidLease = await invalidLeaseAdmission;

    assert.equal(
      completedBeforeOperationsUnlock,
      true,
      'non-Class-A admission must not read or lock operations-readiness rows',
    );
    assert.deepEqual(
      classB,
      { admitted: true, reason: null },
      'Class B must be admitted through the non-Class-A RPC',
    );
    assert.deepEqual(
      classC,
      { admitted: true, reason: null },
      'Class C must be admitted through the non-Class-A RPC',
    );
    assert.equal(
      invalidLeaseCompletedBeforeOperationsUnlock,
      true,
      'invalid Class A lease must fail before operations-readiness locks are acquired',
    );
    assert.deepEqual(invalidLease, { admitted: false, reason: 'LEASE_LOST', replayed: false });

    const compensationRejected = await workerRepo.admitEffect({
      id: `effect-compensation-rejected-${suffix}`,
      runId,
      stepId: first!.id,
      tenantId,
      type: 'compensate.crm.write',
      idempotencyKey: `idem-compensation-rejected-${suffix}`,
      policyDecisionId: 'decision',
      policySnapshotId: 'policy-v1',
      actionDigest: 'd'.repeat(64),
      request: { authorizationId: 'auth-1', requestId: 'request-1', claimToken: 'claim-1' },
      lease: first!.lease!,
      actor: workerId,
    });
    assert.deepEqual(compensationRejected, {
      admitted: false,
      reason: 'COMPENSATION_ADMISSION_UNAVAILABLE',
    });

    const backlogEventId = `task1-backlog-event-${suffix}`;
    await ownerPool.query(
      `INSERT INTO commander_events (
         id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,actor,schema_version,payload
       ) VALUES ($1,'run',$2,99,'compensation.requested',$3,$2,'task1-live','v2','{}')`,
      [backlogEventId, runId, tenantId],
    );
    const backlogId = `task1-backlog-${suffix}`;
    await ownerPool.query(
      `INSERT INTO commander_outbox (
         id,event_id,tenant_id,topic,key,payload,attempts,max_attempts,available_at
       ) VALUES ($1,$2,$3,'commander.kernel.compensation.requested',$4,'{}',0,5,clock_timestamp())`,
      [backlogId, backlogEventId, tenantId, runId],
    );
    const backlogHeartbeat = await adapterPool.query<{ heartbeat: unknown | null }>(
      'SELECT heartbeat_adapter_ops_worker($1,$2,$3) AS heartbeat',
      [compensationId, compensationGeneration, compensationSecret],
    );
    assert.notEqual(backlogHeartbeat.rows[0]?.heartbeat, null);
    assert.equal((await appRepo.getOperationsReadiness(tenantId)).ready, true);
    assert.equal(
      (await adapterRepo.getOperationsReadiness(tenantId)).ready,
      true,
      'adapter-ops LOGIN must report fresh workers independently of backlog state',
    );
    const backlogAdmitted = await appRepo.admitEffect({
      id: `effect-backlog-independent-${suffix}`,
      runId,
      stepId: first!.id,
      tenantId,
      type: 'http.post',
      idempotencyKey: `idem-backlog-independent-${suffix}`,
      policyDecisionId: 'decision',
      policySnapshotId: 'policy-v1',
      actionDigest: 'e'.repeat(64),
      request: { payload: 'backlog-does-not-redefine-readiness' },
      lease: first!.lease!,
      actor: workerId,
    });
    assert.equal(backlogAdmitted.admitted, true);
    await ownerPool.query('DELETE FROM commander_outbox WHERE id=$1', [backlogId]);
    await adapterPool.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      compensationId,
      compensationGeneration,
      compensationSecret,
    ]);
    assert.equal((await appRepo.getOperationsReadiness(tenantId)).ready, true);

    const request = { method: 'POST', payload: { b: 2, a: 1 } };
    const tx = await appPool.connect();
    await tx.query('BEGIN');
    const txContextId = await bindAuthenticatedTenant(tx, tenantAuthorityPool, tenantId);
    const admitted = await tx.query<{ admitted: boolean; reason: string | null }>(
      `SELECT admitted, reason FROM admit_class_a_effect(
         $1,$2,$3,$4,'http.post',$5,$6,'decision','policy-v1',$7,
         $8,$9,$10,$11,$12::jsonb
       )`,
      [
        `effect-race-${suffix}`,
        runId,
        first!.id,
        tenantId,
        `idem-race-${suffix}`,
        requestHash(request),
        'a'.repeat(64),
        workerId,
        workerGeneration,
        first!.lease!.token,
        first!.lease!.fencingEpoch,
        JSON.stringify(request),
      ],
    );
    assert.deepEqual(admitted.rows[0], { admitted: true, reason: null });

    let drainSettled = false;
    const drain = adapterPool
      .query<{ drained: boolean }>('SELECT drain_adapter_ops_worker($1,$2,$3) AS drained', [
        compensationId,
        compensationGeneration,
        compensationSecret,
      ])
      .then((result) => {
        drainSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(drainSettled, false, 'drain must wait for the admission worker-row lock');
    await tx.query('SELECT public.close_app_tenant_context($1::uuid)', [txContextId]);
    await tx.query('COMMIT');
    tx.release();
    assert.equal((await drain).rows[0]?.drained, true);

    const waitingReplayRequest = { payload: 'completed-during-readiness-wait' };
    const waitingReplayKey = `idem-waiting-replay-${suffix}`;
    const waitingReplayEffectId = `effect-waiting-replay-${suffix}`;
    await ownerPool.query(
      `INSERT INTO commander_effects (
         id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,
         policy_decision_id,policy_snapshot_id,action_digest,
         lease_worker_id,lease_worker_generation,lease_fencing_epoch,state,request
       ) VALUES ($1,$2,$3,$4,'http.post',$5,$6,'decision','policy-v1',$7,$8,$9,$10,'ADMITTED',$11::jsonb)`,
      [
        waitingReplayEffectId,
        runId,
        second!.id,
        tenantId,
        waitingReplayKey,
        requestHash(waitingReplayRequest),
        '6'.repeat(64),
        workerId,
        workerGeneration,
        second!.lease!.fencingEpoch,
        JSON.stringify(waitingReplayRequest),
      ],
    );
    const replayLock = await ownerPool.connect();
    await replayLock.query('BEGIN');
    await replayLock.query(
      'SELECT id FROM commander_workers WHERE id = ANY($1::text[]) FOR UPDATE',
      [[reconcileId, compensationId]],
    );
    let waitingReplaySettled = false;
    const waitingReplay = admitClassA(
      appPool,
      tenantId,
      [
        `effect-waiting-replay-caller-${suffix}`,
        runId,
        second!.id,
        tenantId,
        'http.post',
        waitingReplayKey,
        requestHash(waitingReplayRequest),
        'decision',
        'policy-v1',
        '6'.repeat(64),
        workerId,
        workerGeneration,
        second!.lease!.token,
        second!.lease!.fencingEpoch,
        JSON.stringify(waitingReplayRequest),
      ],
      tenantAuthorityPool,
    ).finally(() => {
      waitingReplaySettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(waitingReplaySettled, false, 'incomplete replay must wait for readiness locks');
    await ownerPool.query(
      `UPDATE commander_effects
       SET state='COMPLETED', response='{"receipt":"during-wait"}'::jsonb, completed_at=clock_timestamp()
       WHERE id=$1`,
      [waitingReplayEffectId],
    );
    await replayLock.query('ROLLBACK');
    replayLock.release();
    assert.deepEqual(
      await waitingReplay,
      { admitted: true, reason: null, replayed: true },
      'a replay completed during the readiness lock wait must be rechecked before readiness rejection',
    );

    const incompleteReplayAfterDrain = await admitClassA(
      appPool,
      tenantId,
      [
        `effect-race-replay-${suffix}`,
        runId,
        first!.id,
        tenantId,
        'http.post',
        `idem-race-${suffix}`,
        requestHash(request),
        'decision',
        'policy-v1',
        'a'.repeat(64),
        workerId,
        workerGeneration,
        first!.lease!.token,
        first!.lease!.fencingEpoch,
        JSON.stringify(request),
      ],
      tenantAuthorityPool,
    );
    assert.deepEqual(
      incompleteReplayAfterDrain,
      { admitted: false, reason: 'OPERATIONS_NOT_READY', replayed: false },
      'an incomplete replay remains gated after operations readiness drains',
    );

    await ownerPool.query(
      `UPDATE commander_effects
       SET state='COMPLETED', response='{"receipt":"durable"}'::jsonb, completed_at=now()
       WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantId, `idem-race-${suffix}`],
    );
    const completedReplayAfterDrain = await admitClassA(
      appPool,
      tenantId,
      [
        `effect-race-completed-replay-${suffix}`,
        runId,
        first!.id,
        tenantId,
        'http.post',
        `idem-race-${suffix}`,
        requestHash(request),
        'decision',
        'policy-v1',
        'a'.repeat(64),
        workerId,
        workerGeneration,
        first!.lease!.token,
        first!.lease!.fencingEpoch,
        JSON.stringify(request),
      ],
      tenantAuthorityPool,
    );
    assert.deepEqual(
      completedReplayAfterDrain,
      { admitted: true, reason: null, replayed: true },
      'a completed durable receipt remains replayable after operations readiness drains',
    );

    const inserted = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM commander_effects WHERE id=$1',
      [`effect-race-${suffix}`],
    );
    assert.equal(Number(inserted.rows[0]?.count), 1, 'admission committed before drain');

    const blocked = await appRepo.admitEffect({
      id: `effect-blocked-${suffix}`,
      runId,
      stepId: second!.id,
      tenantId,
      type: 'http.post',
      idempotencyKey: `idem-blocked-${suffix}`,
      policyDecisionId: 'decision',
      policySnapshotId: 'policy-v1',
      actionDigest: 'b'.repeat(64),
      request: { payload: 'blocked-after-drain' },
      lease: second!.lease!,
      actor: workerId,
    });
    assert.deepEqual(blocked, { admitted: false, reason: 'OPERATIONS_NOT_READY' });
    const absent = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM commander_effects WHERE id=$1',
      [`effect-blocked-${suffix}`],
    );
    assert.equal(Number(absent.rows[0]?.count), 0, 'no effect inserts after owner drain');
  });

  it('evaluates worker freshness after a cross-TTL lock wait', async () => {
    const registration = await adapterPool.query<{
      registration: { generation: number; claim_secret: string };
    }>(`SELECT register_adapter_ops_worker('compensation',$1,$2::jsonb,$3) AS registration`, [
      instanceId,
      JSON.stringify([tenantId]),
      compensationSecret,
    ]);
    compensationGeneration = Number(registration.rows[0]!.registration.generation);
    compensationSecret = registration.rows[0]!.registration.claim_secret;
    await adapterPool.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      reconcileId,
      reconcileGeneration,
      reconcileSecret,
    ]);
    await adapterPool.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      compensationId,
      compensationGeneration,
      compensationSecret,
    ]);

    const runId = `task1-ttl-run-${suffix}`;
    await appRepo.createRun(
      {
        id: runId,
        tenantId,
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-v1',
        steps: [{ id: `step-ttl-${suffix}`, kind: 'agent' }],
      },
      'task1-live',
    );
    const claimed = await workerRepo.claimNextStep({
      workerId,
      workerGeneration,
      claimSecret: workerSecret,
      capabilities: ['agent'],
      leaseTtlMs: 60_000,
    });
    assert.ok(claimed?.lease);

    await ownerPool.query(
      `UPDATE commander_workers
       SET registered_at=clock_timestamp()-interval '60 seconds',
           last_heartbeat_at=CASE WHEN id=$1
             THEN clock_timestamp()-interval '29.5 seconds'
             ELSE clock_timestamp()
           END
       WHERE id = ANY($2::text[])`,
      [compensationId, [reconcileId, compensationId]],
    );
    const lock = await ownerPool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM commander_workers WHERE id = ANY($1::text[]) FOR UPDATE', [
      [reconcileId, compensationId],
    ]);
    const pendingAdmission = appRepo.admitEffect({
      id: `effect-ttl-blocked-${suffix}`,
      runId,
      stepId: claimed!.id,
      tenantId,
      type: 'http.post',
      idempotencyKey: `idem-ttl-blocked-${suffix}`,
      policyDecisionId: 'decision',
      policySnapshotId: 'policy-v1',
      actionDigest: 'f'.repeat(64),
      request: { payload: 'cross-ttl' },
      lease: claimed!.lease!,
      actor: workerId,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    await lock.query('COMMIT');
    lock.release();
    assert.deepEqual(await pendingAdmission, { admitted: false, reason: 'OPERATIONS_NOT_READY' });
    const absent = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM commander_effects WHERE id=$1',
      [`effect-ttl-blocked-${suffix}`],
    );
    assert.equal(Number(absent.rows[0]?.count), 0);
  });
});
