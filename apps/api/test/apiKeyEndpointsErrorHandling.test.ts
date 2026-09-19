/**
 * AUTH-07: the API-key management endpoints echoed `String(error)` to the
 * client, leaking internal exceptions (a pg connection failure embeds the DSN,
 * including its password) and turning a down database into a 500. The response
 * must carry a stable code plus the request id, the internal log must be
 * redacted, and an unavailable authority must be 503.
 */
import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import express from 'express';
import { createApiKeyRouter } from '../src/apiKeyEndpoints';
import {
  resetApiKeyStore,
  setApiKeyStore,
  type ApiKeyStore,
  type ApiKeyCreationResult,
  type ApiKeyRecord,
} from '../src/apiKeyStore';
import { requestIdMiddleware } from '../src/securityMiddleware';

// JWT_SECRET is read at sign time, but pin it before importing the middleware
// so no other module can have captured an empty secret.
process.env.JWT_SECRET = 'api-key-error-handling-test-secret-32';
const { createJwtMiddleware, signAccessToken } = await import('../src/jwtMiddleware');

const SYNTHETIC_DSN =
  'postgresql://commander_app:sup3r-s3cr3t-pw@db.internal:5432/commander?sslmode=verify-full';

class ThrowingApiKeyStore implements ApiKeyStore {
  constructor(private readonly error: unknown) {}

  async list(): Promise<never> {
    throw this.error;
  }
  async listByTenant(): Promise<never> {
    throw this.error;
  }
  async findByHash(): Promise<ApiKeyRecord | undefined> {
    return undefined;
  }
  async create(): Promise<ApiKeyCreationResult> {
    throw this.error;
  }
  async revoke(): Promise<ApiKeyRecord | undefined> {
    throw this.error;
  }
  async delete(): Promise<boolean> {
    throw this.error;
  }
}

function dsnError(code: string): Error {
  const error = new Error(`connect ${code} ${SYNTHETIC_DSN}`);
  (error as Error & { code?: string }).code = code;
  return error;
}

const adminUser = {
  id: 'admin-1',
  username: 'admin',
  email: 'admin@example.test',
  passwordHash: 'unused',
  role: 'admin' as const,
  authVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

let server: ReturnType<express.Express['listen']>;
let port: number;
let capturedStderr: string[];
let originalStderrWrite: typeof process.stderr.write;

const adminToken = () =>
  signAccessToken({
    id: adminUser.id,
    username: adminUser.username,
    role: adminUser.role,
    authVersion: adminUser.authVersion,
    tenantId: 'tenant-a',
  });

async function startServer(error: unknown): Promise<void> {
  setApiKeyStore(new ThrowingApiKeyStore(error));
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    createJwtMiddleware(async (id) => (id === adminUser.id ? (adminUser as never) : undefined)),
  );
  app.use(createApiKeyRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}

function request(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${adminToken()}`, ...(init?.headers ?? {}) },
  });
}

before(() => {
  capturedStderr = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    capturedStderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    // Forward to the real stream so the test runner's own output is untouched.
    return (originalStderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

after(async () => {
  process.stderr.write = originalStderrWrite;
  await stopServer();
  resetApiKeyStore();
});

describe('AUTH-07: API-key management error responses', () => {
  test('a down database returns 503 with a stable code and no DSN leak', async () => {
    capturedStderr = [];
    await startServer(dsnError('ECONNREFUSED'));
    try {
      const response = await request('/api/admin/api-keys');
      assert.equal(response.status, 503);
      const raw = await response.text();
      assert.equal(raw.includes('sup3r-s3cr3t-pw'), false, 'the password must not leak');
      assert.equal(raw.includes('db.internal'), false, 'the DSN host must not leak');
      assert.equal(raw.includes('commander_app'), false, 'the DSN role must not leak');
      const body = JSON.parse(raw) as { code?: string; requestId?: string; error?: string };
      assert.equal(body.code, 'API_KEY_AUTHORITY_UNAVAILABLE');
      assert.equal(typeof body.requestId, 'string');
      assert.ok(body.requestId!.length > 0, 'the request id must be echoed for correlation');
    } finally {
      await stopServer();
    }
  });

  test('the internal log keeps a diagnostic but redacts the DSN', async () => {
    capturedStderr = [];
    await startServer(dsnError('ECONNREFUSED'));
    try {
      await request('/api/admin/api-keys');
      const log = capturedStderr.join('');
      assert.match(log, /\[ApiKeyEndpoints\] list failed/);
      assert.match(log, /postgres:\/\/<redacted>/, 'the DSN must be redacted in the log');
      assert.equal(log.includes('sup3r-s3cr3t-pw'), false, 'the password must not be logged');
    } finally {
      await stopServer();
    }
  });

  test('a non-authority failure is a 500 with a stable code, never the raw message', async () => {
    capturedStderr = [];
    await startServer(new Error('unexpected internal invariant at /srv/app/secret.ts:12'));
    try {
      const listResponse = await request('/api/admin/api-keys');
      assert.equal(listResponse.status, 500);
      const listRaw = await listResponse.text();
      assert.equal(listRaw.includes('secret.ts'), false, 'internal paths must not leak');
      assert.equal((JSON.parse(listRaw) as { code?: string }).code, 'API_KEY_OPERATION_FAILED');

      const createResponse = await request('/api/admin/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'k' }),
      });
      assert.equal(createResponse.status, 500);
      assert.equal(
        (JSON.parse(await createResponse.text()) as { code?: string }).code,
        'API_KEY_OPERATION_FAILED',
      );

      const revokeResponse = await request('/api/admin/api-keys/ak_1', { method: 'DELETE' });
      assert.equal(revokeResponse.status, 500);
      assert.equal(
        (JSON.parse(await revokeResponse.text()) as { code?: string }).code,
        'API_KEY_OPERATION_FAILED',
      );
    } finally {
      await stopServer();
    }
  });

  test('an invalid DSN code is treated as an unavailable authority (503)', async () => {
    await startServer(dsnError('AUTH_DATABASE_ROLE_INVALID'));
    try {
      const response = await request('/api/admin/api-keys');
      assert.equal(response.status, 503);
      assert.equal(
        (JSON.parse(await response.text()) as { code?: string }).code,
        'API_KEY_AUTHORITY_UNAVAILABLE',
      );
    } finally {
      await stopServer();
    }
  });
});
