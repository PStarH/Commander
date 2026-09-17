import { describe, it, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Request, Response } from 'express';
import { authMiddleware } from '../src/authMiddleware';
import { getAuthFailureStore } from '../src/authFailureStore';
import { resetApiKeyStore } from '../src/apiKeyStore';
import { requireLiveServer } from '../test/_helpers/requireLiveServer.mjs';
import {
  clearAllAuthApiKeys,
  clearAuthFailureRowsFor,
  provisionLiveServerCredential,
  revokeLiveServerCredential,
  type LiveServerCredential,
} from '../test/_helpers/liveServerCredential';

// apps/api/tests is a live-server suite; refuse to run without the runner's env.
const BASE_URL = requireLiveServer();

const ORIGINAL_API_KEYS = process.env.API_KEYS;
const ORIGINAL_AUTH_DISABLED = process.env.AUTH_DISABLED;
const ORIGINAL_ALLOW_ANON = process.env.COMMANDER_ALLOW_ANON;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_COMMANDER_ENV = process.env.COMMANDER_ENV;

/**
 * Every case uses its own client address from RFC 5737 TEST-NET-2. The
 * middleware records lockout rows keyed by client IP
 * (apps/api/src/authMiddleware.ts:84-121); sharing one address made the
 * invalid-key case lock out the cases after it, so the verdict depended on
 * execution order rather than on the behaviour under test.
 */
const TEST_IP = {
  publicPath: '198.51.100.11',
  refreshLogout: '198.51.100.12',
  protectedRoute: '198.51.100.13',
  noKeysConfigured: '198.51.100.14',
  allowAnon: '198.51.100.15',
  allowAnonWithKeys: '198.51.100.22',
  invalidKey: '198.51.100.16',
  lockoutRecording: '198.51.100.17',
  validKey: '198.51.100.18',
  validBearer: '198.51.100.19',
  authDisabled: '198.51.100.20',
  authDisabledWithoutAnon: '198.51.100.21',
} as const;

/** The lockout rows this file owns — every one is a documentation-range address. */
const OWNED_TEST_IPS = Object.values(TEST_IP);

let credential: LiveServerCredential;

before(async () => {
  credential = await provisionLiveServerCredential();
});

after(async () => {
  await revokeLiveServerCredential();
});

function mockRequest(
  ip: string,
  reqPath: string,
  headers: Record<string, string | string[]> = {},
): Request {
  return {
    path: reqPath,
    headers,
    ip,
    socket: { remoteAddress: ip },
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

async function runAuth(
  reqPath: string,
  headers: Record<string, string | string[]> = {},
  ip: string = TEST_IP.protectedRoute,
) {
  const req = mockRequest(ip, reqPath, headers);
  const { res, result } = mockResponse();
  let nextCalled = false;

  await authMiddleware(req, res, () => {
    nextCalled = true;
  });

  return { req, result, nextCalled };
}

describe('authMiddleware', () => {
  beforeEach(async () => {
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

    // Deterministic start state: clear exactly this file's own lockout rows, so
    // a previous case — or a previous run inside the 5-minute lockout window —
    // cannot decide the verdict. The lockout feature stays intact: the
    // invalid-key case below asserts a real record is written.
    await clearAuthFailureRowsFor(OWNED_TEST_IPS);
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

  it('allows public paths without credentials', async () => {
    const result = await runAuth('/health', {}, TEST_IP.publicPath);

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
  });

  it('allows /api/auth/refresh and /api/auth/logout without credentials', async () => {
    for (const p of ['/api/auth/refresh', '/api/auth/logout']) {
      const result = await runAuth(p, {}, TEST_IP.refreshLogout);
      assert.equal(result.nextCalled, true, `${p} should be public`);
      assert.equal(result.result.statusCode, 200);
    }
  });

  it('requires credentials for protected routes when API_KEYS is configured', async () => {
    const result = await runAuth('/api/orchestrator/status', {}, TEST_IP.protectedRoute);

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
    assert.deepEqual(result.result.body, {
      error: 'Authentication required',
      hint: 'Provide X-API-Key header or Authorization: Bearer <token>',
    });
  });

  it('rejects unauthenticated access when no API keys are configured (no fall-open)', async () => {
    delete process.env.API_KEYS;
    delete process.env.COMMANDER_ALLOW_ANON;

    const result = await runAuth('/api/orchestrator/status', {}, TEST_IP.noKeysConfigured);

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
  });

  it('allows anonymous access only when COMMANDER_ALLOW_ANON=1 and no keys are registered', async () => {
    // The middleware consults the PostgreSQL key store, not the env var
    // (apps/api/src/authMiddleware.ts:272-278): it falls through to the
    // anonymous branch only when the store is empty. So the "no keys"
    // precondition has to be created, not assumed — and the fixture key
    // restored afterwards so the remaining cases still authenticate.
    process.env.COMMANDER_ALLOW_ANON = '1';
    try {
      // The environment variable alone is not the precondition — the store
      // must also be empty, so clear it and restore the fixture afterwards.
      await clearAllAuthApiKeys();

      const result = await runAuth('/api/orchestrator/status', {}, TEST_IP.allowAnon);

      assert.equal(result.nextCalled, true);
      assert.equal(result.result.statusCode, 200);
    } finally {
      credential = await provisionLiveServerCredential();
    }
  });

  it('does not fall through to anonymous access while an API key is registered', async () => {
    // The complement of the case above: COMMANDER_ALLOW_ANON=1 alone is not an
    // anonymous bypass once the store holds a key.
    process.env.COMMANDER_ALLOW_ANON = '1';

    const result = await runAuth('/api/orchestrator/status', {}, TEST_IP.allowAnonWithKeys);

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
  });

  it('rejects invalid API keys', async () => {
    const result = await runAuth(
      '/api/orchestrator/status',
      { 'x-api-key': 'wrong-key' },
      TEST_IP.invalidKey,
    );

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
    assert.deepEqual(result.result.body, { error: 'Invalid API key' });
  });

  it('records a rejected attempt in the lockout authority', async () => {
    await runAuth(
      '/api/orchestrator/status',
      { 'x-api-key': 'wrong-key' },
      TEST_IP.lockoutRecording,
    );

    const entry = await getAuthFailureStore().get(TEST_IP.lockoutRecording);
    assert.ok(entry, 'a rejected key must be recorded against the client address');
    assert.ok(entry.count >= 1, `expected a recorded failure, got count=${entry?.count}`);
    assert.ok(entry.lastFailureAt > 0);
  });

  it('accepts X-API-Key credentials', async () => {
    const result = await runAuth(
      '/api/orchestrator/status',
      { 'x-api-key': credential.apiKey },
      TEST_IP.validKey,
    );

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
    assert.equal(result.req.apiKeyId, credential.principal.username);
  });

  it('accepts bearer token credentials', async () => {
    const result = await runAuth(
      '/api/orchestrator/status',
      { authorization: `Bearer ${credential.apiKey}` },
      TEST_IP.validBearer,
    );

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
    assert.equal(result.req.apiKeyId, credential.principal.username);
  });

  it('can be disabled explicitly for integration tests with ALLOW_ANON', async () => {
    process.env.AUTH_DISABLED = 'true';
    process.env.COMMANDER_ALLOW_ANON = '1';

    const result = await runAuth('/api/orchestrator/status', {}, TEST_IP.authDisabled);

    assert.equal(result.nextCalled, true);
    assert.equal(result.result.statusCode, 200);
  });

  it('rejects AUTH_DISABLED without COMMANDER_ALLOW_ANON outside production', async () => {
    process.env.AUTH_DISABLED = 'true';
    delete process.env.COMMANDER_ALLOW_ANON;

    const result = await runAuth('/api/orchestrator/status', {}, TEST_IP.authDisabledWithoutAnon);

    assert.equal(result.nextCalled, false);
    assert.equal(result.result.statusCode, 401);
  });

  it('reaches the live server the runner started', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
  });
});
