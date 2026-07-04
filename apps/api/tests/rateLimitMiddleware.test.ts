import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// RATE_LIMIT_MAX is parsed at module load time, so we must set the env before
// importing the middleware.
process.env.API_RATE_LIMIT = '2';
process.env.API_RATE_LIMIT_PERSISTENT = 'off';

let rateLimitMiddleware: (req: Request, res: Response, next: () => void) => void;
let _resetRateLimitStoreForTesting: () => void;

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
});
