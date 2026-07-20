import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRANT_CONTRACT_VERSION, wrapGrantV1 } from './grant.js';
import { upcastLegacyGrantToV1 } from './upcasters/grant-legacy-to-v1.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('GrantV1', () => {
  it('fixture has all required fields', () => {
    const raw = readFileSync(join(__dirname, '../fixtures/grant/v1/minimal.json'), 'utf-8');
    const envelope = JSON.parse(raw);
    assert.equal(envelope.schemaVersion, GRANT_CONTRACT_VERSION);
    const required = [
      'schemaVersion', 'jti', 'tenantId', 'runId', 'stepId', 'effectTypes',
      'expiresAt', 'issuer', 'audience', 'issuedAt', 'notBefore', 'keyId',
      'requestHash', 'workloadId', 'policySnapshotId', 'nonce',
    ];
    for (const field of required) {
      assert.ok(field in envelope.payload, `missing ${field}`);
    }
  });

  it('legacy upcast fills schemaVersion and required defaults', () => {
    const grant = upcastLegacyGrantToV1(
      {
        jti: 'j1',
        tenantId: 't1',
        runId: 'r1',
        stepId: 's1',
        effectTypes: ['http.get'],
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
      { issuer: 'iss', audience: 'aud', keyId: 'k1' },
    );
    assert.equal(grant.schemaVersion, GRANT_CONTRACT_VERSION);
    assert.equal(grant.issuer, 'iss');
    assert.ok(grant.nonce);
  });

  it('wrapGrantV1 produces envelope', () => {
    const wrapped = wrapGrantV1({
      schemaVersion: GRANT_CONTRACT_VERSION,
      jti: 'j1',
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      effectTypes: [],
      expiresAt: '2026-12-31T00:00:00.000Z',
      issuer: 'i',
      audience: 'a',
      issuedAt: '2026-01-01T00:00:00.000Z',
      notBefore: '2026-01-01T00:00:00.000Z',
      keyId: 'k',
      requestHash: 'h',
      workloadId: 'w',
      policySnapshotId: 'p',
      nonce: 'n',
    });
    assert.equal(wrapped.kind, 'grant');
  });
});
