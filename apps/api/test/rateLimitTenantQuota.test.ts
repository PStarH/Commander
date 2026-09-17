/**
 * AUDIT-B: rate limiting runs before authMiddleware / tenantContextMiddleware.
 * A raw X-Tenant-ID header must never consume another tenant's PostgreSQL
 * quota before an authenticated principal establishes the tenant identity.
 */
import * as assert from 'node:assert/strict';

// F-B-2: RATE_LIMIT_MAX is parsed at module load, so pin a tiny limit BEFORE
// importing ../src/securityMiddleware. At the default 120 the six spoofed
// requests below cannot exhaust the victim tier, so the regression test could
// never fail when the header-keying bug was reintroduced.
process.env.API_RATE_LIMIT = '1';
process.env.API_RATE_LIMIT_TENANT = '1';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { authMiddleware } from '../src/authMiddleware';
import {
  resetApiKeyStore,
  setApiKeyStore,
  type ApiKeyStore,
  type ApiKeyCreationResult,
  type ApiKeyRecord,
} from '../src/apiKeyStore';
import {
  resetAuthFailureStoreForTesting,
  setAuthFailureStore,
  type AuthFailureStore,
} from '../src/authFailureStore';
import type { RateLimitBucket, RateLimitEntry, RateLimitStore } from '../src/securityMiddleware';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';

class EmptyApiKeyStore implements ApiKeyStore {
  async list(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return [];
  }

  async listByTenant(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return [];
  }

  async findByHash(): Promise<ApiKeyRecord | undefined> {
    return undefined;
  }

  async create(): Promise<ApiKeyCreationResult> {
    throw new Error('test API-key store does not mint keys');
  }

  async revoke(): Promise<ApiKeyRecord | undefined> {
    return undefined;
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

class TestRateLimitStore implements RateLimitStore {
  private readonly entries: Array<{ key: string; count: number; resetAt: number }> = [];

  async consume(buckets: readonly RateLimitBucket[]): Promise<RateLimitEntry[]> {
    const now = Date.now();
    return buckets.map((bucket) => {
      const entry = this.entries.find((candidate) => candidate.key === bucket.key);
      if (!entry || entry.resetAt <= now) {
        const next = { key: bucket.key, count: 1, resetAt: now + bucket.windowMs };
        if (entry) Object.assign(entry, next);
        else this.entries.push(next);
        return { count: 1, resetAt: next.resetAt };
      }
      entry.count += 1;
      return { count: entry.count, resetAt: entry.resetAt };
    });
  }

  async cleanup(): Promise<number> {
    return 0;
  }
}

const unlockedFailures: AuthFailureStore = {
  get: async () => undefined,
  recordFailure: async () => ({
    count: 1,
    firstFailureAt: Date.now(),
    lastFailureAt: Date.now(),
    lockedUntil: 0,
  }),
  cleanup: async () => {},
};

const originalJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'audit-rl-secret';
const { createJwtMiddleware, signAccessToken } = await import('../src/jwtMiddleware');
// F-B-2: import the middleware AFTER API_RATE_LIMIT is set (see the top of the
// file) — a static import would hoist above the assignment and keep the 120
// default, making the spoof unobservable.
const { _resetRateLimitStoreForTesting, rateLimitMiddleware, setRateLimitStoreForTesting } =
  await import('../src/securityMiddleware');
const jwtMiddleware = createJwtMiddleware(async (id) =>
  id === 'user-victim'
    ? {
        id,
        username: 'victim',
        email: 'victim@example.test',
        passwordHash: 'unused',
        role: 'viewer',
        authVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: null,
      }
    : undefined,
);

let server: ReturnType<express.Express['listen']>;
let port: number;

function request(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

before(async () => {
  setRateLimitStoreForTesting(new TestRateLimitStore());
  setApiKeyStore(new EmptyApiKeyStore());
  setAuthFailureStore(unlockedFailures);

  const app = express();
  app.use(jwtMiddleware);
  app.use(rateLimitMiddleware);
  app.use(authMiddleware);
  app.use(tenantContextMiddleware);
  app.get('/probe', (_req, res) => {
    res.json({ ok: true });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  _resetRateLimitStoreForTesting();
  resetApiKeyStore();
  resetAuthFailureStoreForTesting();
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

const VICTIM_TOKEN = () =>
  signAccessToken({
    id: 'user-victim',
    username: 'victim',
    role: 'viewer',
    authVersion: 1,
    tenantId: 'tenant-victim',
  });

describe('AUDIT-B: spoofed X-Tenant-ID cannot consume the victim quota', () => {
  test('the tier limit really is 1, so a single request consumes a bucket', async () => {
    // F-B-2 control: the previous version left API_RATE_LIMIT at its 120
    // default, so six spoofed requests could never exhaust anything and the
    // assertion held no matter which key the middleware used.
    const first = await request('/probe', { headers: { 'x-tenant-id': 'tenant-victim' } });
    assert.notEqual(first.status, 429);
    const second = await request('/probe', { headers: { 'x-tenant-id': 'tenant-victim' } });
    assert.equal(second.status, 429, 'limit=1 must trip on the second request');
  });

  test('unauthenticated spoofed-header flood does not throttle a tenant JWT user', async () => {
    for (let count = 0; count < 6; count += 1) {
      await request('/probe', { headers: { 'x-tenant-id': 'tenant-victim' } });
    }

    const response = await request('/probe', {
      headers: { authorization: `Bearer ${VICTIM_TOKEN()}`, 'x-tenant-id': 'tenant-victim' },
    });

    // If the raw header were read, the victim's tenant bucket would already
    // hold 6+ tokens and this request would be 429.
    assert.equal(
      response.status,
      200,
      'legitimate tenant user must not be throttled by a spoofed-header flood',
    );

    // The victim's own tenant bucket is fresh, so its second request trips it.
    const second = await request('/probe', {
      headers: { authorization: `Bearer ${VICTIM_TOKEN()}`, 'x-tenant-id': 'tenant-victim' },
    });
    assert.equal(second.status, 429, 'the tenant bucket must be the one that is consumed');
  });
});
