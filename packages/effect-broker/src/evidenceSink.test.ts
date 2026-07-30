import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRunEvidenceBundle } from './evidenceBundle.js';
import { EvidenceSink, type EvidenceRepositoryPort, type EvidenceRecord } from './evidenceSink.js';

function record(): EvidenceRecord {
  const body = buildRunEvidenceBundle({
    tenantId: 'tenant-a',
    runId: 'run-1',
    actionDigest: 'a'.repeat(64),
    policySnapshotId: 'ps-1',
    effects: [
      {
        id: 'effect-1',
        runId: 'run-1',
        stepId: 'step-1',
        tenantId: 'tenant-a',
        type: 'http.write',
        state: 'COMPLETED',
        policyDecisionId: 'pd-1',
        requestHash: 'rh-1',
        response: { status: 'ok' },
        createdAt: '2026-07-17T00:00:00.000Z',
        completedAt: '2026-07-17T00:00:01.000Z',
      },
    ],
    bundleId: 'bundle-1',
    exportedAt: '2026-07-17T00:00:02.000Z',
  });
  const signature = {
    algorithm: 'Ed25519' as const,
    keyId: 'cell-test-1',
    signedAt: '2026-07-17T00:00:02.000Z',
    value: 'test-signature',
  };
  body.signature = signature;
  return {
    tenantId: 'tenant-a',
    runId: 'run-1',
    bundleId: body.bundleId,
    actionDigest: body.actionDigest,
    body,
    contentHash: body.contentHash,
    signature,
    createdAt: body.exportedAt,
    anchoredAt: body.exportedAt,
    retentionUntil: '2027-07-17T00:00:02.000Z',
  };
}

describe('append-only evidence sink', () => {
  it('persists through the repository port and rejects oversized receipts before insert', async () => {
    const writes: EvidenceRecord[] = [];
    const repository: EvidenceRepositoryPort = {
      appendEvidence: async (value) => {
        writes.push(value);
        return { inserted: true };
      },
    };
    const sink = new EvidenceSink(repository, { maxBytes: 2_000 });
    await sink.persist(record());
    assert.equal(writes.length, 1);
    const oversized = record();
    oversized.body.auditEvents.push({
      type: 'oversized',
      at: oversized.createdAt,
      severity: 'low',
      details: { note: 'x'.repeat(3_000) },
      entryHash: '0'.repeat(64),
      prevEntryHash: '0'.repeat(64),
    });
    await assert.rejects(sink.persist(oversized), /EVIDENCE_SIZE_LIMIT_EXCEEDED/);
    assert.equal(writes.length, 1);
  });
});
