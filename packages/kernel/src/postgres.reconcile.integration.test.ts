import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { PostgresKernelRepository } from './postgres.js';
import { runKernelMigrations } from './migrations.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

describe('PostgresKernelRepository reconcile claim', () => {
  it('claimReconcileEffects uses SKIP LOCKED so only one replica claims an effect', {
    skip: !databaseUrl,
  }, async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repoA = new PostgresKernelRepository(pool, { schedulerMode: true });
    const repoB = new PostgresKernelRepository(pool, { schedulerMode: true });
    const tenantId = `reconcile-${Date.now()}`;
    const workerId = `worker-${Date.now()}`;
    try {
      await runKernelMigrations(pool);
      await pool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["agent"]',2,'ACTIVE',1,$1,$2::jsonb)`,
        [workerId, JSON.stringify([tenantId])],
      );
      await repoA.createRun(
        {
          id: `run-${tenantId}`,
          tenantId,
          intentHash: 'intent',
          workGraphHash: 'graph',
          workGraphVersion: 'v1',
          policySnapshotId: 'policy',
          steps: [{ id: `step-${tenantId}`, kind: 'agent' }],
        },
        'integration',
      );
      const step = await repoA.claimNextStep({
        workerId,
        workerGeneration: 1,
        tenantIds: [tenantId],
        capabilities: ['agent'],
        leaseTtlMs: 60_000,
      });
      assert.ok(step?.lease);
      const admitted = await repoA.admitEffect({
        id: `eff-${tenantId}`,
        runId: `run-${tenantId}`,
        stepId: step.id,
        tenantId,
        type: 'connector.github.pull-request.create',
        idempotencyKey: `key-${tenantId}`,
        policyDecisionId: 'policy',
        request: { destination: 'github://o/r/pulls' },
        lease: step.lease,
        actor: workerId,
      });
      assert.equal(admitted.admitted, true);
      await repoA.markEffectCompletionUnknown({
        effectId: `eff-${tenantId}`,
        tenantId,
        reason: 'timeout',
        actor: 'test',
      });
      await repoA.requestReconcile({
        effectId: `eff-${tenantId}`,
        tenantId,
        actor: 'api',
        reconcileAfter: new Date().toISOString(),
      });

      const [claimA, claimB] = await Promise.all([
        repoA.claimReconcileEffects({ limit: 1, now: new Date() }),
        repoB.claimReconcileEffects({ limit: 1, now: new Date() }),
      ]);
      const totalClaimed = claimA.length + claimB.length;
      assert.equal(totalClaimed, 1, 'exactly one replica must claim the effect');
      const winner = claimA[0] ?? claimB[0];
      assert.equal(winner?.effect.id, `eff-${tenantId}`);
      await repoA.releaseReconcileClaim(winner!.effect.id, tenantId, winner!.claimToken);
    } finally {
      await pool.end();
    }
  });
});
