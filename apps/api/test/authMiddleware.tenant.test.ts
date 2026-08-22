import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { authMiddleware } from '../src/authMiddleware';
import { setApiKeyStoreForTesting } from '../src/apiKeyStore';
import { resetAuthFailureStoreForTesting, setAuthFailureStore } from '../src/authFailureStore';
import { TestApiKeyStore } from './authRepositories';

let app: express.Express;
let server: ReturnType<typeof app.listen>;
let port: number;
let tmpDir: string;
let originalCwd: string;
const apiKeys = new TestApiKeyStore();

function request(p: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${p}`, init);
}

before(async () => {
  originalCwd = process.cwd();
  tmpDir = path.join(
    os.tmpdir(),
    `commander-auth-tenant-test-${crypto.randomBytes(8).toString('hex')}`,
  );
  fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
  process.chdir(tmpDir);
  setApiKeyStoreForTesting(apiKeys);
  setAuthFailureStore({
    get: async () => undefined,
    recordFailure: async (_key, now) => ({
      count: 1,
      firstFailureAt: now,
      lastFailureAt: now,
      lockedUntil: 0,
    }),
    cleanup: async () => undefined,
  });

  app = express();
  app.use(authMiddleware);
  app.get('/context', (req: Request, res: Response) => {
    res.json({
      apiKeyId: req.apiKeyId,
      apiScopes: req.apiScopes,
      tenantId: req.tenantId,
    });
  });
  app.get('/ready', (_req: Request, res: Response) => {
    res.json({ status: 'ready' });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setApiKeyStoreForTesting(undefined);
  resetAuthFailureStoreForTesting();
  process.chdir(originalCwd);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test('PostgreSQL API key tenant binding sets req.tenantId', async () => {
  const { key } = await apiKeys.create('acme-corp-key', ['read', 'write'], 'acme-corp');

  const res = await request('/context', {
    headers: { 'X-API-Key': key },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { apiKeyId: string; tenantId: string };
  assert.ok(body.apiKeyId.includes('acme-corp'));
  assert.equal(body.tenantId, 'acme-corp');
});

test('PostgreSQL API keys retain their individual tenant bindings', async () => {
  const { key: key1 } = await apiKeys.create('acme-key', ['read'], 'acme-corp');
  const { key: key3 } = await apiKeys.create('globex-key', ['read'], 'globex');

  const res1 = await request('/context', {
    headers: { 'X-API-Key': key1 },
  });
  assert.equal(res1.status, 200);
  const body1 = (await res1.json()) as { tenantId: string };
  assert.equal(body1.tenantId, 'acme-corp');

  const res2 = await request('/context', {
    headers: { 'X-API-Key': key3 },
  });
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as { tenantId: string };
  assert.equal(body2.tenantId, 'globex');
});

test('PostgreSQL API key scopes and tenant binding are authoritative', async () => {
  const { key } = await apiKeys.create('cell-key', ['admin', 'actions:approve'], 'cell-tenant');

  const res = await request('/context', {
    headers: { 'X-API-Key': key },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { apiScopes: string[]; tenantId: string };
  assert.equal(body.tenantId, 'cell-tenant');
  assert.deepEqual(body.apiScopes, ['admin', 'actions:approve']);
});

test('persistent API key with tenantId sets req.tenantId', async () => {
  const { key } = await apiKeys.create('tenant-key', ['read', 'write'], 'wayne-ind');

  const res = await request('/context', {
    headers: { 'X-API-Key': key },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { apiKeyId: string; tenantId: string };
  assert.equal(body.apiKeyId, 'tenant-key');
  assert.equal(body.tenantId, 'wayne-ind');
});

test('static API_KEYS do not bypass PostgreSQL authority', async () => {
  process.env.API_KEYS = 'legacy-api-key:legacy-key';

  const res = await request('/context', {
    headers: { 'X-API-Key': 'legacy-api-key' },
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'Invalid API key' });
});

test('Authorization Bearer token resolves tenant from PostgreSQL API key', async () => {
  const { key } = await apiKeys.create('stark-key', ['read'], 'stark');

  const res = await request('/context', {
    headers: { Authorization: 'Bearer ' + key },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tenantId: string };
  assert.equal(body.tenantId, 'stark');
});

test('invalid API key is rejected when PostgreSQL authority has other keys', async () => {
  await apiKeys.create('valid-key', ['read'], 'acme-corp');

  const res = await request('/context', {
    headers: { 'X-API-Key': 'invalid-key' },
  });
  assert.equal(res.status, 401);
});

test('/ready stays public when PostgreSQL API keys are configured', async () => {
  await apiKeys.create('configured-key', ['read']);

  const res = await request('/ready');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ready' });
});

test('tenant-scoped persistent key does not leak tenant to other keys', async () => {
  const { key: keyA } = await apiKeys.create('key-a', ['read'], 'tenant-a');
  const { key: keyB } = await apiKeys.create('key-b', ['read'], 'tenant-b');

  const resA = await request('/context', { headers: { 'X-API-Key': keyA } });
  const bodyA = (await resA.json()) as { tenantId: string };
  assert.equal(bodyA.tenantId, 'tenant-a');

  const resB = await request('/context', { headers: { 'X-API-Key': keyB } });
  const bodyB = (await resB.json()) as { tenantId: string };
  assert.equal(bodyB.tenantId, 'tenant-b');
});
