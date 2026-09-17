import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRunEvidenceBundle, canonicalEvidenceJson } from './evidenceBundle.js';
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
    const sink = new EvidenceSink(repository, {
      maxBytes: 2_000,
      verifySignature: () => true,
    });
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

  it('fails closed when no trusted signature verifier is supplied', async () => {
    const writes: EvidenceRecord[] = [];
    const repository: EvidenceRepositoryPort = {
      appendEvidence: async (value) => {
        writes.push(value);
        return { inserted: true };
      },
    };
    const sink = new EvidenceSink(repository);
    await assert.rejects(
      sink.persist(record()),
      /EVIDENCE_SIGNATURE_VERIFIER_REQUIRED|EVIDENCE_INTEGRITY_INVALID/,
    );
    assert.equal(writes.length, 0);
  });

  it('rejects a bundle when the trusted verifier rejects its signature', async () => {
    const writes: EvidenceRecord[] = [];
    const repository: EvidenceRepositoryPort = {
      appendEvidence: async (value) => {
        writes.push(value);
        return { inserted: true };
      },
    };
    const sink = new EvidenceSink(repository, { verifySignature: () => false });
    await assert.rejects(sink.persist(record()), /EVIDENCE_INTEGRITY_INVALID/);
    assert.equal(writes.length, 0);
  });

  it('rejects a record whose body was tampered after signing', async () => {
    // A mutated bundle must not reach the repository even when the signature
    // object is unchanged: the verifier sees the altered canonical body.
    const writes: EvidenceRecord[] = [];
    const repository: EvidenceRepositoryPort = {
      appendEvidence: async (value) => {
        writes.push(value);
        return { inserted: true };
      },
    };
    const pristine = record();
    const sink = new EvidenceSink(repository, {
      verifySignature: (body) =>
        canonicalEvidenceJson(body) === canonicalEvidenceJson(pristine.body),
    });
    const tampered = record();
    tampered.body.effects[0]!.response = { status: 'tampered' };
    await assert.rejects(sink.persist(tampered), /EVIDENCE_INTEGRITY_INVALID/);
    assert.equal(writes.length, 0);
  });

  it('rejects a record whose signature disagrees with its body signature', async () => {
    const writes: EvidenceRecord[] = [];
    const repository: EvidenceRepositoryPort = {
      appendEvidence: async (value) => {
        writes.push(value);
        return { inserted: true };
      },
    };
    const sink = new EvidenceSink(repository, { verifySignature: () => true });
    const mismatched = record();
    mismatched.signature = { ...mismatched.signature, value: 'other-signature' };
    await assert.rejects(sink.persist(mismatched), /EVIDENCE_SIGNATURE_REQUIRED/);
    assert.equal(writes.length, 0);
  });

  it('rejects an unparseable retention timestamp instead of accepting it', async () => {
    // `Date.parse` returns NaN for a malformed date and `NaN <= x` is false, so
    // an invalid retentionUntil previously slipped past the retention guard.
    const writes: EvidenceRecord[] = [];
    const repository: EvidenceRepositoryPort = {
      appendEvidence: async (value) => {
        writes.push(value);
        return { inserted: true };
      },
    };
    const sink = new EvidenceSink(repository, { verifySignature: () => true });
    const invalid = record();
    invalid.retentionUntil = 'not-a-date';
    await assert.rejects(sink.persist(invalid), /EVIDENCE_RETENTION_INVALID/);
    assert.equal(writes.length, 0);
  });

  it('rejects an unparseable createdAt timestamp', async () => {
    const writes: EvidenceRecord[] = [];
    const repository: EvidenceRepositoryPort = {
      appendEvidence: async (value) => {
        writes.push(value);
        return { inserted: true };
      },
    };
    const sink = new EvidenceSink(repository, { verifySignature: () => true });
    const invalid = record();
    invalid.createdAt = 'also-not-a-date';
    await assert.rejects(sink.persist(invalid), /EVIDENCE_RETENTION_INVALID/);
    assert.equal(writes.length, 0);
  });
});
