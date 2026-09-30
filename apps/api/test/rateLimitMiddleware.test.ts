import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { AuthUser } from '../src/jwtMiddleware';
import type { UserRole } from '../src/userStore';

// RATE_LIMIT_MAX is parsed at module load time, so we must set the env before
// importing the middleware.
process.env.API_RATE_LIMIT = '2';

let rateLimitMiddleware: (req: Request, res: Response, next: () => void) => Promise<void>;
let setRateLimitStoreForTesting: (store: RateLimitStore) => void;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}
interface RateLimitBucket {
  key: string;
  windowMs: number;
}
interface RateLimitStore {
  consume(buckets: readonly RateLimitBucket[]): Promise<RateLimitEntry[]>;
  cleanup(now: number): Promise<number>;
}

/**
 * In-memory stand-in for the PostgreSQL-authoritative rate-limit store. The
 * middleware only depends on the `RateLimitStore` port, so injecting this keeps
 * the identity/bucket-selection logic under test without a live database.
 */
class FakeRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, RateLimitEntry>();

  async consume(buckets: readonly RateLimitBucket[]): Promise<RateLimitEntry[]> {
    const now = Date.now();
    return buckets.map((bucket) => {
      const existing = this.buckets.get(bucket.key);
      const entry: RateLimitEntry =
        !existing || existing.resetAt <= now
          ? { count: 1, resetAt: now + bucket.windowMs }
          : { count: existing.count + 1, resetAt: existing.resetAt };
      this.buckets.set(bucket.key, entry);
      return { ...entry };
    });
  }

  async cleanup(): Promise<number> {
    return 0;
  }

  keys(): string[] {
    return [...this.buckets.keys()];
  }
}

let store: FakeRateLimitStore;

function makeAuthUser(id: string, role: UserRole = 'user', tenantId?: string): AuthUser {
  return { id, username: id, role, authVersion: 1, ...(tenantId ? { tenantId } : {}) };
}

function makeMockRequest(overrides: Partial<Request> & { tenantId?: string } = {}): Request {
  const url = (overrides.url as string | undefined) ?? '/api/v1/execute';
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' } as any,
    url,
    // Express exposes `req.path` as the canonical pathname with the query string
    // stripped; the limiter classifies on it, because `req.url` let a query
    // parameter choose the tier (AUTH-01). Mirror that here so the harness cannot
    // pass by accident.
    path: (overrides.path as string | undefined) ?? url.split('?')[0],
    method: 'POST',
    headers: {},
    ...overrides,
  } as Request;
}

function makeMockResponse(): Response & {
  _status: number;
  _json: unknown;
  _headers: Record<string, string | number>;
} {
  const res = {
    _status: 200,
    _json: undefined,
    _headers: {},
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
    setHeader(name: string, value: string | number) {
      this._headers[name] = value;
      return this;
    },
  } as any;
  return res;
}

describe('rateLimitMiddleware', async () => {
  before(async () => {
    const mod = await import('../src/securityMiddleware');
    rateLimitMiddleware = mod.rateLimitMiddleware;
    setRateLimitStoreForTesting = mod.setRateLimitStoreForTesting;
  });

  beforeEach(() => {
    store = new FakeRateLimitStore();
    setRateLimitStoreForTesting(store);
  });

  it('allows requests under the per-IP write tier limit', async () => {
    const req = makeMockRequest();
    const res = makeMockResponse();
    let nextCalled = false;

    await rateLimitMiddleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res._status, 200);
    assert.equal(res._headers['X-RateLimit-Limit'], 1); // floor(2 * 0.25) = 1
    assert.deepEqual(store.keys(), ['ip:127.0.0.1']);
  });

  it('returns 429 when per-IP write tier limit is exceeded', async () => {
    const req = makeMockRequest();
    const res1 = makeMockResponse();
    const res2 = makeMockResponse();
    const res3 = makeMockResponse();

    await rateLimitMiddleware(req, res1 as unknown as Response, () => {});
    await rateLimitMiddleware(req, res2 as unknown as Response, () => {});
    await rateLimitMiddleware(req, res3 as unknown as Response, () => {});

    assert.equal(res1._status, 200);
    assert.equal(res2._status, 429);
    assert.equal(res3._status, 429);
    assert.equal((res2._json as any).error, 'Too many requests');
  });

  it('classifies /health as the health tier with a higher limit', async () => {
    const req = makeMockRequest({ url: '/health', method: 'GET' });
    const res = makeMockResponse();

    await rateLimitMiddleware(req, res as unknown as Response, () => {});

    assert.equal(res._headers['X-RateLimit-Tier'], 'health');
    assert.equal(res._headers['X-RateLimit-Limit'], 20); // floor(2 * 10)
  });

  it('does not let a query string choose the rate-limit tier', async () => {
    // AUTH-01: `POST /api/v1/execute?next=/health` matched the non-anchored health
    // pattern against `req.url` and was granted the 10x health budget instead of
    // the 0.25x write budget — a caller picked their own limit.
    const spoofed = makeMockRequest({ url: '/api/v1/execute?next=/health', method: 'POST' });
    const spoofedRes = makeMockResponse();
    await rateLimitMiddleware(spoofed, spoofedRes as unknown as Response, () => {});
    assert.equal(spoofedRes._headers['X-RateLimit-Tier'], 'write');
    assert.equal(spoofedRes._headers['X-RateLimit-Limit'], 1); // floor(2 * 0.25)

    // And a query string on a genuine health path must not change anything.
    const health = makeMockRequest({ url: '/metrics?x=/execute', method: 'GET' });
    const healthRes = makeMockResponse();
    await rateLimitMiddleware(health, healthRes as unknown as Response, () => {});
    assert.equal(healthRes._headers['X-RateLimit-Tier'], 'health');
    assert.equal(healthRes._headers['X-RateLimit-Limit'], 20);
  });

  it('classifies every mutating route as the write tier, not only the legacy three', async () => {
    // The old write pattern listed only /api/v1/(execute|plan|memory), so the real
    // mutating mounts below were billed as reads at 4x the intended budget.
    const cases: Array<[string, string]> = [
      ['POST', '/orchestrator/execute'],
      ['POST', '/api/pipeline/execute'],
      ['POST', '/api/workflows/wf-1/execute'],
      ['PATCH', '/api/v1/settings'],
      ['DELETE', '/v1/actions/run-1'],
    ];
    for (const [method, url] of cases) {
      const req = makeMockRequest({ method, url } as Partial<Request>);
      const res = makeMockResponse();
      await rateLimitMiddleware(req, res as unknown as Response, () => {});
      assert.equal(
        res._headers['X-RateLimit-Tier'],
        'write',
        `${method} ${url} must be the write tier`,
      );
    }
  });

  it('tracks different users on the same IP independently', async () => {
    const reqA = makeMockRequest({ user: makeAuthUser('user-a') });
    const reqB = makeMockRequest({ user: makeAuthUser('user-b') });
    const resA1 = makeMockResponse();
    const resA2 = makeMockResponse();
    const resB1 = makeMockResponse();

    await rateLimitMiddleware(reqA, resA1 as unknown as Response, () => {});
    await rateLimitMiddleware(reqA, resA2 as unknown as Response, () => {});
    await rateLimitMiddleware(reqB, resB1 as unknown as Response, () => {});

    assert.equal(resA1._status, 200);
    assert.equal(resA2._status, 429);
    assert.equal(resA2._headers['X-RateLimit-Reason'], 'per-user-tier-write');
    assert.equal(resB1._status, 200, 'user-b should not be blocked by user-a');
  });

  // F-B-1: the raw X-Tenant-ID header must never be an identity. This middleware
  // runs before authMiddleware, so an unauthenticated caller could otherwise
  // mint an unlimited number of buckets (or exhaust another tenant's quota).
  it('does not treat a client-supplied x-tenant-id header as an identity', async () => {
    const reqA = makeMockRequest({ headers: { 'x-tenant-id': 'tenant-a' } });
    const reqB = makeMockRequest({ headers: { 'x-tenant-id': 'tenant-b' } });
    const resA1 = makeMockResponse();
    const resA2 = makeMockResponse();
    const resB1 = makeMockResponse();

    await rateLimitMiddleware(reqA, resA1 as unknown as Response, () => {});
    await rateLimitMiddleware(reqA, resA2 as unknown as Response, () => {});
    await rateLimitMiddleware(reqB, resB1 as unknown as Response, () => {});

    // The header is ignored, so all three calls share the single IP bucket.
    assert.equal(resA1._status, 200);
    assert.equal(resA2._status, 429);
    assert.equal(resA2._headers['X-RateLimit-Reason'], 'per-ip-tier-write');
    assert.equal(
      resB1._status,
      429,
      'a spoofed tenant header must not mint a fresh bucket for the caller',
    );
    assert.equal(resB1._headers['X-RateLimit-Reason'], 'per-ip-tier-write');
    assert.deepEqual(
      store.keys(),
      ['ip:127.0.0.1'],
      'no tenant bucket may be derived from a client header',
    );
  });

  it('tracks verified tenants on the same IP independently', async () => {
    const reqA = makeMockRequest({ tenantId: 'tenant-a' });
    const reqB = makeMockRequest({ tenantId: 'tenant-b' });
    const resA1 = makeMockResponse();
    const resA2 = makeMockResponse();
    const resB1 = makeMockResponse();

    await rateLimitMiddleware(reqA, resA1 as unknown as Response, () => {});
    await rateLimitMiddleware(reqA, resA2 as unknown as Response, () => {});
    await rateLimitMiddleware(reqB, resB1 as unknown as Response, () => {});

    assert.equal(resA1._status, 200);
    assert.equal(resA2._status, 429);
    assert.equal(resA2._headers['X-RateLimit-Reason'], 'per-tenant-tier-write');
    assert.equal(resB1._status, 200, 'tenant-b should not be blocked by tenant-a');
    assert.deepEqual(store.keys().sort(), ['tenant:tenant-a', 'tenant:tenant-b']);
  });

  it('uses the verified JWT tenant claim as the tenant identity', async () => {
    const req = makeMockRequest({ user: makeAuthUser('user-a', 'user', 'tenant-jwt') });
    const res = makeMockResponse();

    await rateLimitMiddleware(req, res as unknown as Response, () => {});

    assert.equal(res._status, 200);
    assert.deepEqual(store.keys().sort(), ['tenant:tenant-jwt', 'user:user-a']);
  });

  it('prefers user bucket over tenant and IP when both are present', async () => {
    const req = makeMockRequest({
      user: makeAuthUser('user-x', 'user', 'tenant-x'),
    });
    const res = makeMockResponse();

    await rateLimitMiddleware(req, res as unknown as Response, () => {});

    assert.equal(res._headers['X-RateLimit-Limit'], 1);
    assert.equal(res._headers['X-RateLimit-Reason'], undefined);
  });

  it('falls back to IP bucket when the verified tenant id is malformed', async () => {
    const req1 = makeMockRequest({ tenantId: '../evil' });
    const req2 = makeMockRequest({ tenantId: '../evil' });
    const res1 = makeMockResponse();
    const res2 = makeMockResponse();

    await rateLimitMiddleware(req1, res1 as unknown as Response, () => {});
    await rateLimitMiddleware(req2, res2 as unknown as Response, () => {});

    assert.equal(res1._status, 200);
    assert.equal(res2._status, 429);
    assert.equal(res2._headers['X-RateLimit-Reason'], 'per-ip-tier-write');
    assert.deepEqual(store.keys(), ['ip:127.0.0.1']);
  });

  it('fails closed with 503 when the rate-limit authority is unavailable', async () => {
    setRateLimitStoreForTesting({
      consume: async () => {
        throw new Error('AUTH_DATABASE_URL_REQUIRED');
      },
      cleanup: async () => 0,
    });
    const req = makeMockRequest();
    const res = makeMockResponse();
    let nextCalled = false;

    await rateLimitMiddleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, 'an unavailable authority must not let traffic through');
    assert.equal(res._status, 503);
    assert.equal(res._headers['Retry-After'], '60');
  });
});
