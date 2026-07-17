import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEffectEvidenceBundle,
  buildRunEvidenceBundle,
  EVIDENCE_GENESIS_HASH,
  findDlpViolation,
  sanitizeForEvidence,
  verifyEvidenceBundle,
} from './evidenceBundle.js';

const baseEffect = {
  id: 'eff-1',
  runId: 'run-1',
  stepId: 'step-1',
  tenantId: 'tenant-a',
  type: 'llm.invoke',
  state: 'COMPLETED',
  policyDecisionId: 'pd-allow-1',
  requestHash: 'abc123',
  request: {
    contentHash: 'hash-prompt-bound',
    messages: [{ role: 'user', content: 'secret prompt text' }],
    chainOfThought: 'hidden reasoning',
  },
  response: {
    contentHash: 'hash-response-bound',
    completion: 'model output should not export',
    status: 'ok',
  },
  createdAt: '2026-07-17T06:00:00.000Z',
  completedAt: '2026-07-17T06:00:01.000Z',
  approvalInteractionId: 'int-approve-1',
};

describe('L3-11 evidence bundle v0', () => {
  it('buildRunEvidenceBundle includes identity, policy, effect summary, versions', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      intentHash: 'intent-h',
      workGraphHash: 'graph-h',
      workGraphVersion: 'v1',
      policySnapshotId: 'ps-pin-1',
      kernelApiVersion: 'v2',
      capabilityGrant: {
        jti: 'cap-jti-1',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        effectTypes: ['llm.invoke'],
        expiresAt: '2026-07-18T00:00:00.000Z',
        issuer: 'gateway',
        audience: 'worker',
        requestHash: 'abc123',
        policySnapshotId: 'ps-pin-1',
      },
      effects: [baseEffect],
      auditEvents: [{
        type: 'effect.completed',
        severity: 'low',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        at: '2026-07-17T06:00:01.000Z',
        details: { effectId: 'eff-1', policyDecisionId: 'pd-allow-1' },
      }],
      exportedAt: '2026-07-17T06:00:02.000Z',
      bundleId: 'bundle-test-1',
    });

    assert.equal(bundle.schemaVersion, 'l3-11.v0');
    assert.equal(bundle.scope.tenantId, 'tenant-a');
    assert.equal(bundle.versions.policySnapshotId, 'ps-pin-1');
    assert.equal(bundle.identity.capabilityGrant?.jti, 'cap-jti-1');
    assert.equal(bundle.effects[0].policyDecisionId, 'pd-allow-1');
    assert.equal(bundle.effects[0].approvalInteractionId, 'int-approve-1');
    assert.equal(bundle.effects[0].responseSummary?.status, 'ok');
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
  });

  it('default sanitization strips CoT / prompt / gen_ai fields', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      auditEvents: [{
        type: 'effect.completed',
        severity: 'low',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        at: '2026-07-17T06:00:01.000Z',
        details: {
          effectId: 'eff-1',
          'gen_ai.prompt': 'leak',
          'gen_ai.completion': 'leak',
        },
      }],
    });

    assert.equal(findDlpViolation(bundle), undefined);
    assert.equal(bundle.effects[0].responseSummary?.completion, undefined);
    assert.equal(bundle.effects[0].responseSummary?.contentHash, 'hash-response-bound');
    assert.deepEqual(sanitizeForEvidence({ messages: [1], status: 'ok' }), { status: 'ok' });
  });

  it('verifyEvidenceBundle detects tampered contentHash', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    const tampered = { ...bundle, contentHash: 'f'.repeat(64) };
    const result = verifyEvidenceBundle(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'contentHash');
  });

  it('verifyEvidenceBundle detects broken effect entry chain', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    const tampered = structuredClone(bundle);
    tampered.effects[0].entryHash = 'a'.repeat(64);
    const result = verifyEvidenceBundle(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'effects');
  });

  it('effect entry chain starts at GENESIS', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    assert.equal(bundle.effects[0].prevEntryHash, EVIDENCE_GENESIS_HASH);
  });

  it('buildEffectEvidenceBundle scopes to one effect', () => {
    const other = { ...baseEffect, id: 'eff-2', createdAt: '2026-07-17T06:00:05.000Z' };
    const bundle = buildEffectEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      effectId: 'eff-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect, other],
      auditEvents: [
        { type: 'effect.completed', severity: 'low', tenantId: 'tenant-a', runId: 'run-1', stepId: 'step-1', at: '2026-07-17T06:00:01.000Z', details: { effectId: 'eff-1' } },
        { type: 'effect.completed', severity: 'low', tenantId: 'tenant-a', runId: 'run-1', stepId: 'step-1', at: '2026-07-17T06:00:06.000Z', details: { effectId: 'eff-2' } },
      ],
    });
    assert.equal(bundle.scope.effectId, 'eff-1');
    assert.equal(bundle.effects.length, 1);
    assert.equal(bundle.effects[0].effectId, 'eff-1');
    assert.equal(bundle.auditEvents.length, 1);
  });
});
