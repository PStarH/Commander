/**
 * AUDIT-B: rate limiting runs BEFORE authMiddleware / tenantContextMiddleware
 * and derives the tenant bucket from the raw X-Tenant-ID header. A completely
 * unauthenticated attacker (or a tenant-A identity) must not be able to consume
 * tenant-B's rate-limit quota by spoofing the header.
 *
 * Reproduces on the real mount chain (jwt → rateLimit → auth → tenantContext)
 * used by apps/api/src/index.ts.
 */
import { test, before, after, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const tmpDir = path.join(
  os.tmpdir(),
  `commander-rl-audit-${crypto.randomBytes(8).toString('hex')}`,
);
const originalCwd = process.cwd();
const envSnap: Record<string, string | undefined> = {
  JWT_SECRET: process.env.JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV,
  API_KEYS: process.env.API_KEYS,
  COMMANDER_ALLOW_ANON: process.env.COMMANDER_ALLOW_ANON,
  API_RATE_LIMIT: process.env.API_RATE_LIMIT,
  API_RATE_LIMIT_TENANT: process.env.API_RATE_LIMIT_TENANT,
  API_RATE_LIMIT_PERSISTENT: process.env.API_RATE_LIMIT_PERSISTENT,
};

fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = 'audit-rl-secret';
process.env.NODE_ENV = 'test';
delete process.env.API_KEYS;
delete process.env.COMMANDER_ALLOW_ANON;
process.env.API_RATE_LIMIT = '1000';
process.env.API_RATE_LIMIT_TENANT = '3';
process.env.API_RATE_LIMIT_PERSISTENT = 'off';

const { jwtMiddleware } = await import('../src/jwtMiddleware');
const { rateLimitMiddleware } = await import('../src/securityMiddleware');
const { authMiddleware } = await import('../src/authMiddleware');
const { tenantContextMiddleware } = await import('../src/tenantContextMiddleware');
const { signAccessToken } = await import('../src/jwtMiddleware');
const express = (await import('express')).default;

let server: ReturnType<typeof express.listen>;
let port: number;

function request(p: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${p}`, init);
}

before(async () => {
  const app = express();
  // Real mount order from src/index.ts steps 4→5→7→7a.
  app.use(jwtMiddleware);
  app.use(rateLimitMiddleware);
  app.use(authMiddleware);
  app.use(tenantContextMiddleware);
  app.get('/probe', (_req, res) => {
    res.json({ ok: true });
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
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(envSnap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('AUDIT-B: spoofed X-Tenant-ID must not consume the victim tenant quota', () => {
  test('unauthenticated spoofed-header flood does not throttle a legitimate tenant user', async () => {
    // Attacker: no credentials, claims to be tenant-victim.
    for (let i = 0; i < 6; i++) {
      await request('/probe', { headers: { 'x-tenant-id': 'tenant-victim' } });
    }

    // Legitimate tenant-victim user with a signed access token.
    const token = signAccessToken({
      id: 'user-victim',
      username: 'victim',
      role: 'viewer',
      tenantId: 'tenant-victim',
    });
    const res = await request('/probe', {
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'tenant-victim' },
    });

    // FAILING before the fix: 429 — the attacker's unauthenticated requests
    // were bucketed into tenant:victim and exhausted its quota.
    assert.equal(res.status, 200, 'legitimate tenant-victim request must not be throttled');
  });
});
