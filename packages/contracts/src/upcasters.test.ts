import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { upcastLegacyGrantToV1, getLegacyGrantUpcastCount } from './upcasters/grant-legacy-to-v1.js';
import { toEffectContractV2 } from './effectContract.js';
import { GRANT_CONTRACT_VERSION } from './grant.js';

describe('upcasters', () => {
  it('grant legacy upcast increments audit counter', () => {
    const before = getLegacyGrantUpcastCount();
    upcastLegacyGrantToV1(
      { jti: 'j', tenantId: 't', runId: 'r', stepId: 's', effectTypes: [], expiresAt: '2026-12-31T00:00:00.000Z' },
      { issuer: 'i', audience: 'a', keyId: 'k' },
    );
    assert.equal(getLegacyGrantUpcastCount(), before + 1);
  });

  it('grant upcast sets commander.grant/v1', () => {
    const g = upcastLegacyGrantToV1(
      { jti: 'j', tenantId: 't', runId: 'r', stepId: 's', effectTypes: ['x'], expiresAt: '2026-12-31T00:00:00.000Z' },
      { issuer: 'i', audience: 'a', keyId: 'k', workloadId: 'w' },
    );
    assert.equal(g.schemaVersion, GRANT_CONTRACT_VERSION);
  });

  it('effect envelope to v2 preserves compensatesEffectId', () => {
    const c = toEffectContractV2(
      {
        effect_id: 'e2',
        tenant_id: 't',
        run_id: 'r',
        step_id: 's',
        action: 'compensate.http.delete',
        payload: {},
        idempotency_key: 'idem-12345678',
        status: 'completed',
      },
      {
        adapterId: 'a',
        adapterVersion: '1',
        requestDigest: 'd',
        policyDecisionId: 'p',
        fencingEpoch: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        compensatesEffectId: 'e1',
      },
    );
    assert.equal(c.payload.compensatesEffectId, 'e1');
    assert.equal(c.payload.status, 'COMPLETED');
  });
});
