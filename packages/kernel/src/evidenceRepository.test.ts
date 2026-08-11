import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import { SqliteKernelRepository } from './sqlite.js';
import {
  buildEffectScopedEvidenceRecord,
  createEvidenceSigner,
  type TerminalEvidenceRecord,
} from '@commander/effect-broker';

const binding = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  effectId: 'effect-1',
  actionDigest: 'a'.repeat(64),
};

const record: TerminalEvidenceRecord = {
  ...binding,
  bundleId: 'evidence_effect-1',
  receipt: {
    schemaVersion: 'l3-11.v0',
    bodyVersion: 'commander.evidence-body/v1',
    bundleId: 'evidence_effect-1',
    exportedAt: '2026-08-11T00:00:01.000Z',
    actionDigest: binding.actionDigest,
    terminalDisposition: 'SUCCEEDED',
    scope: { tenantId: binding.tenantId, runId: binding.runId, effectId: binding.effectId },
    identity: {},
    versions: { policySnapshotId: 'policy-1' },
    effects: [],
    auditEvents: [],
    contentHash: 'b'.repeat(64),
    signature: {
      algorithm: 'Ed25519',
      keyId: 'key-1',
      signedAt: '2026-08-11T00:00:01.000Z',
      value: 'signature',
    },
  },
  anchoredAt: '2026-08-11T00:00:01.000Z',
  retentionUntil: '2027-08-11T00:00:01.000Z',
};

describe('effect-scoped evidence persistence', () => {
  it('requires tenant, run, effect, and action digest for exact lookup', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.appendEvidence(record);

    assert.deepEqual(await repository.getEvidence(binding), record);
    assert.equal(await repository.getEvidence({ ...binding, tenantId: 'tenant-2' }), null);
    assert.equal(await repository.getEvidence({ ...binding, runId: 'run-2' }), null);
    assert.equal(await repository.getEvidence({ ...binding, effectId: 'effect-2' }), null);
    assert.equal(await repository.getEvidence({ ...binding, actionDigest: 'c'.repeat(64) }), null);
  });

  it('rejects a receipt whose indexed binding disagrees with its signed scope', async () => {
    const repository = new InMemoryKernelRepository();
    await assert.rejects(
      repository.appendEvidence({
        ...record,
        receipt: { ...record.receipt, scope: { ...record.receipt.scope, effectId: 'other' } },
      }),
      /EVIDENCE_RECORD_BINDING_INVALID/,
    );
    assert.equal(await repository.getEvidence(binding), null);
  });

  it('commits effect completion and its anchored receipt in one SQLite transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commander-evidence-'));
    const repository = new SqliteKernelRepository({
      path: join(dir, 'kernel.sqlite'),
      schedulerMode: false,
    });
    await repository.initialize();
    try {
      await repository.createRun(
        {
          id: binding.runId,
          tenantId: binding.tenantId,
          intentHash: 'intent-1',
          workGraphHash: 'graph-1',
          workGraphVersion: 'v1',
          policySnapshotId: 'policy-1',
          steps: [{ id: 'step-1', kind: 'tool' }],
        },
        'gateway',
      );
      const claimSecret = repository.seedTestWorker('worker-1', [binding.tenantId], 1);
      const claimed = await repository.claimNextStep({
        workerId: 'worker-1',
        workerGeneration: 1,
        claimSecret,
        leaseTtlMs: 60_000,
        capabilities: ['tool'],
      });
      assert.ok(claimed?.lease);
      const admitted = await repository.admitEffect({
        id: binding.effectId,
        runId: binding.runId,
        stepId: claimed.id,
        tenantId: binding.tenantId,
        type: 'connector.kubernetes.deployment.rollback',
        idempotencyKey: 'evidence-atomicity',
        policyDecisionId: 'decision-1',
        policySnapshotId: 'policy-1',
        actionDigest: binding.actionDigest,
        request: { revision: 'v2' },
        lease: claimed.lease,
        actor: 'worker-1',
      });
      assert.equal(admitted.admitted, true);
      if (!admitted.admitted) return;

      const { privateKey } = generateKeyPairSync('ed25519');
      const signer = createEvidenceSigner({
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        keyId: 'sqlite-atomic-key',
      });
      const evidence = await buildEffectScopedEvidenceRecord({
        effect: admitted.effect,
        projectedState: 'COMPLETED',
        response: { status: 'ok' },
        auditEvents: [],
        terminalEvent: { type: 'effect.completed', severity: 'low', details: {} },
        signer,
        recordedAt: '2026-08-11T00:00:01.000Z',
        retentionUntil: '2027-08-11T00:00:01.000Z',
      });

      await assert.rejects(
        repository.completeEffectWithEvidence(
          binding.effectId,
          binding.tenantId,
          claimed.lease,
          { status: 'ok' },
          'worker-1',
          { ...evidence, actionDigest: 'f'.repeat(64) },
        ),
        /EVIDENCE_RECORD_BINDING_INVALID/,
      );
      assert.equal(
        (await repository.getEffect(binding.effectId, binding.tenantId))?.state,
        'ADMITTED',
      );
      assert.equal(await repository.getEvidence(binding), null);

      assert.equal(
        (
          await repository.completeEffectWithEvidence(
            binding.effectId,
            binding.tenantId,
            claimed.lease,
            { status: 'ok' },
            'worker-1',
            evidence,
          )
        )?.state,
        'COMPLETED',
      );
      assert.deepEqual(await repository.getEvidence(binding), evidence);
    } finally {
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('commits reconcile escalation and its anchored receipt in one SQLite transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commander-escalation-evidence-'));
    const repository = new SqliteKernelRepository({
      path: join(dir, 'kernel.sqlite'),
      schedulerMode: false,
    });
    await repository.initialize();
    try {
      await repository.createRun(
        {
          id: 'run-escalated',
          tenantId: binding.tenantId,
          intentHash: 'intent-escalated',
          workGraphHash: 'graph-escalated',
          workGraphVersion: 'v1',
          policySnapshotId: 'policy-1',
          steps: [{ id: 'step-escalated', kind: 'tool' }],
        },
        'gateway',
      );
      const claimSecret = repository.seedTestWorker('worker-1', [binding.tenantId], 1);
      const claimedStep = await repository.claimNextStep({
        workerId: 'worker-1',
        workerGeneration: 1,
        claimSecret,
        leaseTtlMs: 60_000,
        capabilities: ['tool'],
      });
      assert.ok(claimedStep?.lease);
      const admitted = await repository.admitEffect({
        id: 'effect-escalated',
        runId: 'run-escalated',
        stepId: claimedStep.id,
        tenantId: binding.tenantId,
        type: 'connector.unknown.effect',
        idempotencyKey: 'evidence-escalation-atomicity',
        policyDecisionId: 'decision-1',
        policySnapshotId: 'policy-1',
        actionDigest: binding.actionDigest,
        request: {},
        lease: claimedStep.lease,
        actor: 'worker-1',
      });
      assert.equal(admitted.admitted, true);
      await repository.markEffectCompletionUnknown({
        effectId: 'effect-escalated',
        tenantId: binding.tenantId,
        reason: 'remote outcome unknown',
        actor: 'worker-1',
      });
      const [claimedEffect] = await repository.claimReconcileEffects({
        limit: 1,
        now: new Date(Date.now() + 1_000),
        workerId: 'worker-1',
        workerGeneration: 1,
        claimSecret,
      });
      assert.ok(claimedEffect);

      const { privateKey } = generateKeyPairSync('ed25519');
      const signer = createEvidenceSigner({
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        keyId: 'sqlite-escalation-key',
      });
      const evidence = await buildEffectScopedEvidenceRecord({
        effect: claimedEffect.effect,
        projectedState: 'COMPLETION_UNKNOWN',
        response: { errorCode: 'REMOTE_OUTCOME_UNKNOWN' },
        auditEvents: [],
        terminalEvent: {
          type: 'effect.reconcile_escalated',
          severity: 'high',
          details: { reason: 'unregistered_adapter' },
        },
        signer,
        recordedAt: '2026-08-11T00:00:02.000Z',
        retentionUntil: '2027-08-11T00:00:02.000Z',
      });
      const lookup = {
        tenantId: binding.tenantId,
        runId: 'run-escalated',
        effectId: 'effect-escalated',
        actionDigest: binding.actionDigest,
      };
      const escalation = {
        effectId: 'effect-escalated',
        tenantId: binding.tenantId,
        claimToken: claimedEffect.claimToken,
        reason: 'unregistered_adapter',
      };

      await assert.rejects(
        repository.escalateReconcileWithEvidence(escalation, {
          ...evidence,
          actionDigest: 'f'.repeat(64),
        }),
        /EVIDENCE_RECORD_BINDING_INVALID/,
      );
      assert.equal(
        (await repository.getEffect('effect-escalated', binding.tenantId))?.reconcileEscalatedAt,
        null,
      );
      assert.equal(await repository.getEvidence(lookup), null);

      assert.equal(await repository.escalateReconcileWithEvidence(escalation, evidence), true);
      assert.ok(
        (await repository.getEffect('effect-escalated', binding.tenantId))?.reconcileEscalatedAt,
      );
      assert.deepEqual(await repository.getEvidence(lookup), evidence);
    } finally {
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
