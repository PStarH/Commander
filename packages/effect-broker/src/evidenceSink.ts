import {
  assertTerminalEvidence,
  canonicalEvidenceJson,
  verifyEvidenceBundle,
  type EvidenceBundle,
  type EvidenceSignature,
  type VerifyEvidenceBundleOptions,
} from './evidenceBundle.js';
import type { EvidenceJwks } from './evidenceSigner.js';

export const DEFAULT_EVIDENCE_MAX_BYTES = 256 * 1024;

export interface EvidenceRecord {
  tenantId: string;
  runId: string;
  bundleId: string;
  actionDigest: string;
  body: EvidenceBundle;
  contentHash: string;
  signature: EvidenceSignature;
  createdAt: string;
  anchoredAt: string | null;
  retentionUntil: string;
}

export interface EvidenceRepositoryPort {
  appendEvidence(record: EvidenceRecord): Promise<{ inserted: boolean }>;
}

export interface EvidenceRecordValidationOptions {
  maxBytes?: number;
  /** Trusted verifier supplied by the evidence authority. */
  verifySignature?: VerifyEvidenceBundleOptions['verifySignature'];
  /** Trusted public keys supplied by the evidence authority. */
  jwks?: EvidenceJwks;
}

export function assertEvidenceRecord(
  record: EvidenceRecord,
  options: EvidenceRecordValidationOptions = {},
): void {
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  if (bytes > (options.maxBytes ?? DEFAULT_EVIDENCE_MAX_BYTES)) {
    throw new Error('EVIDENCE_SIZE_LIMIT_EXCEEDED');
  }
  if (
    record.tenantId !== record.body.scope.tenantId ||
    record.runId !== record.body.scope.runId ||
    record.bundleId !== record.body.bundleId ||
    record.actionDigest !== record.body.actionDigest ||
    record.contentHash !== record.body.contentHash
  ) {
    throw new Error('EVIDENCE_RECORD_BINDING_INVALID');
  }
  if (canonicalEvidenceJson(record.signature) !== canonicalEvidenceJson(record.body.signature)) {
    throw new Error('EVIDENCE_SIGNATURE_REQUIRED');
  }
  const verification = verifyEvidenceBundle(record.body, {
    verifySignature: options.verifySignature,
    jwks: options.jwks,
    // Evidence records are an acceptance boundary. Structural self-consistency
    // is not authenticity; without a trusted verifier, fail closed.
    requireSignature: true,
  });
  if (verification.ok !== true) {
    throw new Error(`EVIDENCE_INTEGRITY_INVALID: ${verification.reason ?? 'verification failed'}`);
  }
  assertTerminalEvidence(record.body);
  // `Date.parse` yields NaN for an unparseable timestamp, and `NaN <= x` is
  // always false — so an invalid retentionUntil/createdAt pair would previously
  // pass this guard. Require both to parse before comparing.
  const retentionUntilMs = Date.parse(record.retentionUntil);
  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(retentionUntilMs) || !Number.isFinite(createdAtMs)) {
    throw new Error('EVIDENCE_RETENTION_INVALID');
  }
  if (retentionUntilMs <= createdAtMs) {
    throw new Error('EVIDENCE_RETENTION_INVALID');
  }
}

export class EvidenceSink {
  constructor(
    private readonly repository: EvidenceRepositoryPort,
    private readonly options: EvidenceRecordValidationOptions = {},
  ) {}

  async persist(record: EvidenceRecord): Promise<void> {
    assertEvidenceRecord(record, this.options);
    await this.repository.appendEvidence(structuredClone(record));
  }
}
