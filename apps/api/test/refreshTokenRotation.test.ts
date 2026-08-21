import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestUserRepository } from './authRepositories'; import type { RefreshTokenRecord, RefreshTokenRepository } from '../src/refreshTokenStore';

const tmpDir = path.join(os.tmpdir(), 'commander-refresh-test-' + crypto.randomUUID());
const originalCwd = process.cwd();
const originalJwt = process.env.JWT_SECRET;
const REFRESH_TEST_PASSWORD = 'password' + '123';

fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = 'test-jwt-secret-for-refresh-rotation';

class TestRefreshTokenRepository implements RefreshTokenRepository {
  readonly records = new Map<string, RefreshTokenRecord & { revoked: boolean }>();
  unavailable = false;

  async insert(record: RefreshTokenRecord): Promise<void> {
    this.assertAvailable();
    this.records.set(record.jti, { ...record, revoked: false });
  }

  async consume(jti: string): Promise<boolean> {
    this.assertAvailable();
    const record = this.records.get(jti);
    if (!record || record.revoked || record.expiresAt.getTime() <= Date.now()) return false;
    record.revoked = true;
    return true;
  }

  async revoke(jti: string): Promise<void> {
    this.assertAvailable();
    const record = this.records.get(jti);
    if (record) record.revoked = true;
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new Error('postgres authority failed: secret-dsn');
  }
}

const refreshTokens = new TestRefreshTokenRepository();
const { signRefreshToken, verifyToken } = await import('../src/jwtMiddleware');
const { createUser, findUserByUsername, setUserRepositoryForTesting } = await import('../src/userStore');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints');
const express = (await import('express')).default;

let app: ReturnType<typeof express>;
let server: ReturnType<typeof app.listen>;
let port: number;
const users = new TestUserRepository();
function request(p: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${p}`, init);
}

before(async () => {
  setUserRepositoryForTesting(users);
  const created = createUser({
    username: 'refreshuser',
    email: 'refresh@example.com',
    password: 'password123',
    role: 'viewer',
  });
  assert.ok(!('error' in (await created)), 'user create should succeed');

  app = express();
  app.use(express.json());
  app.use(createUserAuthRouter({ refreshTokens }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      resolve();
    });
  });
});

beforeEach(() => {
  refreshTokens.records.clear();
  refreshTokens.unavailable = false;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  process.chdir(originalCwd);
  if (originalJwt === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwt;
  setUserRepositoryForTesting(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function login(): Promise<{ token: string; refreshToken: string }> {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'refreshuser', password: REFRESH_TEST_PASSWORD }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { token: string; refreshToken: string };
}

describe('refresh-token issuance', () => {
  test('persists the jti before returning a signed refresh token', async () => {
    const user = await findUserByUsername('refreshuser');
    assert.ok(user);

    const token = await signRefreshToken(
      { id: user.id, username: user.username, role: user.role },
      refreshTokens,
    );
    const decoded = verifyToken(token);

    assert.equal(decoded?.type, 'refresh');
    assert.ok(decoded?.jti);
    assert.equal(refreshTokens.records.get(decoded.jti)?.revoked, false);
  });

  test('does not mint any credentials when persistence is unavailable', async () => {
    refreshTokens.unavailable = true;
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'refreshuser', password: REFRESH_TEST_PASSWORD }),
    });

    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { error: 'Authentication service unavailable' });
    assert.equal(body.token, undefined);
    assert.equal(body.refreshToken, undefined);
    assert.equal(JSON.stringify(body).includes('secret-dsn'), false);
  });
});

describe('auth refresh rotation', () => {
  test('AUTH-01: login and refresh access tokens carry tenant_id', async () => {
    const previous = process.env.COMMANDER_DEFAULT_TENANT_ID;
    process.env.COMMANDER_DEFAULT_TENANT_ID = 'tenant-auth01';
    try {
      const loginBody = await login();
      assert.equal(verifyToken(loginBody.token)?.tenant_id, 'tenant-auth01');

      const refreshed = await request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
      });
      assert.equal(refreshed.status, 200);
      const body = (await refreshed.json()) as { token: string };
      assert.equal(verifyToken(body.token)?.tenant_id, 'tenant-auth01');
    } finally {
      if (previous === undefined) delete process.env.COMMANDER_DEFAULT_TENANT_ID;
      else process.env.COMMANDER_DEFAULT_TENANT_ID = previous;
    }
  });

  test('rotates jti and rejects reuse', async () => {
    const loginBody = await login();
    const first = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { refreshToken: string; token: string };
    assert.notEqual(firstBody.refreshToken, loginBody.refreshToken);

    const replay = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(replay.status, 401);

    const second = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: firstBody.refreshToken }),
    });
    assert.equal(second.status, 200);
  });

  test('returns a sanitized 503 and no credentials when consume fails', async () => {
    const loginBody = await login();
    refreshTokens.unavailable = true;

    const response = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });

    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { error: 'Authentication service unavailable' });
    assert.equal(body.token, undefined);
    assert.equal(body.refreshToken, undefined);
    assert.equal(JSON.stringify(body).includes('secret-dsn'), false);
  });

  test('logout revokes a refresh jti', async () => {
    const loginBody = await login();
    const logout = await request('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(logout.status, 200);

    const refresh = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(refresh.status, 401);
  });

  test('logout returns a sanitized 503 when revoke fails', async () => {
    const loginBody = await login();
    refreshTokens.unavailable = true;

    const response = await request('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });

    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { error: 'Authentication service unavailable' });
    assert.equal(JSON.stringify(body).includes('secret-dsn'), false);
  });
});
