/**
 * Postgres interleaved publisher (claimOutbox denylist) vs compensation consumer
 * (claimOutboxByTopic) — same contract as inMemory race, live PG.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { runKernelMigrations } from '../../migrations.js';
import { PostgresKernelRepository, PostgresTenantContextAuthority } from '../../postgres.js';
import { seedWorkerAllowedTenants } from '../../seedWorkerClaimSecret.js';
import { canonicalCompensationHash } from '../compensationAuthority.js';
import {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
  LEGACY_COMPENSATION_TOPIC,
} from '../compensationConsumer.js';
import { KernelOutboxPublisher } from './kernelOutboxPublisher.js';
import { PostgresOutboxDeliveryPort } from './postgresOutboxDeliveryPort.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

function deriveRoleDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

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
  it(
    'publisher never steals compensation topics across 100 interleaved rounds',
    { skip: !databaseUrl },
    async () => {
      if (!databaseUrl) return;
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const tenantId = `race-pg-${suffix}`;
      const repo = new PostgresKernelRepository(pool, { schedulerMode: true });
      const appPool = new Pool({
        connectionString:
          process.env.COMMANDER_APP_DATABASE_URL ??
          deriveRoleDatabaseUrl(
            databaseUrl,
            'commander_app',
            process.env.COMMANDER_APP_PASSWORD ?? 'commander_app',
          ),
        max: 2,
      });
      const tenantAuthorityPool = new Pool({
        connectionString:
          process.env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL ??
          deriveRoleDatabaseUrl(
            databaseUrl,
            'commander_tenant_authority',
            process.env.COMMANDER_TENANT_AUTHORITY_PASSWORD ?? 'commander_tenant_authority',
          ),
        max: 2,
      });
      const adapterPool = new Pool({
        connectionString:
          process.env.COMMANDER_ADAPTER_OPS_DATABASE_URL ??
          deriveRoleDatabaseUrl(
            databaseUrl,
            'commander_adapter_ops',
            process.env.COMMANDER_ADAPTER_OPS_PASSWORD ?? 'commander_adapter_ops',
          ),
        max: 2,
      });
      const appRepository = new PostgresKernelRepository(appPool, {
        tenantContextAuthority: new PostgresTenantContextAuthority(tenantAuthorityPool),
        tenantContextPhase: 'enforce',
      });
      const adapterRepository = new PostgresKernelRepository(adapterPool, { adapterOpsMode: true });
      const delivery = new PostgresOutboxDeliveryPort(pool, { baseBackoffMs: 1 });
      const publisher = new KernelOutboxPublisher(repo, delivery);
      const adapterInstance = `race-${suffix}`;
      const adapterId = `compensation:${adapterInstance}`;

      let legacySeeded = 0;
      try {
        await runKernelMigrations(pool);
        await seedWorkerAllowedTenants(pool, [tenantId]);
        await pool.query(
          `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO UPDATE SET enabled=true`,
          [tenantId],
        );
        const registration = await adapterPool.query<{
          registration: { generation: number; claim_secret: string };
        }>(`SELECT register_adapter_ops_worker('compensation',$1,$2::jsonb,NULL) AS registration`, [
          adapterInstance,
          JSON.stringify([tenantId]),
        ]);
        const adapterGeneration = Number(registration.rows[0]?.registration.generation);
        const adapterSecret = registration.rows[0]?.registration.claim_secret;
        assert.ok(Number.isSafeInteger(adapterGeneration) && adapterGeneration > 0);
        assert.ok(adapterSecret);

        const runId = `run-race-${suffix}`;
        const effects = Array.from({ length: 40 }, (_, index) => ({
          id: `effect-race-${suffix}-${index}`,
          stepId: `step-race-${suffix}-${index}`,
          response: { prNumber: index },
        }));
        await repo.createRun(
          {
            id: runId,
            tenantId,
            intentHash: `intent-${suffix}`,
            workGraphHash: `graph-${suffix}`,
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-race-v1',
            steps: effects.map((effect) => ({ id: effect.stepId, kind: 'agent' })),
          },
          'integration',
        );
        await pool.query(
          `UPDATE commander_steps
         SET state='SUCCEEDED', output='{}'::jsonb
         WHERE run_id=$1 AND tenant_id=$2`,
          [runId, tenantId],
        );
        for (const effect of effects) {
          await pool.query(
            `INSERT INTO commander_effects
             (id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,policy_decision_id,
              policy_snapshot_id,lease_worker_id,lease_worker_generation,lease_fencing_epoch,
              action_digest,state,request,response,completed_at)
           VALUES ($1,$2,$3,$4,'read.github.pull-request',$5,'seed','policy-forward',
                   'policy-race-v1','seed-worker',1,0,$6,'COMPLETED','{}'::jsonb,$7::jsonb,now())`,
            [
              effect.id,
              runId,
              effect.stepId,
              tenantId,
              `forward-${effect.id}`,
              'a'.repeat(64),
              JSON.stringify(effect.response),
            ],
          );
        }
        await pool.query(
          `UPDATE commander_runs SET state='SUCCEEDED', terminal_at=now() WHERE id=$1 AND tenant_id=$2`,
          [runId, tenantId],
        );
        for (let i = 0; i < 40; i++) {
          const effect = effects[i]!;
          const compensationPatch = { action: 'close', reason: 'race-test' };
          const adapterVersion = 'github-race/v1';
          const authorizationId = `authorization-race-${suffix}-${i}`;
          await appRepository.createCompensationAuthorization({
            id: authorizationId,
            tenantId,
            originalRunId: runId,
            originalEffectId: effect.id,
            compensationEffectType: 'compensate.github.pull-request.create',
            adapterVersion,
            compensationPatch,
            forwardReceiptHash: canonicalCompensationHash(effect.response),
            policyDecisionId: 'policy-compensation',
            policySnapshotId: 'policy-race-v1',
            decision: 'allow',
            actionDigest: canonicalCompensationHash({
              type: 'compensate.github.pull-request.create',
              originalEffectId: effect.id,
              adapterVersion,
              forwardResponse: effect.response,
              compensationPatch,
            }),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          });
          const requested = await appRepository.requestCompensation({
            tenantId,
            authorizationId,
            actor: 'integration',
          });
          assert.equal(requested.accepted, true);
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
        let brokerAdmissions = 0;
        let brokerExecutions = 0;
        let consumerConsumed = 0;
        let consumerEscalated = 0;
        for (let round = 0; round < 100; round++) {
          const [pub, consumed] = await Promise.all([
            publisher.publish(5),
            consumeCompensationBatch(
              adapterRepository,
              {
                admit: async () => {
                  brokerAdmissions += 1;
                  return { admitted: true, effectId: `eff-${round}`, replayed: false };
                },
                executeAdmitted: async () => {
                  brokerExecutions += 1;
                  return { effectId: `eff-${round}`, replayed: false, response: { ok: true } };
                },
              },
              async () => 'race-token',
              {
                workerId: adapterId,
                workerGeneration: adapterGeneration,
                claimSecret: adapterSecret,
                registry: { resolve: () => null },
                limit: 5,
                topic: KERNEL_COMPENSATION_TOPIC,
              },
            ),
          ]);
          consumerConsumed += consumed.consumed;
          consumerEscalated += consumed.escalated;
          assert.ok(pub.published + pub.duplicates + pub.retried + pub.failed >= 0);
        }

        const claimed = await delivery.claim('ws2-race', 500);
        for (const msg of claimed) {
          if (msg.topic === KERNEL_COMPENSATION_TOPIC || msg.topic === LEGACY_COMPENSATION_TOPIC) {
            deliveredCompensationTopics.push(msg.topic);
          }
        }
        assert.deepEqual(
          deliveredCompensationTopics,
          [],
          'kernel-ops publisher must not deliver compensation topics under interleaved load',
        );
        assert.equal(brokerAdmissions, 0, 'pre-Task-3 payloads must fail before broker admission');
        assert.equal(
          brokerExecutions,
          0,
          'publisher race must not masquerade as compensation execution',
        );
        assert.equal(
          consumerConsumed,
          40,
          'adapter-ops consumer must claim every governed request',
        );
        assert.equal(consumerEscalated, 40, 'unregistered adapters must be escalated fail-closed');

        const outstanding = await pool.query<{ legacy: string; governed: string }>(
          `SELECT
             count(*) FILTER (WHERE topic=$2 AND published_at IS NULL)::text AS legacy,
             count(*) FILTER (WHERE topic=$3 AND published_at IS NULL)::text AS governed
           FROM commander_outbox
           WHERE tenant_id=$1`,
          [tenantId, LEGACY_COMPENSATION_TOPIC, KERNEL_COMPENSATION_TOPIC],
        );
        assert.equal(Number(outstanding.rows[0]?.legacy ?? 0), legacySeeded);
        assert.equal(
          Number(outstanding.rows[0]?.governed ?? 0),
          0,
          'all governed compensation rows should be finalized by the adapter-ops consumer',
        );
      } finally {
        await pool.query('DELETE FROM commander_outbox_deliveries WHERE tenant_id=$1', [tenantId]);
        await pool.query(
          `DELETE FROM commander_compensation_finalization_receipts
         WHERE request_id IN (SELECT id FROM commander_compensation_requests WHERE tenant_id=$1)`,
          [tenantId],
        );
        await pool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId]);
        await pool.query('DELETE FROM commander_compensation_requests WHERE tenant_id=$1', [
          tenantId,
        ]);
        await pool.query('DELETE FROM commander_compensation_authorizations WHERE tenant_id=$1', [
          tenantId,
        ]);
        await pool.query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId]);
        await pool.query('DELETE FROM commander_runs WHERE tenant_id=$1', [tenantId]);
        await pool.query('DELETE FROM commander_workers WHERE id=$1', [adapterId]);
        await pool.query('DELETE FROM commander_app_tenant_contexts WHERE tenant_id=$1', [
          tenantId,
        ]);
        await pool.query(
          'DELETE FROM commander_tenant_authority_allowed_tenants WHERE tenant_id=$1',
          [tenantId],
        );
        await pool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [
          tenantId,
        ]);
        await Promise.all([
          adapterPool.end(),
          tenantAuthorityPool.end(),
          appPool.end(),
          pool.end(),
        ]);
      }
    },
  );
});
