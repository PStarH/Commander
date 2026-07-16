import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Request, Response } from 'express';
import { authMiddleware } from '../src/authMiddleware';
import { resetApiKeyStore } from '../src/apiKeyStore';

const ORIGINAL_API_KEYS = process.env.API_KEYS;
const ORIGINAL_AUTH_DISABLED = process.env.AUTH_DISABLED;
const ORIGINAL_ALLOW_ANON = process.env.COMMANDER_ALLOW_ANON;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_COMMANDER_ENV = process.env.COMMANDER_ENV;

function mockRequest(path: string, headers: Record<string, string | string[]> = {}): Request {
  return {
    path,
    headers,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
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
    delete process.env.COMMANDER_ALLOW_ANON;
    delete process.env.COMMANDER_ENV;
    delete process.env.TENANT_API_KEYS;
    resetApiKeyStore();
    // Keep NODE_ENV non-production for unit tests unless a case overrides it.
    if (process.env.NODE_ENV === 'production') {
      process.env.NODE_ENV = 'test';
    }
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

    if (ORIGINAL_ALLOW_ANON === undefined) {
      delete process.env.COMMANDER_ALLOW_ANON;
    } else {
      process.env.COMMANDER_ALLOW_ANON = ORIGINAL_ALLOW_ANON;
    }

    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }

    if (ORIGINAL_COMMANDER_ENV === undefined) {
      delete process.env.COMMANDER_ENV;
    } else {
      process.env.COMMANDER_ENV = ORIGINAL_COMMANDER_ENV;
    }
  });

  it('allows public paths without credentials', () => {
    const result = runAuth('/health');

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
  });

  it('allows /api/auth/refresh and /api/auth/logout without credentials', () => {
    for (const p of ['/api/auth/refresh', '/api/auth/logout']) {
      const result = runAuth(p);
      assert.equal(result.nextCalled, true, `${p} should be public`);
      assert.equal(result.result.statusCode, 200);
    }
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

  it('rejects unauthenticated access when no API keys are configured (no fall-open)', () => {
    delete process.env.API_KEYS;
    delete process.env.COMMANDER_ALLOW_ANON;

    const result = runAuth('/api/orchestrator/status');

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
  });

  it('allows anonymous access only when COMMANDER_ALLOW_ANON=1 and no keys', () => {
    // ApiKeyStore resolves KEYS_FILE at module load (process.cwd then), so
    // chdir cannot empty it — temporarily move the on-disk store aside.
    const keysPath = path.join(process.cwd(), '.commander', 'api_keys.json');
    const backupPath = `${keysPath}.bak-allow-anon-test`;
    let moved = false;
    if (fs.existsSync(keysPath)) {
      fs.renameSync(keysPath, backupPath);
      moved = true;
    }
    try {
      delete process.env.API_KEYS;
      delete process.env.TENANT_API_KEYS;
      process.env.COMMANDER_ALLOW_ANON = '1';
      resetApiKeyStore();

      const result = runAuth('/api/orchestrator/status');

      assert.equal(result.nextCalled, true);
      assert.equal(result.result.statusCode, 200);
    } finally {
      resetApiKeyStore();
      if (moved) {
        fs.renameSync(backupPath, keysPath);
      }
    }
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

  it('can be disabled explicitly for integration tests with ALLOW_ANON', () => {
    process.env.AUTH_DISABLED = 'true';
    process.env.COMMANDER_ALLOW_ANON = '1';

    const result = runAuth('/api/orchestrator/status');

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
  });

  it('rejects AUTH_DISABLED without COMMANDER_ALLOW_ANON outside production', () => {
    process.env.AUTH_DISABLED = 'true';
    delete process.env.COMMANDER_ALLOW_ANON;

    const result = runAuth('/api/orchestrator/status');

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
  });
});
