import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { authMiddleware } from '../src/authMiddleware';

const ORIGINAL_API_KEYS = process.env.API_KEYS;
const ORIGINAL_AUTH_DISABLED = process.env.AUTH_DISABLED;

function mockRequest(path: string, headers: Record<string, string | string[]> = {}): Request {
  return { path, headers } as unknown as Request;
}

function mockResponse() {
  const result = {
    statusCode: 200,
    body: undefined as unknown,
  };

  const res = {
    status(code: number) {
      result.statusCode = code;
      return res;
    },
    json(body: unknown) {
      result.body = body;
      return res;
    },
  } as unknown as Response;

  return { res, result };
}

function runAuth(path: string, headers: Record<string, string | string[]> = {}) {
  const req = mockRequest(path, headers);
  const { res, result } = mockResponse();
  let nextCalled = false;

  authMiddleware(req, res, () => {
    nextCalled = true;
  });

  return { req, result, nextCalled };
}

describe('authMiddleware', () => {
  beforeEach(() => {
    process.env.API_KEYS = 'secret-key:ci-key:read;write';
    delete process.env.AUTH_DISABLED;
  });

  afterEach(() => {
    if (ORIGINAL_API_KEYS === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = ORIGINAL_API_KEYS;
    }

    if (ORIGINAL_AUTH_DISABLED === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = ORIGINAL_AUTH_DISABLED;
    }
  });

  it('allows public paths without credentials', () => {
    const result = runAuth('/health');

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
  });

  it('requires credentials for protected routes when API_KEYS is configured', () => {
    const result = runAuth('/api/orchestrator/status');

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
    assert.deepEqual(result.result.body, {
      error: 'Authentication required',
      hint: 'Provide X-API-Key header or Authorization: Bearer <token>',
    });
  });

  it('rejects invalid API keys', () => {
    const result = runAuth('/api/orchestrator/status', { 'x-api-key': 'wrong-key' });

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
    assert.deepEqual(result.result.body, { error: 'Invalid API key' });
  });

  it('accepts X-API-Key credentials', () => {
    const result = runAuth('/api/orchestrator/status', { 'x-api-key': 'secret-key' });

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
    assert.equal(result.req.apiKeyId, 'ci-key');
  });

  it('accepts bearer token credentials', () => {
    const result = runAuth('/api/orchestrator/status', {
      authorization: 'Bearer secret-key',
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
    assert.equal(result.req.apiKeyId, 'ci-key');
  });

  it('can be disabled explicitly for integration tests', () => {
    process.env.AUTH_DISABLED = 'true';

    const result = runAuth('/api/orchestrator/status');

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
  });
});
