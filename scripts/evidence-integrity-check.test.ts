import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRunEvidenceBundle } from '../packages/effect-broker/src/evidenceBundle.js';
import {
  checkEvidenceIntegrity,
  type IntegrityEvidenceRecord,
} from './evidence-integrity-check.js';

function record(bundleId: string): IntegrityEvidenceRecord {
  const body = buildRunEvidenceBundle({
    tenantId: 'tenant-a',
    runId: `run-${bundleId}`,
    actionDigest: 'a'.repeat(64),
    policySnapshotId: 'ps-1',
    bundleId,
    exportedAt: '2026-07-17T00:00:02.000Z',
    effects: [
      {
        id: 'effect-1',
        runId: `run-${bundleId}`,
        stepId: 'step-1',
        tenantId: 'tenant-a',
        type: 'http.write',
        state: 'COMPLETED',
        policyDecisionId: 'pd-1',
        requestHash: 'rh-1',
        createdAt: '2026-07-17T00:00:00.000Z',
        completedAt: '2026-07-17T00:00:01.000Z',
      },
    ],
  });
  return {
    tenantId: 'tenant-a',
    bundleId,
    body,
    retentionUntil: '2026-07-18T00:00:00.000Z',
  };
}

describe('evidence integrity check', () => {
  it('reports retention expiry without deleting or failing valid evidence', () => {
    const records = [record('bundle-1')];
    const result = checkEvidenceIntegrity(
      records,
      'tenant-a',
      new Date('2026-07-19T00:00:00.000Z'),
    );
    assert.deepEqual(result, { ok: true, checked: 1, expired: 1 });
    assert.equal(records.length, 1);
  });

  it('reports the first broken bundle and ignores another tenant', () => {
    const first = record('bundle-1');
    const broken = record('bundle-2');
    broken.body.effects[0].entryHash = 'f'.repeat(64);
    const foreign = { ...record('bundle-foreign'), tenantId: 'tenant-b' };
    const result = checkEvidenceIntegrity(
      [first, broken, foreign],
      'tenant-a',
      new Date('2026-07-17T12:00:00.000Z'),
    );
    assert.equal(result.ok, false);
    assert.equal(result.checked, 2);
    assert.equal(result.brokenBundleId, 'bundle-2');
  });
});
