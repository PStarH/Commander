import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import {
  PostgresKernelRepository,
  runKernelMigrations,
  seedWorkerAllowedTenants,
  type KernelRepository,
  type PostgresKernelRepositoryOptions,
  type SqlPool,
  type SqlQueryResult,
} from '../../../kernel/src/index.js';
import { runTask1ClosureMigrations } from '../../../kernel/src/migrations.js';
import { PostgresTenantContextAuthority } from '../../../kernel/src/postgres.js';
import { ReconciliationDaemon, type ReconciliationDaemonOptions } from '../reconciliationDaemon.js';

const ownerUrl = process.env.COMMANDER_TASK1_PG_URL?.trim();
const CHILD_FLAG = '--dual-process-claim-child';
const require = createRequire(import.meta.url);

interface LiveTestPool extends SqlPool {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>>;
  end(): Promise<void>;
}

type LiveTestPoolConstructor = new (options: {
  connectionString: string;
  max: number;
}) => LiveTestPool;

const { Pool } = require('pg') as { Pool: LiveTestPoolConstructor };

interface TestRepositoryHandle {
  repository: KernelRepository;
  postgresPool: LiveTestPool;
  close(): Promise<void>;
}

function adaptReconciliationRepository(
  repository: KernelRepository,
): ReconciliationDaemonOptions['repository'] {
  return {
    claimReconcileEffects: (input) => repository.claimReconcileEffects(input),
    completeReconcileEffect: (input) => repository.completeReconcileEffect(input),
    confirmEffectNotApplied: (input) => repository.confirmEffectNotApplied(input),
    rescheduleReconcileEffect: (input) => repository.rescheduleReconcileEffect(input),
    escalateReconcileEffect: (input) =>
      repository.escalateReconcileEffect({
        ...input,
        reason:
          input.reason === 'COMPENSATION_QUERY_UNSUPPORTED'
            ? 'RECONCILE_QUERY_UNSUPPORTED'
            : input.reason,
      }),
  };
}

type Registration = { id: string; generation: number; claimSecret: string };

type ChildMessage =
  | { type: 'claimed'; registration: Registration; effectId: string; claimToken: string }
  | { type: 'survivor-ready'; registration: Registration; firstClaimed: number }
  | { type: 'survivor-done'; secondClaimed: number; completed: number }
  | { type: 'child-error'; message: string };

function databaseIdentifier(databaseName: string): string {
  if (!/^commander_dual_process_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('unsafe dual-process test database identifier');
  }
  return `"${databaseName}"`;
}

function databaseUrl(baseUrl: string, databaseName: string, role?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

function repositoryHandle(
  databaseUrl: string,
  options: PostgresKernelRepositoryOptions = {},
): TestRepositoryHandle {
  const postgresPool = new Pool({ connectionString: databaseUrl, max: 8 });
  return {
    repository: new PostgresKernelRepository(postgresPool, options),
    postgresPool,
    close: () => postgresPool.end(),
  };
}

function adapterHandle(databaseUrl: string): TestRepositoryHandle {
  return repositoryHandle(databaseUrl, { adapterOpsMode: true });
}

async function registerReconciliationWorker(
  handle: TestRepositoryHandle,
  instanceId: string,
  tenantId: string,
  previousClaimSecret?: string,
): Promise<Registration> {
  const result = await handle.postgresPool!.query<{
    registration: { id: string; generation: number | string; claim_secret: string };
  }>(`SELECT register_adapter_ops_worker('reconcile',$1,$2::jsonb,$3::text) AS registration`, [
    instanceId,
    JSON.stringify([tenantId]),
    previousClaimSecret ?? null,
  ]);
  const registration = result.rows[0]!.registration;
  return {
    id: registration.id,
    generation: Number(registration.generation),
    claimSecret: registration.claim_secret,
  };
}

async function runClaimantChild(config: {
  databaseUrl: string;
  instanceId: string;
  tenantId: string;
}): Promise<void> {
  const handle = await adapterHandle(config.databaseUrl);
  try {
    const registration = await registerReconciliationWorker(
      handle,
      config.instanceId,
      config.tenantId,
    );
    const claims = await handle.repository.claimReconcileEffects({
      workerId: registration.id,
      workerGeneration: registration.generation,
      claimSecret: registration.claimSecret,
      limit: 1,
      claimTtlMs: 1_200,
    });
    assert.equal(claims.length, 1);
    process.send?.({
      type: 'claimed',
      registration,
      effectId: claims[0]!.effect.id,
      claimToken: claims[0]!.claimToken,
    } satisfies ChildMessage);
    await new Promise<void>(() => undefined);
  } finally {
    await handle.close();
  }
}

async function runSurvivorChild(config: {
  databaseUrl: string;
  instanceId: string;
  tenantId: string;
  queryUrl: string;
}): Promise<void> {
  const handle = await adapterHandle(config.databaseUrl);
  try {
    const registration = await registerReconciliationWorker(
      handle,
      config.instanceId,
      config.tenantId,
    );
    const daemon = new ReconciliationDaemon({
      repository: adaptReconciliationRepository(handle.repository),
      registry: {
        resolve: () => ({}),
        outcomeQuerierFor: () => ({ queryOutcome: async () => ({ status: 'APPLIED' }) }) as never,
      },
      brokerFactory: () => ({
        reconcileUnknown: async () => {
          const response = await fetch(config.queryUrl, { method: 'GET' });
          assert.equal(response.status, 200);
          return { status: 'APPLIED', response: { observed: true } };
        },
      }),
      pollIntervalMs: 60_000,
      batchSize: 1,
      workerId: registration.id,
      workerGeneration: registration.generation,
      claimSecret: registration.claimSecret,
    });
    const first = await daemon.tick();
    process.send?.({
      type: 'survivor-ready',
      registration,
      firstClaimed: first.claimed,
    } satisfies ChildMessage);
    await new Promise<void>((resolve) => {
      process.once('message', (message) => {
        if (message === 'resume') resolve();
      });
    });
    const second = await daemon.tick();
    process.send?.({
      type: 'survivor-done',
      secondClaimed: second.claimed,
      completed: second.completed,
    } satisfies ChildMessage);
  } finally {
    await handle.close();
  }
}

async function runChild(): Promise<void> {
  const encoded = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
  if (!encoded) throw new Error('child configuration is required');
  const config = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as
    | ({ role: 'claimant' } & Parameters<typeof runClaimantChild>[0])
    | ({ role: 'survivor' } & Parameters<typeof runSurvivorChild>[0]);
  if (config.role === 'claimant') await runClaimantChild(config);
  else await runSurvivorChild(config);
}

function spawnChild(config: object): ChildProcess {
  return fork(
    fileURLToPath(import.meta.url),
    [CHILD_FLAG, Buffer.from(JSON.stringify(config)).toString('base64url')],
    {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
}

function nextMessage<T extends ChildMessage['type']>(
  child: ChildProcess,
  type: T,
  timeoutMs = 15_000,
): Promise<Extract<ChildMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${type}: ${stderr}`));
    }, timeoutMs);
    const onMessage = (message: ChildMessage) => {
      if (message.type === 'child-error') {
        cleanup();
        reject(new Error(message.message));
      } else if (message.type === type) {
        cleanup();
        resolve(message as Extract<ChildMessage, { type: T }>);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`child exited before ${type}: code=${code} signal=${signal} ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

if (process.argv.includes(CHILD_FLAG)) {
  void runChild().then(
    () => {
      process.exitCode = 0;
    },
    (error) => {
      process.send?.({
        type: 'child-error',
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      } satisfies ChildMessage);
      process.exitCode = 1;
    },
  );
} else {
  describe('adapter-ops real PostgreSQL dual-process reconciliation', { skip: !ownerUrl }, () => {
    const suffix = `${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const databaseName = `commander_dual_process_${suffix.replaceAll('-', '_')}`;
    const tenantId = `dual-process-${suffix}`;
    const forwardWorkerId = `dual-forward-${suffix}`;
    const instanceA = `dual-a-${suffix}`.toLowerCase();
    const instanceB = `dual-b-${suffix}`.toLowerCase();
    const ownerDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_owner');
    const appDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_app');
    const authorityDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_tenant_authority');
    const adapterDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_adapter_ops');
    const workerDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_worker');
    let adminPool: LiveTestPool;
    let authorityPool: LiveTestPool;
    let ownerHandle: TestRepositoryHandle;
    let appHandle: TestRepositoryHandle;
    let workerHandle: TestRepositoryHandle;
    let adapterParentHandle: TestRepositoryHandle;
    let effectId: string;
    let claimant: ChildProcess | undefined;
    let survivor: ChildProcess | undefined;

    before(async () => {
      adminPool = new Pool({ connectionString: ownerUrl!, max: 2 });
      await adminPool.query(
        `ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT
           NOREPLICATION BYPASSRLS PASSWORD 'commander_owner'`,
      );
      for (const role of [
        'commander_app',
        'commander_tenant_authority',
        'commander_worker',
        'commander_adapter_ops',
      ]) {
        await adminPool.query(
          `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
             NOREPLICATION NOBYPASSRLS PASSWORD '${role}'`,
        );
      }
      await adminPool.query(
        `CREATE DATABASE ${databaseIdentifier(databaseName)} OWNER commander_owner`,
      );
      ownerHandle = repositoryHandle(ownerDatabaseUrl, { schedulerMode: true });
      await runKernelMigrations(ownerHandle.postgresPool!);
      await runTask1ClosureMigrations(ownerHandle.postgresPool, 'expand');
      await runTask1ClosureMigrations(ownerHandle.postgresPool, 'enforce');
      await runKernelMigrations(ownerHandle.postgresPool);
      await seedWorkerAllowedTenants(ownerHandle.postgresPool!, [tenantId]);
      await ownerHandle.postgresPool.query(
        'INSERT INTO public.commander_tenant_authority_allowed_tenants (tenant_id) VALUES ($1)',
        [tenantId],
      );
      authorityPool = new Pool({ connectionString: authorityDatabaseUrl, max: 2 });
      appHandle = repositoryHandle(appDatabaseUrl, {
        tenantContextPhase: 'enforce',
        tenantContextAuthority: new PostgresTenantContextAuthority(authorityPool),
      });
      workerHandle = repositoryHandle(workerDatabaseUrl);
      adapterParentHandle = adapterHandle(adapterDatabaseUrl);

      const worker = await workerHandle.postgresPool!.query<{
        registration: { generation: number | string; claim_secret: string };
      }>(
        `SELECT register_worker($1,'tool','dual-process','["tool","effect.execute"]','{}',1,$1,$2::jsonb,NULL) AS registration`,
        [forwardWorkerId, JSON.stringify([tenantId])],
      );
      const workerGeneration = Number(worker.rows[0]!.registration.generation);
      const workerClaimSecret = worker.rows[0]!.registration.claim_secret;
      const runId = `dual-run-${suffix}`;
      const stepId = `dual-step-${suffix}`;
      effectId = `dual-effect-${suffix}`;
      await ownerHandle.repository.createRun(
        {
          id: runId,
          tenantId,
          intentHash: `dual-intent-${suffix}`,
          workGraphHash: `dual-graph-${suffix}`,
          workGraphVersion: 'v1',
          policySnapshotId: 'dual-policy-v1',
          steps: [{ id: stepId, kind: 'tool', maxAttempts: 1 }],
        },
        'dual-process-test',
      );
      const step = await workerHandle.repository.claimNextStep({
        workerId: forwardWorkerId,
        workerGeneration,
        claimSecret: workerClaimSecret,
        capabilities: ['tool'],
        leaseTtlMs: 60_000,
      });
      assert.ok(step?.lease);
      const admitted = await workerHandle.repository.admitEffect({
        id: effectId,
        runId,
        stepId,
        tenantId,
        type: 'read.cache',
        idempotencyKey: `dual-idempotency-${suffix}`,
        policyDecisionId: 'dual-policy-decision',
        policySnapshotId: 'dual-policy-v1',
        actionDigest: 'd'.repeat(64),
        request: { destination: 'cache://dual-process', key: suffix },
        lease: step.lease,
        actor: forwardWorkerId,
      });
      assert.equal(admitted.admitted, true);
      const parked = await workerHandle.repository.parkEffectCompletionUnknown({
        tenantId,
        effectId,
        workerId: forwardWorkerId,
        workerGeneration,
        claimSecret: workerClaimSecret,
        leaseToken: step.lease.token,
        fencingEpoch: step.lease.fencingEpoch,
        error: { code: 'REMOTE_RESPONSE_LOST', message: 'Remote response lost after commit' },
      });
      assert.equal(parked.parked, true);
      const requested = await appHandle.repository.requestReconcile({
        tenantId,
        effectId,
        actor: 'dual-process-test',
      });
      assert.equal(requested.scheduled, true);
    });

    after(async () => {
      claimant?.kill('SIGKILL');
      survivor?.kill('SIGKILL');
      await Promise.allSettled([
        adapterParentHandle?.close(),
        workerHandle?.close(),
        appHandle?.close(),
        authorityPool?.end(),
        ownerHandle?.close(),
      ]);
      if (adminPool) {
        await adminPool
          .query(`DROP DATABASE IF EXISTS ${databaseIdentifier(databaseName)}`)
          .catch(() => undefined);
        await adminPool
          .query(
            `ALTER ROLE commander_owner NOLOGIN NOCREATEROLE;
             ALTER ROLE commander_app NOLOGIN;
             ALTER ROLE commander_tenant_authority NOLOGIN;
             ALTER ROLE commander_worker NOLOGIN;
             ALTER ROLE commander_adapter_ops NOLOGIN`,
          )
          .catch(() => undefined);
        await adminPool.end();
      }
    });

    it('fences a killed owner and lets a distinct survivor query once after claim expiry', async () => {
      let forwardWrites = 1;
      let outcomeQueries = 0;
      const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/outcome') {
          outcomeQueries += 1;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"status":"APPLIED"}');
          return;
        }
        forwardWrites += 1;
        response.writeHead(405).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address === 'object');

      try {
        claimant = spawnChild({
          role: 'claimant',
          databaseUrl: adapterDatabaseUrl,
          instanceId: instanceA,
          tenantId,
        });
        const claim = await nextMessage(claimant, 'claimed');
        assert.equal(claim.effectId, effectId);
        assert.equal(claim.registration.id, `reconcile:${instanceA}`);
        const claimantExit = waitForExit(claimant);
        claimant.kill('SIGKILL');
        await claimantExit;

        const replacementA = await registerReconciliationWorker(
          adapterParentHandle,
          instanceA,
          tenantId,
          claim.registration.claimSecret,
        );
        assert.equal(replacementA.generation, claim.registration.generation + 1);
        const staleCompletion = await adapterParentHandle.repository.completeReconcileEffect({
          tenantId,
          effectId,
          workerId: claim.registration.id,
          workerGeneration: claim.registration.generation,
          claimSecret: claim.registration.claimSecret,
          claimToken: claim.claimToken,
          response: { stale: true },
        });
        assert.deepEqual(staleCompletion, { applied: false, reason: 'WORKER_FENCED' });

        survivor = spawnChild({
          role: 'survivor',
          databaseUrl: adapterDatabaseUrl,
          instanceId: instanceB,
          tenantId,
          queryUrl: `http://127.0.0.1:${address.port}/outcome`,
        });
        const ready = await nextMessage(survivor, 'survivor-ready');
        assert.equal(ready.registration.id, `reconcile:${instanceB}`);
        assert.equal(ready.registration.generation, 1);
        assert.equal(ready.firstClaimed, 0, 'unexpired claim must remain exclusive');

        await sleep(1_350);
        const survivorExit = waitForExit(survivor);
        const donePromise = nextMessage(survivor, 'survivor-done');
        survivor.send('resume');
        const done = await donePromise;
        assert.equal(done.secondClaimed, 1);
        assert.equal(done.completed, 1);
        await survivorExit;

        const effect = await ownerHandle.repository.getEffect(effectId, tenantId);
        assert.equal(effect?.state, 'COMPLETED');
        assert.equal(outcomeQueries, 1);
        assert.equal(forwardWrites, 1, 'reconciliation must never retry the consequential write');
        const workers = await ownerHandle.postgresPool!.query<{ id: string; generation: string }>(
          `SELECT id, generation::text FROM commander_workers
            WHERE id = ANY($1::text[]) ORDER BY id`,
          [[`reconcile:${instanceA}`, `reconcile:${instanceB}`]],
        );
        assert.deepEqual(workers.rows, [
          { id: `reconcile:${instanceA}`, generation: String(replacementA.generation) },
          { id: `reconcile:${instanceB}`, generation: '1' },
        ]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });
}
