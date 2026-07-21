/**
 * REL-4 regression: corrupt **and** wrong-shape JSON load must quarantine,
 * not silent-[] then wipe in place (no sidecar).
 *
 * cwd / store paths are captured at module load — chdir before dynamic import.
 */
import { test, describe, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const tmpDir = path.join(
  os.tmpdir(),
  `commander-corrupt-load-${crypto.randomBytes(8).toString('hex')}`,
);
const originalCwd = process.cwd();
const commanderDir = path.join(tmpDir, '.commander');

fs.mkdirSync(commanderDir, { recursive: true });
process.chdir(tmpDir);

const { getApiKeyStore, resetApiKeyStore } = await import('../src/apiKeyStore');
const { persist, isActive, _resetRefreshTokenStoreForTests } =
  await import('../src/refreshTokenStore');
const { listUsers, _resetUserStoreForTests } = await import('../src/userStore');

after(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function listCorruptSidecars(baseName: string): string[] {
  return fs
    .readdirSync(commanderDir)
    .filter((name) => name.startsWith(`${baseName}.corrupt-`))
    .map((name) => path.join(commanderDir, name))
    .sort();
}

function clearCorruptSidecars(baseName: string): void {
  for (const sidecar of listCorruptSidecars(baseName)) {
    try {
      fs.unlinkSync(sidecar);
    } catch {
      // ignore
    }
  }
}

function assertSidecarPreserves(baseName: string, expectedBody: string): string {
  const sidecars = listCorruptSidecars(baseName);
  assert.ok(sidecars.length >= 1, `${baseName} must be quarantined aside`);
  const match = sidecars.find((p) => fs.readFileSync(p, 'utf8') === expectedBody);
  assert.ok(match, `${baseName} sidecar must preserve exact wrong-shape/corrupt body`);
  return match;
}

describe('security store corrupt-load fail-closed (REL-4)', () => {
  test('apiKeyStore quarantines corrupt api_keys.json and does not wipe without sidecar', () => {
    resetApiKeyStore();
    clearCorruptSidecars('api_keys.json');
    const keysFile = path.join(commanderDir, 'api_keys.json');
    const corruptBody = '{not-valid-json';
    fs.writeFileSync(keysFile, corruptBody, 'utf8');

    const store = getApiKeyStore();
    assert.equal(store.list().length, 0);

    const sidecar = assertSidecarPreserves('api_keys.json', corruptBody);
    assert.equal(fs.existsSync(keysFile), false, 'original path must not keep corrupt bytes');

    // Next mutation must not overwrite the quarantine sidecar.
    store.create('recoverable', ['read']);
    assert.ok(fs.existsSync(keysFile), 'fresh write recreates the store file');
    assert.equal(fs.readFileSync(sidecar, 'utf8'), corruptBody);
    assert.ok(store.list().length >= 1);
  });

  test('refreshTokenStore quarantines corrupt refresh_tokens.json before empty persist', () => {
    _resetRefreshTokenStoreForTests();
    clearCorruptSidecars('refresh_tokens.json');
    const storeFile = path.join(commanderDir, 'refresh_tokens.json');
    const corruptBody = '{"broken": true,';
    fs.writeFileSync(storeFile, corruptBody, 'utf8');

    assert.equal(isActive('missing-jti'), false);

    const sidecar = assertSidecarPreserves('refresh_tokens.json', corruptBody);
    assert.equal(fs.existsSync(storeFile), false);

    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    persist(jti, 'user-corrupt-load', exp);
    assert.equal(isActive(jti), true);
    assert.equal(fs.readFileSync(sidecar, 'utf8'), corruptBody);
  });
});

describe('security store wrong-shape fail-closed (REL-4)', () => {
  test('userStore quarantines {"users":[...]} instead of ensureDefaultAdmin wipe-in-place', () => {
    _resetUserStoreForTests();
    clearCorruptSidecars('users.json');
    const usersFile = path.join(commanderDir, 'users.json');
    const wrongShapeBody = JSON.stringify({
      users: [
        {
          id: 'u-preserved',
          username: 'legacy-admin',
          email: 'legacy@example.com',
          passwordHash: '$2a$10$PRESERVED_HASH_MUST_SURVIVE_SIDECAR',
          role: 'admin',
          createdAt: '2020-01-01T00:00:00.000Z',
          lastLoginAt: null,
        },
      ],
    });
    fs.writeFileSync(usersFile, wrongShapeBody, 'utf8');

    // Boot path: wrong shape must not be treated as empty store without quarantine.
    const users = listUsers();
    assert.ok(users.length >= 1, 'reseed after quarantine is allowed');

    const sidecar = assertSidecarPreserves('users.json', wrongShapeBody);
    assert.ok(
      fs.readFileSync(sidecar, 'utf8').includes('PRESERVED_HASH_MUST_SURVIVE_SIDECAR'),
      'password hashes must survive in sidecar, not be wiped in place',
    );
    // Fresh users.json (reseed) must not be the wrong-shape envelope.
    assert.ok(fs.existsSync(usersFile));
    const reseeded = JSON.parse(fs.readFileSync(usersFile, 'utf8')) as unknown;
    assert.ok(Array.isArray(reseeded), 'reseed must write canonical array shape');
  });

  test('apiKeyStore quarantines {"keys":[...]} instead of create() wipe-in-place', () => {
    resetApiKeyStore();
    clearCorruptSidecars('api_keys.json');
    const keysFile = path.join(commanderDir, 'api_keys.json');
    const wrongShapeBody = JSON.stringify({
      keys: [
        {
          id: 'ak_old',
          name: 'legacy',
          prefix: 'cmdr_old',
          hash: 'deadbeef',
          scopes: ['read'],
          enabled: true,
          createdAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    });
    fs.writeFileSync(keysFile, wrongShapeBody, 'utf8');

    const store = getApiKeyStore();
    assert.equal(store.list().length, 0);

    const sidecar = assertSidecarPreserves('api_keys.json', wrongShapeBody);
    assert.ok(fs.readFileSync(sidecar, 'utf8').includes('ak_old'));

    store.create('after-quarantine', ['read']);
    assert.equal(fs.readFileSync(sidecar, 'utf8'), wrongShapeBody);
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(keysFile, 'utf8'))));
  });

  test('refreshTokenStore quarantines unexpected object shape (sibling baseline)', () => {
    _resetRefreshTokenStoreForTests();
    clearCorruptSidecars('refresh_tokens.json');
    const storeFile = path.join(commanderDir, 'refresh_tokens.json');
    const wrongShapeBody = JSON.stringify({
      tokens: [{ jti: 'jti-old', userId: 'u1', exp: 9999999999, revoked: false }],
    });
    fs.writeFileSync(storeFile, wrongShapeBody, 'utf8');

    assert.equal(isActive('jti-old'), false);

    const sidecar = assertSidecarPreserves('refresh_tokens.json', wrongShapeBody);

    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    persist(jti, 'user-wrong-shape', exp);
    assert.equal(isActive(jti), true);
    assert.equal(fs.readFileSync(sidecar, 'utf8'), wrongShapeBody);
  });
});
