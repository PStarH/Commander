import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShadowContractError, parseShadowManifest, parseShadowObservation } from './contracts.js';

const digest = 'a'.repeat(64);
const signature = Buffer.alloc(64, 1).toString('base64url');

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'commander.shadow-observation/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    batchId: 'batch-1',
    index: 0,
    observationId: 'observation-1',
    occurredAt: '2026-09-01T00:00:00.000Z',
    workflow: 'kubernetes.deployment.rollback',
    effectType: 'connector.kubernetes.deployment.rollback',
    tool: 'kubernetes.deployment.rollback',
    destination: 'k8s://cluster-1/namespace-1/deployments/api',
    productionDecision: 'require_approval',
    productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'commander.shadow-manifest/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    policyId: 'action-gateway-mvp-v1',
    policyDigest: digest,
    batchId: 'batch-1',
    closesAt: '2026-09-02T00:00:00.000Z',
    records: [{ index: 0, observationId: 'observation-1', digest }],
    keyId: 'manifest-key-1',
    signature,
    ...overrides,
  };
}

function expectCode(run: () => unknown, code: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof ShadowContractError && error.code === code,
  );
}

describe('strict shadow contracts', () => {
  it('parses canonical manifest and observation values without preserving caller mutation', () => {
    const rawObservation = observation();
    const parsedObservation = parseShadowObservation(rawObservation);
    rawObservation.tenantId = 'changed';
    assert.equal(parsedObservation.tenantId, 'tenant-1');

    const rawManifest = manifest();
    const parsedManifest = parseShadowManifest(rawManifest);
    (rawManifest.records as Array<Record<string, unknown>>)[0]!.digest = 'b'.repeat(64);
    assert.equal(parsedManifest.records[0]!.digest, digest);
  });

  it('rejects unknown, missing, and prohibited free-form fields', () => {
    expectCode(
      () => parseShadowObservation(observation({ prompt: 'secret' })),
      'SHADOW_UNKNOWN_FIELD',
    );
    const missing = observation();
    delete missing.workflow;
    expectCode(() => parseShadowObservation(missing), 'SHADOW_MISSING_FIELD');
    expectCode(() => parseShadowManifest(manifest({ headers: {} })), 'SHADOW_UNKNOWN_FIELD');
  });

  it('enforces identifiers, enums, timestamps, digests, and supported workflow', () => {
    expectCode(
      () => parseShadowObservation(observation({ tenantId: 'x'.repeat(129) })),
      'SHADOW_INVALID_IDENTIFIER',
    );
    expectCode(
      () => parseShadowObservation(observation({ tenantId: '企业' })),
      'SHADOW_INVALID_IDENTIFIER',
    );
    expectCode(
      () => parseShadowObservation(observation({ workflow: 'github.pull-request.create' })),
      'SHADOW_UNSUPPORTED_WORKFLOW',
    );
    expectCode(
      () => parseShadowObservation(observation({ productionDecision: 'approved' })),
      'SHADOW_INVALID_DECISION',
    );
    expectCode(
      () => parseShadowObservation(observation({ productionReasonCode: 'free form' })),
      'SHADOW_INVALID_REASON_CODE',
    );
    expectCode(
      () => parseShadowObservation(observation({ occurredAt: '2026-09-01' })),
      'SHADOW_INVALID_TIMESTAMP',
    );
    expectCode(
      () => parseShadowManifest(manifest({ policyDigest: digest.toUpperCase() })),
      'SHADOW_INVALID_DIGEST',
    );
    expectCode(
      () => parseShadowManifest(manifest({ signature: 'AQID' })),
      'SHADOW_INVALID_SIGNATURE',
    );
  });

  it('uses explicit null only for missing evaluator facts', () => {
    const parsed = parseShadowObservation(
      observation({ effectType: null, tool: null, destination: null }),
    );
    assert.equal(parsed.effectType, null);
    assert.equal(parsed.tool, null);
    assert.equal(parsed.destination, null);
  });

  it('requires unique contiguous indexes and observation identities', () => {
    expectCode(() => parseShadowManifest(manifest({ records: [] })), 'SHADOW_RECORD_LIMIT');
    expectCode(
      () =>
        parseShadowManifest(manifest({ records: [{ index: 1, observationId: 'o-1', digest }] })),
      'SHADOW_INDEX_SEQUENCE',
    );
    expectCode(
      () =>
        parseShadowManifest(
          manifest({
            records: [
              { index: 0, observationId: 'same', digest },
              { index: 1, observationId: 'same', digest },
            ],
          }),
        ),
      'SHADOW_DUPLICATE_OBSERVATION',
    );
    const records = Array.from({ length: 10_001 }, (_, index) => ({
      index,
      observationId: `o-${index}`,
      digest,
    }));
    expectCode(() => parseShadowManifest(manifest({ records })), 'SHADOW_RECORD_LIMIT');
  });

  it('enforces the canonical 16 KiB observation and 2 MiB manifest limits', () => {
    expectCode(
      () => parseShadowObservation(observation({ destination: `k8s://${'x'.repeat(17_000)}` })),
      'SHADOW_SIZE_LIMIT',
    );
    const records = Array.from({ length: 10_000 }, (_, index) => ({
      index,
      observationId: `observation-${index}-${'x'.repeat(128 - `observation-${index}-`.length)}`,
      digest,
    }));
    expectCode(() => parseShadowManifest(manifest({ records })), 'SHADOW_SIZE_LIMIT');
  });
});
