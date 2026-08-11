import type { EvidenceAuditSource, EvidenceEffectSource } from './evidenceBundle.js';
import type { EvidenceSigner } from './signedEvidence.js';
import {
  assertTerminalEvidence,
  buildSignedEvidenceBundle,
  canonicalEvidenceBody,
  type EvidenceSignature,
  type SignedEvidenceBundle,
} from './signedEvidence.js';

export type SignedTerminalEvidenceReceipt = SignedEvidenceBundle & {
  signature: EvidenceSignature;
};

export interface TerminalEvidenceRecord {
  tenantId: string;
  runId: string;
  effectId: string;
  bundleId: string;
  actionDigest: string;
  receipt: SignedTerminalEvidenceReceipt;
  anchoredAt: string;
  retentionUntil: string;
}

export interface TerminalEvidenceEffect extends EvidenceEffectSource {
  actionDigest: string;
  policySnapshotId: string;
}

export async function buildEffectScopedEvidenceRecord(input: {
  effect: TerminalEvidenceEffect;
  projectedState: 'COMPLETED' | 'FAILED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN';
  response: Record<string, unknown>;
  auditEvents: EvidenceAuditSource[];
  terminalEvent: {
    type: string;
    severity: EvidenceAuditSource['severity'];
    details: Record<string, unknown>;
  };
  signer: EvidenceSigner;
  recordedAt: string;
  retentionUntil: string;
}): Promise<TerminalEvidenceRecord> {
  const { effect } = input;
  if (!/^[a-f0-9]{64}$/.test(effect.actionDigest)) {
    throw new Error('EVIDENCE_ACTION_DIGEST_INVALID');
  }
  if (!effect.policySnapshotId.trim()) {
    throw new Error('EVIDENCE_POLICY_SNAPSHOT_REQUIRED');
  }

  const auditEvents = input.auditEvents.filter(
    (event) =>
      event.tenantId === effect.tenantId &&
      event.runId === effect.runId &&
      (event.details.effectId === effect.id || event.stepId === effect.stepId),
  );
  auditEvents.push({
    type: input.terminalEvent.type,
    severity: input.terminalEvent.severity,
    tenantId: effect.tenantId,
    runId: effect.runId,
    stepId: effect.stepId,
    at: input.recordedAt,
    details: { effectId: effect.id, ...input.terminalEvent.details },
  });

  const receipt = buildSignedEvidenceBundle({
    tenantId: effect.tenantId,
    runId: effect.runId,
    effectId: effect.id,
    actionDigest: effect.actionDigest,
    policySnapshotId: effect.policySnapshotId,
    effects: [
      {
        ...effect,
        state: input.projectedState,
        response: input.response,
        completedAt: input.recordedAt,
      },
    ],
    auditEvents,
    exportedAt: input.recordedAt,
    bundleId: `evidence_${effect.id}`,
  });
  const signature = await input.signer.sign(canonicalEvidenceBody(receipt));
  const signedReceipt: SignedTerminalEvidenceReceipt = { ...receipt, signature };
  assertTerminalEvidence(signedReceipt);

  return {
    tenantId: effect.tenantId,
    runId: effect.runId,
    effectId: effect.id,
    bundleId: signedReceipt.bundleId,
    actionDigest: effect.actionDigest,
    receipt: signedReceipt,
    anchoredAt: input.recordedAt,
    retentionUntil: input.retentionUntil,
  };
}
