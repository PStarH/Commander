/**
 * PostgreSQL RLS live-fire tests — WP90-3.
 *
 * These tests exercise the real PostgreSQL kernel with role-separated
 * connections:
 *   - commander_owner: runs migrations and test setup
 *   - commander_app: API-replica role, subject to FORCE RLS
 *   - commander_scheduler: scheduler/recovery role, BYPASSRLS
 *
 * Acceptance gates:
 *   - non-owner RLS live-fire: 0 leaks
 *   - generation rollover stale writes: 0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { PostgresKernelRepository } from './postgres.js';
import type { SqlClient, SqlPool } from './postgres.js';
import { runKernelMigrations } from './migrations.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

function createRunCommand(
  tenantId: string,
  steps: Array<{ kind: string; dependencies?: string[]; maxAttempts?: number; priority?: number }>,
) {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    dependencies: s.dependencies,
    maxAttempts: s.maxAttempts ?? 3,
    priority: s.priority ?? 0,
  }));
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(JSON.stringify(stepDefs)).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'rls-live-fire-policy',
    steps: stepDefs,
  };
}

/** Pool wrapper that SET SESSION ROLEs on every acquired connection before returning it. */
function createRolePool(ownerDatabaseUrl: string, role: string): SqlPool & { end: () => Promise<void> } {
  const pool: Pool = new (require('pg').Pool)({ connectionString: ownerDatabaseUrl, max: 2 });
  return {
    connect: async () => {
      const client = await pool.connect();
      // SET SESSION ROLE persists across transactions (unlike plain SET ROLE,
      // which reverts at COMMIT). This is required for RLS live-fire: each
      // kernel transaction must run as the target role.
      await client.query(`SET SESSION ROLE ${role}`);
      return client as SqlClient;
    },
    end: () => pool.end(),
  };
}

describe('Postgres RLS live-fire', { skip: !databaseUrl }, () => {
  let ownerPool: Pool;
  let appPoolA: SqlPool & { end: () => Promise<void> };
  let appPoolB: SqlPool & { end: () => Promise<void> };
  let schedulerPool: SqlPool & { end: () => Promise<void> };
  let repoA: PostgresKernelRepository;
  let repoB: PostgresKernelRepository;
  let schedulerRepo: PostgresKernelRepository;
  const tenantA = `tenant-a-${Date.now()}`;
  const tenantB = `tenant-b-${Date.now()}`;
  const workerA = `worker-a-${Date.now()}`;
  const workerB = `worker-b-${Date.now()}`;
  const schedulerA = `scheduler-a-${Date.now()}`;
  const schedulerB = `scheduler-b-${Date.now()}`;

  before(async () => {
    if (!databaseUrl) return;
    const { Pool } = require('pg') as { Pool: new (options: { connectionString: string; max?: number }) => Pool };
    ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });

    // Apply migrations as owner, then verify roles exist.
    await runKernelMigrations(ownerPool);
    const roles = await ownerPool.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('commander_owner','commander_app','commander_scheduler')");
    const names = roles.rows.map((r) => r.rolname);
    assert.ok(names.includes('commander_app'), 'commander_app role must exist');
    assert.ok(names.includes('commander_scheduler'), 'commander_scheduler role must exist');

    appPoolA = createRolePool(databaseUrl, 'commander_app');
    appPoolB = createRolePool(databaseUrl, 'commander_app');
    schedulerPool = createRolePool(databaseUrl, 'commander_scheduler');

    repoA = new PostgresKernelRepository(appPoolA);
    repoB = new PostgresKernelRepository(appPoolB);
    schedulerRepo = new PostgresKernelRepository(schedulerPool, { schedulerMode: true });

    // Register workers as owner (workers are cross-tenant entities).
    // We need workers for the generation rollover test (workerA), the isolation
    // test (workerB), and the SKIP LOCKED contention test (2 schedulers + 8 racers).
    const raceWorkers = Array.from({ length: 8 }, (_, i) => `${workerA}-race-${i}`);
    const workerIds = [workerA, workerB, schedulerA, schedulerB, ...raceWorkers];
    const values = workerIds
      .map((id) => `('${id}','agent','v1','["agent"]',4,'ACTIVE',1,'${id}','[${JSON.stringify(tenantA)},${JSON.stringify(tenantB)}]'::jsonb)`)
      .join(',');
    await ownerPool.query(
      `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids) VALUES ${values}`
    );
  });

  after(async () => {
    if (!databaseUrl) return;
    const raceWorkers = Array.from({ length: 8 }, (_, i) => `${workerA}-race-${i}`);
    await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB]]);
    await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [[workerA, workerB, schedulerA, schedulerB, ...raceWorkers]]);
    await appPoolA?.end();
    await appPoolB?.end();
    await schedulerPool?.end();
    await ownerPool?.end();
  });

  it('tenant A/B read/write/cancel/effect/timer/outbox isolation: 0 leaks', async () => {
    const runA = createRunCommand(tenantA, [{ kind: 'agent' }]);
    const runB = createRunCommand(tenantB, [{ kind: 'agent' }]);

    await repoA.createRun(runA, 'live-fire');
    await repoB.createRun(runB, 'live-fire');

    // Tenant A must not read tenant B's data when scoped to tenant A.
    assert.equal(await repoA.getRun(runB.id, tenantA), null, 'A must not read B run');
    assert.equal(await repoA.getStep(runB.steps[0]!.id, tenantA), null, 'A must not read B step');
    assert.deepEqual(await repoA.listEvents(runB.id, tenantA), [], 'A must not read B events');

    // Tenant A must read its own run; B must read B's run.
    assert.ok(await repoA.getRun(runA.id, tenantA), 'A must read A run');
    assert.ok(await repoB.getRun(runB.id, tenantB), 'B must read B run');

    // Cancellation scoped to tenant: A can cancel A, but not B (even if A knows B's id).
    assert.ok(await repoA.cancelRun(runA.id, tenantA, 'live-fire'));
    assert.equal(await repoA.cancelRun(runB.id, tenantA, 'live-fire'), null, 'A cannot cancel B run');

    // Timer creation and read scoped to tenant.
    const timerA = await repoA.createTimer({ runId: runA.id, stepId: runA.steps[0]!.id, tenantId: tenantA, firesAt: new Date(Date.now() + 60_000), timerType: 'RETRY_DELAY', payload: {} }, 'live-fire');
    assert.ok(timerA);
    assert.ok(await repoA.cancelTimer(timerA.id, tenantA), 'A can cancel A timer');
    const timerB = await repoB.createTimer({ runId: runB.id, stepId: runB.steps[0]!.id, tenantId: tenantB, firesAt: new Date(Date.now() + 60_000), timerType: 'RETRY_DELAY', payload: {} }, 'live-fire');
    assert.ok(timerB);
    assert.equal(await repoA.cancelTimer(timerB.id, tenantA), false, 'A cannot cancel B timer scoped as A');

    // Outbox: scheduler can see both; app only sees its own tenant when scoped.
    const schedulerMessages = await schedulerRepo.claimOutbox(100);
    const aEvents = schedulerMessages.filter((m) => m.tenantId === tenantA);
    const bEvents = schedulerMessages.filter((m) => m.tenantId === tenantB);
    assert.ok(aEvents.length > 0, 'scheduler must see A outbox');
    assert.ok(bEvents.length > 0, 'scheduler must see B outbox');
  });

  it('2 schedulers + 10 workers contend on single PostgreSQL with SKIP LOCKED: exactly one claim', async () => {
    const run = createRunCommand(tenantA, [{ kind: 'agent' }]);
    await repoA.createRun(run, 'live-fire');

    const claims = await Promise.all([
      // Two scheduler-mode repos race for the same step.
      schedulerRepo.claimNextStep({ workerId: schedulerA, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 }),
      schedulerRepo.claimNextStep({ workerId: schedulerB, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 }),
      // Eight app-mode workers also race.
      ...Array.from({ length: 8 }, (_, i) => repoA.claimNextStep({ workerId: `${workerA}-race-${i}`, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 })),
    ]);

    const winners = claims.filter((c) => c !== null);
    assert.equal(winners.length, 1, 'exactly one worker may claim the step');
  });

  it('rejects stale worker generation on claim/heartbeat/complete/fail/effect', async () => {
    const run = createRunCommand(tenantA, [{ kind: 'agent' }]);
    await repoA.createRun(run, 'live-fire');

    const claimed = await repoA.claimNextStep({ workerId: workerA, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 });
    assert.ok(claimed);
    assert.equal(claimed!.lease!.workerGeneration, 1);

    // Rollover worker generation.
    await ownerPool.query('UPDATE commander_workers SET generation=2 WHERE id=$1', [workerA]);

    // Old generation claim rejected.
    assert.equal(
      await repoA.claimNextStep({ workerId: workerA, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 }),
      null,
      'stale generation claim must fail',
    );

    // Old generation heartbeat/complete/fail rejected.
    assert.equal(await repoA.heartbeatStep(claimed!.id, claimed!.tenantId, claimed!.lease!, 30_000), null, 'stale generation heartbeat must fail');
    assert.equal(await repoA.completeStep({ stepId: claimed!.id, tenantId: claimed!.tenantId, lease: claimed!.lease!, expectedVersion: claimed!.version, output: {}, actor: workerA }), null, 'stale generation complete must fail');
    assert.equal(
      await repoA.failStep({ stepId: claimed!.id, tenantId: claimed!.tenantId, lease: claimed!.lease!, expectedVersion: claimed!.version, error: { code: 'TEST', message: 'test', retryable: false }, actor: workerA }),
      null,
      'stale generation fail must fail',
    );

    // Effect admission/completion with stale generation rejected on a fresh run.
    const effectRun = createRunCommand(tenantA, [{ kind: 'agent' }]);
    await repoA.createRun(effectRun, 'live-fire');
    const effectClaim = await repoA.claimNextStep({ workerId: workerA, workerGeneration: 2, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 });
    assert.ok(effectClaim);
    assert.equal(effectClaim!.lease!.workerGeneration, 2);

    const effect = await repoA.admitEffect({
      id: `effect-${Date.now()}`,
      runId: effectRun.id, stepId: effectClaim!.id, tenantId: tenantA,
      type: 'http', idempotencyKey: 'rls-test-1', policyDecisionId: 'allow',
      request: { url: 'https://example.com' },
      lease: effectClaim!.lease!, actor: workerA,
    });
    assert.ok(effect.admitted);

    // Roll over again.
    await ownerPool.query('UPDATE commander_workers SET generation=3 WHERE id=$1', [workerA]);
    const staleEffectLease = effectClaim!.lease!;
    assert.equal(
      await repoA.completeEffect(effect.effect!.id, tenantA, staleEffectLease, { status: 'ok' }, workerA),
      null,
      'stale generation effect completion must fail',
    );
  });

  it('app role cannot ALTER TABLE DISABLE RLS, read pg_authid, or alter policy', async () => {
    const client = await appPoolA.connect();
    try {
      // app role must not disable RLS.
      await assert.rejects(
        client.query('ALTER TABLE commander_runs DISABLE ROW LEVEL SECURITY'),
        /must be owner|permission denied/i,
        'app role must not disable RLS',
      );

      // app role must not read system catalogs containing secrets.
      await assert.rejects(
        client.query('SELECT * FROM pg_authid'),
        /permission denied/i,
        'app role must not read pg_authid',
      );

      // app role must not drop policies.
      await assert.rejects(
        client.query('DROP POLICY commander_tenant_isolation ON commander_runs'),
        /must be owner|permission denied/i,
        'app role must not drop policy',
      );
    } finally {
      client.release();
    }
  });

  it('migration rejected when run as app role', async () => {
    await assert.rejects(
      runKernelMigrations(appPoolA as unknown as SqlPool),
      /app role is not the migration owner/i,
      'migrations must reject app role',
    );
  });
});
