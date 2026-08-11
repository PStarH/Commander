import { createHash } from 'node:crypto';
import {
  buildRunEvidenceBundle,
  verifyEvidenceBundle,
  type BuildEvidenceBundleInput,
  type EvidenceBundle,
  type VerifyEvidenceBundleResult,
} from './evidenceBundle.js';

export const EVIDENCE_BODY_VERSION = 'commander.evidence-body/v1' as const;

export type EvidenceTerminalDisposition = 'SUCCEEDED' | 'FAILED' | 'ESCALATED';

export interface EvidenceSignature {
  algorithm: 'Ed25519';
  keyId: string;
  signedAt: string;
  value: string;
}

export interface EvidenceSigner {
  sign(canonicalBody: string): Promise<EvidenceSignature>;
  verify(canonicalBody: string, signature: EvidenceSignature): boolean;
}

export type SignedEvidenceBundle = EvidenceBundle & {
  bodyVersion: typeof EVIDENCE_BODY_VERSION;
  actionDigest: string;
  terminalDisposition: EvidenceTerminalDisposition;
  signature?: EvidenceSignature;
};

export interface BuildSignedEvidenceBundleInput extends BuildEvidenceBundleInput {
  actionDigest?: string;
}

export function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalEvidenceJson).join(',') + ']';
  }
  const object = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(object)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalEvidenceJson(object[key]))
      .join(',') +
    '}'
  );
}

function hashEvidence(value: unknown): string {
  return createHash('sha256').update(canonicalEvidenceJson(value)).digest('hex');
}

function terminalDisposition(bundle: EvidenceBundle): EvidenceTerminalDisposition {
  const terminalStates = new Set(['COMPLETED', 'FAILED', 'CONFIRMED_NOT_APPLIED']);
  const unresolved = bundle.effects.some((effect) => !terminalStates.has(effect.state));
  const escalated = bundle.auditEvents.some((event) => event.type === 'effect.reconcile_escalated');
  if (unresolved && escalated) return 'ESCALATED';
  if (
    bundle.effects.some(
      (effect) => effect.state === 'FAILED' || effect.state === 'CONFIRMED_NOT_APPLIED',
    )
  ) {
    return 'FAILED';
  }
  return 'SUCCEEDED';
}

export function buildSignedEvidenceBundle(
  input: BuildSignedEvidenceBundleInput,
): SignedEvidenceBundle {
  const base = buildRunEvidenceBundle(input);
  const { contentHash: _contentHash, ...baseBody } = base;
  const body = {
    ...baseBody,
    bodyVersion: EVIDENCE_BODY_VERSION,
    actionDigest:
      input.actionDigest ??
      hashEvidence({
        tenantId: input.tenantId,
        runId: input.runId,
        effectRequestHashes: base.effects.map((effect) => effect.requestHash).sort(),
      }),
    terminalDisposition: terminalDisposition(base),
  };
  return { ...body, contentHash: hashEvidence(body) };
}

export function canonicalEvidenceBody(bundle: SignedEvidenceBundle): string {
  const { signature: _signature, ...body } = bundle;
  return canonicalEvidenceJson(body);
}

export function verifySignedEvidenceBundle(
  bundle: SignedEvidenceBundle,
): VerifyEvidenceBundleResult {
  const { signature: _signature, ...unsigned } = bundle;
  return verifyEvidenceBundle(unsigned);
}

export function assertTerminalEvidence(bundle: SignedEvidenceBundle): void {
  const terminalStates = new Set(['COMPLETED', 'FAILED', 'CONFIRMED_NOT_APPLIED']);
  const unresolved = bundle.effects.filter((effect) => !terminalStates.has(effect.state));
  const hasEscalation = bundle.auditEvents.some(
    (event) => event.type === 'effect.reconcile_escalated',
  );
  if (
    unresolved.length > 0 &&
    (!unresolved.every((effect) => effect.state === 'COMPLETION_UNKNOWN') ||
      !hasEscalation ||
      bundle.terminalDisposition !== 'ESCALATED')
  ) {
    throw new Error('TERMINAL_EVIDENCE_REQUIRED');
  }
  if (unresolved.length === 0 && bundle.terminalDisposition === 'ESCALATED') {
    throw new Error('TERMINAL_EVIDENCE_REQUIRED');
  }
  const expected = bundle.effects.some(
    (effect) => effect.state === 'FAILED' || effect.state === 'CONFIRMED_NOT_APPLIED',
  )
    ? 'FAILED'
    : 'SUCCEEDED';
  if (unresolved.length === 0 && bundle.terminalDisposition !== expected) {
    throw new Error('TERMINAL_EVIDENCE_REQUIRED');
  }
  if (!/^[a-f0-9]{64}$/.test(bundle.actionDigest)) {
    throw new Error('TERMINAL_EVIDENCE_REQUIRED: ACTION_DIGEST_INVALID');
  }
}
