import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { PostgresKernelRepository, PostgresTenantContextAuthority } from './postgres.js';
import type { SqlClient, SqlPool } from './postgres.js';
import { runKernelMigrations } from './migrations.js';
import type {
  ClaimedReconcileEffect,
  ClaimReconcileEffectsInput,
  ClaimStepRequest,
  CompleteStepRequest,
  FailEffectRequest,
  KernelEffect,
  KernelLease,
  KernelOutboxMessage,
  KernelStep,
  KernelTimer,
  OperationsReadiness,
} from './types.js';
import { KernelInvariantError } from './types.js';
import { TENANT_TABLES } from './schema.js';
import { seedWorkerAllowedTenants, seedWorkerClaimSecret } from './seedWorkerClaimSecret.js';
import { runKernelRepositoryContractTests } from './testing/repositoryContract.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;
const workerPassword = process.env.COMMANDER_WORKER_PASSWORD ?? 'commander_worker';
const appPassword = process.env.COMMANDER_APP_PASSWORD ?? 'commander_app';
const adapterOpsPassword = process.env.COMMANDER_ADAPTER_OPS_PASSWORD ?? 'commander_adapter_ops';
const tenantAuthorityPassword =
  process.env.COMMANDER_TENANT_AUTHORITY_PASSWORD ?? 'commander_tenant_authority';
const contractDatabaseEnabled = process.env.COMMANDER_KERNEL_POSTGRES_CONTRACT_TEST === '1';
const contractDatabaseUrl = process.env.COMMANDER_KERNEL_POSTGRES_CONTRACT_DATABASE_URL;
const contractDatabaseMarker = 'commander_kernel_contract_v1';

function resolveContractDatabaseUrl(): string | undefined {
  if (!contractDatabaseEnabled) return undefined;
  if (!contractDatabaseUrl) {
    throw new Error('COMMANDER_KERNEL_POSTGRES_CONTRACT_DATABASE_URL_REQUIRED');
  }
  const databaseName = new URL(contractDatabaseUrl).pathname.slice(1);
  if (databaseName !== 'commander_kernel_contract') {
    throw new Error('COMMANDER_KERNEL_POSTGRES_CONTRACT_DATABASE_MUST_BE_ISOLATED');
  }
  return contractDatabaseUrl;
}

const isolatedContractDatabaseUrl = resolveContractDatabaseUrl();

function deriveRoleDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

const workerDatabaseUrl =
  process.env.COMMANDER_WORKER_DATABASE_URL ??
  (databaseUrl
    ? deriveRoleDatabaseUrl(databaseUrl, 'commander_worker', workerPassword)
    : undefined);
const schedulerDatabaseUrl =
  process.env.COMMANDER_SCHEDULER_DATABASE_URL ??
  (databaseUrl
    ? deriveRoleDatabaseUrl(
        databaseUrl,
        'commander_scheduler',
        process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler',
      )
    : undefined);
const adapterOpsDatabaseUrl =
  process.env.COMMANDER_ADAPTER_OPS_DATABASE_URL ??
  (databaseUrl
    ? deriveRoleDatabaseUrl(databaseUrl, 'commander_adapter_ops', adapterOpsPassword)
    : undefined);

const contractWorkerDatabaseUrl = isolatedContractDatabaseUrl
  ? deriveRoleDatabaseUrl(isolatedContractDatabaseUrl, 'commander_worker', workerPassword)
  : undefined;
const contractSchedulerDatabaseUrl = isolatedContractDatabaseUrl
  ? deriveRoleDatabaseUrl(
      isolatedContractDatabaseUrl,
      'commander_scheduler',
      process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler',
    )
  : undefined;
const contractAdapterOpsDatabaseUrl = isolatedContractDatabaseUrl
  ? deriveRoleDatabaseUrl(isolatedContractDatabaseUrl, 'commander_adapter_ops', adapterOpsPassword)
  : undefined;

function createEnforcedAppContext(
  ownerDatabaseUrl: string,
  options: { forceDerivedRoleUrls?: boolean } = {},
): {
  appPool: SqlPool & { end: () => Promise<void> };
  tenantAuthorityPool: SqlPool & { end: () => Promise<void> };
  createRepository: () => PostgresKernelRepository;
} {
  const forceDerivedRoleUrls = options.forceDerivedRoleUrls === true;
  const appPool = createLoginPool(
    (forceDerivedRoleUrls ? undefined : process.env.COMMANDER_APP_DATABASE_URL) ??
      deriveRoleDatabaseUrl(ownerDatabaseUrl, 'commander_app', appPassword),
  );
  const tenantAuthorityPool = createLoginPool(
    (forceDerivedRoleUrls ? undefined : process.env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL) ??
      deriveRoleDatabaseUrl(
        ownerDatabaseUrl,
        'commander_tenant_authority',
        tenantAuthorityPassword,
      ),
  );
  const authority = new PostgresTenantContextAuthority(tenantAuthorityPool);
  return {
    appPool,
    tenantAuthorityPool,
    createRepository: () =>
      new PostgresKernelRepository(appPool, {
        tenantContextAuthority: authority,
        tenantContextPhase: 'enforce',
      }),
  };
}

async function seedTenantAuthorityAllowedTenants(
  ownerPool: Pool,
  tenantIds: readonly string[],
): Promise<void> {
  for (const tenantId of tenantIds) {
    await ownerPool.query(
      `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
       VALUES ($1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  }
}

async function cleanupTenantTestState(
  ownerPool: Pool,
  tenantIds: readonly string[],
): Promise<void> {
  await ownerPool.query(
    'DELETE FROM commander_app_tenant_contexts WHERE tenant_id = ANY($1::text[])',
    [tenantIds],
  );
  await ownerPool.query(
    'DELETE FROM commander_tenant_authority_allowed_tenants WHERE tenant_id = ANY($1::text[])',
    [tenantIds],
  );
  await ownerPool.query(
    'DELETE FROM commander_worker_allowed_tenants WHERE tenant_id = ANY($1::text[])',
    [tenantIds],
  );
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
  // The contract reuses stable fixture IDs; its disposable integration database
  // is reset between cases while preserving the migration checksum ledger.
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

async function assertDisposableContractDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ marker: string }>(
    `SELECT marker
       FROM public.kernel_contract_disposable_marker
      WHERE marker = $1`,
    [contractDatabaseMarker],
  );
  if (result.rowCount !== 1) {
    throw new Error('COMMANDER_KERNEL_POSTGRES_CONTRACT_DATABASE_MARKER_REQUIRED');
  }
}

async function readPostgresClock(pool: SqlPool): Promise<Date> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ now: Date | string }>('SELECT clock_timestamp() AS now');
    const value = result.rows[0]?.now;
    if (!value) throw new Error('POSTGRES_CLOCK_UNAVAILABLE');
    return new Date(value);
  } finally {
    client.release();
  }
}

interface ContractWorkerCredential {
  id: string;
  generation: number;
  claimSecret: string;
}

interface PostgresContractResources {
  ownerPool: Pool;
  workerPool: Pool;
  adapterPool: Pool;
  schedulerPool: SqlPool & { end: () => Promise<void> };
  appPool: SqlPool & { end: () => Promise<void> };
  tenantAuthorityPool: SqlPool & { end: () => Promise<void> };
  workerRepository: PostgresKernelRepository;
  adapterRepository: PostgresKernelRepository;
  schedulerRepository: PostgresKernelRepository;
  workerCredential?: ContractWorkerCredential;
  reconcileCredential?: ContractWorkerCredential;
}

/**
 * The shared contract assumes a single repository, whereas production splits
 * app, worker, adapter-ops, and scheduler authority. This test-only facade
 * preserves that contract while each privileged operation uses its real LOGIN.
 */
class PostgresContractRepository extends PostgresKernelRepository {
  constructor(
    appPool: SqlPool,
    tenantContextAuthority: PostgresTenantContextAuthority,
    readonly resources: PostgresContractResources,
  ) {
    super(appPool, { tenantContextAuthority, tenantContextPhase: 'enforce' });
  }

  override async claimNextStep(request: ClaimStepRequest): Promise<KernelStep | null> {
    const credential = this.resources.workerCredential;
    if (!credential || request.workerId !== credential.id) return null;
    return this.resources.workerRepository.claimNextStep({
      ...request,
      workerGeneration: credential.generation,
      claimSecret: credential.claimSecret,
    });
  }

  override async getOperationsReadiness(tenantId: string, at?: Date): Promise<OperationsReadiness> {
    const readiness = await super.getOperationsReadiness(tenantId, at);
    return at ? { ...readiness, checkedAt: at.toISOString() } : readiness;
  }

  override async completeStep(request: CompleteStepRequest): Promise<KernelStep | null> {
    return this.resources.workerRepository.completeStep(request);
  }

  override async completeEffect(
    effectId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    response: Record<string, unknown>,
    actor: string,
  ): Promise<KernelEffect | null> {
    return this.resources.workerRepository.completeEffect(
      effectId,
      tenantId,
      lease,
      response,
      actor,
    );
  }

  override async failEffect(request: FailEffectRequest): Promise<KernelEffect | null> {
    return this.resources.workerRepository.failEffect(request);
  }

  override async claimOutbox(limit: number, now?: Date): Promise<KernelOutboxMessage[]> {
    // Scheduler claim eligibility is evaluated by PostgreSQL. Reading the same
    // server clock avoids relying on skewed process clocks across real LOGINS.
    return this.resources.schedulerRepository.claimOutbox(
      limit,
      now ?? (await readPostgresClock(this.resources.schedulerPool)),
    );
  }

  override async markOutboxPublished(
    messageId: string,
    claimToken: string,
    tenantId?: string,
  ): Promise<boolean> {
    return this.resources.schedulerRepository.markOutboxPublished(messageId, claimToken, tenantId);
  }

  override async claimExpiredTimers(now?: Date, limit?: number): Promise<KernelTimer[]> {
    return this.resources.schedulerRepository.claimExpiredTimers(now, limit);
  }

  override async claimReconcileEffects(
    input: ClaimReconcileEffectsInput,
  ): Promise<ClaimedReconcileEffect[]> {
    const credential = this.resources.reconcileCredential;
    if (!credential) return [];
    return this.resources.adapterRepository.claimReconcileEffects({
      ...input,
      workerId: credential.id,
      workerGeneration: credential.generation,
      claimSecret: credential.claimSecret,
    });
  }
}

async function seedContractWorker(repository: PostgresContractRepository): Promise<{
  workerId: string;
  generation: number;
}> {
  const { resources } = repository;
  if (resources.workerCredential) {
    return {
      workerId: resources.workerCredential.id,
      generation: resources.workerCredential.generation,
    };
  }
  const registration = await resources.workerPool.query<{
    registration: { id: string; generation: number; claim_secret: string };
  }>(
    `SELECT register_worker(
       'worker-1','agent','contract','["agent","tool"]'::jsonb,'{}'::jsonb,4,
       'db:commander_worker','["tenant-a"]'::jsonb,NULL
     ) AS registration`,
  );
  const credential = registration.rows[0]?.registration;
  assert.ok(credential, 'worker registration must return a credential');
  resources.workerCredential = {
    id: credential.id,
    generation: Number(credential.generation),
    claimSecret: credential.claim_secret,
  };
  return { workerId: credential.id, generation: Number(credential.generation) };
}

async function seedContractOperationsWorker(
  repository: PostgresContractRepository,
  input: {
    id: string;
    tenantIds: string[];
    capabilities: string[];
    status?: 'ACTIVE' | 'DRAINING' | 'OFFLINE';
    registeredAt: Date;
    lastHeartbeatAt: Date;
    identitySubject?: string;
  },
): Promise<void> {
  const { ownerPool, adapterPool } = repository.resources;
  const capability = input.capabilities[0];
  const role = capability === 'effect.reconcile' ? 'reconcile' : 'compensation';
  const instanceId = input.id.slice(input.id.indexOf(':') + 1).replaceAll('_', '-');
  const registeredWorkerId = `${role}:${instanceId}`;
  const canRegister =
    input.capabilities.length === 1 &&
    (capability === 'effect.reconcile' || capability === 'effect.compensate') &&
    input.status !== 'DRAINING' &&
    input.status !== 'OFFLINE' &&
    input.identitySubject === 'db:commander_adapter_ops' &&
    input.lastHeartbeatAt > input.registeredAt;

  for (const tenantId of input.tenantIds) {
    await ownerPool.query(
      `INSERT INTO commander_worker_allowed_tenants (tenant_id)
       VALUES ($1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  }

  await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [
    input.id,
  ]);
  await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [
    registeredWorkerId,
  ]);
  await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [input.id]);
  await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [registeredWorkerId]);

  if (canRegister) {
    const registration = await adapterPool.query<{
      registration: { id: string; generation: number; claim_secret: string };
    }>(`SELECT register_adapter_ops_worker($1,$2,$3::jsonb,NULL) AS registration`, [
      role,
      instanceId,
      JSON.stringify(input.tenantIds),
    ]);
    const credential = registration.rows[0]?.registration;
    assert.ok(credential, 'adapter-ops registration must return a credential');
    await adapterPool.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      credential.id,
      credential.generation,
      credential.claim_secret,
    ]);
    if (capability === 'effect.reconcile') {
      repository.resources.reconcileCredential = {
        id: credential.id,
        generation: Number(credential.generation),
        claimSecret: credential.claim_secret,
      };
    }
    return;
  }

  // Negative contract fixtures intentionally model rows a runtime RPC cannot create.
  await ownerPool.query(
    `INSERT INTO commander_workers (
       id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,
       tenant_ids,registered_at,last_heartbeat_at
     ) VALUES ($1,'agent','contract',$2::jsonb,1,$3,1,$4,$5::jsonb,$6,$7)`,
    [
      input.id,
      JSON.stringify(input.capabilities),
      input.status ?? 'ACTIVE',
      input.identitySubject ?? 'db:commander_adapter_ops',
      JSON.stringify(input.tenantIds),
      input.registeredAt.toISOString(),
      input.lastHeartbeatAt.toISOString(),
    ],
  );
}

if (
  contractDatabaseEnabled &&
  isolatedContractDatabaseUrl &&
  contractWorkerDatabaseUrl &&
  contractSchedulerDatabaseUrl &&
  contractAdapterOpsDatabaseUrl
) {
  runKernelRepositoryContractTests({
    name: 'Postgres enforced authorities',
    reconcileClaimUsesDatabaseClock: true,
    create: async () => {
      const ownerPool = new Pool({ connectionString: isolatedContractDatabaseUrl, max: 4 });
      await assertDisposableContractDatabase(ownerPool);
      await runKernelMigrations(ownerPool);
      await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
      await ensureRoleLogin(ownerPool, 'commander_tenant_authority', tenantAuthorityPassword);
      await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);
      await ensureRoleLogin(
        ownerPool,
        'commander_scheduler',
        process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler',
      );
      await ensureRoleLogin(ownerPool, 'commander_adapter_ops', adapterOpsPassword);
      await resetPostgresContractTables(ownerPool);
      await seedWorkerAllowedTenants(ownerPool, ['tenant-a']);
      await seedTenantAuthorityAllowedTenants(ownerPool, ['tenant-a', 'tenant-b']);

      const { appPool, tenantAuthorityPool } = createEnforcedAppContext(
        isolatedContractDatabaseUrl,
        { forceDerivedRoleUrls: true },
      );
      const workerPool = new Pool({ connectionString: contractWorkerDatabaseUrl, max: 2 });
      const adapterPool = new Pool({ connectionString: contractAdapterOpsDatabaseUrl, max: 2 });
      const schedulerPool = createLoginPool(contractSchedulerDatabaseUrl);
      const workerRepository = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      const adapterRepository = new PostgresKernelRepository(adapterPool, {
        schedulerMode: false,
        adapterOpsMode: true,
      });
      const schedulerRepository = new PostgresKernelRepository(schedulerPool, {
        schedulerMode: true,
      });
      const authority = new PostgresTenantContextAuthority(tenantAuthorityPool);
      const resources: PostgresContractResources = {
        ownerPool,
        workerPool,
        adapterPool,
        schedulerPool,
        appPool,
        tenantAuthorityPool,
        workerRepository,
        adapterRepository,
        schedulerRepository,
      };
      return new PostgresContractRepository(appPool, authority, resources);
    },
    destroy: async (repository) => {
      const contract = repository as PostgresContractRepository;
      const { resources } = contract;
      await resources.workerPool.end();
      await resources.adapterPool.end();
      await resources.schedulerPool.end();
      await resources.tenantAuthorityPool.end();
      await resources.appPool.end();
      await resetPostgresContractTables(resources.ownerPool);
      await resources.ownerPool.end();
    },
    seedWorker: async (repository) => seedContractWorker(repository as PostgresContractRepository),
    seedOperationsWorker: async (repository, input) =>
      seedContractOperationsWorker(repository as PostgresContractRepository, input),
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
        assert.equal(
          privileges.rows[0]?.can_insert,
          false,
          `commander_worker must not INSERT ${table}`,
        );
        assert.equal(
          privileges.rows[0]?.can_delete,
          false,
          `commander_worker must not DELETE ${table}`,
        );
      }

      const required = [
        ['commander_events', 'INSERT'],
        ['commander_effects', 'UPDATE'],
        ['commander_steps', 'UPDATE'],
        ['commander_runs', 'UPDATE'],
        ['commander_interactions', 'INSERT'],
        ['commander_interactions', 'UPDATE'],
        ['commander_effect_quota', 'INSERT'],
        ['commander_capability_revocations', 'INSERT'],
        ['commander_capability_replays', 'INSERT'],
      ] as const;
      for (const [table, privilege] of required) {
        const result = await ownerPool.query<{ allowed: boolean }>(
          `SELECT has_table_privilege('commander_worker', $1, $2) AS allowed`,
          [table, privilege],
        );
        assert.equal(
          result.rows[0]?.allowed,
          true,
          `commander_worker requires ${privilege} on ${table}`,
        );
      }
    } finally {
      await ownerPool.end();
    }
  });

  it(
    'takes over stale action requests and fences the superseded attempt',
    { skip: !databaseUrl },
    async () => {
      if (!databaseUrl) return;
      const ownerPool = new Pool({ connectionString: databaseUrl, max: 2 });
      await runKernelMigrations(ownerPool);
      await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
      await ensureRoleLogin(ownerPool, 'commander_tenant_authority', tenantAuthorityPassword);
      const { appPool, tenantAuthorityPool, createRepository } =
        createEnforcedAppContext(databaseUrl);
      const repository = createRepository();
      const suffix = `${Date.now()}-${process.pid}`;
      const tenantId = `action-takeover-${suffix}`;
      const request = {
        tenantId,
        idempotencyKey: `action-key-${suffix}`,
        requestHash: 'c'.repeat(64),
        attemptToken: `attempt-original-${suffix}`,
        now: new Date(),
        staleAfterMs: 30_000,
        allowStaleTakeover: true,
      };
      const takeoverAttemptToken = `attempt-takeover-${suffix}`;

      try {
        await seedTenantAuthorityAllowedTenants(ownerPool, [tenantId]);

        assert.deepEqual(await repository.beginActionRequest(request), { state: 'STARTED' });
        assert.deepEqual(
          await repository.beginActionRequest({
            ...request,
            attemptToken: `attempt-active-retry-${suffix}`,
            now: new Date('2099-01-01T00:00:00.000Z'),
          }),
          { state: 'IN_PROGRESS' },
        );

        await ownerPool.query(
          `UPDATE commander_action_requests
              SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE tenant_id = $1 AND idempotency_key = $2`,
          [tenantId, request.idempotencyKey],
        );

        assert.deepEqual(
          await repository.beginActionRequest({
            ...request,
            attemptToken: takeoverAttemptToken,
            now: new Date(),
          }),
          { state: 'TAKEOVER' },
        );
        assert.deepEqual(
          await repository.beginActionRequest({
            ...request,
            attemptToken: `attempt-competing-takeover-${suffix}`,
            now: new Date(),
          }),
          { state: 'IN_PROGRESS' },
        );

        await assert.rejects(
          repository.completeActionRequest({
            ...request,
            responseStatus: 202,
            responseBody: { stale: true },
          }),
          (error) =>
            error instanceof KernelInvariantError && error.code === 'ACTION_REQUEST_BINDING_FENCED',
        );
        await repository.completeActionRequest({
          ...request,
          attemptToken: takeoverAttemptToken,
          now: new Date(),
          responseStatus: 202,
          responseBody: { recovered: true },
        });
        assert.deepEqual(
          await repository.beginActionRequest({
            ...request,
            attemptToken: `attempt-replay-${suffix}`,
            now: new Date(),
          }),
          { state: 'REPLAY', responseStatus: 202, responseBody: { recovered: true } },
        );
      } finally {
        await ownerPool.query(
          'DELETE FROM commander_action_requests WHERE tenant_id = $1 AND idempotency_key = $2',
          [tenantId, request.idempotencyKey],
        );
        await cleanupTenantTestState(ownerPool, [tenantId]);
        await tenantAuthorityPool.end();
        await appPool.end();
        await ownerPool.end();
      }
    },
  );

  it(
    'runs checksummed migrations, enforces worker generation fencing, and preserves tenant isolation',
    { skip: !databaseUrl || !workerDatabaseUrl },
    async () => {
      if (!databaseUrl || !workerDatabaseUrl) return;
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      await runKernelMigrations(pool);
      await ensureRoleLogin(pool, 'commander_app', appPassword);
      await ensureRoleLogin(pool, 'commander_tenant_authority', tenantAuthorityPassword);
      await ensureRoleLogin(
        pool,
        'commander_scheduler',
        process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler',
      );
      await ensureRoleLogin(pool, 'commander_worker', workerPassword);
      const { appPool, tenantAuthorityPool, createRepository } =
        createEnforcedAppContext(databaseUrl);
      const workerPool = createLoginPool(workerDatabaseUrl);
      const tenantA = `integration-a-${Date.now()}`;
      const tenantB = `integration-b-${Date.now()}`;
      const workerA = `integration-worker-a-${Date.now()}`;
      const workerB = `integration-worker-b-${Date.now()}`;
      // App role for RLS-scoped reads/writes; worker LOGIN for claim RPC (EXECUTE only).
      // Do not use owner+SET ROLE worker: enforceAppRole KEEP_IDENTITY keys off session_user
      // and would downgrade back to commander_app.
      const repoA = createRepository();
      const repoB = createRepository();
      const workerRepoA = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      const workerRepoB = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      try {
        const migrationRows = await pool.query(
          `SELECT id, checksum FROM commander_kernel_migrations ORDER BY id`,
        );
        assert.ok(
          migrationRows.rows.length >= 4,
          'schema, RLS, roles, and claim migrations must be recorded',
        );
        assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.schema')));
        assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.rls')));
        assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.roles')));
        assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.claim')));
        assert.ok(
          migrationRows.rows.every((row: { checksum: string }) =>
            /^[a-f0-9]{64}$/.test(row.checksum),
          ),
        );

        const policyRows = await pool.query<{ tablename: string }>(
          `SELECT DISTINCT tablename
             FROM pg_policies
            WHERE schemaname='public' AND tablename = ANY($1::text[])`,
          [TENANT_TABLES as unknown as string[]],
        );
        assert.equal(
          policyRows.rows.length,
          TENANT_TABLES.length,
          'tenant RLS policies must be installed for every tenant table',
        );

        // Every tenant table must have RLS both ENABLED and FORCED.
        const rlsRows = await pool.query<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[])`,
          [TENANT_TABLES as unknown as string[]],
        );
        assert.equal(rlsRows.rows.length, TENANT_TABLES.length, 'all tenant tables must exist');
        for (const row of rlsRows.rows) {
          assert.equal(row.relrowsecurity, true, `${row.relname} must ENABLE RLS`);
          assert.equal(row.relforcerowsecurity, true, `${row.relname} must FORCE RLS`);
        }

        // App + worker must not bypass RLS; every runtime role must be non-superuser.
        const roleAttrs = await pool.query<{
          rolname: string;
          rolbypassrls: boolean;
          rolsuper: boolean;
        }>(
          `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
         WHERE rolname IN ('commander_app','commander_worker','commander_scheduler')`,
        );
        const byName = new Map(roleAttrs.rows.map((r) => [r.rolname, r]));
        assert.equal(
          byName.get('commander_app')?.rolbypassrls,
          false,
          'commander_app must NOT bypass RLS',
        );
        assert.equal(
          byName.get('commander_worker')?.rolbypassrls,
          false,
          'commander_worker must NOT bypass RLS',
        );
        for (const name of ['commander_app', 'commander_worker', 'commander_scheduler']) {
          assert.equal(byName.get(name)?.rolsuper, false, `${name} must not be a superuser`);
        }

        await seedWorkerAllowedTenants(pool, [tenantA, tenantB]);
        await seedTenantAuthorityAllowedTenants(pool, [tenantA, tenantB]);
        await pool.query(
          `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["agent"]',2,'ACTIVE',1,$2,$3::jsonb),
                ($4,'agent','integration','["agent"]',2,'ACTIVE',1,$5,$6::jsonb)`,
          [
            workerA,
            workerA,
            JSON.stringify([tenantA]),
            workerB,
            workerB,
            JSON.stringify([tenantA]),
          ],
        );
        const secretA = await seedWorkerClaimSecret(pool, workerA, 1);
        const secretB = await seedWorkerClaimSecret(pool, workerB, 1);
        await repoA.createRun(
          {
            id: `run-${tenantA}`,
            tenantId: tenantA,
            intentHash: 'intent-a',
            workGraphHash: 'graph-a',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-a',
            steps: [{ id: `step-${tenantA}`, kind: 'agent', maxAttempts: 2 }],
          },
          'integration',
        );
        await repoA.createRun(
          {
            id: `run-${tenantB}`,
            tenantId: tenantB,
            intentHash: 'intent-b',
            workGraphHash: 'graph-b',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-b',
            steps: [{ id: `step-${tenantB}`, kind: 'agent', maxAttempts: 2 }],
          },
          'integration',
        );

        const [claimA, claimB] = await Promise.all([
          workerRepoA.claimNextStep({
            workerId: workerA,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: secretA,
          }),
          workerRepoB.claimNextStep({
            workerId: workerB,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: secretB,
          }),
        ]);
        assert.equal(
          [claimA, claimB].filter(Boolean).length,
          1,
          'FOR UPDATE SKIP LOCKED must allow one claimant',
        );
        const claimed = claimA ?? claimB;
        assert.equal(claimed?.lease?.workerGeneration, 1);
        assert.equal(
          await repoA.getRun(`run-${tenantB}`, tenantA),
          null,
          'cross-tenant reads must return null',
        );

        const staleLease = { ...claimed!.lease!, workerGeneration: 0 };
        assert.equal(
          await workerRepoA.completeStep({
            stepId: claimed!.id,
            tenantId: claimed!.tenantId,
            lease: staleLease,
            expectedVersion: claimed!.version,
            actor: workerA,
          }),
          null,
        );
        assert.ok(
          await workerRepoA.completeStep({
            stepId: claimed!.id,
            tenantId: claimed!.tenantId,
            lease: claimed!.lease!,
            expectedVersion: claimed!.version,
            actor: workerA,
          }),
        );

        await repoA.createRun(
          {
            id: `run-${tenantA}-generation`,
            tenantId: tenantA,
            intentHash: 'intent-generation',
            workGraphHash: 'graph-generation',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-a',
            steps: [{ id: `step-${tenantA}-generation`, kind: 'agent' }],
          },
          'integration',
        );
        await pool.query('UPDATE commander_workers SET generation=2 WHERE id=$1', [workerA]);
        const secretAGen2 = await seedWorkerClaimSecret(pool, workerA, 2);
        assert.equal(
          await workerRepoA.claimNextStep({
            workerId: workerA,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: secretA,
          }),
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
        assert.ok(
          await workerRepoA.completeStep({
            stepId: currentGenerationClaim!.id,
            tenantId: currentGenerationClaim!.tenantId,
            lease: currentGenerationClaim!.lease!,
            expectedVersion: currentGenerationClaim!.version,
            actor: workerA,
          }),
        );
      } finally {
        await pool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
          [tenantA, tenantB],
        ]);
        await pool.query(
          'DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])',
          [[workerA, workerB]],
        );
        await pool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [
          [workerA, workerB],
        ]);
        await cleanupTenantTestState(pool, [tenantA, tenantB]);
        await workerPool.end();
        await tenantAuthorityPool.end();
        await appPool.end();
        await pool.end();
      }
    },
  );

  it(
    'atomically releases kernel-native approvals with fencing and tenant isolation',
    { skip: !databaseUrl || !workerDatabaseUrl },
    async () => {
      if (!databaseUrl || !workerDatabaseUrl) return;
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      await runKernelMigrations(pool);
      await ensureRoleLogin(pool, 'commander_app', appPassword);
      await ensureRoleLogin(pool, 'commander_tenant_authority', tenantAuthorityPassword);
      await ensureRoleLogin(
        pool,
        'commander_scheduler',
        process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler',
      );
      await ensureRoleLogin(pool, 'commander_worker', workerPassword);
      const { appPool, tenantAuthorityPool, createRepository } =
        createEnforcedAppContext(databaseUrl);
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
      const repoA = createRepository();
      const repoB = createRepository();
      const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      try {
        await seedWorkerAllowedTenants(pool, [tenantA, tenantB]);
        await seedTenantAuthorityAllowedTenants(pool, [tenantA, tenantB]);
        await pool.query(
          `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["tool"]',1,'ACTIVE',1,$2,$3::jsonb)`,
          [workerId, workerId, JSON.stringify([tenantA])],
        );
        const claimSecret = await seedWorkerClaimSecret(pool, workerId, 1);
        await repoA.createRun(
          {
            id: runId,
            tenantId: tenantA,
            intentHash: 'approval-intent',
            workGraphHash: 'approval-graph',
            workGraphVersion: 'v1',
            policySnapshotId: 'approval-policy',
            steps: [
              {
                id: stepId,
                kind: 'tool',
                initialState: 'WAITING_FOR_HUMAN',
                maxAttempts: 2,
                interaction: {
                  id: interactionId,
                  prompt: 'Approve integration action?',
                  expiresAt: '2030-01-01T00:00:00.000Z',
                },
              },
            ],
          },
          'integration',
        );

        await assert.rejects(
          () =>
            repoA.createRun(
              {
                id: rolledBackRunId,
                tenantId: tenantA,
                intentHash: 'rollback-intent',
                workGraphHash: 'rollback-graph',
                workGraphVersion: 'v1',
                policySnapshotId: 'approval-policy',
                steps: [
                  {
                    id: rolledBackStepId,
                    kind: 'tool',
                    initialState: 'WAITING_FOR_HUMAN',
                    interaction: { id: interactionId, prompt: 'Duplicate interaction' },
                  },
                ],
              },
              'integration',
            ),
          (error) =>
            error instanceof KernelInvariantError && error.code === 'DUPLICATE_INTERACTION',
        );
        assert.equal(await repoA.getRun(rolledBackRunId, tenantA), null);
        assert.equal(await repoA.getStep(rolledBackStepId, tenantA), null);

        assert.equal(await repoB.getInteraction(interactionId, tenantB), null);
        assert.equal(await repoB.getStep(stepId, tenantB), null);
        await assert.rejects(
          () =>
            repoB.answerInteraction({
              interactionId,
              runId,
              tenantId: tenantB,
              response: { approved: true },
              actor: 'cross-tenant-reviewer',
            }),
          (error) =>
            error instanceof KernelInvariantError && error.code === 'INTERACTION_NOT_FOUND',
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
        assert.equal(
          await workerRepo.completeStep({
            stepId,
            tenantId: tenantA,
            lease: { ...claimed!.lease!, token: 'stale-token' },
            expectedVersion: claimed!.version,
            actor: workerId,
          }),
          null,
        );
        assert.ok(
          await workerRepo.completeStep({
            stepId,
            tenantId: tenantA,
            lease: claimed!.lease!,
            expectedVersion: claimed!.version,
            actor: workerId,
          }),
        );
      } finally {
        await pool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
          [tenantA, tenantB],
        ]);
        await pool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [
          workerId,
        ]);
        await pool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
        await cleanupTenantTestState(pool, [tenantA, tenantB]);
        await workerPool.end();
        await tenantAuthorityPool.end();
        await appPool.end();
        await pool.end();
      }
    },
  );

  it(
    'worker LOGIN DSN (schedulerMode false) claims via durable authz and cannot widen with tenantIds',
    { skip: !databaseUrl || !workerDatabaseUrl },
    async () => {
      if (!databaseUrl || !workerDatabaseUrl) return;
      const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
      await runKernelMigrations(ownerPool);
      await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
      await ensureRoleLogin(ownerPool, 'commander_tenant_authority', tenantAuthorityPassword);
      await ensureRoleLogin(
        ownerPool,
        'commander_scheduler',
        process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler',
      );
      await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);

      const workerPool = createLoginPool(workerDatabaseUrl);
      const { appPool, tenantAuthorityPool, createRepository } =
        createEnforcedAppContext(databaseUrl);
      const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      const appRepo = createRepository();
      const suffix = `${Date.now()}-${process.pid}`;
      const tenantAllowed = `worker-allowed-${suffix}`;
      const tenantOutside = `worker-outside-${suffix}`;
      const workerId = `worker-dsn-${suffix}`;
      try {
        const identityClient = await workerPool.connect();
        try {
          const identity = await identityClient.query<{
            session_user: string;
            current_user: string;
          }>('SELECT session_user::text AS session_user, current_user::text AS current_user');
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
        await seedTenantAuthorityAllowedTenants(ownerPool, [tenantAllowed, tenantOutside]);
        const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);

        await appRepo.createRun(
          {
            id: `run-${tenantAllowed}`,
            tenantId: tenantAllowed,
            intentHash: 'intent-allowed',
            workGraphHash: 'graph-allowed',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-allowed',
            steps: [{ id: `step-${tenantAllowed}`, kind: 'agent' }],
          },
          'integration',
        );
        await appRepo.createRun(
          {
            id: `run-${tenantOutside}`,
            tenantId: tenantOutside,
            intentHash: 'intent-outside',
            workGraphHash: 'graph-outside',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-outside',
            steps: [{ id: `step-${tenantOutside}`, kind: 'agent' }],
          },
          'integration',
        );

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
          () =>
            appRepo.claimNextStep({
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
        assert.ok(
          claimAllowed,
          'worker LOGIN must claim via claim_next_step without caller tenantIds',
        );
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
          [
            `${workerId}-empty`,
            `${workerId}-stale`,
            `${workerId}-off`,
            JSON.stringify([tenantOutside]),
          ],
        );
        const emptySecret = await seedWorkerClaimSecret(ownerPool, `${workerId}-empty`, 1);
        const staleSecret = await seedWorkerClaimSecret(ownerPool, `${workerId}-stale`, 9);
        const offSecret = await seedWorkerClaimSecret(ownerPool, `${workerId}-off`, 1);
        assert.equal(
          await workerRepo.claimNextStep({
            workerId: `${workerId}-empty`,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: emptySecret,
          }),
          null,
        );
        assert.equal(
          await workerRepo.claimNextStep({
            workerId: `${workerId}-stale`,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: staleSecret,
          }),
          null,
        );
        assert.equal(
          await workerRepo.claimNextStep({
            workerId: `${workerId}-off`,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: offSecret,
          }),
          null,
        );
      } finally {
        await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
          [tenantAllowed, tenantOutside],
        ]);
        await ownerPool.query(
          'DELETE FROM commander_worker_claim_secrets WHERE worker_id LIKE $1',
          [`${workerId}%`],
        );
        await ownerPool.query('DELETE FROM commander_workers WHERE id LIKE $1', [`${workerId}%`]);
        await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [
          tenantAllowed,
        ]);
        await cleanupTenantTestState(ownerPool, [tenantAllowed, tenantOutside]);
        await workerPool.end();
        await tenantAuthorityPool.end();
        await appPool.end();
        await ownerPool.end();
      }
    },
  );

  it(
    'app revoke + worker LOGIN observe isCapabilityRevoked under RLS (schedulerMode false)',
    { skip: !databaseUrl || !workerDatabaseUrl },
    async () => {
      if (!databaseUrl || !workerDatabaseUrl) return;
      const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
      await runKernelMigrations(ownerPool);
      await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
      await ensureRoleLogin(ownerPool, 'commander_tenant_authority', tenantAuthorityPassword);
      await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);
      await ensureRoleLogin(ownerPool, 'commander_adapter_ops', adapterOpsPassword);

      const workerPool = createLoginPool(workerDatabaseUrl);
      const { appPool, tenantAuthorityPool, createRepository } =
        createEnforcedAppContext(databaseUrl);
      const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      const appRepo = createRepository();
      const suffix = `${Date.now()}-${process.pid}`;
      const tenantId = `cap-rev-${suffix}`;
      const jti = `jti-${suffix}`;
      const expiresAt = new Date(Date.now() + 60_000).toISOString();

      try {
        await seedWorkerAllowedTenants(ownerPool, [tenantId]);
        await seedTenantAuthorityAllowedTenants(ownerPool, [tenantId]);
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
        await ownerPool.query(`DELETE FROM commander_capability_revocations WHERE tenant_id=$1`, [
          tenantId,
        ]);
        await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [
          tenantId,
        ]);
        await cleanupTenantTestState(ownerPool, [tenantId]);
        await workerPool.end();
        await tenantAuthorityPool.end();
        await appPool.end();
        await ownerPool.end();
      }
    },
  );

  it(
    'worker LOGIN reads allowlist and updates quota without policy mutation authority',
    { skip: !databaseUrl || !workerDatabaseUrl },
    async () => {
      if (!databaseUrl || !workerDatabaseUrl) return;
      const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
      await runKernelMigrations(ownerPool);
      await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
      await ensureRoleLogin(ownerPool, 'commander_tenant_authority', tenantAuthorityPassword);
      await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);

      const workerPool = createLoginPool(workerDatabaseUrl);
      const { appPool, tenantAuthorityPool, createRepository } =
        createEnforcedAppContext(databaseUrl);
      const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      const appRepo = createRepository();
      const suffix = `${Date.now()}-${process.pid}`;
      const tenantId = `allow-quota-${suffix}`;

      try {
        await seedWorkerAllowedTenants(ownerPool, [tenantId]);
        await seedTenantAuthorityAllowedTenants(ownerPool, [tenantId]);
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
        await ownerPool.query(`DELETE FROM commander_effect_allowlist WHERE tenant_id=$1`, [
          tenantId,
        ]);
        await ownerPool.query(`DELETE FROM commander_effect_quota WHERE tenant_id=$1`, [tenantId]);
        await ownerPool.query('DELETE FROM commander_action_kill_switches WHERE tenant_id=$1', [
          tenantId,
        ]);
        await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [
          tenantId,
        ]);
        await cleanupTenantTestState(ownerPool, [tenantId]);
        await workerPool.end();
        await tenantAuthorityPool.end();
        await appPool.end();
        await ownerPool.end();
      }
    },
  );

  it(
    'worker LOGIN claimReconcileEffects via claim_reconcile_effects; app cannot EXECUTE',
    { skip: !databaseUrl || !workerDatabaseUrl },
    async () => {
      if (!databaseUrl || !workerDatabaseUrl) return;
      const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
      await runKernelMigrations(ownerPool);
      await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
      await ensureRoleLogin(ownerPool, 'commander_tenant_authority', tenantAuthorityPassword);
      await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);
      await ensureRoleLogin(ownerPool, 'commander_adapter_ops', adapterOpsPassword);

      const workerPool = createLoginPool(workerDatabaseUrl);
      const adapterPool = new Pool({
        connectionString: deriveRoleDatabaseUrl(
          databaseUrl,
          'commander_adapter_ops',
          adapterOpsPassword,
        ),
        max: 2,
      });
      const { appPool, tenantAuthorityPool, createRepository } =
        createEnforcedAppContext(databaseUrl);
      const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      const adapterRepo = new PostgresKernelRepository(adapterPool, {
        schedulerMode: false,
        adapterOpsMode: true,
      });
      const appRepo = createRepository();
      const suffix = `${Date.now()}-${process.pid}`;
      const tenantAllowed = `recon-ok-${suffix}`;
      const tenantOutside = `recon-out-${suffix}`;
      const workerId = `recon-worker-${suffix}`;
      const runId = `run-recon-${suffix}`;
      const stepId = `step-recon-${suffix}`;
      const effectId = `effect-recon-${suffix}`;
      const adapterWorkerIds = [`reconcile:recon-${suffix}`, `compensation:comp-${suffix}`];
      let reconcileCredential: { id: string; generation: number; claim_secret: string } | undefined;

      try {
        await seedWorkerAllowedTenants(ownerPool, [tenantAllowed, tenantOutside]);
        await seedTenantAuthorityAllowedTenants(ownerPool, [tenantAllowed, tenantOutside]);
        for (const [role, id] of [
          ['reconcile', adapterWorkerIds[0]],
          ['compensation', adapterWorkerIds[1]],
        ] as const) {
          const registration = await adapterPool.query<{
            registration: { id: string; generation: number; claim_secret: string };
          }>(`SELECT register_adapter_ops_worker($1,$2,$3::jsonb,NULL) AS registration`, [
            role,
            id.slice(id.indexOf(':') + 1),
            JSON.stringify([tenantAllowed]),
          ]);
          const credential = registration.rows[0]!.registration;
          if (role === 'reconcile') reconcileCredential = credential;
          await adapterPool.query(`SELECT heartbeat_adapter_ops_worker($1,$2,$3)`, [
            credential.id,
            credential.generation,
            credential.claim_secret,
          ]);
        }
        assert.ok(reconcileCredential);
        const workerRegistrationClient = await workerPool.connect();
        let workerRegistration: {
          rows: Array<{ registration: { generation: number; claim_secret: string } }>;
        };
        try {
          workerRegistration = await workerRegistrationClient.query(
            `SELECT register_worker(
               $1,'agent','integration','["agent"]'::jsonb,'{}'::jsonb,2,
               'db:commander_worker',$2::jsonb,NULL
             ) AS registration`,
            [workerId, JSON.stringify([tenantAllowed])],
          );
        } finally {
          workerRegistrationClient.release();
        }
        const workerGeneration = Number(workerRegistration.rows[0]!.registration.generation);
        const claimSecret = workerRegistration.rows[0]!.registration.claim_secret;

        await appRepo.createRun(
          {
            id: runId,
            tenantId: tenantAllowed,
            intentHash: 'intent-recon',
            workGraphHash: 'graph-recon',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-recon',
            steps: [{ id: stepId, kind: 'agent' }],
          },
          'integration',
        );

        const claimed = await workerRepo.claimNextStep({
          workerId,
          workerGeneration,
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
          type: 'read.ticket',
          idempotencyKey: `recon-key-${suffix}`,
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-recon',
          actionDigest: 'a'.repeat(64),
          request: { url: 'https://example.com' },
          lease: claimed!.lease!,
          actor: workerId,
        });
        assert.ok(admitted.admitted, JSON.stringify(admitted));
        await appRepo.markEffectCompletionUnknown({
          effectId,
          tenantId: tenantAllowed,
          reason: 'timeout',
          actor: workerId,
        });
        await appRepo.requestReconcile({
          effectId,
          tenantId: tenantAllowed,
          actor: 'integration',
        });

        await assert.rejects(
          () =>
            appRepo.claimReconcileEffects({
              limit: 5,
              now: new Date(),
              workerId,
              workerGeneration,
              claimSecret,
            }),
          /permission denied/i,
          'commander_app must not EXECUTE claim_reconcile_effects',
        );

        assert.deepEqual(
          await adapterRepo.claimReconcileEffects({
            limit: 5,
            now: new Date(),
            workerId: reconcileCredential.id,
            workerGeneration: reconcileCredential.generation,
            claimSecret: 'wrong-secret',
          }),
          [],
          'wrong claimSecret must claim no reconcile effects',
        );

        const claimedEffects = await adapterRepo.claimReconcileEffects({
          limit: 5,
          now: new Date(),
          workerId: reconcileCredential.id,
          workerGeneration: reconcileCredential.generation,
          claimSecret: reconcileCredential.claim_secret,
        });
        assert.equal(claimedEffects.length, 1, 'worker LOGIN must claim reconcile via RPC');
        assert.equal(claimedEffects[0]!.effect.tenantId, tenantAllowed);
        assert.ok(claimedEffects[0]!.claimToken);

        // Outside-tenant effect must not be claimable with durable authz for tenantAllowed only.
        const outsideRun = `run-out-${suffix}`;
        const outsideStep = `step-out-${suffix}`;
        const outsideEffect = `effect-out-${suffix}`;
        await appRepo.createRun(
          {
            id: outsideRun,
            tenantId: tenantOutside,
            intentHash: 'intent-out',
            workGraphHash: 'graph-out',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-out',
            steps: [{ id: outsideStep, kind: 'agent' }],
          },
          'integration',
        );
        const outsideWorkerId = `${workerId}-out`;
        const outsideRegistrationClient = await workerPool.connect();
        let outsideRegistration: {
          rows: Array<{ registration: { generation: number; claim_secret: string } }>;
        };
        try {
          outsideRegistration = await outsideRegistrationClient.query(
            `SELECT register_worker(
               $1,'agent','integration','["agent"]'::jsonb,'{}'::jsonb,2,
               'db:commander_worker',$2::jsonb,NULL
             ) AS registration`,
            [outsideWorkerId, JSON.stringify([tenantOutside])],
          );
        } finally {
          outsideRegistrationClient.release();
        }
        const outsideGeneration = Number(outsideRegistration.rows[0]!.registration.generation);
        const outsideSecret = outsideRegistration.rows[0]!.registration.claim_secret;
        const outsideClaim = await workerRepo.claimNextStep({
          workerId: outsideWorkerId,
          workerGeneration: outsideGeneration,
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
          actor: outsideWorkerId,
        });
        await appRepo.markEffectCompletionUnknown({
          effectId: outsideEffect,
          tenantId: tenantOutside,
          reason: 'timeout',
          actor: outsideWorkerId,
        });
        await appRepo.requestReconcile({
          effectId: outsideEffect,
          tenantId: tenantOutside,
          actor: 'integration',
        });

        const noWiden = await adapterRepo.claimReconcileEffects({
          limit: 5,
          now: new Date(),
          workerId: reconcileCredential.id,
          workerGeneration: reconcileCredential.generation,
          claimSecret: reconcileCredential.claim_secret,
        });
        assert.equal(
          noWiden.filter((e) => e.effect.tenantId === tenantOutside).length,
          0,
          'worker must not claim reconcile outside durable tenant_ids',
        );
      } finally {
        await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
          [tenantAllowed, tenantOutside],
        ]);
        await ownerPool.query(
          'DELETE FROM commander_worker_claim_secrets WHERE worker_id LIKE $1',
          [`${workerId}%`],
        );
        await ownerPool.query(
          'DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])',
          [adapterWorkerIds],
        );
        await ownerPool.query('DELETE FROM commander_workers WHERE id LIKE $1', [`${workerId}%`]);
        await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [
          adapterWorkerIds,
        ]);
        await cleanupTenantTestState(ownerPool, [tenantAllowed, tenantOutside]);
        await workerPool.end();
        await adapterPool.end();
        await tenantAuthorityPool.end();
        await appPool.end();
        await ownerPool.end();
      }
    },
  );
});
