import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { runKernelMigrations, runTask1ClosureMigrations } from './migrations.js';
import { PostgresKernelRepository } from './postgres.js';
import { seedWorkerAllowedTenants } from './seedWorkerClaimSecret.js';
import type { KernelEvidenceRecord } from './evidenceRepository.js';

const adminUrl = process.env.COMMANDER_TASK2_PG_URL;

describe('signed evidence PostgreSQL authority', { skip: !adminUrl }, () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const databaseName = `commander_evidence_live_${suffix}`;
  const tenantId = `evidence-${suffix}`;
  const otherTenantId = `evidence-other-${suffix}`;
  const workerId = `evidence-worker-${suffix}`;
  const passwords = {
    owner: `owner-${suffix}`,
    worker: `worker-${suffix}`,
    app: `app-${suffix}`,
  };
  let admin: Pool;
  let owner: Pool;
  let worker: Pool;
  let app: Pool;
  let workerRepository: PostgresKernelRepository;
  let appRepository: PostgresKernelRepository;
  let workerGeneration: number;
  let workerClaimSecret: string;

  const url = (role?: string, password?: string): string => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    if (role) parsed.username = role;
    if (password) parsed.password = password;
    return parsed.toString();
  };

  before(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(
      `ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT
         NOREPLICATION BYPASSRLS PASSWORD '${passwords.owner}';
       ALTER ROLE commander_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.worker}';
       ALTER ROLE commander_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.app}'`,
    );
    await admin.query(`CREATE DATABASE "${databaseName}" OWNER commander_owner`);
    owner = new Pool({ connectionString: url('commander_owner', passwords.owner), max: 3 });
    await runKernelMigrations(owner);
    await runTask1ClosureMigrations(owner, 'expand');
    await runTask1ClosureMigrations(owner, 'enforce');
    await runKernelMigrations(owner);
    await seedWorkerAllowedTenants(owner, [tenantId, otherTenantId]);
    const ownerRepository = new PostgresKernelRepository(owner, { schedulerMode: true });
    worker = new Pool({ connectionString: url('commander_worker', passwords.worker), max: 2 });
    app = new Pool({ connectionString: url('commander_app', passwords.app), max: 2 });
    workerRepository = new PostgresKernelRepository(worker);
    appRepository = new PostgresKernelRepository(app);
    const registration = await worker.query<{
      registration: { generation: number; claim_secret: string };
    }>(
      `SELECT register_worker($1,'agent','evidence-live','["agent"]','{}',8,$1,$2::jsonb,NULL)
         AS registration`,
      [workerId, JSON.stringify([tenantId, otherTenantId])],
    );
    workerGeneration = Number(registration.rows[0]!.registration.generation);
    workerClaimSecret = registration.rows[0]!.registration.claim_secret;
  });

  after(async () => {
    await Promise.all([app?.end(), worker?.end(), owner?.end()]);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.query(
        `ALTER ROLE commander_owner NOLOGIN NOCREATEROLE;
         ALTER ROLE commander_worker NOLOGIN;
         ALTER ROLE commander_app NOLOGIN`,
      );
      await admin.end();
    }
  });

  function evidenceRecord(
    runId: string,
    effectId: string,
    receiptTenantId = tenantId,
    overrides: Partial<KernelEvidenceRecord> = {},
  ): KernelEvidenceRecord {
    const signature = {
      algorithm: 'Ed25519' as const,
      keyId: 'test-key',
      signedAt: '2026-07-29T00:00:00.000Z',
      value: 'signature',
    };
    const record: KernelEvidenceRecord = {
      tenantId: receiptTenantId,
      runId,
      bundleId: `evidence_${effectId}`,
      actionDigest: 'a'.repeat(64),
      body: {
        bodyVersion: 'commander.evidence-body/v1',
        bundleId: `evidence_${effectId}`,
        actionDigest: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        scope: { tenantId: receiptTenantId, runId },
        signature,
      },
      contentHash: 'b'.repeat(64),
      signature,
      createdAt: '2026-07-29T00:00:00.000Z',
      anchoredAt: '2026-07-29T00:00:01.000Z',
      retentionUntil: '2027-07-29T00:00:00.000Z',
    };
    return { ...record, ...overrides };
  }

  async function createAdmittedEffect(label: string, effectTenantId = tenantId) {
    const runId = `run-evidence-${label}-${suffix}`;
    const stepId = `step-evidence-${label}-${suffix}`;
    const effectId = `effect-evidence-${label}-${suffix}`;
    const ownerRepository = new PostgresKernelRepository(owner, { schedulerMode: true });
    await ownerRepository.createRun(
      {
        id: runId,
        tenantId: effectTenantId,
        intentHash: `intent-${label}`,
        workGraphHash: `graph-${label}`,
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-v1',
        steps: [{ id: stepId, kind: 'agent', maxAttempts: 1 }],
      },
      'test',
    );
    const step = await workerRepository.claimNextStep({
      workerId,
      workerGeneration,
      claimSecret: workerClaimSecret,
      capabilities: ['agent'],
      leaseTtlMs: 60_000,
    });
    assert.ok(step?.lease);
    assert.equal(step.tenantId, effectTenantId);
    const admitted = await workerRepository.admitEffect({
      id: effectId,
      runId,
      stepId,
      tenantId: effectTenantId,
      type: 'local.compute',
      idempotencyKey: `evidence-${label}-${suffix}`,
      request: { label },
      policyDecisionId: 'decision-v1',
      policySnapshotId: 'policy-v1',
      actionDigest: 'a'.repeat(64),
      lease: step.lease,
      actor: workerId,
    });
    assert.equal(admitted.admitted, true);
    return { runId, effectId, lease: step.lease };
  }

  async function assertAdmittedWithoutEvidence(effectId: string, runId: string) {
    assert.equal((await workerRepository.getEffect(effectId, tenantId))?.state, 'ADMITTED');
    assert.equal(await workerRepository.getEvidence(runId, tenantId), null);
  }

  it('atomically completes an effect and persists its evidence receipt', async () => {
    const admitted = await createAdmittedEffect('atomic-success');
    const evidence = evidenceRecord(admitted.runId, admitted.effectId);
    const completed = await workerRepository.completeEffectWithEvidence(
      admitted.effectId,
      tenantId,
      admitted.lease,
      { status: 'ok' },
      workerId,
      evidence,
    );

    assert.equal(completed?.state, 'COMPLETED');
    assert.deepEqual(await appRepository.getEvidence(admitted.runId, tenantId), evidence);
  });

  it('rolls back effect completion when evidence insertion violates a database constraint', async () => {
    const admitted = await createAdmittedEffect('insert-rollback');
    const evidence = evidenceRecord(admitted.runId, admitted.effectId, tenantId, {
      retentionUntil: '2026-07-29T00:00:00.000Z',
    });

    await assert.rejects(
      workerRepository.completeEffectWithEvidence(
        admitted.effectId,
        tenantId,
        admitted.lease,
        { status: 'ok' },
        workerId,
        evidence,
      ),
      /violates check constraint/i,
    );
    await assertAdmittedWithoutEvidence(admitted.effectId, admitted.runId);
  });

  it('rolls back effect completion when the signed evidence binding is invalid', async () => {
    const admitted = await createAdmittedEffect('signature-rollback');
    const evidence = evidenceRecord(admitted.runId, admitted.effectId);
    evidence.signature = { ...evidence.signature, value: 'different-signature' };

    await assert.rejects(
      workerRepository.completeEffectWithEvidence(
        admitted.effectId,
        tenantId,
        admitted.lease,
        { status: 'ok' },
        workerId,
        evidence,
      ),
      /EVIDENCE_RECORD_BINDING_INVALID/,
    );
    await assertAdmittedWithoutEvidence(admitted.effectId, admitted.runId);
  });

  it('denies stale lease tokens and fencing epochs without writing evidence', async () => {
    const admitted = await createAdmittedEffect('stale-lease');
    const evidence = evidenceRecord(admitted.runId, admitted.effectId);

    assert.equal(
      await workerRepository.completeEffectWithEvidence(
        admitted.effectId,
        tenantId,
        { ...admitted.lease, token: 'stale-token' },
        { status: 'ok' },
        workerId,
        evidence,
      ),
      null,
    );
    assert.equal(
      await workerRepository.completeEffectWithEvidence(
        admitted.effectId,
        tenantId,
        { ...admitted.lease, fencingEpoch: admitted.lease.fencingEpoch + 1 },
        { status: 'ok' },
        workerId,
        evidence,
      ),
      null,
    );
    await assertAdmittedWithoutEvidence(admitted.effectId, admitted.runId);
  });

  it('conceals cross-tenant effect completion attempts', async () => {
    const admitted = await createAdmittedEffect('cross-tenant');
    const crossTenantEvidence = evidenceRecord(admitted.runId, admitted.effectId, otherTenantId);

    assert.equal(
      await workerRepository.completeEffectWithEvidence(
        admitted.effectId,
        otherTenantId,
        admitted.lease,
        { status: 'ok' },
        workerId,
        crossTenantEvidence,
      ),
      null,
    );
    await assertAdmittedWithoutEvidence(admitted.effectId, admitted.runId);
    assert.equal(await workerRepository.getEvidence(admitted.runId, otherTenantId), null);
  });

  it('allows worker append and app tenant reads while denying direct receipt mutation', async () => {
    const runId = `run-evidence-append-${suffix}`;
    const ownerRepository = new PostgresKernelRepository(owner, { schedulerMode: true });
    await ownerRepository.createRun(
      {
        id: runId,
        tenantId,
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-v1',
        steps: [],
      },
      'test',
    );
    const record = evidenceRecord(runId, `append-${suffix}`);
    assert.deepEqual(await workerRepository.appendEvidence(record), { inserted: true });
    assert.deepEqual(await workerRepository.appendEvidence(record), { inserted: false });
    await assert.rejects(
      workerRepository.appendEvidence({ ...record, contentHash: 'c'.repeat(64) }),
      /EVIDENCE_CONFLICT/,
    );
    assert.deepEqual(await appRepository.getEvidence(record.runId, tenantId), record);
    assert.equal(await appRepository.getEvidence(record.runId, 'other-tenant'), null);
    await assert.rejects(
      worker.query(
        `UPDATE commander_evidence_receipts SET content_hash='tampered'
         WHERE tenant_id=$1 AND bundle_id=$2`,
        [tenantId, record.bundleId],
      ),
      /permission denied/i,
    );
    await assert.rejects(
      worker.query(
        `DELETE FROM commander_evidence_receipts
         WHERE tenant_id=$1 AND bundle_id=$2`,
        [tenantId, record.bundleId],
      ),
      /permission denied/i,
    );
    await assert.rejects(
      app.query(
        `UPDATE commander_evidence_receipts SET content_hash='tampered'
         WHERE tenant_id=$1 AND bundle_id=$2`,
        [tenantId, record.bundleId],
      ),
      /permission denied/i,
    );
  });
});
