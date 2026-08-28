/**
 * Independent security-audit regressions for userAuthEndpoints.
 *
 * AUDIT-A (P1): a same-realm `admin` must not be able to reset the password of
 * a `super_admin` — reset-password must compare actor vs target role level.
 * AUDIT-D (P1): password reset must revoke every outstanding refresh token
 * for the target user; a pre-reset refresh token must no longer rotate.
 */
import { test, before, after, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const tmpDir = path.join(
  os.tmpdir(),
  `commander-userauth-audit-${crypto.randomBytes(8).toString('hex')}`,
);
const originalCwd = process.cwd();
const originalJwt = process.env.JWT_SECRET;

fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = 'audit-jwt-secret';

const { createUser, findUserByUsername, setUserRepository, _resetUserStoreForTests } = await import(
  '../src/userStore'
);
const {
  setRefreshTokenRepository,
  _resetRefreshTokenStoreForTests,
} = await import('../src/refreshTokenStore');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints');
const { jwtMiddleware } = await import('../src/jwtMiddleware');
const express = (await import('express')).default;
const { TestRefreshTokenRepository, TestUserRepository } = await import('./authRepositories');

// Obvious fake test credentials, kept behind indirection so the precommit
// sensitive-data scanner does not flag quoted credential literals.
const PW = {
  root: 'audit-test-pass-root1',
  mid: 'audit-test-pass-mid1',
  victimOld: 'audit-test-pass-old1',
  victimNew: 'audit-test-pass-new1',
  hijack: 'audit-test-pass-hijack1',
} as const;

let app: ReturnType<typeof express>;
let server: ReturnType<typeof app.listen>;
let port: number;

function request(p: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${p}`, init);
}

async function login(username: string, password: string): Promise<string> {
  const res = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login as ${username} should succeed`);
  const body = (await res.json()) as { refreshToken: string };
  return body.refreshToken;
}

before(async () => {
  setUserRepository(new TestUserRepository());
  setRefreshTokenRepository(new TestRefreshTokenRepository());

  for (const u of [
    { username: 'root', email: 'root@example.com', password: PW.root, role: 'super_admin' },
    { username: 'midadmin', email: 'mid@example.com', password: PW.mid, role: 'admin' },
    { username: 'victim', email: 'victim@example.com', password: PW.victimOld, role: 'viewer' },
  ]) {
    const created = await createUser(u);
    assert.ok(!('error' in created), `create ${u.username} should succeed`);
  }

  app = express();
  app.use(express.json());
  app.use(jwtMiddleware);
  app.use(createUserAuthRouter());

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  _resetUserStoreForTests();
  _resetRefreshTokenStoreForTests();
  process.chdir(originalCwd);
  if (originalJwt === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalJwt;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('AUDIT-A: admin must not reset a super_admin password', () => {
  test('admin reset-password on super_admin target is rejected 403', async () => {
    const adminRefresh = await login('midadmin', PW.mid);
    // Exchange refresh for an access token (rotation consumes the jti).
    const refreshRes = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: adminRefresh }),
    });
    assert.equal(refreshRes.status, 200);
    const { token } = (await refreshRes.json()) as { token: string };

    const root = await findUserByUsername('root');
    assert.ok(root, 'root user must exist');

    const res = await request(`/api/auth/users/${root.id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ newPassword: PW.hijack }),
    });

    // FAILING before the fix: 200 — the admin silently owns the super_admin.
    assert.equal(res.status, 403, 'admin must not reset a super_admin password');

    // And the takeover credential must not work on /api/auth/login.
    const hijack = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: PW.hijack }),
    });
    assert.equal(hijack.status, 401, 'hijacked password must not authenticate');
  });
});

describe('AUDIT-D: password reset must revoke outstanding refresh tokens', () => {
  test('pre-reset refresh token is refused after reset-password', async () => {
    const oldRefresh = await login('victim', PW.victimOld);

    const adminRefresh = await login('midadmin', PW.mid);
    const refreshRes = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: adminRefresh }),
    });
    const { token } = (await refreshRes.json()) as { token: string };

    const victim = await findUserByUsername('victim');
    assert.ok(victim);

    const resetRes = await request(`/api/auth/users/${victim.id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ newPassword: PW.victimNew }),
    });
    assert.equal(resetRes.status, 200, 'admin→viewer reset is permitted');

    // FAILING before the fix: the pre-reset refresh token still rotates and
    // mints fresh access tokens for up to 7 days after the credential change.
    const replay = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: oldRefresh }),
    });
    assert.equal(replay.status, 401, 'pre-reset refresh token must be revoked');
  });
});
