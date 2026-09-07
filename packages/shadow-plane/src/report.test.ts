import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { actionGatewayPolicySnapshot } from '@commander/contracts';
import { canonicalBytes, sha256Hex } from './canonical.js';
import { parseShadowObservation } from './contracts.js';
import { observationDigest } from './evaluator.js';
import type { ShadowCampaignReportData } from './repository.js';
import { buildSignedShadowReport, verifyShadowReport } from './report.js';

const pair = generateKeyPairSync('ed25519');
const wrong = generateKeyPairSync('ed25519');
const snapshot = actionGatewayPolicySnapshot();

function reportData(): ShadowCampaignReportData {
  const records: Record<string, unknown>[] = [];
  const manifestRecords: Record<string, unknown>[] = [];
  for (let index = 0; index < 100; index += 1) {
    const observation = parseShadowObservation({
      schema: 'commander.shadow-observation/v1',
      campaignId: 'campaign-100',
      tenantId: 'tenant-1',
      producerId: 'producer-1',
      batchId: 'batch-100',
      index,
      observationId: `observation-${index}`,
      occurredAt: '2026-09-01T00:00:00.000Z',
      workflow: 'kubernetes.deployment.rollback',
      effectType: 'connector.kubernetes.deployment.rollback',
      tool: 'kubernetes.deployment.rollback',
      destination: 'k8s://cluster/namespace/deployments/api',
      productionDecision: index < 20 ? 'allow' : index < 80 ? 'require_approval' : 'unknown',
      productionReasonCode: index >= 20 && index < 80 ? 'REGISTERED_ADAPTER_POLICY' : undefined,
    });
    manifestRecords.push({
      index,
      observationId: observation.observationId,
      digest: observationDigest(observation),
    });
    let status = 'failed';
    if (index < 80) status = 'compared';
    else if (index < 90) status = 'uncomparable';
    else if (index < 95) status = 'missing';
    else if (index < 98) status = 'rejected';
    records.push({
      batch_id: 'batch-100',
      record_index: index,
      observation_id: observation.observationId,
      digest: observationDigest(observation),
      status,
      ...(status === 'rejected' || status === 'failed'
        ? {
            attempt_digest: 'b'.repeat(64),
            attempt_code:
              status === 'rejected' ? 'SHADOW_INVALID_DECISION' : 'SHADOW_EVALUATION_FAILED',
            attempted_at: '2026-09-01T01:00:00.000Z',
          }
        : {}),
      ...(index < 90
        ? {
            canonical_observation: observation,
            hypothetical_decision: 'require_approval',
            hypothetical_decision_id: 'action-gateway-manifest-require_approval',
            hypothetical_reason_code: 'REGISTERED_ADAPTER_POLICY',
            production_decision: observation.productionDecision,
            production_reason_code: observation.productionReasonCode ?? null,
            comparison: index < 20 ? 'mismatch' : index < 80 ? 'match' : 'uncomparable',
          }
        : {}),
    });
  }
  const manifest = {
    schema: 'commander.shadow-manifest/v1',
    campaignId: 'campaign-100',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    policyId: snapshot.policyId,
    policyDigest: snapshot.descriptorDigest,
    batchId: 'batch-100',
    closesAt: '2026-09-02T00:00:00.000Z',
    records: manifestRecords,
    keyId: 'manifest-key-1',
    signature: Buffer.alloc(64, 1).toString('base64url'),
  };
  return {
    campaign: {
      campaign_id: 'campaign-100',
      policy_id: snapshot.policyId,
      policy_digest: snapshot.descriptorDigest,
      state: 'open',
    },
    batches: [
      {
        batch_id: 'batch-100',
        state: 'closed',
        manifest_digest: sha256Hex(canonicalBytes(manifest)),
        manifest,
      },
    ],
    records,
  };
}

describe('signed historical evaluation report', () => {
  it('reports the exact 100-record denominator and all terminal states without cost or proof claims', () => {
    const bundle = buildSignedShadowReport(reportData(), {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
    });
    assert.deepEqual(bundle.counts, {
      expected: 100,
      missing: 5,
      rejected: 3,
      failed: 2,
      uncomparable: 10,
      compared: 80,
      matches: 60,
      mismatches: 20,
    });
    assert.equal(bundle.decisionMatrix.allow.require_approval, 20);
    assert.equal(bundle.decisionMatrix.require_approval.require_approval, 60);
    assert.deepEqual(Object.keys(bundle.decisionMatrix), ['allow', 'deny', 'require_approval']);
    assert.equal(bundle.differences.length, 20);
    assert.equal(bundle.differences[0]?.productionDecision, 'allow');
    assert.deepEqual(bundle.records[95]?.attempt, {
      digest: 'b'.repeat(64),
      code: 'SHADOW_INVALID_DECISION',
      attemptedAt: '2026-09-01T01:00:00.000Z',
    });
    const serialized = JSON.stringify(bundle);
    assert.doesNotMatch(serialized, /cost/i);
    assert.doesNotMatch(serialized, /PROVEN|production-ready|customer-accepted/i);
  });

  it('verifies hashes, signature, counts, and deterministic re-evaluation', () => {
    const bundle = buildSignedShadowReport(reportData(), {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
    });
    const trust = {
      algorithm: 'Ed25519' as const,
      keyId: 'report-key-1',
      status: 'active' as const,
      publicKey: pair.publicKey,
    };
    assert.deepEqual(verifyShadowReport(bundle, trust), {
      valid: true,
      code: 'SHADOW_REPORT_VALID',
    });
    assert.deepEqual(verifyShadowReport(bundle, { ...trust, publicKey: wrong.publicKey }), {
      valid: false,
      code: 'SHADOW_REPORT_SIGNATURE_INVALID',
    });
    assert.deepEqual(verifyShadowReport(bundle, { ...trust, status: 'revoked' }), {
      valid: false,
      code: 'SHADOW_REPORT_KEY_REVOKED',
    });
    assert.deepEqual(verifyShadowReport(bundle, { ...trust, keyId: 'replacement-key' }), {
      valid: false,
      code: 'SHADOW_REPORT_KEY_ID_MISMATCH',
    });
    const tampered = structuredClone(bundle);
    tampered.records[0]!.hypotheticalDecision = 'deny';
    assert.equal(verifyShadowReport(tampered, trust).valid, false);

    const inconsistent = structuredClone(bundle);
    inconsistent.records[20]!.observationId = 'other-observation';
    inconsistent.hashes.recordsSha256 = sha256Hex(canonicalBytes(inconsistent.records));
    const { signature: _signature, ...body } = inconsistent;
    inconsistent.signature = sign(null, canonicalBytes(body), pair.privateKey).toString(
      'base64url',
    );
    assert.deepEqual(verifyShadowReport(inconsistent, trust), {
      valid: false,
      code: 'SHADOW_REPORT_MANIFEST_RECORD_MISMATCH',
    });
  });

  it('rejects report creation while any batch remains open', () => {
    const data = reportData();
    data.batches[0]!.state = 'open';
    assert.throws(
      () =>
        buildSignedShadowReport(data, {
          keyId: 'report-key-1',
          privateKey: pair.privateKey,
          generatedAt: '2026-09-03T00:00:00.000Z',
          sourceRevision: 'abc123',
        }),
      /SHADOW_REPORT_BATCH_OPEN/,
    );
  });
});
