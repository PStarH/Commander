import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import {
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  createCapabilityAuthority,
} from './capabilityAuthority.js';
import { KernelCapabilityReplayStore, KernelCapabilityRevocationStore } from './capabilityStores.js';

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

function baseGrant(overrides: Record<string, unknown> = {}) {
  return {
    jti: 'jti-1',
    tenantId: 'tenant-a',
    runId: 'run-1',
    stepId: 'step-1',
    effectTypes: ['http.request'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: 'nonce-1',
    ...overrides,
  };
}

describe('KernelCapabilityReplayStore / KernelCapabilityRevocationStore', () => {
  it('consumes jti:nonce once per tenant and reports replay on second consume', async () => {
    const repo = new InMemoryKernelRepository();
    const store = new KernelCapabilityReplayStore(repo, 'tenant-a');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    assert.equal(await store.consume('jti-1:nonce-1', expiresAt), false);
    assert.equal(await store.consume('jti-1:nonce-1', expiresAt), true);
    // Different tenant is a separate identity.
    const other = KernelCapabilityReplayStore.forTenant(repo, 'tenant-b');
    assert.equal(await other.consume('jti-1:nonce-1', expiresAt), false);
  });

  it('revokes via revokeGrant and surfaces isRevoked', async () => {
    const repo = new InMemoryKernelRepository();
    const store = new KernelCapabilityRevocationStore(repo);
    assert.equal(await store.isRevoked('jti-x', 'tenant-a'), false);
    await store.revokeGrant({
      jti: 'jti-x',
      tenantId: 'tenant-a',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reason: 'test',
    });
    assert.equal(await store.isRevoked('jti-x', 'tenant-a'), true);
    assert.equal(await store.isRevoked('jti-x', 'tenant-b'), false);
  });

  it('same jti may be revoked independently per tenant (tenant-scoped PK)', async () => {
    const repo = new InMemoryKernelRepository();
    const store = new KernelCapabilityRevocationStore(repo);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await store.revokeGrant({ jti: 'shared-jti', tenantId: 'tenant-a', expiresAt, reason: 'a' });
    await store.revokeGrant({ jti: 'shared-jti', tenantId: 'tenant-b', expiresAt, reason: 'b' });
    assert.equal(await store.isRevoked('shared-jti', 'tenant-a'), true);
    assert.equal(await store.isRevoked('shared-jti', 'tenant-b'), true);
    assert.equal(await store.isRevoked('shared-jti', 'tenant-c'), false);
  });

  it('isRevoked fails closed without tenantId', async () => {
    const repo = new InMemoryKernelRepository();
    const store = new KernelCapabilityRevocationStore(repo);
    await assert.rejects(
      () => store.isRevoked('jti-z', ''),
      /CAPABILITY_REVOCATION_TENANT_REQUIRED/,
    );
  });

  it('bare revoke fails closed without defaultTenantId', async () => {
    const repo = new InMemoryKernelRepository();
    const store = new KernelCapabilityRevocationStore(repo);
    await assert.rejects(
      () => store.revoke('jti-y', new Date(Date.now() + 60_000).toISOString()),
      /CAPABILITY_REVOCATION_TENANT_REQUIRED/,
    );
  });
});

describe('createCapabilityAuthority', () => {
  it('loads PEM+JWKS+key id and issues/verifies with durable replay', async () => {
    const mat = ed25519Material('kid-stable');
    const repo = new InMemoryKernelRepository();
    const authority = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
      { issuer: 'commander-test', audience: 'commander.effect-broker' },
    );
    assert.equal(authority.generated, false);
    assert.equal(authority.keyId, 'kid-stable');

    const token = authority.issuer.issue(baseGrant());
    const grant = await authority.verifier.verify(token);
    assert.equal(grant.jti, 'jti-1');
    assert.equal(grant.tenantId, 'tenant-a');

    await assert.rejects(() => authority.verifier.verify(token), /replayed/);
  });

  it('rejects revoked jti before adapter invocation completes admit path', async () => {
    const mat = ed25519Material('kid-rev');
    const repo = new InMemoryKernelRepository();
    const authority = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    const token = authority.issuer.issue(baseGrant({ jti: 'jti-rev', nonce: 'n-rev' }));
    await authority.revocations.revokeGrant({
      jti: 'jti-rev',
      tenantId: 'tenant-a',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await assert.rejects(() => authority.verifier.verify(token), /revoked/);
  });

  it('rejects unknown kid', async () => {
    const mat = ed25519Material('kid-a');
    const other = ed25519Material('kid-b');
    const repo = new InMemoryKernelRepository();
    const authority = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    // Mint with a different key id embedded via a separate issuer — forge header kid.
    const foreignIssuer = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: other.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: other.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: other.jwksJson,
      },
      repo,
    );
    const token = foreignIssuer.issuer.issue(baseGrant({ jti: 'jti-foreign', nonce: 'n-f' }));
    await assert.rejects(() => authority.verifier.verify(token), /Unknown capability token key id/);
  });

  it('production throws CAPABILITY_AUTHORITY_REQUIRED when PEM missing', () => {
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createCapabilityAuthority(
          {
            NODE_ENV: 'production',
            [CAPABILITY_KEY_ID_ENV]: 'kid',
            [CAPABILITY_JWKS_JSON_ENV]: '{"keys":[]}',
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED),
    );
  });

  it('enterprise throws CAPABILITY_AUTHORITY_REQUIRED when JWKS missing', () => {
    const mat = ed25519Material('kid-e');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createCapabilityAuthority(
          {
            NODE_ENV: 'development',
            COMMANDER_PROFILE: 'enterprise',
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
            [CAPABILITY_KEY_ID_ENV]: mat.keyId,
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED),
    );
  });

  it('COMMANDER_CELL_TIER=enterprise refuses generate when materials missing', () => {
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createCapabilityAuthority(
          {
            NODE_ENV: 'development',
            COMMANDER_CELL_TIER: 'enterprise',
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED),
    );
  });

  it('COMMANDER_CELL_TIER=enterprise throws CAPABILITY_AUTHORITY_REQUIRED when PEM missing', () => {
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createCapabilityAuthority(
          {
            NODE_ENV: 'development',
            COMMANDER_CELL_TIER: 'enterprise',
            [CAPABILITY_KEY_ID_ENV]: 'kid',
            [CAPABILITY_JWKS_JSON_ENV]: '{"keys":[]}',
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED),
    );
  });

  it('production throws when private key does not match JWKS', () => {
    const a = ed25519Material('kid-m');
    const b = ed25519Material('kid-m');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createCapabilityAuthority(
          {
            NODE_ENV: 'production',
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: a.privateKeyPem,
            [CAPABILITY_KEY_ID_ENV]: a.keyId,
            // JWKS from a different keypair with same kid
            [CAPABILITY_JWKS_JSON_ENV]: b.jwksJson,
          },
          repo,
        ),
      /does not match JWKS/,
    );
  });

  it('rejects placeholder PEM content (REPLACE_ME) even outside production', () => {
    const repo = new InMemoryKernelRepository();
    const mat = ed25519Material('kid-ph');
    assert.throws(
      () =>
        createCapabilityAuthority(
          {
            NODE_ENV: 'test',
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: '-----BEGIN PRIVATE KEY-----\nREPLACE_ME\n-----END PRIVATE KEY-----\n',
            [CAPABILITY_KEY_ID_ENV]: mat.keyId,
            [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        /placeholder/i.test(err.message),
    );
  });

  it('rejects placeholder JWKS content (DEMO_ONLY) even outside production', () => {
    const repo = new InMemoryKernelRepository();
    const mat = ed25519Material('kid-ph2');
    assert.throws(
      () =>
        createCapabilityAuthority(
          {
            NODE_ENV: 'test',
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
            [CAPABILITY_KEY_ID_ENV]: mat.keyId,
            [CAPABILITY_JWKS_JSON_ENV]: '{"keys":[],"note":"DEMO_ONLY"}',
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        /placeholder/i.test(err.message),
    );
  });

  it('rejects placeholder key id content (changeme) even outside production', () => {
    const repo = new InMemoryKernelRepository();
    const mat = ed25519Material('kid-ph3');
    assert.throws(
      () =>
        createCapabilityAuthority(
          {
            NODE_ENV: 'test',
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
            [CAPABILITY_KEY_ID_ENV]: 'changeme',
            [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        /placeholder/i.test(err.message),
    );
  });

  it('non-production may generate ephemeral keys when env missing', async () => {
    const repo = new InMemoryKernelRepository();
    const authority = createCapabilityAuthority({ NODE_ENV: 'test' }, repo, {
      issuer: 'commander-dev',
    });
    assert.equal(authority.generated, true);
    const token = authority.issuer.issue(baseGrant({ jti: 'jti-gen', nonce: 'n-gen' }));
    const grant = await authority.verifier.verify(token);
    assert.equal(grant.jti, 'jti-gen');
  });

  it('cross-process replay: token consumed via repository is rejected by second authority', async () => {
    const mat = ed25519Material('kid-x');
    const env = {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: mat.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
    };
    const shared = new InMemoryKernelRepository();
    const processA = createCapabilityAuthority(env, shared);
    const processB = createCapabilityAuthority(env, shared);
    const token = processA.issuer.issue(baseGrant({ jti: 'jti-shared', nonce: 'n-shared' }));
    await processA.verifier.verify(token);
    await assert.rejects(() => processB.verifier.verify(token), /replayed/);
  });

  it('restart with same PEM/JWKS verifies previously issued tokens (first consume)', async () => {
    const mat = ed25519Material('kid-restart');
    const env = {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: mat.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
    };
    const repo = new InMemoryKernelRepository();
    const before = createCapabilityAuthority(env, repo);
    const token = before.issuer.issue(baseGrant({ jti: 'jti-r', nonce: 'n-r' }));
    // Simulate restart: new authority instance, empty in-process state, same durable repo keys.
    const after = createCapabilityAuthority(env, new InMemoryKernelRepository());
    // Fresh repo → first verify succeeds (proves key material reload, not process-local map).
    const grant = await after.verifier.verify(token);
    assert.equal(grant.keyId, 'kid-restart');
    // Same PEM still loads via createPrivateKey / createPublicKey.
    assert.ok(createPrivateKey(mat.privateKeyPem));
    const jwk = JSON.parse(mat.jwksJson).keys[0] as { kty: string; crv: string; x: string; kid: string };
    assert.ok(createPublicKey({ key: jwk, format: 'jwk' }));
  });
});
