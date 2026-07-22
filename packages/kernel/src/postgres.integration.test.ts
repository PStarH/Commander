import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { PostgresKernelRepository } from './postgres.js';
import type { SqlClient, SqlPool } from './postgres.js';
import { runKernelMigrations } from './migrations.js';
import { KernelInvariantError } from './types.js';
import { runKernelRepositoryContractTests } from './testing/repositoryContract.js';
import { TENANT_TABLES } from './schema.js';
import { seedWorkerAllowedTenants, seedWorkerClaimSecret } from './seedWorkerClaimSecret.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;
const workerPassword = process.env.COMMANDER_WORKER_PASSWORD ?? 'commander_worker';

function deriveRoleDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

const workerDatabaseUrl =
  process.env.COMMANDER_WORKER_DATABASE_URL ??
  (databaseUrl ? deriveRoleDatabaseUrl(databaseUrl, 'commander_worker', workerPassword) : undefined);

/** Pool wrapper that SET SESSION ROLEs on every acquired connection. */
function createRolePool(ownerDatabaseUrl: string, role: string): SqlPool & { end: () => Promise<void> } {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return {
    connect: async () => {
      const client = await pool.connect();
      await client.query(`SET SESSION ROLE ${role}`);
      return client as SqlClient;
    },
    end: () => pool.end(),
  };
}

/** True LOGIN pool — session_user is the role (unlike SET SESSION ROLE from owner). */
function createLoginPool(roleDatabaseUrl: string): SqlPool & { end: () => Promise<void> } {
  const pool = new Pool({ connectionString: roleDatabaseUrl, max: 2 });
  return {
    connect: async () => (await pool.connect()) as SqlClient,
    end: () => pool.end(),
  };
}

async function ensureRoleLogin(ownerPool: Pool, role: string, password: string): Promise<void> {
  const escaped = password.replace(/'/g, "''");
  await ownerPool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${escaped}'`);
}

async function resetPostgresContractTables(pool: Pool): Promise<void> {
  // Contract suite reuses fixed ids (run-1 / tenant-a); wipe between cases.
  // Keep migration ledger so runKernelMigrations stays idempotent.
  await pool.query(`
    DO $reset$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename LIKE 'commander_%'
          AND tablename <> 'commander_kernel_migrations'
      LOOP
        EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
      END LOOP;
    END
    $reset$;
  `);
}

if (databaseUrl) {
  runKernelRepositoryContractTests({
    name: 'Postgres',
    create: async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await runKernelMigrations(pool);
      await resetPostgresContractTables(pool);
      const repo = new PostgresKernelRepository(pool, { schedulerMode: true });
      (repo as PostgresKernelRepository & { _contractPool?: Pool })._contractPool = pool;
      return repo;
    },
    destroy: async (repo) => {
      const pg = repo as PostgresKernelRepository & { _contractPool?: Pool };
      if (pg._contractPool) await pg._contractPool.end();
    },
    seedWorker: async (repo) => {
      const pg = repo as PostgresKernelRepository & { _contractPool?: Pool };
      const workerId = `contract-worker-${Date.now()}`;
      await pg._contractPool!.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','contract','["agent","tool"]',4,'ACTIVE',1,$1,$2::jsonb)`,
        [workerId, JSON.stringify(['tenant-a'])],
      );
      return { workerId, generation: 1 };
    },
  });
}

describe('PostgresKernelRepository integration', () => {
  it('limits commander_worker DML to the execution data path', { skip: !databaseUrl }, async () => {
    if (!databaseUrl) return;
    const ownerPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await runKernelMigrations(ownerPool);
    try {
      const forbidden = [
        'commander_runs',
        'commander_steps',
        'commander_workers',
        'commander_effect_allowlist',
        'commander_action_kill_switches',
        'commander_tenant_execution_limits',
        'commander_tenant_execution_control',
        'commander_outbox_dlq',
      ];
      for (const table of forbidden) {
        const privileges = await ownerPool.query<{ can_insert: boolean; can_delete: boolean }>(
          `SELECT
             has_table_privilege('commander_worker', $1, 'INSERT') AS can_insert,
             has_table_privilege('commander_worker', $1, 'DELETE') AS can_delete`,
          [table],
        );
        assert.equal(privileges.rows[0]?.can_insert, false, `commander_worker must not INSERT ${table}`);
        assert.equal(privileges.rows[0]?.can_delete, false, `commander_worker must not DELETE ${table}`);
      }

      const required = [
        ['commander_events', 'INSERT'],
        ['commander_effects', 'INSERT'],
        ['commander_effects', 'UPDATE'],
        ['commander_steps', 'UPDATE'],
        ['commander_runs', 'UPDATE'],
        ['commander_interactions', 'INSERT'],
        ['commander_interactions', 'UPDATE'],
        ['commander_capability_replays', 'INSERT'],
      ] as const;
      for (const [table, privilege] of required) {
        const result = await ownerPool.query<{ allowed: boolean }>(
          `SELECT has_table_privilege('commander_worker', $1, $2) AS allowed`,
          [table, privilege],
        );
        assert.equal(result.rows[0]?.allowed, true, `commander_worker requires ${privilege} on ${table}`);
      }
    } finally {
      await ownerPool.end();
    }
  });

  it('runs checksummed migrations, enforces worker generation fencing, and preserves tenant isolation', { skip: !databaseUrl || !workerDatabaseUrl }, async () => {
    if (!databaseUrl || !workerDatabaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await runKernelMigrations(pool);
    await ensureRoleLogin(pool, 'commander_app', process.env.COMMANDER_APP_PASSWORD ?? 'commander_app');
    await ensureRoleLogin(pool, 'commander_scheduler', process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler');
    await ensureRoleLogin(pool, 'commander_worker', workerPassword);
    const appPool = createRolePool(databaseUrl, 'commander_app');
    const workerPool = createLoginPool(workerDatabaseUrl);
    const tenantA = `integration-a-${Date.now()}`;
    const tenantB = `integration-b-${Date.now()}`;
    const workerA = `integration-worker-a-${Date.now()}`;
    const workerB = `integration-worker-b-${Date.now()}`;
    // App role for RLS-scoped reads/writes; worker LOGIN for claim RPC (EXECUTE only).
    // Do not use owner+SET ROLE worker: enforceAppRole KEEP_IDENTITY keys off session_user
    // and would downgrade back to commander_app.
    const repoA = new PostgresKernelRepository(appPool);
    const repoB = new PostgresKernelRepository(appPool);
    const workerRepoA = new PostgresKernelRepository(workerPool, { schedulerMode: false });
    const workerRepoB = new PostgresKernelRepository(workerPool, { schedulerMode: false });
    try {

      const migrationRows = await pool.query(`SELECT id, checksum FROM commander_kernel_migrations ORDER BY id`);
      assert.ok(migrationRows.rows.length >= 4, 'schema, RLS, roles, and claim migrations must be recorded');
      assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.schema')));
      assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.rls')));
      assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.roles')));
      assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.claim')));
      assert.ok(migrationRows.rows.every((row: { checksum: string }) => /^[a-f0-9]{64}$/.test(row.checksum)));

      const policyRows = await pool.query(`SELECT tablename FROM pg_policies WHERE policyname='commander_tenant_isolation'`);
      assert.ok(policyRows.rows.length >= 8, 'tenant RLS policies must be installed');

      // Every tenant table must have RLS both ENABLED and FORCED.
      const rlsRows = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[])`,
        [TENANT_TABLES as unknown as string[]],
      );
      assert.equal(rlsRows.rows.length, TENANT_TABLES.length, 'all tenant tables must exist');
      for (const row of rlsRows.rows) {
        assert.equal(row.relrowsecurity, true, `${row.relname} must ENABLE RLS`);
        assert.equal(row.relforcerowsecurity, true, `${row.relname} must FORCE RLS`);
      }

      // App + worker must not bypass RLS; every runtime role must be non-superuser.
      const roleAttrs = await pool.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
        `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
         WHERE rolname IN ('commander_app','commander_worker','commander_scheduler')`,
      );
      const byName = new Map(roleAttrs.rows.map((r) => [r.rolname, r]));
      assert.equal(byName.get('commander_app')?.rolbypassrls, false, 'commander_app must NOT bypass RLS');
      assert.equal(byName.get('commander_worker')?.rolbypassrls, false, 'commander_worker must NOT bypass RLS');
      for (const name of ['commander_app', 'commander_worker', 'commander_scheduler']) {
        assert.equal(byName.get(name)?.rolsuper, false, `${name} must not be a superuser`);
      }

      await pool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["agent"]',2,'ACTIVE',1,$2,$3::jsonb),
                ($4,'agent','integration','["agent"]',2,'ACTIVE',1,$5,$6::jsonb)`,
        [workerA, workerA, JSON.stringify([tenantA]), workerB, workerB, JSON.stringify([tenantA])],
      );
      const secretA = await seedWorkerClaimSecret(pool, workerA, 1);
      const secretB = await seedWorkerClaimSecret(pool, workerB, 1);
      await repoA.createRun({
        id: `run-${tenantA}`,
        tenantId: tenantA,
        intentHash: 'intent-a',
        workGraphHash: 'graph-a',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-a',
        steps: [{ id: `step-${tenantA}`, kind: 'agent', maxAttempts: 2 }],
      }, 'integration');
      await repoA.createRun({
        id: `run-${tenantB}`,
        tenantId: tenantB,
        intentHash: 'intent-b',
        workGraphHash: 'graph-b',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-b',
        steps: [{ id: `step-${tenantB}`, kind: 'agent', maxAttempts: 2 }],
      }, 'integration');

      const [claimA, claimB] = await Promise.all([
        workerRepoA.claimNextStep({ workerId: workerA, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: secretA }),
        workerRepoB.claimNextStep({ workerId: workerB, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: secretB }),
      ]);
      assert.equal([claimA, claimB].filter(Boolean).length, 1, 'FOR UPDATE SKIP LOCKED must allow one claimant');
      const claimed = claimA ?? claimB;
      assert.equal(claimed?.lease?.workerGeneration, 1);
      assert.equal(await repoA.getRun(`run-${tenantB}`, tenantA), null, 'cross-tenant reads must return null');

      const staleLease = { ...claimed!.lease!, workerGeneration: 0 };
      assert.equal(await repoA.completeStep({ stepId: claimed!.id, tenantId: claimed!.tenantId, lease: staleLease, expectedVersion: claimed!.version, actor: workerA }), null);
      assert.ok(await repoA.completeStep({ stepId: claimed!.id, tenantId: claimed!.tenantId, lease: claimed!.lease!, expectedVersion: claimed!.version, actor: workerA }));

      await repoA.createRun({
        id: `run-${tenantA}-generation`,
        tenantId: tenantA,
        intentHash: 'intent-generation',
        workGraphHash: 'graph-generation',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-a',
        steps: [{ id: `step-${tenantA}-generation`, kind: 'agent' }],
      }, 'integration');
      await pool.query('UPDATE commander_workers SET generation=2 WHERE id=$1', [workerA]);
      const secretAGen2 = await seedWorkerClaimSecret(pool, workerA, 2);
      assert.equal(
        await workerRepoA.claimNextStep({ workerId: workerA, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: secretA }),
        null,
      );
      const currentGenerationClaim = await workerRepoA.claimNextStep({
        workerId: workerA,
        workerGeneration: 2,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret: secretAGen2,
      });
      assert.equal(currentGenerationClaim?.lease?.workerGeneration, 2);
      assert.ok(await repoA.completeStep({ stepId: currentGenerationClaim!.id, tenantId: currentGenerationClaim!.tenantId, lease: currentGenerationClaim!.lease!, expectedVersion: currentGenerationClaim!.version, actor: workerA }));
    } finally {
      await pool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB]]);
      await pool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])', [[workerA, workerB]]);
      await pool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [[workerA, workerB]]);
      await workerPool.end();
      await appPool.end();
      await pool.end();
    }
  });

  it('atomically releases kernel-native approvals with fencing and tenant isolation', { skip: !databaseUrl || !workerDatabaseUrl }, async () => {
    if (!databaseUrl || !workerDatabaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await runKernelMigrations(pool);
    await ensureRoleLogin(pool, 'commander_app', process.env.COMMANDER_APP_PASSWORD ?? 'commander_app');
    await ensureRoleLogin(pool, 'commander_scheduler', process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler');
    await ensureRoleLogin(pool, 'commander_worker', workerPassword);
    const appPool = createRolePool(databaseUrl, 'commander_app');
    const workerPool = createLoginPool(workerDatabaseUrl);
    const suffix = `${Date.now()}-${process.pid}`;
    const tenantA = `approval-a-${suffix}`;
    const tenantB = `approval-b-${suffix}`;
    const runId = `run-approval-${suffix}`;
    const stepId = `step-approval-${suffix}`;
    const interactionId = `interaction-approval-${suffix}`;
    const rolledBackRunId = `run-approval-rollback-${suffix}`;
    const rolledBackStepId = `step-approval-rollback-${suffix}`;
    const workerId = `worker-approval-${suffix}`;
    const repoA = new PostgresKernelRepository(appPool);
    const repoB = new PostgresKernelRepository(appPool);
    const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
    try {
      await pool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["tool"]',1,'ACTIVE',1,$2,$3::jsonb)`,
        [workerId, workerId, JSON.stringify([tenantA])],
      );
      const claimSecret = await seedWorkerClaimSecret(pool, workerId, 1);
      await repoA.createRun({
        id: runId,
        tenantId: tenantA,
        intentHash: 'approval-intent',
        workGraphHash: 'approval-graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'approval-policy',
        steps: [{
          id: stepId,
          kind: 'tool',
          initialState: 'WAITING_FOR_HUMAN',
          maxAttempts: 2,
          interaction: {
            id: interactionId,
            prompt: 'Approve integration action?',
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
        }],
      }, 'integration');

      await assert.rejects(
        () => repoA.createRun({
          id: rolledBackRunId,
          tenantId: tenantA,
          intentHash: 'rollback-intent',
          workGraphHash: 'rollback-graph',
          workGraphVersion: 'v1',
          policySnapshotId: 'approval-policy',
          steps: [{
            id: rolledBackStepId,
            kind: 'tool',
            initialState: 'WAITING_FOR_HUMAN',
            interaction: { id: interactionId, prompt: 'Duplicate interaction' },
          }],
        }, 'integration'),
        (error) => error instanceof KernelInvariantError && error.code === 'DUPLICATE_INTERACTION',
      );
      assert.equal(await repoA.getRun(rolledBackRunId, tenantA), null);
      assert.equal(await repoA.getStep(rolledBackStepId, tenantA), null);

      assert.equal(await repoB.getInteraction(interactionId, tenantB), null);
      assert.equal(await repoB.getStep(stepId, tenantB), null);
      await assert.rejects(
        () => repoB.answerInteraction({
          interactionId,
          runId,
          tenantId: tenantB,
          response: { approved: true },
          actor: 'cross-tenant-reviewer',
        }),
        (error) => error instanceof KernelInvariantError && error.code === 'INTERACTION_NOT_FOUND',
      );

      const answers = await Promise.allSettled([
        repoA.answerInteraction({
          interactionId,
          runId,
          tenantId: tenantA,
          response: { approved: true, reviewer: 'reviewer-a' },
          actor: 'reviewer-a',
        }),
        repoA.answerInteraction({
          interactionId,
          runId,
          tenantId: tenantA,
          response: { approved: true, reviewer: 'reviewer-b' },
          actor: 'reviewer-b',
        }),
      ]);
      assert.equal(answers.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = answers.find((result) => result.status === 'rejected');
      assert.ok(rejected?.status === 'rejected');
      assert.ok(rejected.reason instanceof KernelInvariantError);
      assert.equal(rejected.reason.code, 'INTERACTION_NOT_FOUND');

      const claimed = await workerRepo.claimNextStep({
        workerId,
        workerGeneration: 1,
        capabilities: ['tool'],
        leaseTtlMs: 30_000,
        claimSecret,
      });
      assert.equal(claimed?.id, stepId);
      assert.equal(claimed?.state, 'RUNNING');
      assert.equal(claimed?.lease?.fencingEpoch, 1);
      assert.ok(claimed?.lease?.token);
      assert.equal(await repoA.completeStep({
        stepId,
        tenantId: tenantA,
        lease: { ...claimed!.lease!, token: 'stale-token' },
        expectedVersion: claimed!.version,
        actor: workerId,
      }), null);
      assert.ok(await repoA.completeStep({
        stepId,
        tenantId: tenantA,
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        actor: workerId,
      }));
    } finally {
      await pool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB]]);
      await pool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [workerId]);
      await pool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
      await workerPool.end();
      await appPool.end();
      await pool.end();
    }
  });

  it('worker LOGIN DSN (schedulerMode false) claims via durable authz and cannot widen with tenantIds', { skip: !databaseUrl || !workerDatabaseUrl }, async () => {
    if (!databaseUrl || !workerDatabaseUrl) return;
    const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    await runKernelMigrations(ownerPool);
    await ensureRoleLogin(ownerPool, 'commander_app', process.env.COMMANDER_APP_PASSWORD ?? 'commander_app');
    await ensureRoleLogin(ownerPool, 'commander_scheduler', process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler');
    await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);

    const workerPool = createLoginPool(workerDatabaseUrl);
    const appPool = createRolePool(databaseUrl, 'commander_app');
    const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
    const appRepo = new PostgresKernelRepository(appPool);
    const suffix = `${Date.now()}-${process.pid}`;
    const tenantAllowed = `worker-allowed-${suffix}`;
    const tenantOutside = `worker-outside-${suffix}`;
    const workerId = `worker-dsn-${suffix}`;
    try {
      const identityClient = await workerPool.connect();
      try {
        const identity = await identityClient.query<{ session_user: string; current_user: string }>(
          'SELECT session_user::text AS session_user, current_user::text AS current_user',
        );
        assert.equal(identity.rows[0]?.session_user, 'commander_worker');
        assert.equal(identity.rows[0]?.current_user, 'commander_worker');
        await assert.rejects(
          identityClient.query('SET ROLE commander_app'),
          /permission denied/i,
          'worker LOGIN must not have commander_app membership',
        );
      } finally {
        identityClient.release();
      }

      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["agent"]',2,'ACTIVE',1,$1,$2::jsonb)`,
        [workerId, JSON.stringify([tenantAllowed])],
      );
      await seedWorkerAllowedTenants(ownerPool, [tenantAllowed]);
      const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);

      await appRepo.createRun({
        id: `run-${tenantAllowed}`,
        tenantId: tenantAllowed,
        intentHash: 'intent-allowed',
        workGraphHash: 'graph-allowed',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-allowed',
        steps: [{ id: `step-${tenantAllowed}`, kind: 'agent' }],
      }, 'integration');
      await appRepo.createRun({
        id: `run-${tenantOutside}`,
        tenantId: tenantOutside,
        intentHash: 'intent-outside',
        workGraphHash: 'graph-outside',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-outside',
        steps: [{ id: `step-${tenantOutside}`, kind: 'agent' }],
      }, 'integration');

      assert.ok(
        await workerRepo.getRun(`run-${tenantAllowed}`, tenantAllowed),
        'worker must read a run for an allowed explicit tenant',
      );
      assert.equal(
        await workerRepo.getRun(`run-${tenantOutside}`, tenantAllowed),
        null,
        'worker must not read a run outside its explicit tenant list',
      );

      // App role must not EXECUTE claim_next_step (worker-only privilege).
      await assert.rejects(
        () => appRepo.claimNextStep({
          workerId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret,
        }),
        /permission denied/i,
        'commander_app must not EXECUTE claim_next_step',
      );

      assert.equal(
        await workerRepo.claimNextStep({
          workerId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret: 'wrong-secret',
        }),
        null,
        'wrong claimSecret must claim nothing',
      );
      assert.equal(
        await workerRepo.claimNextStep({
          workerId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
        }),
        null,
        'missing claimSecret must claim nothing',
      );

      const claimAllowed = await workerRepo.claimNextStep({
        workerId,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret,
      });
      assert.ok(claimAllowed, 'worker LOGIN must claim via claim_next_step without caller tenantIds');
      assert.equal(claimAllowed!.tenantId, tenantAllowed);

      // Caller tenantIds must not widen durable authz.
      const claimOutside = await workerRepo.claimNextStep({
        workerId,
        workerGeneration: 1,
        tenantIds: [tenantOutside],
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret,
      });
      assert.equal(claimOutside, null, 'worker must not claim outside durable tenant_ids');

      // Fail-closed cases on the same LOGIN path.
      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids) VALUES
         ($1,'agent','integration','["agent"]',2,'ACTIVE',1,$1,'[]'::jsonb),
         ($2,'agent','integration','["agent"]',2,'ACTIVE',9,$2,$4::jsonb),
         ($3,'agent','integration','["agent"]',2,'OFFLINE',1,$3,$4::jsonb)`,
        [`${workerId}-empty`, `${workerId}-stale`, `${workerId}-off`, JSON.stringify([tenantOutside])],
      );
      const emptySecret = await seedWorkerClaimSecret(ownerPool, `${workerId}-empty`, 1);
      const staleSecret = await seedWorkerClaimSecret(ownerPool, `${workerId}-stale`, 9);
      const offSecret = await seedWorkerClaimSecret(ownerPool, `${workerId}-off`, 1);
      assert.equal(
        await workerRepo.claimNextStep({ workerId: `${workerId}-empty`, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: emptySecret }),
        null,
      );
      assert.equal(
        await workerRepo.claimNextStep({ workerId: `${workerId}-stale`, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: staleSecret }),
        null,
      );
      assert.equal(
        await workerRepo.claimNextStep({ workerId: `${workerId}-off`, workerGeneration: 1, capabilities: ['agent'], leaseTtlMs: 30_000, claimSecret: offSecret }),
        null,
      );
    } finally {
      await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantAllowed, tenantOutside]]);
      await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id LIKE $1', [`${workerId}%`]);
      await ownerPool.query('DELETE FROM commander_workers WHERE id LIKE $1', [`${workerId}%`]);
      await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [tenantAllowed]);
      await workerPool.end();
      await appPool.end();
      await ownerPool.end();
    }
  });

  it('app revoke + worker LOGIN observe isCapabilityRevoked under RLS (schedulerMode false)', { skip: !databaseUrl || !workerDatabaseUrl }, async () => {
    if (!databaseUrl || !workerDatabaseUrl) return;
    const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    await runKernelMigrations(ownerPool);
    await ensureRoleLogin(ownerPool, 'commander_app', process.env.COMMANDER_APP_PASSWORD ?? 'commander_app');
    await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);

    const workerPool = createLoginPool(workerDatabaseUrl);
    const appPool = createRolePool(databaseUrl, 'commander_app');
    const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
    const appRepo = new PostgresKernelRepository(appPool);
    const suffix = `${Date.now()}-${process.pid}`;
    const tenantId = `cap-rev-${suffix}`;
    const jti = `jti-${suffix}`;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    try {
      await seedWorkerAllowedTenants(ownerPool, [tenantId]);
      assert.equal(
        await workerRepo.isCapabilityRevoked(jti, tenantId),
        false,
        'worker observe before revoke must be false',
      );

      await appRepo.revokeCapability({
        jti,
        tenantId,
        expiresAt,
        reason: 'integration-worker-observe',
      });

      assert.equal(
        await workerRepo.isCapabilityRevoked(jti, tenantId),
        true,
        'worker LOGIN must observe app-written revocation under tenant RLS',
      );
      assert.equal(
        await workerRepo.isCapabilityRevoked(jti, `other-${tenantId}`),
        false,
        'worker must not observe revoke under wrong tenant scope',
      );
    } finally {
      await ownerPool.query(`DELETE FROM commander_capability_revocations WHERE tenant_id=$1`, [tenantId]);
      await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [tenantId]);
      await workerPool.end();
      await appPool.end();
      await ownerPool.end();
    }
  });

  it('worker LOGIN reads allowlist and updates quota without policy mutation authority', { skip: !databaseUrl || !workerDatabaseUrl }, async () => {
    if (!databaseUrl || !workerDatabaseUrl) return;
    const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    await runKernelMigrations(ownerPool);
    await ensureRoleLogin(ownerPool, 'commander_app', process.env.COMMANDER_APP_PASSWORD ?? 'commander_app');
    await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);

    const workerPool = createLoginPool(workerDatabaseUrl);
    const appPool = createRolePool(databaseUrl, 'commander_app');
    const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
    const appRepo = new PostgresKernelRepository(appPool);
    const suffix = `${Date.now()}-${process.pid}`;
    const tenantId = `allow-quota-${suffix}`;

    try {
      await seedWorkerAllowedTenants(ownerPool, [tenantId]);
      assert.equal(await workerRepo.isActionAllowed(tenantId, 'http.post'), false);
      await appRepo.setAllowlistEntry(tenantId, 'http.post', true);
      assert.equal(await workerRepo.isActionAllowed(tenantId, 'http.post'), true);

      await appRepo.ensureAllowlistDefault(tenantId, 'llm.*', true);
      assert.equal(await workerRepo.isActionAllowed(tenantId, 'llm.openai'), true);

      await assert.rejects(
        workerRepo.setAllowlistEntry(tenantId, 'worker.must-not-write', true),
        /permission denied/i,
        'commander_worker must not mutate policy allowlists',
      );
      await assert.rejects(
        workerRepo.putKillSwitch({
          tenantId,
          scope: 'tenant',
          value: tenantId,
          enabled: false,
          actor: 'commander_worker',
        }),
        /permission denied/i,
        'commander_worker must not mutate kill switches',
      );

      const r1 = await workerRepo.incrementQuota({ tenantId, actionClass: 'http' });
      assert.equal(r1.countUsed, 1);
      assert.equal((await workerRepo.getQuota(tenantId, 'http')).countUsed, 1);
    } finally {
      await ownerPool.query(`DELETE FROM commander_effect_allowlist WHERE tenant_id=$1`, [tenantId]);
      await ownerPool.query(`DELETE FROM commander_effect_quota WHERE tenant_id=$1`, [tenantId]);
      await ownerPool.query('DELETE FROM commander_action_kill_switches WHERE tenant_id=$1', [tenantId]);
      await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [tenantId]);
      await workerPool.end();
      await appPool.end();
      await ownerPool.end();
    }
  });

  it('worker LOGIN claimReconcileEffects via claim_reconcile_effects; app cannot EXECUTE', { skip: !databaseUrl || !workerDatabaseUrl }, async () => {
    if (!databaseUrl || !workerDatabaseUrl) return;
    const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    await runKernelMigrations(ownerPool);
    await ensureRoleLogin(ownerPool, 'commander_app', process.env.COMMANDER_APP_PASSWORD ?? 'commander_app');
    await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);

    const workerPool = createLoginPool(workerDatabaseUrl);
    const appPool = createRolePool(databaseUrl, 'commander_app');
    const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
    const appRepo = new PostgresKernelRepository(appPool);
    const suffix = `${Date.now()}-${process.pid}`;
    const tenantAllowed = `recon-ok-${suffix}`;
    const tenantOutside = `recon-out-${suffix}`;
    const workerId = `recon-worker-${suffix}`;
    const runId = `run-recon-${suffix}`;
    const stepId = `step-recon-${suffix}`;
    const effectId = `effect-recon-${suffix}`;

    try {
      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["agent"]',2,'ACTIVE',1,$1,$2::jsonb)`,
        [workerId, JSON.stringify([tenantAllowed])],
      );
      const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);

      await appRepo.createRun({
        id: runId,
        tenantId: tenantAllowed,
        intentHash: 'intent-recon',
        workGraphHash: 'graph-recon',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-recon',
        steps: [{ id: stepId, kind: 'agent' }],
      }, 'integration');

      const claimed = await workerRepo.claimNextStep({
        workerId,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret,
      });
      assert.ok(claimed?.lease);

      const admitted = await appRepo.admitEffect({
        id: effectId,
        runId,
        stepId,
        tenantId: tenantAllowed,
        type: 'http.post',
        idempotencyKey: `recon-key-${suffix}`,
        policyDecisionId: 'decision-1',
        policySnapshotId: 'policy-recon',
        actionDigest: 'a'.repeat(64),
        request: { url: 'https://example.com' },
        lease: claimed!.lease!,
        actor: workerId,
      });
      assert.ok(admitted.admitted);
      await appRepo.markEffectCompletionUnknown({
        effectId,
        tenantId: tenantAllowed,
        reason: 'timeout',
        actor: workerId,
      });
      const past = new Date(Date.now() - 1_000).toISOString();
      await appRepo.requestReconcile({
        effectId,
        tenantId: tenantAllowed,
        actor: 'integration',
        reconcileAfter: past,
      });

      await assert.rejects(
        () => appRepo.claimReconcileEffects({
          limit: 5,
          now: new Date(),
          workerId,
          workerGeneration: 1,
          claimSecret,
        }),
        /permission denied/i,
        'commander_app must not EXECUTE claim_reconcile_effects',
      );

      assert.deepEqual(
        await workerRepo.claimReconcileEffects({
          limit: 5,
          now: new Date(),
          workerId,
          workerGeneration: 1,
          claimSecret: 'wrong-secret',
        }),
        [],
        'wrong claimSecret must claim no reconcile effects',
      );

      const claimedEffects = await workerRepo.claimReconcileEffects({
        limit: 5,
        now: new Date(),
        workerId,
        workerGeneration: 1,
        claimSecret,
      });
      assert.equal(claimedEffects.length, 1, 'worker LOGIN must claim reconcile via RPC');
      assert.equal(claimedEffects[0]!.effect.tenantId, tenantAllowed);
      assert.ok(claimedEffects[0]!.claimToken);

      // Outside-tenant effect must not be claimable with durable authz for tenantAllowed only.
      const outsideRun = `run-out-${suffix}`;
      const outsideStep = `step-out-${suffix}`;
      const outsideEffect = `effect-out-${suffix}`;
      await appRepo.createRun({
        id: outsideRun,
        tenantId: tenantOutside,
        intentHash: 'intent-out',
        workGraphHash: 'graph-out',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-out',
        steps: [{ id: outsideStep, kind: 'agent' }],
      }, 'integration');
      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["agent"]',2,'ACTIVE',1,$1,$2::jsonb)`,
        [`${workerId}-out`, JSON.stringify([tenantOutside])],
      );
      const outsideSecret = await seedWorkerClaimSecret(ownerPool, `${workerId}-out`, 1);
      const outsideClaim = await workerRepo.claimNextStep({
        workerId: `${workerId}-out`,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret: outsideSecret,
      });
      assert.ok(outsideClaim?.lease);
      await appRepo.admitEffect({
        id: outsideEffect,
        runId: outsideRun,
        stepId: outsideStep,
        tenantId: tenantOutside,
        type: 'http.post',
        idempotencyKey: `out-key-${suffix}`,
        policyDecisionId: 'decision-1',
        policySnapshotId: 'policy-out',
        actionDigest: 'b'.repeat(64),
        request: {},
        lease: outsideClaim!.lease!,
        actor: `${workerId}-out`,
      });
      await appRepo.markEffectCompletionUnknown({
        effectId: outsideEffect,
        tenantId: tenantOutside,
        reason: 'timeout',
        actor: `${workerId}-out`,
      });
      await appRepo.requestReconcile({
        effectId: outsideEffect,
        tenantId: tenantOutside,
        actor: 'integration',
        reconcileAfter: past,
      });

      const noWiden = await workerRepo.claimReconcileEffects({
        limit: 5,
        now: new Date(),
        workerId,
        workerGeneration: 1,
        claimSecret,
      });
      assert.equal(
        noWiden.filter((e) => e.effect.tenantId === tenantOutside).length,
        0,
        'worker must not claim reconcile outside durable tenant_ids',
      );
    } finally {
      await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantAllowed, tenantOutside]]);
      await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id LIKE $1', [`${workerId}%`]);
      await ownerPool.query('DELETE FROM commander_workers WHERE id LIKE $1', [`${workerId}%`]);
      await workerPool.end();
      await appPool.end();
      await ownerPool.end();
    }
  });
});
