import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { runKernelMigrations } from './migrations.js';
import { KernelOutboxPublisher } from './ops/outbox/kernelOutboxPublisher.js';
import { PostgresOutboxDeliveryPort } from './ops/outbox/postgresOutboxDeliveryPort.js';
import { PostgresKernelRepository } from './postgres.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

describe('PostgreSQL kernel ops durability', () => {
  it('persists tenant pause, reclaim compensation, and WS2 delivery', { skip: !databaseUrl }, async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenantA = `ops-a-${suffix}`;
    const tenantB = `ops-b-${suffix}`;
    const tenantC = `ops-c-${suffix}`;
    const workerId = `ops-worker-${suffix}`;
    const repo = new PostgresKernelRepository(pool, { schedulerMode: true });
    const delivery = new PostgresOutboxDeliveryPort(pool, { baseBackoffMs: 1 });
    try {
      await runKernelMigrations(pool);
      await pool.query(
        `INSERT INTO commander_workers
           (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','integration','["agent"]',4,'ACTIVE',1,$1,$2::jsonb)`,
        [workerId, JSON.stringify([tenantA, tenantB, tenantC])],
      );
      for (const [tenantId, runId, stepId, maxAttempts] of [
        [tenantA, `run-a-${suffix}`, `step-a-${suffix}`, 2],
        [tenantB, `run-b-${suffix}`, `step-b-${suffix}`, 2],
        [tenantC, `run-c-${suffix}`, `step-c-${suffix}`, 1],
      ] as const) {
        await repo.createRun({
          id: runId, tenantId, intentHash: `intent-${runId}`, workGraphHash: `graph-${runId}`,
          workGraphVersion: 'v1', policySnapshotId: 'policy',
          steps: [{ id: stepId, kind: 'agent', maxAttempts }],
        }, 'integration');
      }
      const stepA = await repo.claimNextStep({
        tenantId: tenantA, workerId, workerGeneration: 1, leaseTtlMs: 60_000,
      });
      const stepB = await repo.claimNextStep({
        tenantId: tenantB, workerId, workerGeneration: 1, leaseTtlMs: 60_000,
      });
      assert.ok(stepA?.lease);
      assert.ok(stepB?.lease);
      await repo.pauseTenant(tenantA, 'operator', 'incident');
      assert.equal(await repo.heartbeatStep(stepA.id, tenantA, stepA.lease, 60_000), null);
      assert.ok(await repo.heartbeatStep(stepB.id, tenantB, stepB.lease, 60_000));
      assert.equal(await repo.claimNextStep({
        tenantId: tenantA, workerId, workerGeneration: 1, leaseTtlMs: 60_000,
      }), null);

      const stepC = await repo.claimNextStep({
        tenantId: tenantC, workerId, workerGeneration: 1, leaseTtlMs: 60_000,
      });
      assert.ok(stepC?.lease);
      const admitted = await repo.admitEffect({
        id: `effect-${suffix}`, runId: stepC.runId, stepId: stepC.id, tenantId: tenantC,
        type: 'tool', idempotencyKey: `effect-key-${suffix}`, request: { tool: 'write' },
        policyDecisionId: 'decision', lease: stepC.lease, actor: workerId,
      });
      assert.equal(admitted.admitted, true);
      assert.ok(await repo.completeEffect(
        `effect-${suffix}`, tenantC, stepC.lease, { ok: true }, workerId,
      ));
      await pool.query(
        `UPDATE commander_steps SET lease_expires_at=now()-interval '1 second'
         WHERE id=$1`,
        [stepC.id],
      );
      await repo.reclaimExpiredLeases(new Date(), 10);
      assert.equal((await repo.getRun(stepC.runId, tenantC))?.state, 'COMPENSATING');

      await new KernelOutboxPublisher(repo, delivery).publish(100);
      const deliveries = await delivery.claim('ws2', 100);
      const compensation = deliveries.find(
        (message) => message.topic === 'commander.kernel.compensation.requested',
      );
      assert.ok(compensation);
      assert.equal(compensation.tenantId, tenantC);
      assert.equal(await delivery.acknowledge(compensation.deliveryId, 'stale'), false);
      assert.equal(await delivery.acknowledge(compensation.deliveryId, compensation.claimToken), true);

      const durableEventId = `restart-event-${suffix}`;
      await delivery.publish({
        eventId: durableEventId, schemaVersion: 1, tenantId: tenantC,
        topic: 'kernel.effect.retry', key: durableEventId,
        occurredAt: new Date().toISOString(), payload: { runId: stepC.runId },
      });
      const firstClaim = (await delivery.claim(
        'ws2-before-restart', 100, new Date(Date.now() + 1_000),
      )).find(
        (message) => message.eventId === durableEventId,
      );
      assert.ok(firstClaim);
      const restartedAdapter = new PostgresOutboxDeliveryPort(pool, { baseBackoffMs: 1 });
      const redelivered = (await restartedAdapter.claim(
        'ws2-after-restart', 100, new Date(Date.now() + 61_000),
      )).find((message) => message.eventId === durableEventId);
      assert.ok(redelivered);
      assert.notEqual(redelivered.claimToken, firstClaim.claimToken);
    } finally {
      await pool.query('DELETE FROM commander_outbox_deliveries WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB, tenantC]]);
      await pool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB, tenantC]]);
      await pool.query('DELETE FROM commander_tenant_execution_control WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB, tenantC]]);
      await pool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
      await pool.end();
    }
  });
});
