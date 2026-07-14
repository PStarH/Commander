import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { PostgresKernelRepository } from './postgres.js';
import { runKernelMigrations } from './migrations.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

describe('PostgresKernelRepository integration', () => {
  it('runs checksummed migrations, enforces worker generation fencing, and preserves tenant isolation', { skip: !databaseUrl }, async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const tenantA = `integration-a-${Date.now()}`;
    const tenantB = `integration-b-${Date.now()}`;
    const workerA = `integration-worker-a-${Date.now()}`;
    const workerB = `integration-worker-b-${Date.now()}`;
    const repoA = new PostgresKernelRepository(pool);
    const repoB = new PostgresKernelRepository(pool);
    try {
      await runKernelMigrations(pool);

      const migrationRows = await pool.query(`SELECT id, checksum FROM commander_kernel_migrations ORDER BY id`);
      assert.ok(migrationRows.rows.length >= 3, 'schema, RLS and roles migrations must be recorded');
      assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.schema')));
      assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.rls')));
      assert.ok(migrationRows.rows.some((row: { id: string }) => row.id.endsWith('.roles')));
      assert.ok(migrationRows.rows.every((row: { checksum: string }) => /^[a-f0-9]{64}$/.test(row.checksum)));

      const policyRows = await pool.query(`SELECT tablename FROM pg_policies WHERE policyname='commander_tenant_isolation'`);
      assert.ok(policyRows.rows.length >= 8, 'tenant RLS policies must be installed');

      await pool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["agent"]',2,'ACTIVE',1,$2,$3::jsonb),
                ($4,'agent','integration','["agent"]',2,'ACTIVE',1,$5,$6::jsonb)`,
        [workerA, workerA, JSON.stringify([tenantA]), workerB, workerB, JSON.stringify([tenantA])],
      );
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
        repoA.claimNextStep({ workerId: workerA, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 }),
        repoB.claimNextStep({ workerId: workerB, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 }),
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
      assert.equal(await repoA.claimNextStep({ workerId: workerA, workerGeneration: 1, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 }), null);
      const currentGenerationClaim = await repoA.claimNextStep({ workerId: workerA, workerGeneration: 2, tenantIds: [tenantA], capabilities: ['agent'], leaseTtlMs: 30_000 });
      assert.equal(currentGenerationClaim?.lease?.workerGeneration, 2);
      assert.ok(await repoA.completeStep({ stepId: currentGenerationClaim!.id, tenantId: currentGenerationClaim!.tenantId, lease: currentGenerationClaim!.lease!, expectedVersion: currentGenerationClaim!.version, actor: workerA }));
    } finally {
      await pool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB]]);
      await pool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [[workerA, workerB]]);
      await pool.end();
    }
  });
});
