export interface KernelEvidenceSignature {
  algorithm: 'Ed25519';
  keyId: string;
  signedAt: string;
  value: string;
}

export interface KernelEvidenceRecord {
  tenantId: string;
  runId: string;
  bundleId: string;
  actionDigest: string;
  body: object;
  contentHash: string;
  signature: KernelEvidenceSignature;
  createdAt: string;
  anchoredAt: string | null;
  retentionUntil: string;
}

export interface EvidenceRepository {
  appendEvidence(record: KernelEvidenceRecord): Promise<{ inserted: boolean }>;
  getEvidence(runId: string, tenantId: string): Promise<KernelEvidenceRecord | null>;
  listEvidence(tenantId: string): Promise<KernelEvidenceRecord[]>;
}

export function assertEvidenceRecordBoundToEffect(
  record: KernelEvidenceRecord,
  effect: {
    id: string;
    tenantId: string;
    runId: string;
    actionDigest: string;
    state: 'ADMITTED' | 'COMPLETION_UNKNOWN' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETED' | 'FAILED';
  },
): void {
  const body = record.body as Record<string, unknown>;
  const scope = body.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('EVIDENCE_RECORD_BINDING_INVALID');
  }
  const bodyScope = scope as Record<string, unknown>;
  const effects = Array.isArray(body.effects) ? body.effects : [];
  const bodyEffect = effects.find(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object' && !Array.isArray(entry) && entry.effectId === effect.id,
  );
  const expectedDisposition =
    effect.state === 'COMPLETED'
      ? 'SUCCEEDED'
      : effect.state === 'FAILED' || effect.state === 'CONFIRMED_NOT_APPLIED'
        ? 'FAILED'
        : effect.state === 'COMPLETION_UNKNOWN'
          ? 'ESCALATED'
          : null;
  const invalid = [
    record.tenantId !== effect.tenantId && 'tenant',
    record.runId !== effect.runId && 'run',
    record.bundleId !== `evidence_${effect.id}` && 'bundle',
    record.actionDigest !== effect.actionDigest && 'action_digest',
    record.anchoredAt === null && 'anchor',
    bodyScope.tenantId !== effect.tenantId && 'body_tenant',
    bodyScope.runId !== effect.runId && 'body_run',
    bodyScope.effectId !== effect.id && 'body_effect',
    body.bundleId !== record.bundleId && 'body_bundle',
    body.actionDigest !== record.actionDigest && 'body_action_digest',
    body.contentHash !== record.contentHash && 'body_content_hash',
    canonical(body.signature) !== canonical(record.signature) && 'body_signature',
    expectedDisposition === null && 'effect_state',
    body.terminalDisposition !== expectedDisposition && 'disposition',
    bodyEffect?.state !== effect.state && 'body_effect_state',
  ].filter(Boolean);
  if (invalid.length > 0) {
    throw new Error(`EVIDENCE_RECORD_BINDING_INVALID:${invalid.join(',')}`);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly records = new Map<string, KernelEvidenceRecord>();

  async appendEvidence(record: KernelEvidenceRecord): Promise<{ inserted: boolean }> {
    const key = `${record.tenantId}\u0000${record.bundleId}`;
    const existing = this.records.get(key);
    if (existing) {
      if (canonical(existing) !== canonical(record)) throw new Error('EVIDENCE_CONFLICT');
      return { inserted: false };
    }
    this.records.set(key, structuredClone(record));
    return { inserted: true };
  }

  async getEvidence(runId: string, tenantId: string): Promise<KernelEvidenceRecord | null> {
    const records = [...this.records.values()]
      .filter((record) => record.tenantId === tenantId && record.runId === runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records[0] ? structuredClone(records[0]) : null;
  }

  async listEvidence(tenantId: string): Promise<KernelEvidenceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => structuredClone(record));
  }
}
