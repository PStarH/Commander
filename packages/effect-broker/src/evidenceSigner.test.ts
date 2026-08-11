import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEvidenceSigner, verifyEvidenceSignature } from './evidenceSigner.js';

describe('evidence signer', () => {
  it('publishes a JWKS entry that verifies its Ed25519 signature', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'cell-1',
    });
    const body = '{"receipt":1}';
    const signature = await signer.sign(body);

    assert.equal(signer.verify(body, signature), true);
    assert.equal(verifyEvidenceSignature(body, signature, signer.jwks), true);
    assert.equal(verifyEvidenceSignature(body + 'x', signature, signer.jwks), false);
  });

  it('rejects non-Ed25519 signing keys', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(
      () =>
        createEvidenceSigner({
          privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          keyId: 'invalid-key',
        }),
      /EVIDENCE_SIGNING_KEY_INVALID/,
    );
  });
});
