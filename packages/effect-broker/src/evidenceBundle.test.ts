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
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
    assert.equal(bundle.effects[0].responseSummary?.completion, undefined);
    assert.equal(bundle.effects[0].responseSummary?.messages, undefined);
    assert.equal(bundle.effects[0].responseSummary?.contentHash, 'hash-response-bound');
    assert.deepEqual(sanitizeForEvidence({ messages: [1], status: 'ok' }), { status: 'ok' });
  });

  it('responseSummary is allowlisted and secret field names are stripped', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [{
        ...baseEffect,
        response: {
          contentHash: 'hash-response-bound',
          status: 'ok',
          body: 'raw payload must not export',
          Authorization: 'Bearer secret-token',
          httpStatus: 200,
          // Nested under allowlisted key must not smuggle raw payload.
          ok: { body: 'nested-leak', refresh_token: 'rt-1' },
        },
      }],
      auditEvents: [{
        type: 'effect.completed',
        severity: 'low',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        at: '2026-07-17T06:00:01.000Z',
        details: {
          effectId: 'eff-1',
          Authorization: 'Bearer audit-token',
          cookie: 'session=1',
          refresh_token: 'rt-leak',
          client_secret: 'cs-leak',
          access_token: 'at-leak',
        },
      }],
    });

    assert.deepEqual(bundle.effects[0].responseSummary, {
      contentHash: 'hash-response-bound',
      status: 'ok',
      httpStatus: 200,
    });
    assert.equal('Authorization' in bundle.auditEvents[0].details, false);
    assert.equal('cookie' in bundle.auditEvents[0].details, false);
    assert.equal('refresh_token' in bundle.auditEvents[0].details, false);
    assert.equal('client_secret' in bundle.auditEvents[0].details, false);
    assert.equal('access_token' in bundle.auditEvents[0].details, false);
    assert.equal(bundle.auditEvents[0].details.effectId, 'eff-1');
    assert.deepEqual(
      sanitizeForEvidence({ Authorization: 'x', token: 'y', refresh_token: 'z', status: 'ok' }),
      { status: 'ok' },
    );
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
  });

  it('verifyEvidenceBundle rejects nested responseSummary values', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    const nested = structuredClone(bundle);
    nested.effects[0].responseSummary = {
      status: { body: 'should-fail-verify' },
    };
    assert.equal(verifyEvidenceBundle(nested).ok, false);
    assert.equal(verifyEvidenceBundle(nested).brokenAt, 'dlp');
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
        { type: 'effect.rejected', severity: 'high', tenantId: 'tenant-a', runId: 'run-1', stepId: 'step-1', at: '2026-07-17T06:00:00.500Z', details: { code: 'POLICY_DENIED' } },
      ],
    });
    assert.equal(bundle.scope.effectId, 'eff-1');
    assert.equal(bundle.effects.length, 1);
    assert.equal(bundle.effects[0].effectId, 'eff-1');
    assert.equal(bundle.auditEvents.length, 1);
    assert.equal(bundle.auditEvents[0].details.effectId, 'eff-1');
  });

  it('buildRunEvidenceBundle drops cross-tenant effects, audits, and grants', () => {
    const foreignEffect = {
      ...baseEffect,
      id: 'eff-foreign',
      tenantId: 'tenant-b',
      runId: 'run-1',
    };
    const wrongRunEffect = {
      ...baseEffect,
      id: 'eff-other-run',
      tenantId: 'tenant-a',
      runId: 'run-other',
    };
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      capabilityGrant: {
        jti: 'cap-foreign',
        tenantId: 'tenant-b',
        runId: 'run-1',
        stepId: 'step-1',
        effectTypes: ['llm.invoke'],
        expiresAt: '2026-07-18T00:00:00.000Z',
      },
      effects: [baseEffect, foreignEffect, wrongRunEffect],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: { effectId: 'eff-1' },
        },
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-b',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:02.000Z',
          details: { effectId: 'eff-foreign' },
        },
      ],
    });

    assert.equal(bundle.effects.length, 1);
    assert.equal(bundle.effects[0].effectId, 'eff-1');
    assert.equal(bundle.auditEvents.length, 1);
    assert.equal(bundle.auditEvents[0].details.effectId, 'eff-1');
    assert.equal(bundle.identity.capabilityGrant, undefined);
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
  });

  it('verifyEvidenceBundle rejects unredacted secret fields and non-allowlisted responseSummary', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });

    const secretLeak = structuredClone(bundle);
    secretLeak.auditEvents = [{
      type: 'effect.completed',
      at: '2026-07-17T06:00:01.000Z',
      severity: 'low',
      details: { Authorization: 'Bearer leaked' },
      entryHash: 'c'.repeat(64),
      prevEntryHash: EVIDENCE_GENESIS_HASH,
    }];
    assert.equal(verifyEvidenceBundle(secretLeak).ok, false);
    assert.equal(verifyEvidenceBundle(secretLeak).brokenAt, 'dlp');

    const summaryLeak = structuredClone(bundle);
    summaryLeak.effects[0].responseSummary = {
      ...(summaryLeak.effects[0].responseSummary ?? {}),
      body: 'should-not-pass-verify',
    };
    assert.equal(verifyEvidenceBundle(summaryLeak).ok, false);
    assert.equal(verifyEvidenceBundle(summaryLeak).brokenAt, 'dlp');
  });

  it('verifyEvidenceBundle detects tampered effect field and deleted audit row', () => {
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
        details: { effectId: 'eff-1' },
      }],
    });

    const fieldTampered = structuredClone(bundle);
    fieldTampered.effects[0].policyDecisionId = 'pd-forged';
    const fieldResult = verifyEvidenceBundle(fieldTampered);
    assert.equal(fieldResult.ok, false);
    assert.equal(fieldResult.brokenAt, 'effects');

    const auditDeleted = structuredClone(bundle);
    auditDeleted.auditEvents = [];
    const deletedResult = verifyEvidenceBundle(auditDeleted);
    assert.equal(deletedResult.ok, false);
    assert.equal(deletedResult.brokenAt, 'contentHash');
  });

  it('verifyEvidenceBundle detects broken audit entry chain', () => {
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
        details: { effectId: 'eff-1' },
      }],
    });
    const tampered = structuredClone(bundle);
    tampered.auditEvents[0].entryHash = 'b'.repeat(64);
    const result = verifyEvidenceBundle(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'auditEvents');
  });

  it('verifyEvidenceBundle rejects residual DLP keys', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    const leaked = structuredClone(bundle);
    leaked.auditEvents = [{
      type: 'effect.completed',
      at: '2026-07-17T06:00:01.000Z',
      severity: 'low',
      details: { 'gen_ai.prompt': 'should-fail-verify' },
      entryHash: 'c'.repeat(64),
      prevEntryHash: EVIDENCE_GENESIS_HASH,
    }];
    const result = verifyEvidenceBundle(leaked);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'dlp');
  });

  it('approvalInteractionId is optional', () => {
    const { approvalInteractionId: _omit, ...withoutApproval } = baseEffect;
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [withoutApproval],
      exportedAt: '2026-07-17T06:00:02.000Z',
      bundleId: 'bundle-no-approval',
    });
    assert.equal('approvalInteractionId' in bundle.effects[0], false);
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
  });

  it('verifyEvidenceBundle survives JSON round-trip when optional fields are absent', () => {
    const sparse = {
      id: 'eff-1',
      runId: 'run-1',
      stepId: 'step-1',
      tenantId: 'tenant-a',
      type: 'http.write',
      state: 'ADMITTED',
      policyDecisionId: 'pd-1',
      requestHash: 'req-h',
      createdAt: '2026-07-17T06:00:00.000Z',
    };
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      capabilityGrant: {
        jti: 'cap-jti-1',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        effectTypes: ['http.write'],
        expiresAt: '2026-07-18T00:00:00.000Z',
      },
      effects: [sparse],
      exportedAt: '2026-07-17T06:00:02.000Z',
      bundleId: 'bundle-roundtrip-1',
    });
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
    assert.equal('completedAt' in bundle.effects[0], false);
    assert.equal('issuer' in (bundle.identity.capabilityGrant ?? {}), false);
    const roundTripped = JSON.parse(JSON.stringify(bundle));
    assert.equal(verifyEvidenceBundle(roundTripped).ok, true);
  });
});
