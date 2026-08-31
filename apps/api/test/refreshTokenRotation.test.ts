import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestUserRepository } from './authRepositories';
import type { RefreshTokenRecord, RefreshTokenRepository } from '../src/refreshTokenStore';

const tmpDir = path.join(os.tmpdir(), 'commander-refresh-test-' + crypto.randomUUID());
const originalCwd = process.cwd();
const originalJwt = process.env.JWT_SECRET;
const REFRESH_TEST_PASSWORD = 'password' + '123';
const REFRESH_TEST_ADMIN_PASSWORD = 'password' + '456';

fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = 'test-jwt-secret-for-refresh-rotation';

class TestRefreshTokenRepository implements RefreshTokenRepository {
  readonly records = new Map<string, RefreshTokenRecord & { revoked: boolean }>();
  unavailable = false;
  private pausedConsume:
    | {
        jti: string;
        consumed: () => void;
        waitForRelease: Promise<void>;
      }
    | undefined;
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly sessionLockWaiters = new Map<string, () => void>();

  waitForSessionLock(userId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sessionLockWaiters.set(userId, resolve);
    });
  }

  pauseConsume(jti: string): { consumed: Promise<void>; release: () => void } {
    let consumed!: () => void;
    let release!: () => void;
    const consumedPromise = new Promise<void>((resolve) => {
      consumed = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pausedConsume = { jti, consumed, waitForRelease };
    return { consumed: consumedPromise, release };
  }

  async withUserSessionLock<T>(
    userId: string,
    operation: (session: this) => Promise<T>,
  ): Promise<T> {
    const predecessor = this.sessionLocks.get(userId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = (predecessor ?? Promise.resolve()).then(() => held);
    this.sessionLocks.set(userId, queued);
    if (predecessor) this.sessionLockWaiters.get(userId)?.();
    await predecessor;
    try {
      return await operation(this);
    } finally {
      release();
      if (this.sessionLocks.get(userId) === queued) this.sessionLocks.delete(userId);
    }
  }

  async insert(record: RefreshTokenRecord): Promise<void> {
    this.assertAvailable();
    this.records.set(record.jti, { ...record, revoked: false });
  }

  async consume(jti: string): Promise<boolean> {
    this.assertAvailable();
    const record = this.records.get(jti);
    if (!record || record.revoked || record.expiresAt.getTime() <= Date.now()) return false;
    record.revoked = true;
    if (this.pausedConsume?.jti === jti) {
      const paused = this.pausedConsume;
      this.pausedConsume = undefined;
      paused.consumed();
      await paused.waitForRelease;
    }
    return true;
  }

  async revoke(jti: string): Promise<void> {
    this.assertAvailable();
    const record = this.records.get(jti);
    if (record) record.revoked = true;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    this.assertAvailable();
    for (const record of this.records.values()) {
      if (record.userId === userId) record.revoked = true;
    }
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new Error('postgres authority failed: secret-dsn');
  }
}

const refreshTokens = new TestRefreshTokenRepository();
const { jwtMiddleware, signRefreshToken, verifyToken } = await import('../src/jwtMiddleware');
const { createUser, findUserByUsername, setUserRepositoryForTesting } =
  await import('../src/userStore');
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
    password: REFRESH_TEST_PASSWORD,
    role: 'viewer',
    tenantId: 'tenant-a',
  });
  assert.ok(!('error' in (await created)), 'user create should succeed');
  const admin = createUser({
    username: 'refreshadmin',
    email: 'refresh-admin@example.com',
    password: REFRESH_TEST_ADMIN_PASSWORD,
    role: 'admin',
    tenantId: 'tenant-a',
  });
  assert.ok(!('error' in (await admin)), 'admin create should succeed');

  app = express();
  app.use(express.json());
  app.use(jwtMiddleware);
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

async function login(
  username = 'refreshuser',
  password = REFRESH_TEST_PASSWORD,
): Promise<{ token: string; refreshToken: string }> {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, tenantId: 'tenant-a' }),
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
      body: JSON.stringify({
        username: 'refreshuser',
        password: REFRESH_TEST_PASSWORD,
        tenantId: 'tenant-a',
      }),
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
  test('does not mint or refresh a token for a tenant without durable membership', async () => {
    const prior = process.env.COMMANDER_DEFAULT_TENANT_ID;
    process.env.COMMANDER_DEFAULT_TENANT_ID = 'tenant-b';
    try {
      const response = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'refreshuser',
          password: REFRESH_TEST_PASSWORD,
          tenantId: 'tenant-b',
        }),
      });
      assert.equal(response.status, 401);
      const valid = await login();
      const forged = await signRefreshToken(
        {
          id: (await findUserByUsername('refreshuser'))!.id,
          username: 'refreshuser',
          role: 'viewer',
          tenantId: 'tenant-b',
        },
        refreshTokens,
      );
      const refresh = await request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: forged }),
      });
      assert.equal(refresh.status, 401);
      assert.equal(verifyToken(valid.token)?.tenant_id, 'tenant-a');
    } finally {
      if (prior === undefined) delete process.env.COMMANDER_DEFAULT_TENANT_ID;
      else process.env.COMMANDER_DEFAULT_TENANT_ID = prior;
    }
  });

  test('AUTH-01: login and refresh access tokens carry tenant_id', async () => {
    const loginBody = await login();
    assert.equal(verifyToken(loginBody.token)?.tenant_id, 'tenant-a');

    const refreshed = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(refreshed.status, 200);
    const body = (await refreshed.json()) as { token: string };
    assert.equal(verifyToken(body.token)?.tenant_id, 'tenant-a');
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

  test('password reset revokes every previously issued refresh token', async () => {
    const victimSession = await login();
    const adminSession = await login('refreshadmin', REFRESH_TEST_ADMIN_PASSWORD);
    const adminRefresh = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: adminSession.refreshToken }),
    });
    assert.equal(adminRefresh.status, 200);
    const { token: adminToken } = (await adminRefresh.json()) as { token: string };
    const victim = await findUserByUsername('refreshuser');
    assert.ok(victim);

    try {
      const reset = await request('/api/auth/users/' + victim.id + '/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
        body: JSON.stringify({ newPassword: 'password' + '789' }),
      });
      assert.equal(reset.status, 200);

      const replay = await request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: victimSession.refreshToken }),
      });
      assert.equal(replay.status, 401);
    } finally {
      await users.resetUserPassword(victim.id, REFRESH_TEST_PASSWORD);
    }
  });

  test('password reset invalidates a replacement token issued by an in-flight refresh', async () => {
    const victimSession = await login();
    const adminSession = await login('refreshadmin', REFRESH_TEST_ADMIN_PASSWORD);
    const adminRefresh = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: adminSession.refreshToken }),
    });
    assert.equal(adminRefresh.status, 200);
    const { token: adminToken } = (await adminRefresh.json()) as { token: string };
    const victim = await findUserByUsername('refreshuser');
    assert.ok(victim);
    const original = verifyToken(victimSession.refreshToken);
    assert.ok(original?.jti);
    const paused = refreshTokens.pauseConsume(original.jti);

    const rotating = request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: victimSession.refreshToken }),
    });
    await paused.consumed;
    const resetWaiting = refreshTokens.waitForSessionLock(victim.id);

    try {
      const resetting = request('/api/auth/users/' + victim.id + '/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
        body: JSON.stringify({ newPassword: 'password' + '789' }),
      });
      await resetWaiting;
      paused.release();
      const reset = await resetting;
      assert.equal(reset.status, 200);

      const rotated = await rotating;
      assert.equal(rotated.status, 200);
      const { refreshToken } = (await rotated.json()) as { refreshToken: string };
      const replay = await request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      assert.equal(replay.status, 401);
    } finally {
      paused.release();
      await users.resetUserPassword(victim.id, REFRESH_TEST_PASSWORD);
    }
  });

  test('password reset fails closed before changing the password when token revocation is unavailable', async () => {
    const adminSession = await login('refreshadmin', REFRESH_TEST_ADMIN_PASSWORD);
    const adminRefresh = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: adminSession.refreshToken }),
    });
    assert.equal(adminRefresh.status, 200);
    const { token: adminToken } = (await adminRefresh.json()) as { token: string };
    const victim = await findUserByUsername('refreshuser');
    assert.ok(victim);
    refreshTokens.unavailable = true;

    const reset = await request('/api/auth/users/' + victim.id + '/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
      body: JSON.stringify({ newPassword: 'password' + '789' }),
    });
    assert.equal(reset.status, 503);
    assert.deepEqual(await reset.json(), { error: 'Authentication service unavailable' });

    refreshTokens.unavailable = false;
    const oldPasswordLogin = await login();
    assert.ok(oldPasswordLogin.refreshToken);
  });
});
