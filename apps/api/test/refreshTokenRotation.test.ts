/**
 * Refresh token jti store + rotation/revocation regression tests.
 *
 * JWT_SECRET / cwd must be set before importing jwtMiddleware and stores
 * (paths and secret are captured at module load).
 */
import { test, before, after, beforeEach, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const tmpDir = path.join(
  os.tmpdir(),
  `commander-refresh-test-${crypto.randomBytes(8).toString('hex')}`,
);
const originalCwd = process.cwd();
const originalJwt = process.env.JWT_SECRET;

fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = 'test-jwt-secret-for-refresh-rotation';
// Router mounted without authMiddleware; refresh is public when middleware is present.

const { signRefreshToken, verifyToken } = await import('../src/jwtMiddleware');
const {
  persist,
  revoke,
  isActive,
  _resetRefreshTokenStoreForTests,
} = await import('../src/refreshTokenStore');
const { createUser, findUserByUsername } = await import('../src/userStore');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints');
const express = (await import('express')).default;

let app: ReturnType<typeof express>;
let server: ReturnType<typeof app.listen>;
let port: number;

function request(p: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${p}`, init);
}

before(async () => {
  _resetRefreshTokenStoreForTests();

  const created = createUser({
    username: 'refreshuser',
    email: 'refresh@example.com',
    password: 'password123',
    role: 'viewer',
  });
  assert.ok(!('error' in created), 'user create should succeed');

  app = express();
  app.use(express.json());
  app.use(createUserAuthRouter());

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

beforeEach(() => {
  // Keep the user; only clear jti rows between cases that need a clean store.
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  process.chdir(originalCwd);
  if (originalJwt === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalJwt;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('refreshTokenStore', () => {
  test('persist / revoke / isActive round-trip', () => {
    _resetRefreshTokenStoreForTests();
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    persist(jti, 'user-1', exp);
    assert.equal(isActive(jti), true);
    revoke(jti);
    assert.equal(isActive(jti), false);
  });

  test('signRefreshToken embeds jti and persists it as active', () => {
    _resetRefreshTokenStoreForTests();
    const user = findUserByUsername('refreshuser');
    assert.ok(user);
    const token = signRefreshToken({
      id: user!.id,
      username: user!.username,
      role: user!.role,
    });
    const decoded = verifyToken(token);
    assert.ok(decoded);
    assert.equal(decoded!.type, 'refresh');
    assert.ok(decoded!.jti);
    assert.equal(isActive(decoded!.jti!), true);
  });
});

describe('auth refresh rotation', () => {
  test('POST /api/auth/refresh rotates jti and rejects reused token', async () => {
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'refreshuser', password: 'password123' }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as {
      token: string;
      refreshToken: string;
    };
    assert.ok(loginBody.refreshToken);

    const first = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { refreshToken: string; token: string };
    assert.ok(firstBody.refreshToken);
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

  test('POST /api/auth/logout revokes refresh jti', async () => {
    const user = findUserByUsername('refreshuser');
    assert.ok(user);
    const token = signRefreshToken({
      id: user!.id,
      username: user!.username,
      role: user!.role,
    });

    const logout = await request('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });
    assert.equal(logout.status, 200);

    const refresh = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });
    assert.equal(refresh.status, 401);
  });
});
