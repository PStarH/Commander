import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEvidenceSigner, verifyEvidenceSignature } from './evidenceSigner.js';
import { EffectBroker, canonicalRequestHash } from './index.js';
import { canonicalEvidenceBody, verifySignedEvidenceBundle } from './signedEvidence.js';
import { buildEffectScopedEvidenceRecord } from './terminalEvidence.js';
import type { TerminalEvidenceRecord } from './terminalEvidence.js';

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createEvidenceSigner({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'producer-test-key',
  });
}

const effect = {
  id: 'effect-1',
  runId: 'run-1',
  stepId: 'step-1',
  tenantId: 'tenant-1',
  type: 'connector.kubernetes.deployment.rollback',
  state: 'ADMITTED',
  policyDecisionId: 'decision-1',
  policySnapshotId: 'policy-1',
  actionDigest: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
  createdAt: '2026-08-11T00:00:00.000Z',
};

describe('effect-scoped terminal evidence producer', () => {
  it('builds a signed completed receipt bound to one effect', async () => {
    const evidenceSigner = signer();
    const record = await buildEffectScopedEvidenceRecord({
      effect,
      projectedState: 'COMPLETED',
      response: { status: 'ok' },
      auditEvents: [],
      terminalEvent: {
        type: 'compensation.completed',
        severity: 'low',
        details: { disposition: 'COMPLETED' },
      },
      signer: evidenceSigner,
      recordedAt: '2026-08-11T00:00:01.000Z',
      retentionUntil: '2027-08-11T00:00:01.000Z',
    });

    assert.equal(record.effectId, effect.id);
    assert.equal(record.actionDigest, effect.actionDigest);
    assert.equal(record.receipt.scope.effectId, effect.id);
    assert.equal(record.receipt.bodyVersion, 'commander.evidence-body/v1');
    assert.equal(record.receipt.terminalDisposition, 'SUCCEEDED');
    assert.equal(verifySignedEvidenceBundle(record.receipt).ok, true);
    assert.equal(
      verifyEvidenceSignature(
        canonicalEvidenceBody(record.receipt),
        record.receipt.signature,
        evidenceSigner.jwks,
      ),
      true,
    );
  });

  it('builds a verifiable ESCALATED receipt for irreducible unknown', async () => {
    const evidenceSigner = signer();
    const record = await buildEffectScopedEvidenceRecord({
      effect: { ...effect, id: 'effect-unknown', state: 'COMPLETION_UNKNOWN' },
      projectedState: 'COMPLETION_UNKNOWN',
      response: { errorCode: 'REMOTE_OUTCOME_UNKNOWN' },
      auditEvents: [],
      terminalEvent: {
        type: 'effect.reconcile_escalated',
        severity: 'high',
        details: { disposition: 'ESCALATED' },
      },
      signer: evidenceSigner,
      recordedAt: '2026-08-11T00:00:02.000Z',
      retentionUntil: '2027-08-11T00:00:02.000Z',
    });

    assert.equal(record.receipt.scope.effectId, 'effect-unknown');
    assert.equal(record.receipt.terminalDisposition, 'ESCALATED');
    assert.equal(verifySignedEvidenceBundle(record.receipt).ok, true);
    assert.equal(
      verifyEvidenceSignature(
        canonicalEvidenceBody(record.receipt),
        record.receipt.signature,
        evidenceSigner.jwks,
      ),
      true,
    );
  });

  it('atomically completes a broker effect with its signed receipt', async () => {
    const evidenceSigner = signer();
    let persisted: TerminalEvidenceRecord | undefined;
    let legacyCompletionCalled = false;
    const request = { status: 'requested' };
    const broker = new EffectBroker(
      {
        verify: async () => ({
          jti: 'grant-1',
          tenantId: 'tenant-1',
          runId: 'run-1',
          stepId: 'step-1',
          audience: 'commander.effect-broker',
          effectTypes: ['connector.kubernetes.deployment.rollback'],
          expiresAt: '2099-01-01T00:00:00.000Z',
          policySnapshotId: 'policy-1',
          requestHash: canonicalRequestHash(request),
          actionDigest: 'a'.repeat(64),
          workerId: 'worker-1',
          workerGeneration: 1,
        }),
      },
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'decision-1',
          reason: 'allowed',
          policySnapshotId: 'policy-1',
        }),
      },
      {
        admitEffect: async () => ({
          admitted: true,
          effect: { id: 'effect-1', state: 'ADMITTED' },
        }),
        completeEffect: async () => {
          legacyCompletionCalled = true;
          return {};
        },
        completeEffectWithEvidence: async (
          _effectId,
          _tenantId,
          _lease,
          _response,
          _actor,
          evidence,
        ) => {
          persisted = evidence;
          return {};
        },
      },
      { execute: async () => ({ status: 'ok' }) },
      { append: async () => {} },
      { evidenceSigner, evidenceRetentionMs: 365 * 24 * 60 * 60 * 1_000 },
    );

    await broker.execute({
      effectId: 'effect-1',
      token: 'verified-by-test-port',
      type: 'connector.kubernetes.deployment.rollback',
      request,
      idempotencyKey: 'idem-1',
      lease: {
        workerId: 'worker-1',
        workerGeneration: 1,
        token: 'lease-1',
        fencingEpoch: 1,
      },
      actor: 'worker-1',
    });

    assert.equal(legacyCompletionCalled, false);
    assert.equal(persisted?.receipt.scope.effectId, 'effect-1');
    assert.equal(persisted?.receipt.actionDigest, 'a'.repeat(64));
    assert.equal(
      verifyEvidenceSignature(
        canonicalEvidenceBody(persisted!.receipt),
        persisted!.receipt.signature,
        evidenceSigner.jwks,
      ),
      true,
    );
  });
});
