import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { AuthUser } from '../src/jwtMiddleware';
import type { RateLimitBucket, RateLimitStore } from '../src/securityMiddleware';
import type { UserRole } from '../src/userStore';

process.env.API_RATE_LIMIT = '2';

let rateLimitMiddleware: (req: Request, res: Response, next: () => void) => Promise<void>;
let setRateLimitStoreForTesting: (store: RateLimitStore) => void;
let _resetRateLimitStoreForTesting: () => void;

function makeAuthUser(id: string, role: UserRole = 'user'): AuthUser { return { id, username: id, role }; }
function makeMockRequest(overrides: Partial<Request> = {}): Request {
  return { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } as never, url: '/api/v1/execute', method: 'POST', headers: {}, ...overrides } as Request;
}
function makeMockResponse(): Response & { _status: number; _json: unknown; _headers: Record<string, string | number> } {
  return {
    _status: 200, _json: undefined, _headers: {},
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._json = body; return this; },
    setHeader(name: string, value: string | number) { this._headers[name] = value; return this; },
  } as never;
}
function authority(): RateLimitStore {
  const entries = new Map<string, number>();
  return {
    async consume(buckets: readonly RateLimitBucket[]) {
      return buckets.map((bucket) => {
        const count = (entries.get(bucket.key) ?? 0) + 1;
        entries.set(bucket.key, count);
        return { count, resetAt: Date.now() + 60_000 };
      });
    },
  };
}

describe('rateLimitMiddleware', () => {
  before(async () => {
    const mod = await import('../src/securityMiddleware');
    rateLimitMiddleware = mod.rateLimitMiddleware;
    setRateLimitStoreForTesting = mod.setRateLimitStoreForTesting;
    _resetRateLimitStoreForTesting = mod._resetRateLimitStoreForTesting;
  });
  beforeEach(() => { _resetRateLimitStoreForTesting(); setRateLimitStoreForTesting(authority()); });

  it('enforces the PostgreSQL-backed IP scope', async () => {
    const req = makeMockRequest();
    const first = makeMockResponse();
    const second = makeMockResponse();
    await rateLimitMiddleware(req, first, () => {});
    await rateLimitMiddleware(req, second, () => {});
    assert.equal(first._status, 200);
    assert.equal(second._status, 429);
    assert.equal(second._headers['X-RateLimit-Reason'], 'per-ip-tier-write');
  });

  it('keeps authenticated users on separate scopes', async () => {
    const first = makeMockResponse();
    const second = makeMockResponse();
    await rateLimitMiddleware(makeMockRequest({ user: makeAuthUser('user-a') }), first, () => {});
    await rateLimitMiddleware(makeMockRequest({ user: makeAuthUser('user-b') }), second, () => {});
    assert.equal(first._status, 200);
    assert.equal(second._status, 200);
  });
});
