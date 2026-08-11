import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildEffectScopedEvidenceRecord, createEvidenceSigner } from '@commander/effect-broker';
import { Pool } from 'pg';
import { runKernelMigrations } from './migrations.js';
import { PostgresKernelRepository } from './postgres.js';

const databaseUrl = process.env.COMMANDER_TASK1_PG_URL?.trim();

function createLivePool(connectionString: string): Pool {
  const caFile = process.env.COMMANDER_DATABASE_TLS_CA_FILE?.trim();
  if (!caFile) throw new Error('COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED');
  const url = new URL(connectionString);
  if (url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('POSTGRES_VERIFY_FULL_REQUIRED');
  }
  url.searchParams.delete('sslmode');
  return new Pool({
    connectionString: url.toString(),
    max: 4,
    ssl: {
      ca: readFileSync(caFile, 'utf8'),
      rejectUnauthorized: true,
      servername: url.hostname,
    },
  });
}

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createEvidenceSigner({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'postgres-live-evidence-key',
  });
}

describe('PostgreSQL effect-scoped evidence persistence', { skip: !databaseUrl }, () => {
  it('atomically anchors completion and escalation receipts with exact lookup', async () => {
    if (!databaseUrl) return;
    const pool = createLivePool(databaseUrl);
    const repository = new PostgresKernelRepository(pool, { schedulerMode: true });
    const suffix = `${process.pid}-${randomUUID().replaceAll('-', '')}`;
    const tenantId = `evidence-live-${suffix}`;
    const workerId = `evidence-worker-${suffix}`;
    const actionDigest = 'a'.repeat(64);
    const evidenceSigner = signer();

    try {
      await runKernelMigrations(pool);
      await pool.query(
        "DELETE FROM commander_evidence_receipts WHERE tenant_id LIKE 'evidence-live-%'",
      );
      await pool.query("DELETE FROM commander_runs WHERE tenant_id LIKE 'evidence-live-%'");
      await pool.query("DELETE FROM commander_workers WHERE id LIKE 'evidence-worker-%'");
      await pool.query(
        `INSERT INTO commander_workers
           (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','evidence-live','["tool"]',1,'ACTIVE',1,$1,$2::jsonb)`,
        [workerId, JSON.stringify([tenantId])],
      );

      const completionRunId = `run-complete-${suffix}`;
      await repository.createRun(
        {
          id: completionRunId,
          tenantId,
          intentHash: `intent-complete-${suffix}`,
          workGraphHash: `graph-complete-${suffix}`,
          workGraphVersion: 'v1',
          policySnapshotId: 'policy-live',
          steps: [{ id: `step-complete-${suffix}`, kind: 'tool' }],
        },
        'postgres-live-test',
      );
      const completionStep = await repository.claimNextStep({
        tenantId,
        workerId,
        workerGeneration: 1,
        capabilities: ['tool'],
        leaseTtlMs: 60_000,
      });
      assert.ok(completionStep?.lease);
      const completionEffectId = `effect-complete-${suffix}`;
      const admittedCompletion = await repository.admitEffect({
        id: completionEffectId,
        runId: completionRunId,
        stepId: completionStep.id,
        tenantId,
        type: 'connector.kubernetes.deployment.rollback',
        idempotencyKey: `complete-${suffix}`,
        policyDecisionId: 'decision-live',
        policySnapshotId: 'policy-live',
        actionDigest,
        request: { revision: 'v2' },
        lease: completionStep.lease,
        actor: workerId,
      });
      assert.equal(admittedCompletion.admitted, true);
      if (!admittedCompletion.admitted) return;

      const completionEvidence = await buildEffectScopedEvidenceRecord({
        effect: admittedCompletion.effect,
        projectedState: 'COMPLETED',
        response: { status: 'ok' },
        auditEvents: [],
        terminalEvent: { type: 'effect.completed', severity: 'low', details: {} },
        signer: evidenceSigner,
        recordedAt: '2026-08-11T00:00:01.000Z',
        retentionUntil: '2027-08-11T00:00:01.000Z',
      });
      const completionLookup = {
        tenantId,
        runId: completionRunId,
        effectId: completionEffectId,
        actionDigest,
      };

      await assert.rejects(
        repository.completeEffectWithEvidence(
          completionEffectId,
          tenantId,
          completionStep.lease,
          { status: 'ok' },
          workerId,
          { ...completionEvidence, actionDigest: 'f'.repeat(64) },
        ),
        /EVIDENCE_RECORD_BINDING_INVALID/,
      );
      assert.equal((await repository.getEffect(completionEffectId, tenantId))?.state, 'ADMITTED');
      assert.equal(await repository.getEvidence(completionLookup), null);

      assert.equal(
        (
          await repository.completeEffectWithEvidence(
            completionEffectId,
            tenantId,
            completionStep.lease,
            { status: 'ok' },
            workerId,
            completionEvidence,
          )
        )?.state,
        'COMPLETED',
      );
      assert.deepEqual(await repository.getEvidence(completionLookup), completionEvidence);
      assert.equal(
        await repository.getEvidence({ ...completionLookup, tenantId: `${tenantId}-other` }),
        null,
      );
      assert.equal(
        await repository.getEvidence({ ...completionLookup, runId: `${completionRunId}-other` }),
        null,
      );
      assert.equal(
        await repository.getEvidence({
          ...completionLookup,
          effectId: `${completionEffectId}-other`,
        }),
        null,
      );
      assert.equal(
        await repository.getEvidence({ ...completionLookup, actionDigest: 'b'.repeat(64) }),
        null,
      );

      const escalationRunId = `run-escalate-${suffix}`;
      await repository.createRun(
        {
          id: escalationRunId,
          tenantId,
          intentHash: `intent-escalate-${suffix}`,
          workGraphHash: `graph-escalate-${suffix}`,
          workGraphVersion: 'v1',
          policySnapshotId: 'policy-live',
          steps: [{ id: `step-escalate-${suffix}`, kind: 'tool' }],
        },
        'postgres-live-test',
      );
      const escalationStep = await repository.claimNextStep({
        tenantId,
        workerId,
        workerGeneration: 1,
        capabilities: ['tool'],
        leaseTtlMs: 60_000,
      });
      assert.ok(escalationStep?.lease);
      const escalationEffectId = `effect-escalate-${suffix}`;
      const admittedEscalation = await repository.admitEffect({
        id: escalationEffectId,
        runId: escalationRunId,
        stepId: escalationStep.id,
        tenantId,
        type: 'connector.unknown.effect',
        idempotencyKey: `escalate-${suffix}`,
        policyDecisionId: 'decision-live',
        policySnapshotId: 'policy-live',
        actionDigest,
        request: {},
        lease: escalationStep.lease,
        actor: workerId,
      });
      assert.equal(admittedEscalation.admitted, true);
      if (!admittedEscalation.admitted) return;
      assert.ok(
        await repository.markEffectCompletionUnknown({
          effectId: escalationEffectId,
          tenantId,
          reason: 'remote outcome unknown',
          actor: workerId,
        }),
      );
      const [claimedEffect] = await repository.claimReconcileEffects({
        tenantId,
        limit: 1,
        now: new Date(Date.now() + 60_000),
        workerId,
        workerGeneration: 1,
      });
      assert.ok(claimedEffect);

      const escalationEvidence = await buildEffectScopedEvidenceRecord({
        effect: claimedEffect.effect,
        projectedState: 'COMPLETION_UNKNOWN',
        response: { errorCode: 'REMOTE_OUTCOME_UNKNOWN' },
        auditEvents: [],
        terminalEvent: {
          type: 'effect.reconcile_escalated',
          severity: 'high',
          details: { reason: 'unregistered_adapter' },
        },
        signer: evidenceSigner,
        recordedAt: '2026-08-11T00:00:02.000Z',
        retentionUntil: '2027-08-11T00:00:02.000Z',
      });
      const escalationLookup = {
        tenantId,
        runId: escalationRunId,
        effectId: escalationEffectId,
        actionDigest,
      };
      const escalation = {
        effectId: escalationEffectId,
        tenantId,
        claimToken: claimedEffect.claimToken,
        reason: 'unregistered_adapter',
      };

      await assert.rejects(
        repository.escalateReconcileWithEvidence(escalation, {
          ...escalationEvidence,
          actionDigest: 'f'.repeat(64),
        }),
        /EVIDENCE_RECORD_BINDING_INVALID/,
      );
      assert.equal(
        (await repository.getEffect(escalationEffectId, tenantId))?.reconcileEscalatedAt,
        null,
      );
      assert.equal(await repository.getEvidence(escalationLookup), null);

      assert.equal(
        await repository.escalateReconcileWithEvidence(escalation, escalationEvidence),
        true,
      );
      assert.ok((await repository.getEffect(escalationEffectId, tenantId))?.reconcileEscalatedAt);
      assert.deepEqual(await repository.getEvidence(escalationLookup), escalationEvidence);
    } finally {
      await pool
        .query('DELETE FROM commander_evidence_receipts WHERE tenant_id=$1', [tenantId])
        .catch(() => undefined);
      await pool
        .query('DELETE FROM commander_runs WHERE tenant_id=$1', [tenantId])
        .catch(() => undefined);
      await pool
        .query('DELETE FROM commander_workers WHERE id=$1', [workerId])
        .catch(() => undefined);
      await pool.end();
    }
  });
});
