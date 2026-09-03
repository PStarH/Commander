/**
 * AUDIT-CORE1: every cryptographic key resolver must refuse dev-key fallback
 * under ANY recognised production signal — not NODE_ENV alone.
 */
import { test, describe } from 'vitest';
import * as assert from 'node:assert/strict';
import { isProductionCryptoEnv } from '../../src/security/productionEnv.js';
import { resolveMasterKey as resolveCapabilityMasterKey } from '../../src/security/capabilityToken.js';
import { resolveMasterKey as resolveVaultMasterKey } from '../../src/security/encryptedSecretsVault.js';
import { resolveFederationKey } from '../../src/security/federatedIdentity.js';

const GOOD_KEY = 'x'.repeat(32);

describe('isProductionCryptoEnv', () => {
  test('no signals → dev keys allowed', () => {
    assert.equal(isProductionCryptoEnv({}), false);
  });
  for (const signal of [
    { NODE_ENV: 'production' },
    { COMMANDER_ENV: 'production' },
    { COMMANDER_ENV: 'prod' },
  ] as const) {
    test(`${Object.keys(signal)[0]}=${Object.values(signal)[0]} is production`, () => {
      assert.equal(isProductionCryptoEnv(signal), true);
    });
  }
});

describe('capabilityToken key resolver (AUDIT-CORE1)', () => {
  test('COMMANDER_ENV=prod without a configured key refuses (baseline hole)', () => {
    // FAILING before the fix: only NODE_ENV gated this resolver, so a
    // deployment with just COMMANDER_ENV=prod silently issued capability
    // tokens signed with a public constant.
    assert.throws(
      () => resolveCapabilityMasterKey({ COMMANDER_ENV: 'prod' } as NodeJS.ProcessEnv),
      /must be set/,
    );
  });

  test('production with a proper key passes', () => {
    const key = resolveCapabilityMasterKey({
      NODE_ENV: 'production',
      COMMANDER_CAPABILITY_TOKEN_KEY: GOOD_KEY,
    } as NodeJS.ProcessEnv);
    assert.equal(key.length, 32);
  });

  test('dev without a key still returns the documented dev key (ergonomics preserved)', () => {
    const key = resolveCapabilityMasterKey({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    assert.ok(key.length > 0);
  });
});

describe('encryptedSecretsVault key resolver (AUDIT-CORE1)', () => {
  test('COMMANDER_ENV=prod without a key refuses (baseline hole)', () => {
    assert.throws(
      () => resolveVaultMasterKey({ COMMANDER_ENV: 'prod' } as NodeJS.ProcessEnv),
      /COMMANDER_MASTER_KEY/,
    );
  });
});

describe('federatedIdentity key resolver (AUDIT-CORE1)', () => {
  test('COMMANDER_ENV=prod without a key refuses (baseline hole)', () => {
    assert.throws(
      () => resolveFederationKey({ COMMANDER_ENV: 'prod' } as NodeJS.ProcessEnv),
      /required|must be set/i,
    );
  });
});
