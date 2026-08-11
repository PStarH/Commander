import {
  assertTerminalEvidence,
  canonicalEvidenceBody,
  verifySignedEvidenceBundle,
  type SignedEvidenceBundle,
} from './signedEvidence.js';
import { verifyEvidenceSignature, type EvidenceJwks } from './evidenceSigner.js';

export interface EvidenceVerificationResult {
  ok: boolean;
  reason?: string;
}

export function verifyEvidenceReceipt(
  receipt: SignedEvidenceBundle,
  jwks: EvidenceJwks,
): EvidenceVerificationResult {
  try {
    if (!receipt || typeof receipt !== 'object' || !receipt.signature) {
      return { ok: false, reason: 'EVIDENCE_SIGNATURE_REQUIRED' };
    }
    const structural = verifySignedEvidenceBundle(receipt);
    if (!structural.ok) return { ok: false, reason: structural.reason ?? 'EVIDENCE_INVALID' };
    assertTerminalEvidence(receipt);
    if (!receipt.scope.tenantId || !receipt.scope.runId || !receipt.scope.effectId) {
      return { ok: false, reason: 'EVIDENCE_SCOPE_INVALID' };
    }
    if (!verifyEvidenceSignature(canonicalEvidenceBody(receipt), receipt.signature, jwks)) {
      return { ok: false, reason: 'EVIDENCE_SIGNATURE_INVALID' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'EVIDENCE_INVALID' };
  }
}
