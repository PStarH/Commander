/**
 * AUDIT-B: rate limiting runs before authMiddleware / tenantContextMiddleware.
 * A raw X-Tenant-ID header must never consume another tenant's PostgreSQL
 * quota before an authenticated principal establishes the tenant identity.
 */
import * as assert from 'node:assert/strict';
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
import {
  _resetRateLimitStoreForTesting,
  rateLimitMiddleware,
  setRateLimitStoreForTesting,
  type RateLimitBucket,
  type RateLimitEntry,
  type RateLimitStore,
} from '../src/securityMiddleware';
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
const { jwtMiddleware, signAccessToken } = await import('../src/jwtMiddleware');

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

describe('AUDIT-B: spoofed X-Tenant-ID cannot consume the victim quota', () => {
  test('unauthenticated spoofed-header flood does not throttle a tenant JWT user', async () => {
    for (let count = 0; count < 6; count += 1) {
      await request('/probe', { headers: { 'x-tenant-id': 'tenant-victim' } });
    }

    const token = signAccessToken({
      id: 'user-victim',
      username: 'victim',
      role: 'viewer',
      tenantId: 'tenant-victim',
    });
    const response = await request('/probe', {
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'tenant-victim' },
    });

    assert.equal(response.status, 200, 'legitimate tenant user must not be throttled');
  });
});
