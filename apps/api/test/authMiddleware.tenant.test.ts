import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { authMiddleware } from '../src/authMiddleware';
import { getApiKeyStore, resetApiKeyStore } from '../src/apiKeyStore';

let app: express.Express;
let server: ReturnType<typeof app.listen>;
let port: number;
let tmpDir: string;
let originalCwd: string;
let originalApiKeys: string | undefined;
let originalTenantApiKeys: string | undefined;

function request(p: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${p}`, init);
}

before(async () => {
  originalCwd = process.cwd();
  originalApiKeys = process.env.API_KEYS;
  originalTenantApiKeys = process.env.TENANT_API_KEYS;

  tmpDir = path.join(
    os.tmpdir(),
    `commander-auth-tenant-test-${crypto.randomBytes(8).toString('hex')}`,
  );
  fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
  process.chdir(tmpDir);

  app = express();
  app.use(authMiddleware);
  app.get('/context', (req: Request, res: Response) => {
    res.json({
      apiKeyId: req.apiKeyId,
      tenantId: req.tenantId,
    });
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
  process.env.API_KEYS = originalApiKeys;
  process.env.TENANT_API_KEYS = originalTenantApiKeys;
  resetApiKeyStore();
  process.chdir(originalCwd);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test('TENANT_API_KEYS static mapping sets req.tenantId', async () => {
  delete process.env.API_KEYS;
  process.env.TENANT_API_KEYS = 'acme-corp:acme-secret-key';
  resetApiKeyStore();

  const res = await request('/context', {
    headers: { 'X-API-Key': 'acme-secret-key' },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { apiKeyId: string; tenantId: string };
  assert.ok(body.apiKeyId.includes('acme-corp'));
  assert.equal(body.tenantId, 'acme-corp');
});

test('TENANT_API_KEYS multiple keys per tenant', async () => {
  delete process.env.API_KEYS;
  process.env.TENANT_API_KEYS = 'acme-corp:key1,key2;globex:key3';
  resetApiKeyStore();

  const res1 = await request('/context', {
    headers: { 'X-API-Key': 'key1' },
  });
  assert.equal(res1.status, 200);
  const body1 = (await res1.json()) as { tenantId: string };
  assert.equal(body1.tenantId, 'acme-corp');

  const res2 = await request('/context', {
    headers: { 'X-API-Key': 'key3' },
  });
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as { tenantId: string };
  assert.equal(body2.tenantId, 'globex');
});

test('persistent API key with tenantId sets req.tenantId', async () => {
  delete process.env.API_KEYS;
  delete process.env.TENANT_API_KEYS;
  resetApiKeyStore();

  const { key } = getApiKeyStore().create('tenant-key', ['read', 'write'], 'wayne-ind');

  const res = await request('/context', {
    headers: { 'X-API-Key': key },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { apiKeyId: string; tenantId: string };
  assert.equal(body.apiKeyId, 'tenant-key');
  assert.equal(body.tenantId, 'wayne-ind');
});

test('legacy API_KEYS without tenant still works and leaves tenantId unset', async () => {
  delete process.env.TENANT_API_KEYS;
  process.env.API_KEYS = 'legacy-api-key:legacy-key';
  resetApiKeyStore();

  const res = await request('/context', {
    headers: { 'X-API-Key': 'legacy-api-key' },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { apiKeyId: string; tenantId: string | undefined };
  assert.equal(body.apiKeyId, 'legacy-key');
  assert.equal(body.tenantId, undefined);
});

test('Authorization Bearer token resolves tenant from TENANT_API_KEYS', async () => {
  delete process.env.API_KEYS;
  process.env.TENANT_API_KEYS = 'stark:stark-bearer-token';
  resetApiKeyStore();

  const res = await request('/context', {
    headers: { Authorization: 'Bearer stark-bearer-token' },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tenantId: string };
  assert.equal(body.tenantId, 'stark');
});

test('invalid API key is rejected regardless of tenant mapping', async () => {
  delete process.env.API_KEYS;
  process.env.TENANT_API_KEYS = 'acme-corp:valid-key';
  resetApiKeyStore();

  const res = await request('/context', {
    headers: { 'X-API-Key': 'invalid-key' },
  });
  assert.equal(res.status, 401);
});

test('tenant-scoped persistent key does not leak tenant to other keys', async () => {
  delete process.env.API_KEYS;
  delete process.env.TENANT_API_KEYS;
  resetApiKeyStore();

  const store = getApiKeyStore();
  const { key: keyA } = store.create('key-a', ['read'], 'tenant-a');
  const { key: keyB } = store.create('key-b', ['read'], 'tenant-b');

  const resA = await request('/context', { headers: { 'X-API-Key': keyA } });
  const bodyA = (await resA.json()) as { tenantId: string };
  assert.equal(bodyA.tenantId, 'tenant-a');

  const resB = await request('/context', { headers: { 'X-API-Key': keyB } });
  const bodyB = (await resB.json()) as { tenantId: string };
  assert.equal(bodyB.tenantId, 'tenant-b');
});
