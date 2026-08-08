import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { runKernelMigrations, runTask1ClosureMigrations } from './migrations.js';
import { PostgresKernelRepository } from './postgres.js';
import { seedWorkerAllowedTenants } from './seedWorkerClaimSecret.js';
import type { KernelEvidenceRecord } from './evidenceRepository.js';
import type { KernelStep, ReconcileMutationResult } from './types.js';

const adminUrl = process.env.COMMANDER_TASK2_PG_URL;

function databaseIdentifier(databaseName: string): string {
  if (!/^commander_task2_live_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('unsafe Task 2 test database identifier');
  }
  return `"${databaseName}"`;
}

function databaseUrl(databaseName: string, role?: string, password?: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${databaseName}`;
  if (role) url.username = role;
  if (password) url.password = password;
  return url.toString();
}

type RegisteredWorker = { generation: number; claimSecret: string };

function terminalEvidence(
  effect: { effectId: string; step: KernelStep },
  state: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN',
): KernelEvidenceRecord {
  const disposition =
    state === 'COMPLETED'
      ? 'SUCCEEDED'
      : state === 'CONFIRMED_NOT_APPLIED'
        ? 'FAILED'
        : 'ESCALATED';
  const bundleId = `evidence_${effect.effectId}`;
  const actionDigest = 'a'.repeat(64);
  const contentHash = 'b'.repeat(64);
  const signature = {
    algorithm: 'Ed25519' as const,
    keyId: 'task2-live-test-key',
    signedAt: '2026-08-02T00:00:00.000Z',
    value: 'task2-live-signature',
  };
  return {
    tenantId: effect.step.tenantId,
    runId: effect.step.runId,
    bundleId,
    actionDigest,
    body: {
      bodyVersion: 'commander.evidence-body/v1',
      bundleId,
      actionDigest,
      contentHash,
      terminalDisposition: disposition,
      scope: {
        tenantId: effect.step.tenantId,
        runId: effect.step.runId,
        effectId: effect.effectId,
      },
      effects: [{ effectId: effect.effectId, state }],
      auditEvents: disposition === 'ESCALATED' ? [{ type: 'effect.reconcile_escalated' }] : [],
      signature,
    },
    contentHash,
    signature,
    createdAt: '2026-08-02T00:00:00.000Z',
    anchoredAt: '2026-08-02T00:00:00.000Z',
    retentionUntil: '2027-08-02T00:00:00.000Z',
  };
}

describe('Task 2 real PostgreSQL reconciliation authority', { skip: !adminUrl }, () => {
  const suffix = `${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const databaseName = `commander_task2_live_${suffix.replaceAll('-', '_')}`;
  const tenantA = `task2-a-${suffix}`;
  const tenantB = `task2-b-${suffix}`;
  const workerId = `task2-worker-${suffix}`;
  const adapterInstanceA = `task2a${suffix.replaceAll('-', '').slice(0, 16)}`;
  const adapterInstanceB = `task2b${suffix.replaceAll('-', '').slice(0, 16)}`;
  const adapterIdA = `reconcile:${adapterInstanceA}`;
  const adapterIdB = `reconcile:${adapterInstanceB}`;
  const passwords = {
    owner: `owner-${suffix}`,
    worker: `worker-${suffix}`,
    adapter: `adapter-${suffix}`,
    app: `app-${suffix}`,
  };

  let adminPool: Pool;
  let ownerPool: Pool;
  let workerPool: Pool;
  let adapterPool: Pool;
  let appPool: Pool;
  let ownerRepo: PostgresKernelRepository;
  let workerRepo: PostgresKernelRepository;
  let adapterRepo: PostgresKernelRepository;
  let worker: RegisteredWorker;
  let adapterA: RegisteredWorker;
  let adapterB: RegisteredWorker;

  before(async () => {
    adminPool = new Pool({ connectionString: adminUrl, max: 2 });
    await adminPool.query(
      `ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT
         NOREPLICATION BYPASSRLS PASSWORD '${passwords.owner}'`,
    );
    for (const [role, password] of [
      ['commander_worker', passwords.worker],
      ['commander_adapter_ops', passwords.adapter],
      ['commander_app', passwords.app],
    ] as const) {
      await adminPool.query(
        `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
           NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
      );
    }
    await adminPool.query(
      `CREATE DATABASE ${databaseIdentifier(databaseName)} OWNER commander_owner`,
    );

    ownerPool = new Pool({
      connectionString: databaseUrl(databaseName, 'commander_owner', passwords.owner),
      max: 8,
    });
    await runKernelMigrations(ownerPool);
    await runTask1ClosureMigrations(ownerPool, 'expand');
    await runTask1ClosureMigrations(ownerPool, 'enforce');
    await runKernelMigrations(ownerPool);
    await seedWorkerAllowedTenants(ownerPool, [tenantA, tenantB]);

    workerPool = new Pool({
      connectionString: databaseUrl(databaseName, 'commander_worker', passwords.worker),
      max: 6,
    });
    adapterPool = new Pool({
      connectionString: databaseUrl(databaseName, 'commander_adapter_ops', passwords.adapter),
      max: 6,
    });
    appPool = new Pool({
      connectionString: databaseUrl(databaseName, 'commander_app', passwords.app),
      max: 2,
    });
    ownerRepo = new PostgresKernelRepository(ownerPool, { schedulerMode: true });
    workerRepo = new PostgresKernelRepository(workerPool);
    adapterRepo = new PostgresKernelRepository(adapterPool, { adapterOpsMode: true });

    const workerRegistration = await workerPool.query<{
      registration: { generation: number; claim_secret: string };
    }>(
      `SELECT register_worker($1,'agent','task2-live','["agent"]','{}',8,$1,$2::jsonb,NULL)
         AS registration`,
      [workerId, JSON.stringify([tenantA, tenantB])],
    );
    worker = {
      generation: Number(workerRegistration.rows[0]!.registration.generation),
      claimSecret: workerRegistration.rows[0]!.registration.claim_secret,
    };

    const registerAdapter = async (instanceId: string): Promise<RegisteredWorker> => {
      const registration = await adapterPool.query<{
        registration: { generation: number; claim_secret: string };
      }>(`SELECT register_adapter_ops_worker('reconcile',$1,$2::jsonb,NULL) AS registration`, [
        instanceId,
        JSON.stringify([tenantA]),
      ]);
      return {
        generation: Number(registration.rows[0]!.registration.generation),
        claimSecret: registration.rows[0]!.registration.claim_secret,
      };
    };
    adapterA = await registerAdapter(adapterInstanceA);
    adapterB = await registerAdapter(adapterInstanceB);
  });

  after(async () => {
    await Promise.all([appPool?.end(), adapterPool?.end(), workerPool?.end(), ownerPool?.end()]);
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${databaseIdentifier(databaseName)}`);
      await adminPool.query(
        `ALTER ROLE commander_owner NOLOGIN NOCREATEROLE;
         ALTER ROLE commander_worker NOLOGIN;
         ALTER ROLE commander_adapter_ops NOLOGIN;
         ALTER ROLE commander_app NOLOGIN`,
      );
      await adminPool.end();
    }
  });

  async function createAdmittedEffect(
    label: string,
    tenantId = tenantA,
  ): Promise<{
    effectId: string;
    step: KernelStep;
  }> {
    const runId = `run-${label}-${suffix}`;
    const stepId = `step-${label}-${suffix}`;
    const effectId = `effect-${label}-${suffix}`;
    await ownerRepo.createRun(
      {
        id: runId,
        tenantId,
        intentHash: `intent-${label}`,
        workGraphHash: `graph-${label}`,
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-v1',
        steps: [{ id: stepId, kind: 'agent', maxAttempts: 1 }],
      },
      'task2-live',
    );
    const step = await workerRepo.claimNextStep({
      workerId,
      workerGeneration: worker.generation,
      claimSecret: worker.claimSecret,
      capabilities: ['agent'],
      leaseTtlMs: 60_000,
    });
    assert.ok(step?.lease);
    assert.equal(step.tenantId, tenantId);
    const admitted = await workerRepo.admitEffect({
      id: effectId,
      runId,
      stepId,
      tenantId,
      type: 'read.cache',
      idempotencyKey: `idem-${label}-${suffix}`,
      request: { label },
      policyDecisionId: 'decision-v1',
      policySnapshotId: 'policy-v1',
      actionDigest: 'a'.repeat(64),
      lease: step.lease,
      actor: workerId,
    });
    assert.equal(admitted.admitted, true, JSON.stringify(admitted));
    return { effectId, step };
  }

  async function park(label: string, tenantId = tenantA) {
    const admitted = await createAdmittedEffect(label, tenantId);
    const input = {
      tenantId,
      effectId: admitted.effectId,
      workerId,
      workerGeneration: worker.generation,
      claimSecret: worker.claimSecret,
      leaseToken: admitted.step.lease!.token,
      fencingEpoch: admitted.step.lease!.fencingEpoch,
      error: {
        code: 'REMOTE_RESPONSE_UNCERTAIN',
        message: 'Remote response was not committed locally',
      },
    };
    const result = await workerRepo.parkEffectCompletionUnknown(input);
    assert.equal(result.parked, true);
    return { ...admitted, input, result };
  }

  async function claimAll() {
    return adapterRepo.claimReconcileEffects({
      workerId: adapterIdA,
      workerGeneration: adapterA.generation,
      claimSecret: adapterA.claimSecret,
      limit: 100,
      claimTtlMs: 60_000,
      now: new Date(Date.now() + 1_000),
    });
  }

  function auth(effectId: string, claimToken: string) {
    return {
      tenantId: tenantA,
      effectId,
      workerId: adapterIdA,
      workerGeneration: adapterA.generation,
      claimSecret: adapterA.claimSecret,
      claimToken,
    };
  }

  function evidenceAuth(input: {
    tenantId?: string;
    runId: string;
    effectId: string;
    claimToken: string;
  }) {
    return {
      workerId: adapterIdA,
      workerGeneration: adapterA.generation,
      claimSecret: adapterA.claimSecret,
      tenantId: input.tenantId ?? tenantA,
      runId: input.runId,
      effectId: input.effectId,
      claimToken: input.claimToken,
    };
  }

  it('authenticates parking exactly once and rejects stale worker credentials', async () => {
    const admitted = await createAdmittedEffect('park-auth');
    const usageBefore = await ownerPool.query<{ running_steps: string }>(
      `SELECT running_steps::text FROM commander_tenant_execution_usage WHERE tenant_id=$1`,
      [tenantA],
    );
    const base = {
      tenantId: tenantA,
      effectId: admitted.effectId,
      workerId,
      workerGeneration: worker.generation,
      claimSecret: worker.claimSecret,
      leaseToken: admitted.step.lease!.token,
      fencingEpoch: admitted.step.lease!.fencingEpoch,
      error: { code: 'UNCERTAIN', message: 'Uncertain completion' },
    };
    assert.deepEqual(
      await workerRepo.parkEffectCompletionUnknown({ ...base, claimSecret: 'wrong-secret' }),
      { parked: false, reason: 'LEASE_FENCED' },
    );
    assert.deepEqual(
      await workerRepo.parkEffectCompletionUnknown({
        ...base,
        workerGeneration: worker.generation + 1,
      }),
      { parked: false, reason: 'LEASE_FENCED' },
    );
    const first = await workerRepo.parkEffectCompletionUnknown(base);
    assert.equal(first.parked, true);
    assert.equal(first.parked && first.replayed, false);
    const usageAfter = await ownerPool.query<{ running_steps: string }>(
      `SELECT running_steps::text FROM commander_tenant_execution_usage WHERE tenant_id=$1`,
      [tenantA],
    );
    assert.equal(
      usageAfter.rows[0]?.running_steps,
      String(Math.max(0, Number(usageBefore.rows[0]?.running_steps ?? 0) - 1)),
      'first UNKNOWN parking must release the tenant execution slot',
    );
    const replay = await workerRepo.parkEffectCompletionUnknown(base);
    assert.equal(replay.parked && replay.replayed, true);
    assert.deepEqual(
      await workerRepo.parkEffectCompletionUnknown({ ...base, leaseToken: 'stale-token' }),
      { parked: false, reason: 'ADMISSION_BINDING_MISMATCH' },
    );
    const events = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM commander_events
        WHERE aggregate_id=$1 AND type='effect.completion_unknown'`,
      [admitted.effectId],
    );
    assert.equal(events.rows[0]?.count, '1');
  });

  it('rejects stale leases in the legacy completion-unknown mutation', async () => {
    const admitted = await createAdmittedEffect('legacy-mark-stale');
    const lease = admitted.step.lease!;

    const stale = await ownerRepo.markEffectCompletionUnknown({
      effectId: admitted.effectId,
      tenantId: tenantA,
      reason: 'stale-worker',
      actor: workerId,
      lease: { ...lease, fencingEpoch: lease.fencingEpoch + 1 },
    });

    assert.equal(stale, null, 'a stale fencing epoch must not park the effect');
    const state = await ownerPool.query<{ effect_state: string; step_state: string }>(
      `SELECT e.state AS effect_state, s.state AS step_state
         FROM commander_effects e
         JOIN commander_steps s ON s.id=e.step_id AND s.run_id=e.run_id AND s.tenant_id=e.tenant_id
        WHERE e.id=$1 AND e.tenant_id=$2`,
      [admitted.effectId, tenantA],
    );
    assert.deepEqual(state.rows[0], { effect_state: 'ADMITTED', step_state: 'RUNNING' });
  });

  it('transfers a valid legacy completion-unknown mark to reconciliation ownership', async () => {
    const admitted = await createAdmittedEffect('legacy-mark-valid');
    const lease = admitted.step.lease!;

    const beforeUsage = await ownerPool.query<{ running_steps: string }>(
      `SELECT running_steps::text FROM commander_tenant_execution_usage WHERE tenant_id=$1`,
      [tenantA],
    );
    const runningStepsBeforeMark = Number(beforeUsage.rows[0]?.running_steps ?? 0);

    const marked = await ownerRepo.markEffectCompletionUnknown({
      effectId: admitted.effectId,
      tenantId: tenantA,
      reason: 'valid-worker',
      actor: workerId,
      lease,
    });

    assert.equal(marked?.state, 'COMPLETION_UNKNOWN');
    const state = await ownerPool.query<{
      effect_state: string;
      reconcile_disposition: string | null;
      reconcile_deadline_at: string | null;
      step_state: string;
      lease_worker_id: string | null;
      lease_worker_generation: string | null;
      lease_token: string | null;
      lease_expires_at: string | null;
      running_steps: string;
    }>(
      `SELECT e.state AS effect_state, e.reconcile_disposition, e.reconcile_deadline_at,
              s.state AS step_state, s.lease_worker_id, s.lease_worker_generation::text,
              s.lease_token, s.lease_expires_at, u.running_steps::text
         FROM commander_effects e
         JOIN commander_steps s ON s.id=e.step_id AND s.run_id=e.run_id AND s.tenant_id=e.tenant_id
         JOIN commander_tenant_execution_usage u ON u.tenant_id=e.tenant_id
        WHERE e.id=$1 AND e.tenant_id=$2`,
      [admitted.effectId, tenantA],
    );
    assert.deepEqual(state.rows[0], {
      effect_state: 'COMPLETION_UNKNOWN',
      reconcile_disposition: 'PENDING',
      reconcile_deadline_at: state.rows[0]?.reconcile_deadline_at,
      step_state: 'WAITING_FOR_RECONCILIATION',
      lease_worker_id: null,
      lease_worker_generation: '0',
      lease_token: null,
      lease_expires_at: null,
      running_steps: String(Math.max(0, runningStepsBeforeMark - 1)),
    });
    assert.ok(state.rows[0]?.reconcile_deadline_at);

    const claims = await adapterRepo.claimReconcileEffects({
      workerId: adapterIdA,
      workerGeneration: adapterA.generation,
      claimSecret: adapterA.claimSecret,
      limit: 10,
      claimTtlMs: 60_000,
      now: new Date(Date.now() + 1_000),
    });
    assert.equal(
      claims.some((claim) => claim.effect.id === admitted.effectId),
      true,
      'a valid UNKNOWN mark must be visible to adapter-ops reconciliation',
    );
  });

  it('fences claims and all four mutations, including replay, expiry, and tenant concealment', async () => {
    const complete = await park('complete');
    const confirm = await park('confirm');
    const reschedule = await park('reschedule');
    const escalate = await park('escalate');
    const authNegative = await park('auth-negative');
    const expired = await park('expired');
    const crossTenant = await park('cross-tenant', tenantB);
    await ownerPool.query(
      `UPDATE commander_effects SET type='write.cache'
        WHERE tenant_id=$1 AND id = ANY($2::text[])`,
      [tenantA, [complete.effectId, confirm.effectId]],
    );

    assert.deepEqual(
      await adapterRepo.claimReconcileEffects({
        workerId: adapterIdA,
        workerGeneration: adapterA.generation,
        claimSecret: 'wrong-secret',
        limit: 100,
      }),
      [],
    );
    assert.deepEqual(
      await adapterRepo.claimReconcileEffects({
        workerId: adapterIdA,
        workerGeneration: adapterA.generation + 1,
        claimSecret: adapterA.claimSecret,
        limit: 100,
      }),
      [],
    );

    const claims = await claimAll();
    const tokens = new Map(claims.map((claim) => [claim.effect.id, claim.claimToken]));
    for (const effect of [complete, confirm, reschedule, escalate, authNegative, expired]) {
      assert.ok(tokens.has(effect.effectId), `${effect.effectId} was not claimed`);
    }
    assert.equal(tokens.has(crossTenant.effectId), false, 'claim must be tenant concealed');

    const completeAuth = auth(complete.effectId, tokens.get(complete.effectId)!);
    const completeEvidence = terminalEvidence(complete, 'COMPLETED');
    const completed = await adapterRepo.completeReconcileEffect({
      ...completeAuth,
      response: { remoteId: 'applied-1' },
      evidence: completeEvidence,
    });
    assert.equal(completed.applied && completed.disposition, 'COMPLETED');
    const completedReplay = await adapterRepo.completeReconcileEffect({
      ...completeAuth,
      response: { remoteId: 'applied-1' },
      evidence: completeEvidence,
    });
    assert.equal(completedReplay.applied && completedReplay.replayed, true);
    assert.deepEqual(
      (completedReplay as Extract<ReconcileMutationResult, { applied: true }>).receipt,
      (completed as Extract<ReconcileMutationResult, { applied: true }>).receipt,
    );

    const confirmed = await adapterRepo.confirmEffectNotApplied({
      ...auth(confirm.effectId, tokens.get(confirm.effectId)!),
      response: { remoteId: 'not-applied-1' },
      evidence: terminalEvidence(confirm, 'CONFIRMED_NOT_APPLIED'),
    });
    assert.equal(confirmed.applied && confirmed.disposition, 'CONFIRMED_NOT_APPLIED');
    const terminalRuns = await ownerPool.query<{ id: string; state: string }>(
      `SELECT id, state FROM commander_runs WHERE id = ANY($1::text[]) ORDER BY id`,
      [[complete.step.runId, confirm.step.runId]],
    );
    assert.deepEqual(
      Object.fromEntries(terminalRuns.rows.map((run) => [run.id, run.state])),
      {
        [complete.step.runId]: 'SUCCEEDED',
        [confirm.step.runId]: 'FAILED',
      },
      'terminal evidence and aggregate run transition must commit atomically',
    );
    const rescheduled = await adapterRepo.rescheduleReconcileEffect({
      ...auth(reschedule.effectId, tokens.get(reschedule.effectId)!),
      lastError: { code: 'REMOTE_UNKNOWN', message: 'Remote status remains unknown' },
    });
    assert.equal(rescheduled.applied && rescheduled.disposition, 'RESCHEDULED');
    const escalated = await adapterRepo.escalateReconcileEffect({
      ...auth(escalate.effectId, tokens.get(escalate.effectId)!),
      reason: 'RECONCILE_QUERY_UNSUPPORTED',
      evidence: terminalEvidence(escalate, 'COMPLETION_UNKNOWN'),
    });
    assert.equal(escalated.applied && escalated.disposition, 'ESCALATED');

    const durableStates = await ownerPool.query<{
      id: string;
      state: string;
      reconcile_disposition: string;
    }>(
      `SELECT id, state, reconcile_disposition FROM commander_effects
        WHERE id = ANY($1::text[])`,
      [[complete.effectId, confirm.effectId, reschedule.effectId, escalate.effectId]],
    );
    assert.deepEqual(
      Object.fromEntries(
        durableStates.rows.map((row) => [row.id, [row.state, row.reconcile_disposition]]),
      ),
      {
        [complete.effectId]: ['COMPLETED', 'CONFIRMED_APPLIED'],
        [confirm.effectId]: ['CONFIRMED_NOT_APPLIED', 'CONFIRMED_NOT_APPLIED'],
        [reschedule.effectId]: ['COMPLETION_UNKNOWN', 'PENDING'],
        [escalate.effectId]: ['COMPLETION_UNKNOWN', 'ESCALATED'],
      },
    );

    const negativeToken = tokens.get(authNegative.effectId)!;
    const negativeAuth = auth(authNegative.effectId, negativeToken);
    assert.deepEqual(
      await adapterRepo.completeReconcileEffect({
        ...negativeAuth,
        claimSecret: 'wrong-secret',
        response: {},
      }),
      { applied: false, reason: 'WORKER_FENCED' },
    );
    assert.deepEqual(
      await adapterRepo.completeReconcileEffect({
        ...negativeAuth,
        workerGeneration: adapterA.generation + 1,
        response: {},
      }),
      { applied: false, reason: 'WORKER_FENCED' },
    );
    assert.deepEqual(
      await adapterRepo.completeReconcileEffect({
        ...negativeAuth,
        claimToken: 'wrong-token',
        response: {},
      }),
      { applied: false, reason: 'CLAIM_NOT_OWNED' },
    );
    assert.deepEqual(
      await adapterRepo.completeReconcileEffect({
        ...negativeAuth,
        workerId: adapterIdB,
        workerGeneration: adapterB.generation,
        claimSecret: adapterB.claimSecret,
        response: {},
      }),
      { applied: false, reason: 'CLAIM_NOT_OWNED' },
    );

    await ownerPool.query(
      `UPDATE commander_effects SET reconcile_claim_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1 AND tenant_id=$2`,
      [expired.effectId, tenantA],
    );
    assert.deepEqual(
      await adapterRepo.completeReconcileEffect({
        ...auth(expired.effectId, tokens.get(expired.effectId)!),
        response: {},
      }),
      { applied: false, reason: 'CLAIM_EXPIRED' },
    );
    assert.deepEqual(
      await adapterRepo.completeReconcileEffect({
        tenantId: tenantB,
        effectId: crossTenant.effectId,
        workerId: adapterIdA,
        workerGeneration: adapterA.generation,
        claimSecret: adapterA.claimSecret,
        claimToken: 'concealed-token',
        response: {},
      }),
      { applied: false, reason: 'NOT_FOUND' },
    );

    const eventActors = await ownerPool.query<{ aggregate_id: string; actor: string }>(
      `SELECT aggregate_id, actor FROM commander_events
        WHERE aggregate_id = ANY($1::text[])
          AND type IN ('effect.reconciled_completed','effect.confirmed_not_applied',
            'effect.reconcile_rescheduled','effect.reconcile_escalated')`,
      [[complete.effectId, confirm.effectId, reschedule.effectId, escalate.effectId]],
    );
    assert.equal(eventActors.rowCount, 4);
    assert.equal(
      eventActors.rows.every((row) => row.actor === adapterIdA),
      true,
    );
  });

  it('reveals reconciliation evidence context only to the exact unexpired claim', async () => {
    const first = await park('evidence-context-first');
    const second = await park('evidence-context-second');
    const crossTenant = await park('evidence-context-cross-tenant', tenantB);
    const claims = await claimAll();
    const tokens = new Map(claims.map((claim) => [claim.effect.id, claim.claimToken]));
    const firstToken = tokens.get(first.effectId);
    const secondToken = tokens.get(second.effectId);
    assert.ok(firstToken);
    assert.ok(secondToken);

    const context = await adapterRepo.getAdapterOpsEvidenceContext(
      evidenceAuth({
        runId: first.step.runId,
        effectId: first.effectId,
        claimToken: firstToken,
      }),
    );
    assert.equal(context.effect.id, first.effectId);
    assert.equal(context.effect.runId, first.step.runId);
    assert.equal(context.effect.tenantId, tenantA);

    await assert.rejects(
      adapterRepo.getAdapterOpsEvidenceContext(
        evidenceAuth({
          runId: first.step.runId,
          effectId: first.effectId,
          claimToken: '',
        }),
      ),
      /ADAPTER_OPS_EVIDENCE_CONTEXT_INVALID/,
    );
    await assert.rejects(
      adapterRepo.getAdapterOpsEvidenceContext(
        evidenceAuth({
          runId: first.step.runId,
          effectId: first.effectId,
          claimToken: 'wrong-token',
        }),
      ),
      /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
    );
    await assert.rejects(
      adapterRepo.getAdapterOpsEvidenceContext(
        evidenceAuth({
          runId: first.step.runId,
          effectId: second.effectId,
          claimToken: firstToken,
        }),
      ),
      /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
    );
    await assert.rejects(
      adapterRepo.getAdapterOpsEvidenceContext(
        evidenceAuth({
          runId: second.step.runId,
          effectId: first.effectId,
          claimToken: firstToken,
        }),
      ),
      /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
    );
    await assert.rejects(
      adapterRepo.getAdapterOpsEvidenceContext(
        evidenceAuth({
          tenantId: tenantB,
          runId: crossTenant.step.runId,
          effectId: crossTenant.effectId,
          claimToken: firstToken,
        }),
      ),
      /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
    );

    await ownerPool.query(
      `UPDATE commander_effects
          SET reconcile_claim_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1 AND tenant_id=$2`,
      [first.effectId, tenantA],
    );
    await assert.rejects(
      adapterRepo.getAdapterOpsEvidenceContext(
        evidenceAuth({
          runId: first.step.runId,
          effectId: first.effectId,
          claimToken: firstToken,
        }),
      ),
      /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
    );
  });

  it('denies reconciliation RPCs to other roles and adapter-ops direct table access', async () => {
    await assert.rejects(
      () =>
        appPool.query(`SELECT complete_reconcile_effect($1,$2,$3,$4,$5,$6,'{}'::jsonb)`, [
          tenantA,
          'missing',
          adapterIdA,
          adapterA.generation,
          adapterA.claimSecret,
          'token',
        ]),
      /permission denied/i,
    );
    await assert.rejects(
      () =>
        adapterPool.query(
          `SELECT park_effect_completion_unknown_v1($1,$2,'{}'::jsonb,$3,$4,$5,$6,1,NULL)`,
          [tenantA, 'missing', workerId, worker.generation, worker.claimSecret, 'token'],
        ),
      /permission denied/i,
    );
    await assert.rejects(
      () => adapterPool.query('SELECT id FROM commander_effects LIMIT 1'),
      /permission denied/i,
    );
    await assert.rejects(
      () => adapterPool.query(`UPDATE commander_effects SET reconcile_attempts=0`),
      /permission denied/i,
    );
  });

  it('reports the adapter-ops evidence authority unavailable when its PostgreSQL RPC is absent', async () => {
    assert.deepEqual(await adapterRepo.checkEvidenceRepositoryAvailability(), { ready: true });
    await ownerPool.query(
      'DROP FUNCTION public.read_adapter_ops_evidence_context(text,bigint,text,text,text,text,text)',
    );
    assert.deepEqual(await adapterRepo.checkEvidenceRepositoryAvailability(), { ready: false });
  });
});
