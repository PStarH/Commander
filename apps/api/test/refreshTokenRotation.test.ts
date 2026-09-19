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
  consume,
  setRefreshTokenRepository,
  _resetRefreshTokenStoreForTests,
} = await import('../src/refreshTokenStore');
const {
  createUser,
  findUserById,
  findUserByUsername,
  resetUserPassword,
  setUserRepository,
  _resetUserStoreForTests,
} = await import('../src/userStore');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints');
const { setAuthFailureStore, resetAuthFailureStoreForTesting } =
  await import('../src/authFailureStore');
const express = (await import('express')).default;
const { TestAuthFailureStore, TestRefreshTokenRepository, TestUserRepository } =
  await import('./authRepositories');

const testPassword = ['password', '123'].join('');

let app: ReturnType<typeof express>;
let server: ReturnType<typeof app.listen>;
let port: number;
let userRepo: InstanceType<typeof TestUserRepository>;

/**
 * AUTH-03: the refresh double enforces the same auth-version fence the
 * PostgreSQL repository applies with `SELECT … FOR UPDATE`, by reading the
 * owning user repository.
 */
function makeRefreshRepository() {
  const repository = new TestRefreshTokenRepository();
  repository.authVersionProvider = async (userId) =>
    (await userRepo.findUserById(userId))?.authVersion;
  return repository;
}

function request(p: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${p}`, init);
}

before(async () => {
  userRepo = new TestUserRepository();
  setUserRepository(userRepo);
  setRefreshTokenRepository(makeRefreshRepository());
  setAuthFailureStore(new TestAuthFailureStore());

  const created = await createUser({
    username: 'refreshuser',
    email: 'refresh@example.com',
    password: testPassword,
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
  setRefreshTokenRepository(makeRefreshRepository());
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  _resetUserStoreForTests();
  _resetRefreshTokenStoreForTests();
  resetAuthFailureStoreForTesting();
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
  test('persist / revoke / isActive round-trip', async () => {
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await persist(jti, 'user-1', exp);
    assert.equal(await isActive(jti), true);
    await revoke(jti);
    assert.equal(await isActive(jti), false);
  });

  test('consume is single-winner for the same jti', async () => {
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await persist(jti, 'user-1', exp);
    assert.equal(await consume(jti), true);
    assert.equal(await consume(jti), false);
    assert.equal(await isActive(jti), false);
  });

  test('signRefreshToken embeds jti and persists it as active', async () => {
    const user = await findUserByUsername('refreshuser');
    assert.ok(user);
    const token = await signRefreshToken({
      id: user!.id,
      username: user!.username,
      role: user!.role,
    });
    const decoded = verifyToken(token);
    assert.ok(decoded);
    assert.equal(decoded!.type, 'refresh');
    assert.ok(decoded!.jti);
    assert.equal(await isActive(decoded!.jti!), true);
  });
});

describe('auth refresh rotation', () => {
  test('AUTH-01: login and refresh access tokens carry tenant_id', async () => {
    const prev = process.env.COMMANDER_DEFAULT_TENANT_ID;
    process.env.COMMANDER_DEFAULT_TENANT_ID = 'tenant-auth01';
    try {
      const login = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'refreshuser', password: testPassword }),
      });
      assert.equal(login.status, 200);
      const loginBody = (await login.json()) as { token: string; refreshToken: string };
      const access = verifyToken(loginBody.token);
      assert.ok(access);
      assert.equal(access!.type, 'access');
      assert.equal(access!.tenant_id, 'tenant-auth01');

      const refreshed = await request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
      });
      assert.equal(refreshed.status, 200);
      const refreshedBody = (await refreshed.json()) as { token: string };
      const rotated = verifyToken(refreshedBody.token);
      assert.ok(rotated);
      assert.equal(rotated!.tenant_id, 'tenant-auth01');
    } finally {
      if (prev === undefined) delete process.env.COMMANDER_DEFAULT_TENANT_ID;
      else process.env.COMMANDER_DEFAULT_TENANT_ID = prev;
    }
  });

  test('POST /api/auth/refresh rotates jti and rejects reused token', async () => {
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'refreshuser', password: testPassword }),
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
    const user = await findUserByUsername('refreshuser');
    assert.ok(user);
    const token = await signRefreshToken({
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

describe('AUTH-03: refresh rotation is fenced by the user auth version', () => {
  test('signRefreshToken carries auth_version so rotation can be fenced', async () => {
    const user = await findUserByUsername('refreshuser');
    assert.ok(user);
    const token = await signRefreshToken(user!);
    const decoded = verifyToken(token);
    assert.ok(decoded);
    assert.equal(decoded!.type, 'refresh');
    // Pre-fix the refresh payload had no auth_version, so a token minted before
    // a reset stayed exchangeable afterwards.
    assert.equal(decoded!.auth_version, user!.authVersion);
  });

  test('a stale refresh token is rejected after the user version advances', async () => {
    const user = await findUserByUsername('refreshuser');
    assert.ok(user);
    const versionBeforeReset = user!.authVersion;

    // This is the reset racing a refresh whose jti was already consumed: the
    // reset bumps the version, and the new refresh token is minted with the
    // pre-reset version. Without a version fence it would still be accepted.
    await resetUserPassword(user!.id, ['rotated', 'secret'].join(''));
    const stale = await signRefreshToken({
      id: user!.id,
      username: user!.username,
      role: user!.role,
      authVersion: versionBeforeReset,
    });

    const refresh = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: stale }),
    });
    assert.equal(refresh.status, 401, 'a pre-reset refresh token must not mint a new session');
  });

  test('two concurrent refreshes of the same token produce exactly one success', async () => {
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'refreshuser', password: ['rotated', 'secret'].join('') }),
    });
    assert.equal(login.status, 200);
    const { refreshToken } = (await login.json()) as { refreshToken: string };

    const [a, b] = await Promise.all([
      request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }),
      request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 401], 'exactly one concurrent refresh may succeed');
  });

  test('a rotation authority failure returns 503 and never a token', async () => {
    const user = await findUserByUsername('refreshuser');
    assert.ok(user);
    const token = await signRefreshToken(user!);

    const failing = new TestRefreshTokenRepository();
    failing.rotate = async () => {
      throw new Error('ECONNREFUSED');
    };
    setRefreshTokenRepository(failing);
    try {
      const response = await request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      assert.equal(response.status, 503);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.token, undefined);
      assert.equal(body.refreshToken, undefined);
    } finally {
      setRefreshTokenRepository(makeRefreshRepository());
    }
  });
});

/** Records the exact statements a PostgreSQL rotation issues. */
class RecordingClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
  script: Array<{ match: RegExp; rows?: unknown[]; rowCount?: number }> = [];

  async query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, values });
    const entry = this.script.find((candidate) => candidate.match.test(sql));
    return {
      rows: (entry?.rows ?? []) as T[],
      rowCount: entry?.rowCount ?? entry?.rows?.length ?? 0,
    };
  }

  async release(): Promise<void> {}

  indexOf(pattern: RegExp): number {
    return this.calls.findIndex((call) => pattern.test(call.sql));
  }
}

describe('AUTH-03: PostgreSQL rotation transaction shape', () => {
  test('fences the auth version, consumes and inserts inside one transaction', async () => {
    const { PostgresRefreshTokenRepository } = await import('../src/refreshTokenStore');
    const client = new RecordingClient();
    client.script = [
      { match: /SELECT auth_version FROM commander_auth_users/, rows: [{ auth_version: 3 }] },
      {
        match: /UPDATE commander_auth_refresh_tokens SET revoked_at/,
        rows: [{ jti: 'jti-old' }],
        rowCount: 1,
      },
    ];
    const repository = new PostgresRefreshTokenRepository({
      connect: async () => client,
    } as never);

    const result = await repository.rotate({
      userId: 'user-1',
      currentJti: 'jti-old',
      nextJti: 'jti-new',
      nextExp: Math.floor(Date.now() / 1000) + 3600,
      expectedAuthVersion: 3,
    });

    assert.deepEqual(result, { status: 'rotated' });
    assert.equal(client.calls[0]!.sql, 'BEGIN');
    assert.equal(client.calls.at(-1)!.sql, 'COMMIT');
    // Lock order: user row first, then the refresh-token rows — the same order
    // resetUserPassword and deleteUser use.
    const lock = client.indexOf(
      /SELECT auth_version FROM commander_auth_users WHERE id = \$1 FOR UPDATE/,
    );
    const consume = client.indexOf(/UPDATE commander_auth_refresh_tokens SET revoked_at/);
    const insert = client.indexOf(/INSERT INTO commander_auth_refresh_tokens/);
    assert.ok(lock >= 0, 'the user row must be locked FOR UPDATE');
    assert.ok(consume > lock, 'the old jti must be consumed after the user lock');
    assert.ok(insert > consume, 'the new jti must be inserted in the same transaction');
    assert.deepEqual(client.calls[consume]!.values, ['jti-old', 'user-1']);
  });

  test('a stale auth_version is rejected without consuming or inserting', async () => {
    const { PostgresRefreshTokenRepository } = await import('../src/refreshTokenStore');
    const client = new RecordingClient();
    client.script = [
      { match: /SELECT auth_version FROM commander_auth_users/, rows: [{ auth_version: 4 }] },
    ];
    const repository = new PostgresRefreshTokenRepository({
      connect: async () => client,
    } as never);

    const result = await repository.rotate({
      userId: 'user-1',
      currentJti: 'jti-old',
      nextJti: 'jti-new',
      nextExp: Math.floor(Date.now() / 1000) + 3600,
      expectedAuthVersion: 3,
    });

    assert.deepEqual(result, { status: 'rejected', reason: 'auth_version_mismatch' });
    assert.equal(
      client.calls.some((call) => /UPDATE commander_auth_refresh_tokens/.test(call.sql)),
      false,
      'a stale version must not consume the old jti',
    );
    assert.equal(
      client.calls.some((call) => /INSERT INTO commander_auth_refresh_tokens/.test(call.sql)),
      false,
      'a stale version must not register a new jti',
    );
  });
});
