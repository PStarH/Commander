/**
 * Postgres interleaved publisher (claimOutbox denylist) vs compensation consumer
 * (claimOutboxByTopic) — same contract as inMemory race, live PG.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { runKernelMigrations } from '../../migrations.js';
import { PostgresKernelRepository } from '../../postgres.js';
import {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
  LEGACY_COMPENSATION_TOPIC,
} from '../compensationConsumer.js';
import { KernelOutboxPublisher } from './kernelOutboxPublisher.js';
import { PostgresOutboxDeliveryPort } from './postgresOutboxDeliveryPort.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

async function seedOutboxRow(
  pool: Pool,
  input: {
    tenantId: string;
    topic: string;
    key: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const messageId = randomUUID();
  const eventId = randomUUID();
  const availableAt = new Date(Date.now() - 60_000).toISOString();
  await pool.query(
    `INSERT INTO commander_events
       (id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, actor, schema_version, payload)
     VALUES ($1,'run',$2,1,'kernel.test.seed',$3,$2,'race','v2','{}'::jsonb)`,
    [eventId, `run-${messageId}`, input.tenantId],
  );
  await pool.query(
    `INSERT INTO commander_outbox
       (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, available_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,0,10,$7::timestamptz)`,
    [
      messageId,
      eventId,
      input.tenantId,
      input.topic,
      input.key,
      JSON.stringify(input.payload),
      availableAt,
    ],
  );
}

describe('compensationPublisherRace (postgres)', () => {
  it('publisher never steals compensation topics across 100 interleaved rounds', { skip: !databaseUrl }, async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenantId = `race-pg-${suffix}`;
    const repo = new PostgresKernelRepository(pool, { schedulerMode: true });
    const delivery = new PostgresOutboxDeliveryPort(pool, { baseBackoffMs: 1 });
    const publisher = new KernelOutboxPublisher(repo, delivery);

    let legacySeeded = 0;
    try {
      await runKernelMigrations(pool);
      for (let i = 0; i < 40; i++) {
        await seedOutboxRow(pool, {
          tenantId,
          topic: KERNEL_COMPENSATION_TOPIC,
          key: `${tenantId}/run-race/cmp-${i}`,
          payload: {
            type: 'kernel.compensation.requested',
            tenantId,
            runId: 'run-race',
            stepId: 'step-race',
            compensationAction: 'compensate.github.pull-request.create',
            compensationPayload: {
              originalEffectId: `effect-${i}`,
              forwardResponse: { prNumber: i },
              destination: 'github://octo/repo/pulls',
            },
            idempotencyKey: `cmp:effect-${i}:1.0.0`,
          },
        });
        if (i % 3 === 0) {
          await seedOutboxRow(pool, {
            tenantId,
            topic: LEGACY_COMPENSATION_TOPIC,
            key: `${tenantId}/run-race/legacy-${i}`,
            payload: { type: 'compensation.requested', tenantId },
          });
          legacySeeded++;
        }
      }
      for (let i = 0; i < 20; i++) {
        await seedOutboxRow(pool, {
          tenantId,
          topic: 'kernel.effect.completed',
          key: `${tenantId}/run-race/noise-${i}`,
          payload: { type: 'kernel.effect.completed', effectId: `noise-${i}` },
        });
      }

      const deliveredCompensationTopics: string[] = [];
      for (let round = 0; round < 100; round++) {
        const [pub] = await Promise.all([
          publisher.publish(5),
          consumeCompensationBatch(
            repo,
            {
              admit: async () => ({ admitted: true, effectId: `eff-${round}`, replayed: false }),
              executeAdmitted: async () => ({
                effectId: `eff-${round}`,
                replayed: false,
                response: { ok: true },
              }),
            },
            async () => 'race-token',
            { workerId: 'race-consumer', limit: 5, topic: KERNEL_COMPENSATION_TOPIC },
          ),
        ]);
        assert.ok(pub.published + pub.duplicates + pub.retried + pub.failed >= 0);
      }

      const claimed = await delivery.claim('ws2-race', 500);
      for (const msg of claimed) {
        if (
          msg.topic === KERNEL_COMPENSATION_TOPIC ||
          msg.topic === LEGACY_COMPENSATION_TOPIC
        ) {
          deliveredCompensationTopics.push(msg.topic);
        }
      }
      assert.deepEqual(
        deliveredCompensationTopics,
        [],
        'kernel-ops publisher must not deliver compensation topics under interleaved load',
      );

      const remainingLegacy = await repo.claimOutboxByTopic(LEGACY_COMPENSATION_TOPIC, 100);
      assert.equal(remainingLegacy.length, legacySeeded);
      assert.equal(
        (await repo.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 100)).length,
        0,
        'all kernel compensation rows should be consumed or claimed-through by consumer',
      );
    } finally {
      await pool.query('DELETE FROM commander_outbox_deliveries WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId]);
      await pool.end();
    }
  });
});
