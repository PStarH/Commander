import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import type { KernelEvidenceRecord } from './evidenceRepository.js';
import { SqliteKernelRepository } from './sqlite.js';
import { SQLITE_KERNEL_SCHEMA_VERSION } from './sqliteSchema.js';

const PREVIOUS_SCHEMA_VERSION = '2026-07-23.17';

const LEGACY_17_SCHEMA_SQL = `
CREATE TABLE commander_kernel_schema (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE commander_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  work_graph_hash TEXT NOT NULL,
  work_graph_version TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paused_at TEXT,
  terminal_at TEXT,
  UNIQUE (id, tenant_id)
);
CREATE TABLE commander_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','WAITING_FOR_HUMAN','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED','SKIPPED')),
  version INTEGER NOT NULL DEFAULT 1,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  dependencies TEXT NOT NULL DEFAULT '[]',
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT,
  error TEXT,
  scheduled_at TEXT NOT NULL,
  lease_worker_id TEXT,
  lease_worker_generation INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  fencing_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (run_id, tenant_id) REFERENCES commander_runs(id, tenant_id)
);
CREATE TABLE commander_effects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES commander_steps(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  policy_decision_id TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  lease_worker_id TEXT NOT NULL,
  lease_worker_generation INTEGER NOT NULL DEFAULT 0,
  lease_fencing_epoch INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('ADMITTED','COMPLETION_UNKNOWN','COMPLETED','FAILED')),
  request TEXT NOT NULL DEFAULT '{}',
  response TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  reconcile_after TEXT,
  reconcile_claim_token TEXT,
  reconcile_claim_expires_at TEXT,
  reconcile_last_error TEXT,
  reconcile_escalated_at TEXT,
  UNIQUE (tenant_id, idempotency_key)
);
`;

function withTempDatabase<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'commander-sqlite-reconcile-'));
  return run(join(dir, 'kernel.sqlite')).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function terminalEvidence(
  runId: string,
  effectId: string,
  state: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN',
): KernelEvidenceRecord {
  const disposition =
    state === 'COMPLETED'
      ? 'SUCCEEDED'
      : state === 'CONFIRMED_NOT_APPLIED'
        ? 'FAILED'
        : 'ESCALATED';
  const bundleId = `evidence_${effectId}`;
  const contentHash = 'b'.repeat(64);
  const signature = {
    algorithm: 'Ed25519' as const,
    keyId: 'cell-test-1',
    signedAt: '2026-07-29T00:00:00.000Z',
    value: 'signature',
  };
  return {
    tenantId: 'tenant-a',
    runId,
    bundleId,
    actionDigest: 'a'.repeat(64),
    body: {
      bodyVersion: 'commander.evidence-body/v1',
      bundleId,
      actionDigest: 'a'.repeat(64),
      contentHash,
      terminalDisposition: disposition,
      scope: { tenantId: 'tenant-a', runId, effectId },
      effects: [{ effectId, state }],
      auditEvents: disposition === 'ESCALATED' ? [{ type: 'effect.reconcile_escalated' }] : [],
      signature,
    },
    contentHash,
    signature,
    createdAt: '2026-07-29T00:00:00.000Z',
    anchoredAt: '2026-07-29T00:00:00.000Z',
    retentionUntil: '2027-07-29T00:00:00.000Z',
  };
}

function seedLegacy17(path: string, attempts = 3): void {
  const db = new Database(path);
  try {
    db.exec(LEGACY_17_SCHEMA_SQL);
    db.prepare('INSERT INTO commander_kernel_schema (version) VALUES (?)').run(
      PREVIOUS_SCHEMA_VERSION,
    );
    db.prepare(
      `INSERT INTO commander_runs
         (id,tenant_id,intent_hash,work_graph_hash,work_graph_version,policy_snapshot_id,state,created_at,updated_at)
       VALUES ('run-legacy','tenant-a','intent','graph','v1','policy-v1','RUNNING',?,?)`,
    ).run('2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z');
    db.prepare(
      `INSERT INTO commander_steps
         (id,run_id,tenant_id,kind,state,lease_worker_id,lease_worker_generation,lease_token,
          fencing_epoch,lease_expires_at,scheduled_at,created_at,updated_at)
       VALUES ('step-legacy','run-legacy','tenant-a','agent','RUNNING','worker-old',4,'lease-old',
               9,'2026-07-25T00:00:00.000Z',?,?,?)`,
    ).run('2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z');
    db.prepare(
      `INSERT INTO commander_effects
         (id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,policy_decision_id,
          policy_snapshot_id,action_digest,lease_worker_id,lease_worker_generation,
          lease_fencing_epoch,state,request,response,created_at,reconcile_attempts,
          reconcile_after,reconcile_claim_token,reconcile_claim_expires_at,reconcile_last_error)
       VALUES ('effect-legacy','run-legacy','step-legacy','tenant-a','local.effect','idem-legacy',
               'request-hash','decision-v1','policy-v1','action-digest','worker-old',4,9,
               'COMPLETION_UNKNOWN','{"value":1}','{"completionUnknownReason":"timeout"}',?, ?, ?,
               'stale-claim','2026-07-25T00:00:00.000Z','{"code":"TIMEOUT","message":"unknown"}')`,
    ).run('2026-07-24T00:00:00.000Z', attempts, '2026-07-24T00:05:00.000Z');
  } finally {
    db.close();
  }
}

async function seedAdmittedEffect(path: string, id: string) {
  const repo = new SqliteKernelRepository({ path, schedulerMode: false });
  await repo.initialize();
  const now = new Date();
  const executeSecret = repo.seedTestWorker('worker-execute', ['tenant-a'], 1, {
    capabilities: ['agent', 'tool'],
  });
  const reconcileSecret = repo.seedTestWorker('worker-reconcile', ['tenant-a'], 1, {
    capabilities: ['effect.reconcile'],
    identitySubject: 'db:commander_adapter_ops',
    registeredAt: new Date(now.getTime() - 10_000),
    lastHeartbeatAt: new Date(now.getTime() - 1_000),
  });
  repo.seedTestWorker('worker-compensation', ['tenant-a'], 1, {
    capabilities: ['effect.compensate'],
    identitySubject: 'db:commander_adapter_ops',
    registeredAt: new Date(now.getTime() - 10_000),
    lastHeartbeatAt: new Date(now.getTime() - 1_000),
  });
  await repo.createRun(
    {
      id: `run-${id}`,
      tenantId: 'tenant-a',
      intentHash: 'intent',
      workGraphHash: 'graph',
      workGraphVersion: 'v1',
      policySnapshotId: 'policy-v1',
      steps: [{ id: `step-${id}`, kind: 'agent' }],
    },
    'gateway',
  );
  const step = await repo.claimNextStep({
    workerId: 'worker-execute',
    workerGeneration: 1,
    claimSecret: executeSecret,
    leaseTtlMs: 60_000,
    capabilities: ['agent'],
  });
  assert.ok(step?.lease);
  const admitted = await repo.admitEffect({
    id: `effect-${id}`,
    runId: step.runId,
    stepId: step.id,
    tenantId: step.tenantId,
    type: 'http.post',
    idempotencyKey: `idem-${id}`,
    policyDecisionId: 'decision-v1',
    policySnapshotId: 'policy-v1',
    actionDigest: 'a'.repeat(64),
    request: { value: id },
    lease: step.lease,
    actor: 'worker-execute',
  });
  assert.equal(admitted.admitted, true);
  return { repo, step, executeSecret, reconcileSecret };
}

async function parkAndClaim(path: string, id: string) {
  const seeded = await seedAdmittedEffect(path, id);
  const parked = await seeded.repo.parkEffectCompletionUnknown({
    tenantId: 'tenant-a',
    effectId: `effect-${id}`,
    workerId: 'worker-execute',
    workerGeneration: 1,
    claimSecret: seeded.executeSecret,
    leaseToken: seeded.step.lease!.token,
    fencingEpoch: seeded.step.lease!.fencingEpoch,
    error: { code: 'REMOTE_TIMEOUT', message: 'outcome unknown' },
    governedActionDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(parked.parked, true);
  if (!parked.parked) throw new Error('effect was not parked');
  assert.equal(parked.replayed, false);
  assert.equal(parked.effect.reconcileDisposition, 'PENDING');
  assert.deepEqual(
    parked.effect.reconcilePolicy && {
      maxAttempts: parked.effect.reconcilePolicy.maxAttempts,
      initialDelayMs: parked.effect.reconcilePolicy.initialDelayMs,
      maxDelayMs: parked.effect.reconcilePolicy.maxDelayMs,
    },
    { maxAttempts: 8, initialDelayMs: 30_000, maxDelayMs: 900_000 },
  );
  const claims = await seeded.repo.claimReconcileEffects({
    workerId: 'worker-reconcile',
    workerGeneration: 1,
    claimSecret: seeded.reconcileSecret,
    limit: 1,
    now: new Date(),
  });
  assert.equal(claims.length, 1);
  return { ...seeded, parked, claim: claims[0]! };
}

describe('SQLite reconciliation migration and file-backed parity', () => {
  it('atomically upgrades .17 files and fail-safe escalates legacy unknown rows', async () => {
    await withTempDatabase(async (path) => {
      seedLegacy17(path);
      const repo = new SqliteKernelRepository({ path });
      await repo.initialize();
      repo.close();

      const db = new Database(path, { readonly: true });
      try {
        const versions = db
          .prepare('SELECT version FROM commander_kernel_schema ORDER BY version')
          .all() as Array<{ version: string }>;
        assert.ok(versions.some(({ version }) => version === SQLITE_KERNEL_SCHEMA_VERSION));
        const effect = db
          .prepare('SELECT * FROM commander_effects WHERE id=?')
          .get('effect-legacy') as Record<string, unknown>;
        assert.equal(effect.state, 'COMPLETION_UNKNOWN');
        assert.equal(effect.reconcile_attempts, 3, 'migration must not reset attempts');
        assert.equal(effect.reconcile_max_attempts, 0);
        assert.equal(effect.reconcile_disposition, 'ESCALATED');
        assert.equal(effect.reconcile_escalation_code, 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED');
        assert.equal(effect.reconcile_claim_token, null);
        assert.equal(effect.request, '{"value":1}');
        assert.equal(effect.reconcile_last_error, '{"code":"TIMEOUT","message":"unknown"}');
        const step = db
          .prepare('SELECT state, lease_token FROM commander_steps WHERE id=?')
          .get('step-legacy') as { state: string; lease_token: string | null };
        assert.deepEqual(step, { state: 'WAITING_FOR_HUMAN', lease_token: null });
        assert.deepEqual(db.pragma('foreign_key_check'), []);
      } finally {
        db.close();
      }
    });
  });

  it('rolls back a failed .17 migration without stamping or partial DDL', async () => {
    await withTempDatabase(async (path) => {
      seedLegacy17(path, 9);
      const repo = new SqliteKernelRepository({ path });
      await assert.rejects(repo.initialize());
      repo.close();

      const db = new Database(path, { readonly: true });
      try {
        assert.deepEqual(db.prepare('SELECT version FROM commander_kernel_schema').pluck().all(), [
          PREVIOUS_SCHEMA_VERSION,
        ]);
        const columns = db.pragma('table_info(commander_effects)') as Array<{ name: string }>;
        assert.equal(
          columns.some(({ name }) => name === 'reconcile_max_attempts'),
          false,
        );
        assert.equal(
          db.prepare('SELECT reconcile_attempts FROM commander_effects').pluck().get(),
          9,
        );
        assert.equal(
          db
            .prepare("SELECT count(*) FROM sqlite_master WHERE name LIKE '%2026072317%'")
            .pluck()
            .get(),
          0,
        );
      } finally {
        db.close();
      }
    });
  });

  it('creates the .18 schema with database-enforced policy invariants', async () => {
    await withTempDatabase(async (path) => {
      const seeded = await seedAdmittedEffect(path, 'schema');
      seeded.repo.close();
      const db = new Database(path);
      try {
        const columns = db.pragma('table_info(commander_effects)') as Array<{ name: string }>;
        for (const name of [
          'reconcile_max_attempts',
          'reconcile_initial_delay_ms',
          'reconcile_max_delay_ms',
          'reconcile_deadline_at',
          'reconcile_disposition',
          'reconcile_claim_worker_generation',
          'reconcile_last_result',
        ]) {
          assert.ok(
            columns.some((column) => column.name === name),
            `missing ${name}`,
          );
        }
        await assert.rejects(async () =>
          db.prepare('UPDATE commander_effects SET reconcile_max_attempts=7').run(),
        );
        await assert.rejects(async () =>
          db.prepare('UPDATE commander_effects SET reconcile_initial_delay_ms=0').run(),
        );
        await assert.rejects(async () =>
          db.prepare("UPDATE commander_effects SET reconcile_deadline_at='not-a-date'").run(),
        );
      } finally {
        db.close();
      }
    });
  });

  it('persists park, expedite-only, claim, reschedule, and replay state across reopen', async () => {
    await withTempDatabase(async (path) => {
      const seeded = await parkAndClaim(path, 'restart');
      const rescheduled = await seeded.repo.rescheduleReconcileEffect({
        tenantId: 'tenant-a',
        effectId: 'effect-restart',
        workerId: 'worker-reconcile',
        workerGeneration: 1,
        claimSecret: seeded.reconcileSecret,
        claimToken: seeded.claim.claimToken,
        lastError: { category: 'TRANSIENT', code: 'QUERY_TIMEOUT', message: 'retry' },
      });
      assert.equal(rescheduled.applied, true);
      assert.equal(rescheduled.applied && rescheduled.disposition, 'RESCHEDULED');
      const before = await seeded.repo.getEffect('effect-restart', 'tenant-a');
      assert.ok(before?.reconcileAfter);
      seeded.repo.close();

      const reopened = new SqliteKernelRepository({ path, schedulerMode: false });
      await reopened.initialize();
      try {
        const persisted = await reopened.getEffect('effect-restart', 'tenant-a');
        assert.deepEqual(persisted?.reconcilePolicy, before.reconcilePolicy);
        assert.equal(persisted?.reconcileAttempts, 1);
        assert.deepEqual(persisted?.reconcileLastError, before.reconcileLastError);

        const replay = await reopened.rescheduleReconcileEffect({
          tenantId: 'tenant-a',
          effectId: 'effect-restart',
          workerId: 'worker-reconcile',
          workerGeneration: 1,
          claimSecret: seeded.reconcileSecret,
          claimToken: seeded.claim.claimToken,
          lastError: { category: 'TRANSIENT', code: 'QUERY_TIMEOUT', message: 'retry' },
        });
        assert.equal(replay.applied, true);
        assert.equal(replay.applied && replay.replayed, true);

        const expedited = await reopened.requestReconcile({
          effectId: 'effect-restart',
          tenantId: 'tenant-a',
          actor: 'api',
        });
        assert.equal(expedited.scheduled, true);
        const after = await reopened.getEffect('effect-restart', 'tenant-a');
        assert.equal(after?.reconcileAttempts, persisted?.reconcileAttempts);
        assert.deepEqual(after?.reconcilePolicy, persisted?.reconcilePolicy);
        assert.deepEqual(after?.reconcileLastError, persisted?.reconcileLastError);
        assert.equal(after?.reconcileDisposition, persisted?.reconcileDisposition);
        assert.equal(after?.reconcileClaimToken, persisted?.reconcileClaimToken);
        assert.ok(Date.parse(after!.reconcileAfter!) <= Date.parse(persisted!.reconcileAfter!));
      } finally {
        reopened.close();
      }
    });
  });

  for (const mutation of ['complete', 'not-applied', 'escalate'] as const) {
    it(`applies ${mutation} once and rejects a stale-token conflict`, async () => {
      await withTempDatabase(async (path) => {
        const seeded = await parkAndClaim(path, mutation);
        const auth = {
          tenantId: 'tenant-a',
          effectId: `effect-${mutation}`,
          workerId: 'worker-reconcile',
          workerGeneration: 1,
          claimSecret: seeded.reconcileSecret,
          claimToken: seeded.claim.claimToken,
        };
        const evidence = terminalEvidence(
          `run-${mutation}`,
          `effect-${mutation}`,
          mutation === 'complete'
            ? 'COMPLETED'
            : mutation === 'not-applied'
              ? 'CONFIRMED_NOT_APPLIED'
              : 'COMPLETION_UNKNOWN',
        );
        const result =
          mutation === 'complete'
            ? await seeded.repo.completeReconcileEffect({
                ...auth,
                response: { receipt: 'applied' },
                evidence,
              })
            : mutation === 'not-applied'
              ? await seeded.repo.confirmEffectNotApplied({
                  ...auth,
                  response: { receipt: 'negative-proof' },
                  evidence,
                })
              : await seeded.repo.escalateReconcileEffect({
                  ...auth,
                  reason: 'RECONCILE_QUERY_UNSUPPORTED',
                  evidence,
                });
        assert.equal(result.applied, true);
        assert.equal(result.applied && result.replayed, false);
        assert.deepEqual(await seeded.repo.getEvidence(`run-${mutation}`, 'tenant-a'), evidence);
        const effect = await seeded.repo.getEffect(`effect-${mutation}`, 'tenant-a');
        assert.equal(effect?.reconcileClaimToken, null);
        assert.equal(
          effect?.state,
          mutation === 'complete'
            ? 'COMPLETED'
            : mutation === 'not-applied'
              ? 'CONFIRMED_NOT_APPLIED'
              : 'COMPLETION_UNKNOWN',
        );
        assert.equal(
          effect?.reconcileDisposition,
          mutation === 'complete'
            ? 'CONFIRMED_APPLIED'
            : mutation === 'not-applied'
              ? 'CONFIRMED_NOT_APPLIED'
              : 'ESCALATED',
        );
        if (mutation !== 'escalate') {
          assert.equal(
            (await seeded.repo.getRun(`run-${mutation}`, 'tenant-a'))?.state,
            'RUNNING',
            'reconciliation must not directly terminalize a run without signed evidence',
          );
        }
        if (mutation === 'not-applied') {
          assert.deepEqual(effect?.response, { receipt: 'negative-proof' });
          assert.equal(effect?.reconcileAfter, null, 'terminal negative proof schedules no retry');
        }
        const conflict = await seeded.repo.rescheduleReconcileEffect({
          ...auth,
          lastError: { code: 'LATE', message: 'stale result' },
        });
        assert.deepEqual(conflict, { applied: false, reason: 'CLAIM_REPLAY_CONFLICT' });
        const events = await seeded.repo.listEvents(`run-${mutation}`, 'tenant-a');
        assert.equal(
          events.filter((event) =>
            [
              'effect.reconciled_completed',
              'effect.confirmed_not_applied',
              'effect.reconcile_escalated',
            ].includes(event.type),
          ).length,
          1,
        );
        seeded.repo.close();
      });
    });
  }

  it('rejects a terminal reconciliation mutation without signed evidence', async () => {
    await withTempDatabase(async (path) => {
      const seeded = await parkAndClaim(path, 'missing-evidence');
      try {
        const result = await seeded.repo.completeReconcileEffect({
          tenantId: 'tenant-a',
          effectId: 'effect-missing-evidence',
          workerId: 'worker-reconcile',
          workerGeneration: 1,
          claimSecret: seeded.reconcileSecret,
          claimToken: seeded.claim.claimToken,
          response: { receipt: 'applied' },
        });

        assert.deepEqual(result, { applied: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' });
        const effect = await seeded.repo.getEffect('effect-missing-evidence', 'tenant-a');
        assert.equal(effect?.state, 'COMPLETION_UNKNOWN');
        assert.equal(effect?.reconcileClaimToken, seeded.claim.claimToken);
        assert.equal(await seeded.repo.getEvidence('run-missing-evidence', 'tenant-a'), null);
      } finally {
        seeded.repo.close();
      }
    });
  });

  it('rejects an invalid governed deadline without partially parking the effect', async () => {
    await withTempDatabase(async (path) => {
      const seeded = await seedAdmittedEffect(path, 'invalid-deadline');
      try {
        await assert.rejects(
          seeded.repo.parkEffectCompletionUnknown({
            tenantId: 'tenant-a',
            effectId: 'effect-invalid-deadline',
            workerId: 'worker-execute',
            workerGeneration: 1,
            claimSecret: seeded.executeSecret,
            leaseToken: seeded.step.lease!.token,
            fencingEpoch: seeded.step.lease!.fencingEpoch,
            error: { code: 'REMOTE_TIMEOUT', message: 'outcome unknown' },
            governedActionDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
          }),
          /RECONCILE_DEADLINE_INVALID/,
        );
        assert.equal(
          (await seeded.repo.getEffect('effect-invalid-deadline', 'tenant-a'))?.state,
          'ADMITTED',
        );
      } finally {
        seeded.repo.close();
      }
    });
  });
});
