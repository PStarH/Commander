/**
 * LM-27 (server half) — the real middleware chain in front of the SSE router.
 *
 * `streamEndpoints.auth.test.ts` covers the router's own decisions, but it
 * **stubs the identity**: every case there sets `req.user` / `req.tenantId` in a
 * hand-written middleware. That proves the router's logic and proves nothing
 * about the composition the product actually ships — that the JWT middleware,
 * the API-key auth middleware and the tenant-context middleware run *before* the
 * stream handler and reject there.
 *
 * The plan asked for exactly this (LM-27 step 6): "full middleware composition
 * ... JWT/auth/tenant/stream order, without booting index.ts; project
 * authorization and the tenant-wide admin gate stay; a rejection means zero
 * subscriptions / zero SSE headers."
 *
 * Three properties are asserted, and they are the whole point of the file:
 *
 *   1. **No SSE headers.** `createStreamRouter` writes
 *      `Content-Type: text/event-stream` (and `X-Accel-Buffering: no`) only on
 *      the success path, after every authorization gate has passed. Their
 *      absence is a precise statement that no stream was opened.
 *   2. **Where the rejection happened.** `resolveProject` is injected as a spy,
 *      so the suite can distinguish the two genuinely different rejection
 *      classes rather than lumping them together:
 *        - rejected *before* the handler (auth failure, tenant-header mismatch)
 *          → `resolveProject` is never called;
 *        - rejected *inside* the handler by the object-level tenant check
 *          → the project **is** resolved, because its tenant is only knowable
 *          after resolution, and the denial is a 404.
 *   3. **The URL token stays dead.** A query-string `access_token` is not an
 *      authority in the composed chain.
 *
 * The two Postgres authorities are injected through their documented seams
 * (`setAuthFailureStore` / `setApiKeyStore`) exactly as
 * `authMiddleware.tenant.test.ts` does. Without them the chain under test is
 * not the shipped chain: `authMiddleware` reaches for the failure store before
 * it looks at any credential, so a missing DSN turns every anonymous request
 * into a 500 and the test would be asserting an artifact of the environment
 * rather than the middleware's behaviour.
 *
 * `index.ts` is never imported — the chain is composed here explicitly, so the
 * test cannot be satisfied by a route the real app does not mount, and cannot
 * boot the server.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createJwtMiddleware, signAccessToken } from '../src/jwtMiddleware';
import { authMiddleware } from '../src/authMiddleware';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import { createStreamRouter } from '../src/streamEndpoints';
import { TestAuthFailureStore, TestUserRepository } from './authRepositories';
import {
  resetAuthFailureStoreForTesting,
  setAuthFailureStore,
  type AuthFailureStore,
} from '../src/authFailureStore';
import {
  resetApiKeyStore,
  setApiKeyStore,
  type ApiKeyCreationResult,
  type ApiKeyRecord,
  type ApiKeyStore,
} from '../src/apiKeyStore';
import { _resetUserStoreForTests, findUserById, setUserRepository } from '../src/userStore';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

/**
 * The chain must see an empty key table, not a missing database. `findByHash`
 * and `list` are the two calls `authMiddleware` makes; the mutators are
 * unreachable from the middleware and throw so that a future change which
 * starts depending on them fails loudly instead of silently passing.
 */
class EmptyApiKeyStore implements ApiKeyStore {
  async list(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return [];
  }

  async listByTenant(_tenantId: string): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return [];
  }

  async findByHash(_hash: string): Promise<ApiKeyRecord | undefined> {
    return undefined;
  }

  async create(
    _name: string,
    _scopes?: string[],
    _tenantId?: string,
  ): Promise<ApiKeyCreationResult> {
    throw new Error('EmptyApiKeyStore.create is unreachable from authMiddleware');
  }

  async revoke(_id: string, _tenantScope?: string): Promise<ApiKeyRecord | undefined> {
    throw new Error('EmptyApiKeyStore.revoke is unreachable from authMiddleware');
  }

  async delete(_id: string, _tenantScope?: string): Promise<boolean> {
    throw new Error('EmptyApiKeyStore.delete is unreachable from authMiddleware');
  }
}

interface Harness {
  port: number;
  close: () => Promise<void>;
  /** Projects `resolveProject` was asked about. */
  resolvedProjectIds: string[];
}

/**
 * Compose the shipped chain — jwt → auth → tenant context → stream router —
 * around an in-memory user repository.
 */
async function startHarness(): Promise<Harness> {
  const resolvedProjectIds: string[] = [];
  const projects = new Map<string, { id: string; tenantId: string }>([
    ['p-a', { id: 'p-a', tenantId: TENANT_A }],
    ['p-b', { id: 'p-b', tenantId: TENANT_B }],
  ]);

  const app = express();
  app.use(createJwtMiddleware(findUserById));
  app.use(authMiddleware);
  app.use(tenantContextMiddleware);
  app.use(
    createStreamRouter({
      resolveProject: (projectId) => {
        resolvedProjectIds.push(projectId);
        return projects.get(projectId);
      },
    }),
  );

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    resolvedProjectIds,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Every response the router opens must be cancelled so the socket is freed. */
async function request(
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; contentType: string | null; body: unknown; raw: Response }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/event-stream', ...(init.headers ?? {}) },
    ...init,
  });
  const contentType = res.headers.get('content-type');
  const isSse = (contentType ?? '').includes('text/event-stream');
  const body = isSse ? undefined : await res.json().catch(() => undefined);
  if (isSse) await res.body?.cancel();
  return { status: res.status, contentType, body, raw: res };
}

/** A 2xx SSE response must carry both stream headers; a rejection neither. */
function assertNoStream(contentType: string | null, raw: Response, context: string): void {
  assert.doesNotMatch(contentType ?? '', /text\/event-stream/, context);
  assert.equal(raw.headers.get('x-accel-buffering'), null, `${context} — no SSE buffering header`);
}

describe('LM-27: real auth → tenant → stream middleware composition', () => {
  let harness: Harness;
  let adminToken: string;
  let viewerToken: string;

  before(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-sse-composition';
    // Default-deny is the shipped posture; an ambient escape hatch inherited
    // from the runner would turn the anonymous cases into 200s.
    delete process.env.COMMANDER_ALLOW_ANON;
    delete process.env.AUTH_DISABLED;

    const users = new TestUserRepository();
    setUserRepository(users);
    const failureStore: AuthFailureStore = new TestAuthFailureStore();
    setAuthFailureStore(failureStore);
    setApiKeyStore(new EmptyApiKeyStore());

    const admin = await users.createUser({
      username: 'sse-admin',
      email: 'sse-admin@example.test',
      password: 'test-password',
      role: 'admin',
    });
    assert.ok(!('error' in admin));
    const viewer = await users.createUser({
      username: 'sse-viewer',
      email: 'sse-viewer@example.test',
      password: 'test-password',
      role: 'viewer',
    });
    assert.ok(!('error' in viewer));

    const adminUser = await findUserById(admin.user.id);
    const viewerUser = await findUserById(viewer.user.id);
    assert.ok(adminUser, 'the injected repository must resolve the admin it created');
    assert.ok(viewerUser, 'the injected repository must resolve the viewer it created');

    // The access token carries the tenant claim, so the chain establishes
    // identity from the token alone — no header may widen it.
    adminToken = signAccessToken({ ...adminUser, tenantId: TENANT_A });
    viewerToken = signAccessToken({ ...viewerUser, tenantId: TENANT_A });

    harness = await startHarness();
  });

  beforeEach(() => {
    harness.resolvedProjectIds.length = 0;
  });

  after(async () => {
    await harness.close();
    _resetUserStoreForTests();
    resetApiKeyStore();
    resetAuthFailureStoreForTesting();
  });

  it('opens a stream for a project in the token tenant', async () => {
    const { status, contentType, raw } = await request(harness.port, '/projects/p-a/events', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    assert.equal(status, 200);
    assert.match(contentType ?? '', /text\/event-stream/);
    assert.equal(raw.headers.get('x-accel-buffering'), 'no', 'SSE buffering must be disabled');
    assert.deepEqual(harness.resolvedProjectIds, ['p-a']);
  });

  it('rejects an anonymous request before the handler resolves anything', async () => {
    const { status, contentType, raw } = await request(harness.port, '/projects/p-a/events');

    assert.equal(status, 401, 'the chain must reject before the stream handler');
    assertNoStream(contentType, raw, 'anonymous');
    assert.deepEqual(harness.resolvedProjectIds, [], 'project resolution must not run');
  });

  it('rejects a forged Bearer token before the handler resolves anything', async () => {
    const { status, contentType, raw } = await request(harness.port, '/projects/p-a/events', {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
    });

    assert.equal(status, 401);
    assertNoStream(contentType, raw, 'forged bearer');
    assert.deepEqual(harness.resolvedProjectIds, []);
  });

  it('does not leak the existence of another tenant project', async () => {
    // Same status for "not yours" and "not there": a 403 here would confirm the
    // project exists in tenant-b.
    const { status, contentType, raw, body } = await request(harness.port, '/projects/p-b/events', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    assert.equal(
      status,
      404,
      `cross-tenant access must not be distinguishable\n${JSON.stringify(body)}`,
    );
    assertNoStream(contentType, raw, 'cross-tenant');
    // This rejection happens *inside* the handler: the project's tenant is only
    // knowable after resolution, so resolution must have run and the denial is
    // the object-level check. Asserting the call is what separates this case
    // from the pre-handler rejections above.
    assert.deepEqual(
      harness.resolvedProjectIds,
      ['p-b'],
      'the object-level tenant check requires resolution first',
    );
  });

  it('rejects an X-Tenant-ID that does not match the token binding', async () => {
    // tenantContextMiddleware owns this rule: a client header may match the
    // authenticated binding, never widen it.
    const { status, contentType, raw } = await request(harness.port, '/projects/p-a/events', {
      headers: { Authorization: `Bearer ${adminToken}`, 'X-Tenant-ID': TENANT_B },
    });

    assert.equal(status, 403);
    assertNoStream(contentType, raw, 'tenant-header mismatch');
    assert.deepEqual(harness.resolvedProjectIds, []);
  });

  it('keeps the tenant-wide admin gate on the unscoped alias', async () => {
    // A viewer holds a valid token for tenant-a but must not read every event on
    // the tenant bus; project-scoped access is the supported path for them.
    const { status, contentType, raw } = await request(harness.port, '/events', {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });

    assert.equal(status, 403);
    assertNoStream(contentType, raw, 'unscoped alias, viewer');
    assert.deepEqual(harness.resolvedProjectIds, []);
  });

  it('does not resurrect a query-token authority in the composed chain', async () => {
    const { status, contentType, raw } = await request(
      harness.port,
      `/projects/p-a/events?access_token=${encodeURIComponent(adminToken)}`,
    );

    assert.equal(status, 401, 'a URL token is a disclosure, not a credential');
    assertNoStream(contentType, raw, 'query token');
    assert.deepEqual(harness.resolvedProjectIds, []);
  });
});
