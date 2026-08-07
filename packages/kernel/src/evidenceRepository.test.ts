import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertEvidenceRecordBoundToEffect,
  InMemoryEvidenceRepository,
  type KernelEvidenceRecord,
} from './evidenceRepository.js';
import { SqliteKernelRepository } from './sqlite.js';
import { PostgresKernelRepository, type SqlClient, type SqlPool } from './postgres.js';
import {
  InMemoryKernelRepository,
  seedFreshOperationsDrains,
} from './testing/inMemoryRepository.js';
import type { KernelRepository } from './repository.js';

const record: KernelEvidenceRecord = {
  tenantId: 'tenant-a',
  runId: 'run-1',
  bundleId: 'bundle-1',
  actionDigest: 'a'.repeat(64),
  body: { bodyVersion: 'commander.evidence-body/v1' },
  contentHash: 'b'.repeat(64),
  signature: {
    algorithm: 'Ed25519',
    keyId: 'cell-test-1',
    signedAt: '2026-07-17T00:00:00.000Z',
    value: 'sig',
  },
  createdAt: '2026-07-17T00:00:00.000Z',
  anchoredAt: '2026-07-17T00:00:01.000Z',
  retentionUntil: '2027-07-17T00:00:00.000Z',
};

function terminalRecord(
  runId: string,
  bundleId: string,
  disposition: 'SUCCEEDED' | 'FAILED' | 'ESCALATED' = 'SUCCEEDED',
): KernelEvidenceRecord {
  const effectId = bundleId.replace(/^evidence_/, '');
  const effectState =
    disposition === 'SUCCEEDED'
      ? 'COMPLETED'
      : disposition === 'FAILED'
        ? 'FAILED'
        : 'COMPLETION_UNKNOWN';
  const actionDigest = 'a'.repeat(64);
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
    actionDigest,
    body: {
      bodyVersion: 'commander.evidence-body/v1',
      bundleId,
      actionDigest,
      contentHash,
      terminalDisposition: disposition,
      scope: { tenantId: 'tenant-a', runId, effectId },
      effects: [{ effectId, state: effectState }],
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

async function admitAtomicEffect(
  repository: KernelRepository,
  suffix: string,
  effectType = 'local.compute',
) {
  const runId = `run-atomic-${suffix}`;
  const stepId = `step-atomic-${suffix}`;
  const effectId = `effect-atomic-${suffix}`;
  await repository.createRun(
    {
      id: runId,
      tenantId: 'tenant-a',
      intentHash: 'intent',
      workGraphHash: 'graph',
      workGraphVersion: 'v1',
      policySnapshotId: 'policy-v1',
      steps: [{ id: stepId, kind: 'agent' }],
    },
    'gateway',
  );
  const claimed = await repository.claimNextStep({
    workerId: 'worker-1',
    workerGeneration: 1,
    tenantId: 'tenant-a',
    capabilities: ['agent'],
    leaseTtlMs: 60_000,
  });
  assert.ok(claimed?.lease);
  const admitted = await repository.admitEffect({
    id: effectId,
    runId,
    stepId,
    tenantId: 'tenant-a',
    type: effectType,
    idempotencyKey: `idem-${suffix}`,
    policyDecisionId: 'decision-1',
    policySnapshotId: 'policy-v1',
    actionDigest: 'a'.repeat(64),
    request: { target: suffix },
    lease: claimed.lease,
    actor: 'worker-1',
  });
  assert.equal(admitted.admitted, true);
  return { runId, stepId, effectId, lease: claimed.lease, stepVersion: claimed.version };
}

describe('standalone evidence repository contract', () => {
  it('stores once, replays identically, rejects mutation, and conceals tenants', async () => {
    const repository = new InMemoryEvidenceRepository();
    assert.deepEqual(await repository.appendEvidence(record), { inserted: true });
    assert.deepEqual(await repository.appendEvidence(structuredClone(record)), { inserted: false });
    await assert.rejects(
      repository.appendEvidence({ ...record, contentHash: 'c'.repeat(64) }),
      /EVIDENCE_CONFLICT/,
    );
    assert.deepEqual(await repository.getEvidence('run-1', 'tenant-a'), record);
    assert.equal(await repository.getEvidence('run-1', 'tenant-b'), null);
  });
});

describe('SQLite evidence repository integration', () => {
  it('persists append-only receipts and applies tenant-scoped reads', async () => {
    const repository = new SqliteKernelRepository({ path: ':memory:', allowMemory: true });
    await repository.initialize();
    await repository.createRun(
      {
        id: record.runId,
        tenantId: record.tenantId,
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-v1',
        steps: [],
      },
      'test',
    );

    assert.deepEqual(await repository.appendEvidence(record), { inserted: true });
    assert.deepEqual(await repository.appendEvidence(structuredClone(record)), { inserted: false });
    await assert.rejects(
      repository.appendEvidence({
        ...record,
        signature: { ...record.signature, value: 'changed' },
      }),
      /EVIDENCE_CONFLICT/,
    );
    assert.deepEqual(await repository.getEvidence(record.runId, record.tenantId), record);
    assert.equal(await repository.getEvidence(record.runId, 'tenant-b'), null);
    assert.deepEqual(await repository.listEvidence(record.tenantId), [record]);
    repository.close();
  });
});

describe('PostgreSQL evidence repository availability probe', () => {
  it('uses a global catalog read without requiring tenant scope on API repositories', async () => {
    const queries: string[] = [];
    const client: SqlClient = {
      async query<T>(sql: string) {
        queries.push(sql);
        if (sql.includes('session_user')) {
          return { rows: [{ login_role: 'commander_app' }] as T[], rowCount: 1 };
        }
        return { rows: [{ available: true }] as T[], rowCount: 1 };
      },
      release() {},
    };
    const pool: SqlPool = { connect: async () => client };
    const repository = new PostgresKernelRepository(pool);

    assert.deepEqual(await repository.checkEvidenceRepositoryAvailability?.(), { ready: true });
    assert.equal(
      queries.some((query) => query.includes('FROM public.commander_evidence_receipts')),
      true,
    );
    assert.equal(
      queries.some((query) => query.includes("set_config('app.tenant_scope'")),
      false,
    );
  });
});

describe('atomic terminal evidence authority', () => {
  it('atomically persists reconciliation evidence in memory', async () => {
    const repository = new InMemoryKernelRepository();
    seedFreshOperationsDrains(repository, 'tenant-a');
    const reconcileSecret = repository.seedTestWorker(
      'worker-reconcile-evidence',
      ['tenant-a'],
      1,
      {
        capabilities: ['effect.reconcile'],
        identitySubject: 'db:commander_adapter_ops',
      },
    );
    const admitted = await admitAtomicEffect(repository, 'reconcile-evidence', 'http.post');
    await repository.markEffectCompletionUnknown({
      effectId: admitted.effectId,
      tenantId: 'tenant-a',
      reason: 'REMOTE_TIMEOUT',
      actor: 'worker-1',
      lease: admitted.lease,
    });
    const claims = await repository.claimReconcileEffects({
      limit: 1,
      workerId: 'worker-reconcile-evidence',
      workerGeneration: 1,
      claimSecret: reconcileSecret,
    });
    assert.equal(claims.length, 1);
    const evidence = terminalRecord(admitted.runId, `evidence_${admitted.effectId}`);

    const completed = await repository.completeReconcileEffect({
      tenantId: 'tenant-a',
      effectId: admitted.effectId,
      workerId: 'worker-reconcile-evidence',
      workerGeneration: 1,
      claimSecret: reconcileSecret,
      claimToken: claims[0]!.claimToken,
      response: { status: 'ok' },
      evidence,
    });

    assert.equal(completed.applied, true);
    assert.deepEqual(await repository.getEvidence(admitted.runId, 'tenant-a'), evidence);
    assert.equal((await repository.getEffect(admitted.effectId, 'tenant-a'))?.state, 'COMPLETED');
  });

  it('leaves an in-memory reconciliation claim untouched when evidence is missing', async () => {
    const repository = new InMemoryKernelRepository();
    seedFreshOperationsDrains(repository, 'tenant-a');
    const reconcileSecret = repository.seedTestWorker('worker-reconcile-missing', ['tenant-a'], 1, {
      capabilities: ['effect.reconcile'],
      identitySubject: 'db:commander_adapter_ops',
    });
    const admitted = await admitAtomicEffect(repository, 'reconcile-missing', 'http.post');
    await repository.markEffectCompletionUnknown({
      effectId: admitted.effectId,
      tenantId: 'tenant-a',
      reason: 'REMOTE_TIMEOUT',
      actor: 'worker-1',
      lease: admitted.lease,
    });
    const claims = await repository.claimReconcileEffects({
      limit: 1,
      workerId: 'worker-reconcile-missing',
      workerGeneration: 1,
      claimSecret: reconcileSecret,
    });
    assert.equal(claims.length, 1);

    const result = await repository.completeReconcileEffect({
      tenantId: 'tenant-a',
      effectId: admitted.effectId,
      workerId: 'worker-reconcile-missing',
      workerGeneration: 1,
      claimSecret: reconcileSecret,
      claimToken: claims[0]!.claimToken,
      response: { status: 'ok' },
    });

    assert.deepEqual(result, { applied: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' });
    const effect = await repository.getEffect(admitted.effectId, 'tenant-a');
    assert.equal(effect?.state, 'COMPLETION_UNKNOWN');
    assert.equal(effect?.reconcileClaimToken, claims[0]!.claimToken);
    assert.equal(await repository.getEvidence(admitted.runId, 'tenant-a'), null);
  });

  it('does not succeed a consequential run until its effect has a receipt', async () => {
    const repository = new InMemoryKernelRepository();
    seedFreshOperationsDrains(repository, 'tenant-a');
    const admitted = await admitAtomicEffect(repository, 'success-gate', 'http.post');

    await repository.completeEffect(
      admitted.effectId,
      'tenant-a',
      admitted.lease,
      { status: 'ok' },
      'worker-1',
    );
    await repository.completeStep({
      stepId: admitted.stepId,
      tenantId: 'tenant-a',
      expectedVersion: admitted.stepVersion,
      lease: admitted.lease,
      output: { status: 'ok' },
      actor: 'worker-1',
    });

    assert.equal((await repository.getRun(admitted.runId, 'tenant-a'))?.state, 'RUNNING');
  });

  for (const kind of ['memory', 'sqlite'] as const) {
    it(`${kind} does not fail a consequential run until its failed effect has a receipt`, async () => {
      const repository =
        kind === 'memory'
          ? new InMemoryKernelRepository()
          : new SqliteKernelRepository({ path: ':memory:', allowMemory: true });
      if (repository instanceof SqliteKernelRepository) {
        await repository.initialize();
        repository.seedTestWorker('worker-1', ['tenant-a'], 1);
        const at = new Date();
        repository.seedTestWorker('reconcile:tenant-a', ['tenant-a'], 1, {
          capabilities: ['effect.reconcile'],
          identitySubject: 'db:commander_adapter_ops',
          registeredAt: new Date(at.getTime() - 10_000),
          lastHeartbeatAt: new Date(at.getTime() - 1_000),
        });
        repository.seedTestWorker('compensation:tenant-a', ['tenant-a'], 1, {
          capabilities: ['effect.compensate'],
          identitySubject: 'db:commander_adapter_ops',
          registeredAt: new Date(at.getTime() - 10_000),
          lastHeartbeatAt: new Date(at.getTime() - 1_000),
        });
      } else {
        seedFreshOperationsDrains(repository, 'tenant-a');
      }
      const admitted = await admitAtomicEffect(repository, `failed-gate-${kind}`, 'http.post');
      await repository.failEffect({
        effectId: admitted.effectId,
        tenantId: 'tenant-a',
        lease: admitted.lease,
        error: { code: 'REMOTE_REJECTED', message: 'not committed', retryable: false },
        actor: 'worker-1',
      });
      await repository.failStep({
        stepId: admitted.stepId,
        tenantId: 'tenant-a',
        expectedVersion: admitted.stepVersion,
        lease: admitted.lease,
        error: { code: 'REMOTE_REJECTED', message: 'not committed', retryable: false },
        actor: 'worker-1',
      });

      assert.equal((await repository.getRun(admitted.runId, 'tenant-a'))?.state, 'RUNNING');
      if (repository instanceof SqliteKernelRepository) repository.close();
    });
  }

  it('rejects a receipt whose disposition does not match the kernel effect truth', () => {
    const evidence = terminalRecord('run-disposition', 'evidence_effect-disposition');
    assert.throws(
      () =>
        assertEvidenceRecordBoundToEffect(evidence, {
          id: 'effect-disposition',
          tenantId: 'tenant-a',
          runId: 'run-disposition',
          actionDigest: 'a'.repeat(64),
          state: 'FAILED',
        }),
      /EVIDENCE_RECORD_BINDING_INVALID:disposition,body_effect_state/,
    );
  });

  it('succeeds a consequential run after atomic effect and receipt completion', async () => {
    const repository = new InMemoryKernelRepository();
    seedFreshOperationsDrains(repository, 'tenant-a');
    const admitted = await admitAtomicEffect(repository, 'success-receipt', 'http.post');
    const evidence = terminalRecord(admitted.runId, `evidence_${admitted.effectId}`);

    await repository.completeEffectWithEvidence(
      admitted.effectId,
      'tenant-a',
      admitted.lease,
      { status: 'ok' },
      'worker-1',
      evidence,
    );
    await repository.completeStep({
      stepId: admitted.stepId,
      tenantId: 'tenant-a',
      expectedVersion: admitted.stepVersion,
      lease: admitted.lease,
      output: { status: 'ok' },
      actor: 'worker-1',
    });

    assert.equal((await repository.getRun(admitted.runId, 'tenant-a'))?.state, 'SUCCEEDED');
  });

  it('commits the effect and its receipt together in memory', async () => {
    const repository = new InMemoryKernelRepository();
    const admitted = await admitAtomicEffect(repository, 'memory');
    const evidence = terminalRecord(admitted.runId, `evidence_${admitted.effectId}`);

    const completed = await repository.completeEffectWithEvidence(
      admitted.effectId,
      'tenant-a',
      admitted.lease,
      { status: 'ok' },
      'worker-1',
      evidence,
    );

    assert.equal(completed?.state, 'COMPLETED');
    assert.deepEqual(await repository.getEvidence(admitted.runId, 'tenant-a'), evidence);
  });

  it('rolls back SQLite effect completion when the immutable receipt conflicts', async () => {
    const repository = new SqliteKernelRepository({ path: ':memory:', allowMemory: true });
    await repository.initialize();
    repository.seedTestWorker('worker-1', ['tenant-a'], 1);
    const admitted = await admitAtomicEffect(repository, 'sqlite-conflict');
    const evidence = terminalRecord(admitted.runId, `evidence_${admitted.effectId}`);
    const conflicting = structuredClone(evidence);
    conflicting.contentHash = 'c'.repeat(64);
    (conflicting.body as { contentHash: string }).contentHash = conflicting.contentHash;
    await repository.appendEvidence(conflicting);

    await assert.rejects(
      repository.completeEffectWithEvidence(
        admitted.effectId,
        'tenant-a',
        admitted.lease,
        { status: 'ok' },
        'worker-1',
        evidence,
      ),
      /EVIDENCE_CONFLICT/,
    );
    assert.equal((await repository.getEffect(admitted.effectId, 'tenant-a'))?.state, 'ADMITTED');
    assert.deepEqual(await repository.getEvidence(admitted.runId, 'tenant-a'), conflicting);
    repository.close();
  });
});
