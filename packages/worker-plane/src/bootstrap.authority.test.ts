import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
} from '@commander/kernel';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import {
  assertDurableCapabilityStores,
  assertNonOwnerDatabaseRole,
  assertNonOwnerDatabaseUrl,
  CAPABILITY_DURABLE_STORES_REQUIRED,
  createEffectBroker,
  OWNER_DATABASE_ROLE_REJECTED,
  productionCapabilityBrokerOptions,
} from './bootstrap.js';

function ed25519Material(kid: string): {
  privateKeyPem: string;
  jwksJson: string;
  keyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const jwksJson = JSON.stringify({
    keys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: jwk.x, alg: 'EdDSA', use: 'sig' }],
  });
  return { privateKeyPem, jwksJson, keyId: kid };
}

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('worker-plane authority startup gates', () => {
  it('rejects missing private key before poll (production)', () => {
    const mat = ed25519Material('kid-wp');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createEffectBroker(
          repo as never,
          'worker-1',
          productionEnv({
            [CAPABILITY_KEY_ID_ENV]: mat.keyId,
            [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
          }),
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        err.message.includes(CAPABILITY_PRIVATE_KEY_PEM_ENV),
    );
  });

  it('rejects missing JWKS before poll (production)', () => {
    const mat = ed25519Material('kid-wp');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createEffectBroker(
          repo as never,
          'worker-1',
          productionEnv({
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
            [CAPABILITY_KEY_ID_ENV]: mat.keyId,
          }),
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        err.message.includes(CAPABILITY_JWKS_JSON_ENV),
    );
  });

  it('rejects missing key id before poll (production)', () => {
    const mat = ed25519Material('kid-wp');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createEffectBroker(
          repo as never,
          'worker-1',
          productionEnv({
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
            [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
          }),
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        err.message.includes(CAPABILITY_KEY_ID_ENV),
    );
  });

  it('rejects owner-role DSN userinfo (no false-positive on commander_worker)', () => {
    assert.throws(
      () =>
        assertNonOwnerDatabaseUrl(
          'postgres://commander_owner:commander_owner@postgres:5432/commander',
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.throws(
      () => assertNonOwnerDatabaseUrl('postgresql://commander_owner@127.0.0.1/db'),
      /OWNER_DATABASE_ROLE_REJECTED/,
    );
    // Task 1 worker-url must not false-positive.
    assert.doesNotThrow(() =>
      assertNonOwnerDatabaseUrl(
        'postgres://commander_worker:commander_worker@postgres:5432/commander',
      ),
    );
    assert.doesNotThrow(() =>
      assertNonOwnerDatabaseUrl(
        'postgres://commander_app:commander_app@postgres:5432/commander',
      ),
    );
  });

  it('rejects post-connect current_user matching owner', () => {
    assert.throws(
      () => assertNonOwnerDatabaseRole('commander_owner'),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.doesNotThrow(() => assertNonOwnerDatabaseRole('commander_worker'));
  });

  it('rejects unavailable replay store before poll', () => {
    const mat = ed25519Material('kid-replay');
    const repo = new InMemoryKernelRepository();
    const { capability } = createEffectBroker(
      repo as never,
      'worker-1',
      productionEnv({
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      }),
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(capability, {
          isCapabilityRevoked: () => false,
          revokeCapability: async () => undefined,
          // consumeCapabilityReplay intentionally absent
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        err.message.includes('consumeCapabilityReplay'),
    );
  });

  it('rejects unavailable revocation store before poll', () => {
    const mat = ed25519Material('kid-rev');
    const repo = new InMemoryKernelRepository();
    const { capability } = createEffectBroker(
      repo as never,
      'worker-1',
      productionEnv({
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      }),
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(capability, {
          consumeCapabilityReplay: async () => false,
          // isCapabilityRevoked / revokeCapability intentionally absent
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        /isCapabilityRevoked|revokeCapability/.test(err.message),
    );
  });

  it('wires durable replay + revocations on EffectBroker options (no generate path)', () => {
    const mat = ed25519Material('kid-ok');
    const repo = new InMemoryKernelRepository();
    const { capability, issuer, broker } = createEffectBroker(
      repo as never,
      'worker-1',
      productionEnv({
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      }),
    );
    assert.equal(capability.generated, false);
    assert.ok(issuer);
    assert.ok(broker);
    const opts = productionCapabilityBrokerOptions(capability, 'worker-1');
    assert.ok(opts.replay);
    assert.equal(typeof opts.replay, 'function');
    assert.ok(opts.revocations);
    assert.equal(opts.requireDurableCapabilityStores, true);
    assert.equal(opts.requireRequestBinding, true);
    assert.equal(opts.localWorkerId, 'worker-1');
  });
});
