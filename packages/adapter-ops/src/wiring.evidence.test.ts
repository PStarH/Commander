import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createAdapterOpsEvidenceSigner,
  createAdapterOpsWiring,
  EVIDENCE_SIGNING_KEY_ID_ENV,
  EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV,
} from './wiring.js';

describe('adapter-ops signed evidence startup', () => {
  it('fails closed in production unless both Ed25519 settings exist', () => {
    assert.throws(
      () => createAdapterOpsEvidenceSigner({ NODE_ENV: 'production' }),
      /EVIDENCE_SIGNING_KEY_REQUIRED/,
    );

    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createAdapterOpsEvidenceSigner({
      NODE_ENV: 'production',
      [EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]: privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      [EVIDENCE_SIGNING_KEY_ID_ENV]: 'adapter-evidence-key',
    });
    assert.equal(signer?.jwks.keys[0]?.kid, 'adapter-evidence-key');
  });

  it('rejects missing evidence key before production wiring creates a repository', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      privateKey: process.env[EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV],
      keyId: process.env[EVIDENCE_SIGNING_KEY_ID_ENV],
    };
    process.env.NODE_ENV = 'production';
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    delete process.env[EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV];
    delete process.env[EVIDENCE_SIGNING_KEY_ID_ENV];
    try {
      await assert.rejects(() => createAdapterOpsWiring(), /EVIDENCE_SIGNING_KEY_REQUIRED/);
    } finally {
      if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.COMMANDER_ADAPTER_OPS_DEMO_OPEN === undefined) {
        delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
      } else {
        process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = saved.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
      }
      if (saved.privateKey === undefined) delete process.env[EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV];
      else process.env[EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV] = saved.privateKey;
      if (saved.keyId === undefined) delete process.env[EVIDENCE_SIGNING_KEY_ID_ENV];
      else process.env[EVIDENCE_SIGNING_KEY_ID_ENV] = saved.keyId;
    }
  });
});
