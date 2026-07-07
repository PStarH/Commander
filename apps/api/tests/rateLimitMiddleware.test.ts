import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { AuthUser } from '../src/jwtMiddleware';
import type { UserRole } from '../src/userStore';

// RATE_LIMIT_MAX is parsed at module load time, so we must set the env before
// importing the middleware.
process.env.API_RATE_LIMIT = '2';
process.env.API_RATE_LIMIT_PERSISTENT = 'off';

let rateLimitMiddleware: (req: Request, res: Response, next: () => void) => void;
let _resetRateLimitStoreForTesting: () => void;

function makeAuthUser(id: string, role: UserRole = 'user'): AuthUser {
  return { id, username: id, role };
}

function makeMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' } as any,
    url: '/api/v1/execute',
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
    _resetRateLimitStoreForTesting = mod._resetRateLimitStoreForTesting;
  });

  beforeEach(() => {
    _resetRateLimitStoreForTesting();
  });

  it('allows requests under the per-IP write tier limit', () => {
    const req = makeMockRequest();
    const res = makeMockResponse();
    let nextCalled = false;

    rateLimitMiddleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res._status, 200);
    assert.equal(res._headers['X-RateLimit-Limit'], 1); // floor(2 * 0.25) = 1
  });

  it('returns 429 when per-IP write tier limit is exceeded', () => {
    const req = makeMockRequest();
    const res1 = makeMockResponse();
    const res2 = makeMockResponse();
    const res3 = makeMockResponse();

    rateLimitMiddleware(req, res1 as unknown as Response, () => {});
    rateLimitMiddleware(req, res2 as unknown as Response, () => {});
    rateLimitMiddleware(req, res3 as unknown as Response, () => {});

    assert.equal(res1._status, 200);
    assert.equal(res2._status, 429);
    assert.equal(res3._status, 429);
    assert.equal((res2._json as any).error, 'Too many requests');
  });

  it('classifies /health as the health tier with a higher limit', () => {
    const req = makeMockRequest({ url: '/health', method: 'GET' });
    const res = makeMockResponse();

    rateLimitMiddleware(req, res as unknown as Response, () => {});

    assert.equal(res._headers['X-RateLimit-Tier'], 'health');
    assert.equal(res._headers['X-RateLimit-Limit'], 20); // floor(2 * 10)
  });

  it('tracks different users on the same IP independently', () => {
    const reqA = makeMockRequest({ user: makeAuthUser('user-a') });
    const reqB = makeMockRequest({ user: makeAuthUser('user-b') });
    const resA1 = makeMockResponse();
    const resA2 = makeMockResponse();
    const resB1 = makeMockResponse();

    rateLimitMiddleware(reqA, resA1 as unknown as Response, () => {});
    rateLimitMiddleware(reqA, resA2 as unknown as Response, () => {});
    rateLimitMiddleware(reqB, resB1 as unknown as Response, () => {});

    assert.equal(resA1._status, 200);
    assert.equal(resA2._status, 429);
    assert.equal(resA2._headers['X-RateLimit-Reason'], 'per-user-tier-write');
    assert.equal(resB1._status, 200, 'user-b should not be blocked by user-a');
  });

  it('tracks different tenants on the same IP independently', () => {
    const reqA = makeMockRequest({ headers: { 'x-tenant-id': 'tenant-a' } });
    const reqB = makeMockRequest({ headers: { 'x-tenant-id': 'tenant-b' } });
    const resA1 = makeMockResponse();
    const resA2 = makeMockResponse();
    const resB1 = makeMockResponse();

    rateLimitMiddleware(reqA, resA1 as unknown as Response, () => {});
    rateLimitMiddleware(reqA, resA2 as unknown as Response, () => {});
    rateLimitMiddleware(reqB, resB1 as unknown as Response, () => {});

    assert.equal(resA1._status, 200);
    assert.equal(resA2._status, 429);
    assert.equal(resA2._headers['X-RateLimit-Reason'], 'per-tenant-tier-write');
    assert.equal(resB1._status, 200, 'tenant-b should not be blocked by tenant-a');
  });

  it('prefers user bucket over tenant and IP when both are present', () => {
    const req = makeMockRequest({
      user: makeAuthUser('user-x'),
      headers: { 'x-tenant-id': 'tenant-x' },
    });
    const res = makeMockResponse();

    rateLimitMiddleware(req, res as unknown as Response, () => {});

    assert.equal(res._headers['X-RateLimit-Limit'], 1);
    assert.equal(res._headers['X-RateLimit-Reason'], undefined);
  });

  it('falls back to IP bucket when X-Tenant-ID is invalid', () => {
    const req1 = makeMockRequest({ headers: { 'x-tenant-id': '../evil' } });
    const req2 = makeMockRequest({ headers: { 'x-tenant-id': '../evil' } });
    const res1 = makeMockResponse();
    const res2 = makeMockResponse();

    rateLimitMiddleware(req1, res1 as unknown as Response, () => {});
    rateLimitMiddleware(req2, res2 as unknown as Response, () => {});

    assert.equal(res1._status, 200);
    assert.equal(res2._status, 429);
    assert.equal(res2._headers['X-RateLimit-Reason'], 'per-ip-tier-write');
  });
});
