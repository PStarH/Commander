import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertTerminalEvidence,
  buildSignedEvidenceBundle,
  canonicalEvidenceBody,
  verifySignedEvidenceBundle,
} from './signedEvidence.js';

function completedReceipt() {
  return buildSignedEvidenceBundle({
    tenantId: 'tenant-a',
    runId: 'run-1',
    actionDigest: 'a'.repeat(64),
    policySnapshotId: 'policy-1',
    bundleId: 'bundle-1',
    exportedAt: '2026-08-11T00:00:00.000Z',
    effects: [
      {
        id: 'effect-1',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        type: 'connector.kubernetes.deployment.rollback',
        state: 'COMPLETED',
        policyDecisionId: 'decision-1',
        requestHash: 'b'.repeat(64),
        createdAt: '2026-08-11T00:00:00.000Z',
        completedAt: '2026-08-11T00:00:01.000Z',
      },
    ],
  });
}

describe('signed evidence bundle', () => {
  it('verifies the unsigned content hash and terminal disposition', () => {
    const receipt = completedReceipt();
    receipt.signature = {
      algorithm: 'Ed25519',
      keyId: 'cell-1',
      signedAt: '2026-08-11T00:00:02.000Z',
      value: 'signature',
    };

    assert.deepEqual(verifySignedEvidenceBundle(receipt), { ok: true });
    assert.doesNotThrow(() => assertTerminalEvidence(receipt));
    assert.equal(canonicalEvidenceBody(receipt).includes('signature'), false);
  });

  it('rejects unresolved evidence without an escalation audit record', () => {
    const receipt = completedReceipt();
    receipt.effects[0].state = 'COMPLETION_UNKNOWN';
    receipt.terminalDisposition = 'ESCALATED';

    assert.throws(() => assertTerminalEvidence(receipt), /TERMINAL_EVIDENCE_REQUIRED/);
  });
});
