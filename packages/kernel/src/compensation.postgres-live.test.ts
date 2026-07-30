import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { runKernelMigrations, runTask1ClosureMigrations } from './migrations.js';
import { PostgresKernelRepository, PostgresTenantContextAuthority } from './postgres.js';
import { seedWorkerAllowedTenants } from './seedWorkerClaimSecret.js';
import {
  governedCompensationAuthorizationInput,
} from './ops/compensationPersistence.js';
import { sealGovernedCompensationAuthorization } from './ops/compensationAuthority.js';
import { KERNEL_COMPENSATION_TOPIC } from './ops/compensationConsumer.js';
import type { RequestCompensationInput } from './types.js';

const adminUrl = process.env.COMMANDER_COMPENSATION_PG_URL;

describe('governed compensation PostgreSQL authority', { skip: !adminUrl }, () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const databaseName = `commander_compensation_live_${suffix}`;
  const tenantA = `comp-a-${suffix}`;
  const tenantB = `comp-b-${suffix}`;
  const workerId = `worker-${suffix}`;
  const adapterInstance = `comp${suffix}`;
  const adapterId = `compensation:${adapterInstance}`;
  const passwords = {
    owner: `owner-${suffix}`,
    worker: `worker-${suffix}`,
    adapter: `adapter-${suffix}`,
    app: `app-${suffix}`,
    authority: `authority-${suffix}`,
  };

  let admin: Pool;
  let owner: Pool;
  let worker: Pool;
  let adapter: Pool;
  let app: Pool;
  let authority: Pool;
  let ownerRepository: PostgresKernelRepository;
  let workerRepository: PostgresKernelRepository;
  let adapterRepository: PostgresKernelRepository;
  let appRepository: PostgresKernelRepository;
  let workerGeneration: number;
  let workerSecret: string;
  let adapterGeneration: number;
  let adapterSecret: string;

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
       ALTER ROLE commander_adapter_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.adapter}';
       ALTER ROLE commander_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.app}';
       ALTER ROLE commander_tenant_authority LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.authority}'`,
    );
    await admin.query(`CREATE DATABASE "${databaseName}" OWNER commander_owner`);
    owner = new Pool({ connectionString: url('commander_owner', passwords.owner), max: 5 });
    await runKernelMigrations(owner);
    await runTask1ClosureMigrations(owner, 'expand');
    await runTask1ClosureMigrations(owner, 'enforce');
    await runKernelMigrations(owner);
    await seedWorkerAllowedTenants(owner, [tenantA, tenantB]);
    await owner.query(
      `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
       VALUES ($1), ($2)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = true`,
      [tenantA, tenantB],
    );

    worker = new Pool({ connectionString: url('commander_worker', passwords.worker), max: 3 });
    adapter = new Pool({ connectionString: url('commander_adapter_ops', passwords.adapter), max: 3 });
    app = new Pool({ connectionString: url('commander_app', passwords.app), max: 3 });
    authority = new Pool({
      connectionString: url('commander_tenant_authority', passwords.authority),
      max: 2,
    });
    ownerRepository = new PostgresKernelRepository(owner, { schedulerMode: true });
    workerRepository = new PostgresKernelRepository(worker);
    adapterRepository = new PostgresKernelRepository(adapter, { adapterOpsMode: true });
    appRepository = new PostgresKernelRepository(app, {
      tenantContextAuthority: new PostgresTenantContextAuthority(authority),
      tenantContextPhase: 'enforce',
    });

    const workerRegistration = await worker.query<{
      registration: { generation: number; claim_secret: string };
    }>(
      `SELECT register_worker($1,'agent','comp-live','["agent"]','{}',1,$1,$2::jsonb,NULL)
         AS registration`,
      [workerId, JSON.stringify([tenantA])],
    );
    workerGeneration = Number(workerRegistration.rows[0]!.registration.generation);
    workerSecret = workerRegistration.rows[0]!.registration.claim_secret;
    const adapterRegistration = await adapter.query<{
      registration: { generation: number; claim_secret: string };
    }>(`SELECT register_adapter_ops_worker('compensation',$1,$2::jsonb,NULL) AS registration`, [
      adapterInstance,
      JSON.stringify([tenantA]),
    ]);
    adapterGeneration = Number(adapterRegistration.rows[0]!.registration.generation);
    adapterSecret = adapterRegistration.rows[0]!.registration.claim_secret;
  });

  after(async () => {
    await Promise.all([authority?.end(), app?.end(), adapter?.end(), worker?.end(), owner?.end()]);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.query(
        `ALTER ROLE commander_owner NOLOGIN NOCREATEROLE;
         ALTER ROLE commander_worker NOLOGIN;
         ALTER ROLE commander_adapter_ops NOLOGIN;
         ALTER ROLE commander_app NOLOGIN;
         ALTER ROLE commander_tenant_authority NOLOGIN`,
      );
      await admin.end();
    }
  });

  async function completedForwardEffect() {
    const runId = `run-forward-${suffix}`;
    const stepId = `step-forward-${suffix}`;
    const effectId = `effect-forward-${suffix}`;
    await ownerRepository.createRun(
      {
        id: runId,
        tenantId: tenantA,
        intentHash: 'intent-forward',
        workGraphHash: 'graph-forward',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-forward-v1',
        steps: [{ id: stepId, kind: 'agent' }],
      },
      'test-owner',
    );
    const step = await workerRepository.claimNextStep({
      workerId,
      workerGeneration,
      claimSecret: workerSecret,
      capabilities: ['agent'],
      leaseTtlMs: 60_000,
    });
    assert.ok(step?.lease);
    const request = { destination: 'ticket://tenant-a/INC-1', args: { severity: 'high' } };
    const admitted = await workerRepository.admitEffect({
      id: effectId,
      runId,
      stepId,
      tenantId: tenantA,
      type: 'read.ticket',
      idempotencyKey: `forward-${suffix}`,
      policyDecisionId: 'policy-decision-forward',
      policySnapshotId: 'policy-forward-v1',
      actionDigest: 'a'.repeat(64),
      request,
      lease: step.lease,
      actor: workerId,
    });
    assert.equal(admitted.admitted, true);
    const response = { providerId: 'INC-1', version: 7 };
    assert.ok(await workerRepository.completeEffect(effectId, tenantA, step.lease, response, workerId));
    await owner.query(
      `UPDATE commander_steps SET state='SUCCEEDED',lease_worker_id=NULL,lease_worker_generation=0,
         lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2`,
      [stepId, tenantA],
    );
    await owner.query(
      `UPDATE commander_runs SET state='SUCCEEDED',terminal_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2`,
      [runId, tenantA],
    );
    return { runId, stepId, effectId, request, response };
  }

  it('uses immutable authorization/request rows and only adapter-ops can execute the lifecycle', async () => {
    const forward = await completedForwardEffect();
    const base: RequestCompensationInput = {
      tenantId: tenantA,
      originalRunId: forward.runId,
      originalEffectId: forward.effectId,
      forwardReceipt: forward.response,
      adapterVersion: 'demo-ticket/v1',
      compensationEffectType: 'compensate.demo.ticket.create',
      compensationPatch: { status: 'cancelled' },
      policyDecisionId: 'policy-decision-compensation',
      policySnapshotId: 'policy-compensation-v1',
      actionDigest: '',
      decisionEffect: 'allow',
      authorizationExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      approvalBinding: null,
      actor: 'api-user',
    };
    const sealed = sealGovernedCompensationAuthorization(
      governedCompensationAuthorizationInput({
        request: base,
        originalRunStateAtRequest: 'SUCCEEDED',
        originalEffect: { request: forward.request, response: forward.response },
      }),
    );
    base.actionDigest = sealed.actionDigest;
    const requested = await appRepository.requestCompensation(base);
    assert.equal(requested?.status, 'SCHEDULED');

    const authorityTables = await owner.query<{ authorization: string | null; request: string | null }>(
      `SELECT to_regclass('public.commander_compensation_authorizations')::text AS authorization,
              to_regclass('public.commander_compensation_requests')::text AS request`,
    );
    assert.equal(authorityTables.rows[0]?.authorization, 'commander_compensation_authorizations');
    assert.equal(authorityTables.rows[0]?.request, 'commander_compensation_requests');

    await assert.rejects(
      app.query(`UPDATE commander_compensation_authorizations SET action_digest='tampered'`),
      /permission denied/i,
    );
    await assert.rejects(
      adapter.query(`INSERT INTO commander_compensation_authorizations DEFAULT VALUES`),
      /permission denied/i,
    );

    assert.deepEqual(
      await adapterRepository.claimCompensationWork({
        workerId: adapterId,
        workerGeneration: adapterGeneration + 1,
        claimSecret: adapterSecret,
        topic: KERNEL_COMPENSATION_TOPIC,
        limit: 10,
      }),
      [],
    );
    const claims = await adapterRepository.claimCompensationWork({
      workerId: adapterId,
      workerGeneration: adapterGeneration,
      claimSecret: adapterSecret,
      topic: KERNEL_COMPENSATION_TOPIC,
      limit: 10,
    });
    assert.equal(claims.length, 1);
    const claim = claims[0]!;
    const admitted = await adapterRepository.admitEffect({
      id: claim.authorization.compensationEffectId,
      runId: claim.authorization.compensationRunId,
      stepId: claim.authorization.compensationStepId,
      tenantId: tenantA,
      type: claim.authorization.compensationEffectType,
      idempotencyKey: claim.authorization.idempotencyKey,
      policyDecisionId: claim.authorization.policyDecisionId,
      policySnapshotId: claim.authorization.policySnapshotId,
      actionDigest: claim.authorization.actionDigest,
      request: claim.authorization.compensationRequest,
      lease: claim.lease,
      compensationBinding: {
        authorizationId: claim.authorization.authorizationId,
        requestId: claim.authorization.requestId,
        claimToken: claim.claimToken,
      },
      actor: adapterId,
    });
    assert.equal(admitted.admitted, true);
    assert.ok(
      await adapterRepository.completeEffect(
        claim.authorization.compensationEffectId,
        tenantA,
        claim.lease,
        { compensated: true },
        adapterId,
      ),
    );
    const disposition = await adapterRepository.completeCompensationWork({
      workerId: adapterId,
      workerGeneration: adapterGeneration,
      claimSecret: adapterSecret,
      tenantId: tenantA,
      messageId: claim.messageId,
      outboxClaimToken: claim.claimToken,
      compensationEffectId: claim.authorization.compensationEffectId,
      response: { compensated: true },
    });
    assert.equal(disposition.applied && disposition.disposition, 'COMPLETED');
  });
});
