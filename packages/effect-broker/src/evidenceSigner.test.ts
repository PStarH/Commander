import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEvidenceSigner, verifyEvidenceSignature } from './evidenceSigner.js';

describe('signed evidence Ed25519 authority', () => {
  it('uses the configured key id and private key across signer recreation', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const first = createEvidenceSigner({ privateKeyPem, keyId: 'cell-2026-01' });
    const second = createEvidenceSigner({ privateKeyPem, keyId: 'cell-2026-01' });
    const signature = await first.sign('{"receipt":1}');
    assert.equal(signature.algorithm, 'Ed25519');
    assert.equal(signature.keyId, 'cell-2026-01');
    assert.equal(second.verify('{"receipt":1}', signature), true);
    assert.equal(second.verify('{"receipt":2}', signature), false);
    assert.equal(verifyEvidenceSignature('{"receipt":1}', signature, first.jwks), true);
  });

  it('rejects missing or non-Ed25519 signing material', () => {
    assert.throws(
      () => createEvidenceSigner({ privateKeyPem: '', keyId: 'cell-1' }),
      /EVIDENCE_SIGNING_KEY_REQUIRED/,
    );
    assert.throws(
      () => createEvidenceSigner({ privateKeyPem: 'not-a-key', keyId: 'cell-1' }),
      /EVIDENCE_SIGNING_KEY_INVALID/,
    );
  });
});
