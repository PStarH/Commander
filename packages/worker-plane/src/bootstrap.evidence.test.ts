import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createWorkerEvidenceSigner,
  EVIDENCE_SIGNING_KEY_ID_ENV,
  EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV,
} from './bootstrap.js';

describe('worker signed evidence startup', () => {
  it('fails closed in production unless both Ed25519 settings exist', () => {
    assert.throws(
      () => createWorkerEvidenceSigner({ NODE_ENV: 'production' }),
      /EVIDENCE_SIGNING_KEY_REQUIRED/,
    );

    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createWorkerEvidenceSigner({
      NODE_ENV: 'production',
      [EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]: privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      [EVIDENCE_SIGNING_KEY_ID_ENV]: 'worker-evidence-key',
    });
    assert.equal(signer?.jwks.keys[0]?.kid, 'worker-evidence-key');
  });
});
