import {
  assertTerminalEvidence,
  canonicalEvidenceJson,
  verifyEvidenceBundle,
  type EvidenceBundle,
  type EvidenceSignature,
} from './evidenceBundle.js';

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

export function assertEvidenceRecord(
  record: EvidenceRecord,
  options: { maxBytes?: number } = {},
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
  if (verifyEvidenceBundle(record.body).ok !== true) {
    throw new Error('EVIDENCE_INTEGRITY_INVALID');
  }
  assertTerminalEvidence(record.body);
  if (Date.parse(record.retentionUntil) <= Date.parse(record.createdAt)) {
    throw new Error('EVIDENCE_RETENTION_INVALID');
  }
}

export class EvidenceSink {
  constructor(
    private readonly repository: EvidenceRepositoryPort,
    private readonly options: { maxBytes?: number } = {},
  ) {}

  async persist(record: EvidenceRecord): Promise<void> {
    assertEvidenceRecord(record, this.options);
    await this.repository.appendEvidence(structuredClone(record));
  }
}
