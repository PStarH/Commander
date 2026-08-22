import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AuthPluginResult } from '@commander/core';
import { TestUserRepository } from './authRepositories'; import type { RefreshTokenRecord, RefreshTokenRepository } from '../src/refreshTokenStore';

const originalCwd = process.cwd();
const originalEnv = {
  JWT_SECRET: process.env.JWT_SECRET,
  OIDC_ISSUER: process.env.OIDC_ISSUER,
  OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
  OIDC_ENABLED: process.env.OIDC_ENABLED,
  OIDC_DEFAULT_TENANT_ID: process.env.OIDC_DEFAULT_TENANT_ID,
  OIDC_TENANT_CLAIM: process.env.OIDC_TENANT_CLAIM,
  COMMANDER_DEFAULT_TENANT_ID: process.env.COMMANDER_DEFAULT_TENANT_ID,
};
const tmpDir = path.join(os.tmpdir(), `commander-oidc-binding-${crypto.randomUUID()}`);

fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = 'oidc-binding-test-secret-at-least-32-chars';
process.env.OIDC_ISSUER = 'https://idp.example.test';
process.env.OIDC_CLIENT_ID = 'commander-test-client';
process.env.OIDC_ENABLED = 'true';
process.env.COMMANDER_DEFAULT_TENANT_ID = 'deployment-default';

const { createOIDCAuthRouter } = await import('../src/oidcAuthEndpoints');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints');
const { createUser, findUserByEmail, findUserByOidcIdentity, setUserRepositoryForTesting } =
  await import('../src/userStore');
const { verifyToken } = await import('../src/jwtMiddleware');
const { SimpleTenantProvider, setGlobalTenantProvider, resetGlobalTenantProvider } =
  await import('@commander/core/runtime');

let result: AuthPluginResult;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;
let users: TestUserRepository;
class TestRefreshTokenRepository implements RefreshTokenRepository {
  readonly records = new Map<string, RefreshTokenRecord & { revoked: boolean }>();
  unavailable = false;

  async insert(record: RefreshTokenRecord): Promise<void> {
    if (this.unavailable) throw new Error('postgres authority failed: secret-dsn');
    this.records.set(record.jti, { ...record, revoked: false });
  }

  async consume(jti: string): Promise<boolean> {
    if (this.unavailable) throw new Error('postgres authority failed: secret-dsn');
    const record = this.records.get(jti);
    if (!record || record.revoked || record.expiresAt.getTime() <= Date.now()) return false;
    record.revoked = true;
    return true;
  }

  async revoke(jti: string): Promise<void> {
    if (this.unavailable) throw new Error('postgres authority failed: secret-dsn');
    const record = this.records.get(jti);
    if (record) record.revoked = true;
  }
}

const refreshTokens = new TestRefreshTokenRepository();
const LOCAL_TEST_PASSWORD = ['local', 'password'].join('-');

function oidcResult(overrides: Partial<AuthPluginResult> = {}): AuthPluginResult {
  return {
    userId: 'subject-alice',
    username: 'alice@example.test',
    role: 'operator',
    tenantId: 'tenant-a',
    claims: {
      iss: 'https://idp.example.test',
      sub: 'subject-alice',
      email: 'alice@example.test',
      email_verified: true,
      tenant_id: 'tenant-a',
    },
    ...overrides,
  };
}

async function exchange(idToken = 'validated-id-token') {
  return fetch(`${baseUrl}/api/auth/oidc/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    createOIDCAuthRouter({
      authenticate: async () => result,
      refreshTokens,
    }),
  );
  app.use(createUserAuthRouter({ refreshTokens }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  resetGlobalTenantProvider();
  delete process.env.OIDC_DEFAULT_TENANT_ID;
  delete process.env.OIDC_TENANT_CLAIM;
  process.env.COMMANDER_DEFAULT_TENANT_ID = 'deployment-default';
  users = new TestUserRepository();
  setUserRepositoryForTesting(users);
  refreshTokens.records.clear();
  refreshTokens.unavailable = false;
  result = oidcResult();
});

after(async () => {
  resetGlobalTenantProvider();
  setUserRepositoryForTesting(undefined);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OIDC exchange identity and tenant binding', () => {
  it('rejects a valid multi-tenant token with no tenant claim before minting tokens', async () => {
    setGlobalTenantProvider(new SimpleTenantProvider());
    result = oidcResult({
      tenantId: undefined,
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice@example.test',
        email_verified: true,
      },
    });

    const response = await exchange();
    assert.equal(response.status, 401);
    const body = (await response.json()) as { token?: string; refreshToken?: string };
    assert.equal(body.token, undefined);
    assert.equal(body.refreshToken, undefined);
    assert.equal(await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'), undefined);
  });

  it('accepts a valid explicit tenant claim in multi-tenant mode', async () => {
    setGlobalTenantProvider(new SimpleTenantProvider());

    const response = await exchange();
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string };
    assert.equal(verifyToken(body.token)?.tenant_id, 'tenant-a');
  });

  it('accepts a tenant from an operator-configured claim name', async () => {
    setGlobalTenantProvider(new SimpleTenantProvider());
    process.env.OIDC_TENANT_CLAIM = 'organization_id';
    result = oidcResult({
      tenantId: 'implicit-idp-hostname',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice@example.test',
        email_verified: true,
        organization_id: 'tenant-configured',
      },
    });

    const response = await exchange();
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string };
    assert.equal(verifyToken(body.token)?.tenant_id, 'tenant-configured');
  });

  it('requires a verified tenant claim even for a single-tenant deployment', async () => {
    delete process.env.COMMANDER_DEFAULT_TENANT_ID;
    result = oidcResult({
      tenantId: 'implicit-idp-hostname',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice@example.test',
        email_verified: true,
      },
    });

    const rejected = await exchange();
    assert.equal(rejected.status, 401);
    assert.equal(await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'), undefined);

    process.env.OIDC_DEFAULT_TENANT_ID = 'single-tenant-default';
    assert.equal((await exchange()).status, 401);
  });

  it('provisions a new user bound to issuer+subject and mints the validated tenant', async () => {
    const response = await exchange();
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string; user: { id: string } };
    const token = verifyToken(body.token);

    assert.equal(token?.tenant_id, 'tenant-a');
    assert.equal(
      (await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'))?.id,
      body.user.id,
    );
  });

  it('rejects an identity exchange when the verified tenant claim is absent', async () => {
    const first = await exchange();
    const firstBody = (await first.json()) as { user: { id: string } };

    result = oidcResult({
      username: 'alice-renamed@example.test',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice-renamed@example.test',
        email_verified: true,
      },
    });
    const second = await exchange();
    assert.equal(first.status, 200);
    assert.equal(second.status, 401);
  });

  it('links a legitimate existing local account only when the email is verified', async () => {
    const created = createUser({
      username: 'alice',
      email: 'alice@example.test',
      password: LOCAL_TEST_PASSWORD,
      role: 'viewer',
      tenantId: 'tenant-a',
    });
    const resolved = await created;
    assert.ok(!('error' in resolved));

    const response = await exchange();
    assert.equal(response.status, 200);
    assert.equal(
      (await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'))?.id,
      resolved.user.id,
    );
  });

  it('rejects an unverified colliding email without changing the local account', async () => {
    const created = createUser({
      username: 'victim',
      email: 'alice@example.test',
      password: LOCAL_TEST_PASSWORD,
      role: 'admin',
      tenantId: 'tenant-a',
    });
    const resolved = await created;
    assert.ok(!('error' in resolved));
    result = oidcResult({
      role: 'viewer',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'attacker-subject',
        email: 'alice@example.test',
        email_verified: false,
        tenant_id: 'tenant-a',
      },
      userId: 'attacker-subject',
    });

    const response = await exchange();
    assert.equal(response.status, 409);
    assert.equal((await findUserByEmail('alice@example.test'))?.role, 'admin');
    assert.equal(await findUserByOidcIdentity('https://idp.example.test', 'attacker-subject'), undefined);
  });

  it('rejects a second subject attempting to claim an already-bound email', async () => {
    assert.equal((await exchange()).status, 200);
    result = oidcResult({
      userId: 'subject-attacker',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-attacker',
        email: 'alice@example.test',
        email_verified: true,
        tenant_id: 'tenant-a',
      },
    });

    assert.equal((await exchange()).status, 409);
    assert.equal(await findUserByOidcIdentity('https://idp.example.test', 'subject-attacker'), undefined);
  });

  it('rejects an invalid tenant claim instead of minting a fallback tenant', async () => {
    result = oidcResult({
      tenantId: '../tenant-b',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice@example.test',
        email_verified: true,
        tenant_id: '../tenant-b',
      },
    });

    const response = await exchange();
    assert.equal(response.status, 401);
    assert.equal(await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'), undefined);
  });

  it('preserves the OIDC tenant when rotating the refresh token', async () => {
    const response = await exchange();
    const body = (await response.json()) as { refreshToken: string };
    const rotatedResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    const rotated = (await rotatedResponse.json()) as { token: string; refreshToken: string };

    assert.equal(rotatedResponse.status, 200);
    assert.equal(verifyToken(rotated.token)?.tenant_id, 'tenant-a');
    assert.equal(verifyToken(rotated.refreshToken)?.tenant_id, 'tenant-a');
  });

  it('returns a sanitized 503 and no credentials when refresh authority is unavailable', async () => {
    refreshTokens.unavailable = true;

    const response = await exchange();

    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { error: 'Authentication service unavailable' });
    assert.equal(body.token, undefined);
    assert.equal(body.refreshToken, undefined);
    assert.equal(JSON.stringify(body).includes('secret-dsn'), false);
  });
});
