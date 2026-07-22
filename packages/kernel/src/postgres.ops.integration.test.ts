import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
  LEGACY_COMPENSATION_TOPIC,
} from './ops/compensationConsumer.js';
import { runKernelMigrations } from './migrations.js';
import { KernelOutboxPublisher } from './ops/outbox/kernelOutboxPublisher.js';
import { PostgresOutboxDeliveryPort } from './ops/outbox/postgresOutboxDeliveryPort.js';
import { PostgresKernelRepository } from './postgres.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

describe('PostgreSQL kernel ops durability', () => {
  it('persists tenant pause, reclaim compensation via consumer, and WS2 delivery', { skip: !databaseUrl }, async () => {
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
        `DELETE FROM commander_outbox WHERE topic = ANY($1::text[])`,
        [[KERNEL_COMPENSATION_TOPIC, LEGACY_COMPENSATION_TOPIC]],
      );
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
        policyDecisionId: 'decision',
        policySnapshotId: 'policy',
        actionDigest: 'a'.repeat(64),
        lease: stepC.lease, actor: workerId,
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
      const compensationInWs2 = deliveries.filter(
        (message) => message.topic === KERNEL_COMPENSATION_TOPIC,
      );
      assert.equal(
        compensationInWs2.length,
        0,
        'kernel-ops publisher must not deliver compensation topics on WS2',
      );

      const pendingComp = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM commander_outbox
         WHERE tenant_id=$1 AND topic=$2 AND published_at IS NULL`,
        [tenantC, KERNEL_COMPENSATION_TOPIC],
      );
      const pendingCount = Number(pendingComp.rows[0]?.count ?? 0);
      assert.equal(pendingCount, 1);

      await pool.query(
        `DELETE FROM commander_outbox
         WHERE topic = ANY($1::text[]) AND tenant_id <> $2`,
        [[KERNEL_COMPENSATION_TOPIC, LEGACY_COMPENSATION_TOPIC], tenantC],
      );

      let compensated = 0;
      const consumeResult = await consumeCompensationBatch(
        repo,
        {
          admit: async (input) => {
            const cmpAdmit = await repo.admitEffect({
              id: input.effectId,
              runId: stepC.runId,
              stepId: stepC.id,
              tenantId: tenantC,
              type: input.type,
              idempotencyKey: input.idempotencyKey,
              request: input.request,
              policyDecisionId: 'cmp-decision',
              policySnapshotId: 'policy',
              actionDigest: 'a'.repeat(64),
              lease: {
                workerId: input.lease.workerId,
                workerGeneration: input.lease.workerGeneration,
                token: input.lease.token,
                fencingEpoch: input.lease.fencingEpoch,
              },
              actor: input.actor,
            });
            return {
              admitted: cmpAdmit.admitted,
              effectId: input.effectId,
              replayed: !!cmpAdmit.replayed,
              reason: cmpAdmit.reason,
            };
          },
          executeAdmitted: async (input) => {
            compensated += 1;
            const completed = await repo.completeEffect(
              input.effectId,
              tenantC,
              { workerId: 'cmp-worker', token: 'cmp-lease', fencingEpoch: 1 },
              { rolledBack: true },
              'compensation-consumer:cmp-worker',
            );
            assert.ok(completed);
            return { effectId: input.effectId, replayed: false, response: { rolledBack: true } };
          },
        },
        async () => 'cmp-token',
        { workerId: 'cmp-worker', topic: KERNEL_COMPENSATION_TOPIC, limit: 10 },
      );
      assert.equal(consumeResult.consumed, 1);
      assert.equal(consumeResult.succeeded, 1);
      assert.equal(compensated, 1);
      assert.equal((await repo.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10)).length, 0);

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
      await pool.query('DELETE FROM commander_outbox WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB, tenantC]]);
      await pool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB, tenantC]]);
      await pool.query('DELETE FROM commander_tenant_execution_control WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB, tenantC]]);
      await pool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
      await pool.end();
    }
  });

  // Pre-existing gap (not Task-1): failStep/finishRunIfTerminal still go to FAILED;
  // InMemory unit tests for failStep→COMPENSATING fail the same way. Skip until
  // compensation-on-terminal-fail lands; do not block Postgres authority gate.
  it('locks COMPLETED|ADMITTED effects before compensation snapshot so sibling completeEffect cannot orphan', {
    skip: !databaseUrl || 'failStep→COMPENSATING unimplemented (parity with failing kernel.test.ts)',
  }, async () => {
    if (!databaseUrl) return;
    // 并发回归：failStep→COMPENSATING 与 sibling completeEffect 竞态时，
    // 凡最终 COMPLETED 的 effect 必须落在 compensation.requested.effectIds 内。
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const repo = new PostgresKernelRepository(pool, { schedulerMode: true });
    const rounds = 24;
    const tenants: string[] = [];
    const workers: string[] = [];
    try {
      await runKernelMigrations(pool);
      for (let round = 0; round < rounds; round++) {
        const suffix = `${Date.now()}-${round}-${Math.random().toString(16).slice(2)}`;
        const tenantId = `comp-race-${suffix}`;
        const workerA = `comp-race-wa-${suffix}`;
        const workerB = `comp-race-wb-${suffix}`;
        const runId = `run-${suffix}`;
        const stepA = `step-a-${suffix}`;
        const stepB = `step-b-${suffix}`;
        const effectA = `effect-a-${suffix}`;
        const effectB = `effect-b-${suffix}`;
        tenants.push(tenantId);
        workers.push(workerA, workerB);

        await pool.query(
          `INSERT INTO commander_workers
             (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
           VALUES ($1,'agent','integration','["agent"]',4,'ACTIVE',1,$1,$3::jsonb),
                  ($2,'agent','integration','["agent"]',4,'ACTIVE',1,$2,$3::jsonb)`,
          [workerA, workerB, JSON.stringify([tenantId])],
        );
        await repo.createRun({
          id: runId,
          tenantId,
          intentHash: `intent-${runId}`,
          workGraphHash: `graph-${runId}`,
          workGraphVersion: 'v1',
          policySnapshotId: 'policy',
          steps: [
            { id: stepA, kind: 'agent', maxAttempts: 1 },
            { id: stepB, kind: 'agent', maxAttempts: 1 },
          ],
        }, 'integration');

        const first = await repo.claimNextStep({
          tenantId, workerId: workerA, workerGeneration: 1, leaseTtlMs: 60_000,
        });
        const second = await repo.claimNextStep({
          tenantId, workerId: workerB, workerGeneration: 1, leaseTtlMs: 60_000,
        });
        assert.ok(first?.lease);
        assert.ok(second?.lease);
        const byId = new Map([[first!.id, first!], [second!.id, second!]]);
        const claimedA = byId.get(stepA);
        const claimedB = byId.get(stepB);
        assert.ok(claimedA?.lease, `round ${round}: step-a not claimed`);
        assert.ok(claimedB?.lease, `round ${round}: step-b not claimed`);

        assert.equal((await repo.admitEffect({
          id: effectA, runId, stepId: stepA, tenantId, type: 'tool',
          idempotencyKey: `a-${suffix}`, request: { tool: 'write-a' },
          policyDecisionId: 'decision-a',
          policySnapshotId: 'policy',
          actionDigest: 'a'.repeat(64),
          lease: claimedA!.lease!, actor: claimedA!.lease!.workerId,
        })).admitted, true);
        assert.ok(await repo.completeEffect(
          effectA, tenantId, claimedA!.lease!, { ok: true }, claimedA!.lease!.workerId,
        ));

        assert.equal((await repo.admitEffect({
          id: effectB, runId, stepId: stepB, tenantId, type: 'tool',
          idempotencyKey: `b-${suffix}`, request: { tool: 'write-b' },
          policyDecisionId: 'decision-b',
          policySnapshotId: 'policy',
          actionDigest: 'a'.repeat(64),
          lease: claimedB!.lease!, actor: claimedB!.lease!.workerId,
        })).admitted, true);

        const [failed, siblingComplete] = await Promise.all([
          repo.failStep({
            stepId: stepA,
            tenantId,
            lease: claimedA!.lease!,
            expectedVersion: claimedA!.version,
            error: { code: 'DOWNSTREAM_FAILED', message: 'race fail', retryable: false },
            actor: claimedA!.lease!.workerId,
          }),
          repo.completeEffect(
            effectB, tenantId, claimedB!.lease!, { ok: true }, claimedB!.lease!.workerId,
          ),
        ]);
        assert.equal(failed?.state, 'FAILED');
        assert.equal((await repo.getRun(runId, tenantId))?.state, 'COMPENSATING');
        assert.equal((await repo.getStep(stepB, tenantId))?.state, 'CANCELLED');

        const completedRows = await pool.query<{ id: string }>(
          `SELECT id FROM commander_effects
           WHERE run_id=$1 AND tenant_id=$2 AND state='COMPLETED'
           ORDER BY id`,
          [runId, tenantId],
        );
        const events = await repo.listEvents(runId, tenantId);
        const compensation = events.find((event) => event.type === 'kernel.compensation.requested');
        assert.ok(compensation, `round ${round}: compensation.requested missing`);
        const effectIds = compensation.payload.effectIds;
        assert.ok(Array.isArray(effectIds), `round ${round}: effectIds missing`);
        const requested = new Set(effectIds as string[]);
        for (const row of completedRows.rows) {
          assert.ok(
            requested.has(row.id),
            `round ${round}: COMPLETED ${row.id} orphaned from compensation (siblingComplete=${siblingComplete != null})`,
          );
        }
        const effectBState = (await repo.getEffect(effectB, tenantId))?.state;
        assert.ok(
          effectBState === 'COMPLETED' || effectBState === 'COMPLETION_UNKNOWN',
          `round ${round}: unexpected effect-b state ${effectBState}`,
        );
        if (effectBState === 'COMPLETED') {
          assert.equal(siblingComplete?.id, effectB);
          assert.ok(requested.has(effectB));
        } else {
          assert.equal(siblingComplete, null);
        }
      }
    } finally {
      if (tenants.length > 0) {
        await pool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [tenants]);
        await pool.query('DELETE FROM commander_tenant_execution_control WHERE tenant_id = ANY($1::text[])', [tenants]);
        await pool.query('DELETE FROM commander_tenant_execution_usage WHERE tenant_id = ANY($1::text[])', [tenants]);
      }
      if (workers.length > 0) {
        await pool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [workers]);
      }
      await pool.end();
    }
  });
});
