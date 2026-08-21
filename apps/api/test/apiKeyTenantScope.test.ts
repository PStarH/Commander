/**
 * AUTH-02: non-super_admin must not mint/list/revoke cross-tenant API keys.
 * Uses mock req/res so we don't need a live HTTP server.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createApiKeyRouter } from '../src/apiKeyEndpoints';
import { setApiKeyStoreForTesting } from '../src/apiKeyStore';
import { TestApiKeyStore } from './authRepositories';

type FakeUser = {
  id: string;
  username: string;
  role: 'super_admin' | 'admin' | 'developer' | 'operator' | 'auditor' | 'viewer';
  tenantId?: string;
};

function mockRes(): Response & {
  statusCode: number;
  body: unknown;
  status: (c: number) => Response;
  json: (b: unknown) => Response;
} {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as never;
}

/** Run middleware + handler chain for a route. */
async function invoke(
  router: ReturnType<typeof createApiKeyRouter>,
  method: string,
  routePath: string,
  req: Request,
  res: Response,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (router as any).stack as Array<{
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: RequestHandler }>;
    };
  }>;
  for (const layer of stack) {
    if (!layer.route) continue;
    if (layer.route.path === routePath && layer.route.methods[method]) {
      const handlers = layer.route.stack.map((s) => s.handle);
      let idx = 0;
      await new Promise<void>((resolve, reject) => {
        const next: NextFunction = (err?: unknown) => {
          if (err) {
            reject(err);
            return;
          }
          const h = handlers[idx++];
          if (!h) {
            resolve();
            return;
          }
          try {
            const ret = h(req, res, next);
            if (ret && typeof (ret as Promise<void>).then === 'function') {
              (ret as Promise<void>)
                .then(() => {
                  // Handler returned a promise and didn't call next — treat as done
                  // if no more handlers or response already written.
                  if (idx >= handlers.length || res.statusCode !== 200 || res.body !== undefined) {
                    resolve();
                  }
                })
                .catch(reject);
            } else if (idx >= handlers.length) {
              // Sync final handler that didn't call next
              queueMicrotask(() => resolve());
            }
          } catch (e) {
            reject(e);
          }
        };
        next();
      });
      return;
    }
  }
  throw new Error(`No route ${method.toUpperCase()} ${routePath}`);
}

function makeReq(
  user: FakeUser | null,
  tenantId?: string,
  body?: unknown,
  params?: Record<string, string>,
): Request {
  return {
    user,
    tenantId,
    body: body ?? {},
    params: params ?? {},
  } as unknown as Request;
}

describe('API key tenant scope (AUTH-02)', () => {
  let router: ReturnType<typeof createApiKeyRouter>;
  let apiKeys: TestApiKeyStore;

  beforeEach(() => {
    apiKeys = new TestApiKeyStore();
    setApiKeyStoreForTesting(apiKeys);
    router = createApiKeyRouter();
  });

  afterEach(() => {
    setApiKeyStoreForTesting(undefined);
  });

  it('admin cannot mint a key for another tenant', async () => {
    const res = mockRes();
    await invoke(
      router,
      'post',
      '/api/admin/api-keys',
      makeReq({ id: 'u1', username: 'admin', role: 'admin', tenantId: 'tenant-a' }, 'tenant-a', {
        name: 'evil',
        tenantId: 'tenant-b',
        scopes: ['admin'],
      }),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(String((res.body as { error: string }).error), /another tenant/i);
  });

  it('admin mint forces own tenant when body omits tenantId', async () => {
    const res = mockRes();
    await invoke(
      router,
      'post',
      '/api/admin/api-keys',
      makeReq({ id: 'u1', username: 'admin', role: 'admin', tenantId: 'tenant-a' }, 'tenant-a', {
        name: 'mine',
        scopes: ['read'],
      }),
      res,
    );
    assert.equal(res.statusCode, 201);
    const body = res.body as { key: string; record: { tenantId?: string; hash?: string } };
    assert.equal(body.record.tenantId, 'tenant-a');
    assert.ok(body.key);
    assert.equal(body.record.hash, undefined);
  });

  it('admin list only shows own tenant keys', async () => {
    const tenantA = 'tenant-a';
    const tenantB = 'tenant-b';
    await apiKeys.create('a-key', ['read'], tenantA);
    await apiKeys.create('b-key', ['read'], tenantB);

    const res = mockRes();
    await invoke(
      router,
      'get',
      '/api/admin/api-keys',
      makeReq({ id: 'u1', username: 'admin', role: 'admin', tenantId: tenantA }, tenantA),
      res,
    );
    assert.equal(res.statusCode, 200, `unexpected body: ${JSON.stringify(res.body)}`);
    const body = res.body as { keys: Array<{ tenantId?: string; name?: string }> };
    assert.ok(body.keys.length >= 1, `keys: ${JSON.stringify(body.keys)}`);
    assert.ok(
      body.keys.every((k) => k.tenantId === tenantA),
      `cross-tenant leak: ${JSON.stringify(body.keys)}`,
    );
    assert.ok(
      !body.keys.some((k) => k.tenantId === tenantB),
      `tenant-b key visible to tenant-a admin: ${JSON.stringify(body.keys)}`,
    );
  });

  it('super_admin can mint for any tenant', async () => {
    const res = mockRes();
    await invoke(
      router,
      'post',
      '/api/admin/api-keys',
      makeReq(
        { id: 'su', username: 'root', role: 'super_admin', tenantId: 'platform' },
        'platform',
        { name: 'cross', tenantId: 'tenant-b', scopes: ['write'] },
      ),
      res,
    );
    assert.equal(res.statusCode, 201);
    const body = res.body as { record: { tenantId?: string } };
    assert.equal(body.record.tenantId, 'tenant-b');
  });

  it('admin without JWT tenant claim cannot mint even with ambient X-Tenant-ID (403)', async () => {
    const before = (await apiKeys.list())
      .map((k) => k.id);
    const res = mockRes();
    await invoke(
      router,
      'post',
      '/api/admin/api-keys',
      // No user.tenantId; ambient req.tenantId simulates non-prod X-Tenant-ID.
      makeReq({ id: 'u1', username: 'admin', role: 'admin' }, 'victim-tenant', {
        name: 'forged-ambient-mint',
        scopes: ['admin'],
      }),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(String((res.body as { error: string }).error), /tenant-bound identity/i);
    const after = await apiKeys.list();
    assert.ok(
      !after.some((k) => k.name === 'forged-ambient-mint' && !before.includes(k.id)),
      'ambient header must not mint a key',
    );
  });

  it('admin without JWT tenant claim cannot list even with ambient tenant (403)', async () => {
    await apiKeys.create('a-key', ['read'], 'victim-tenant');
    const res = mockRes();
    await invoke(
      router,
      'get',
      '/api/admin/api-keys',
      makeReq({ id: 'u1', username: 'admin', role: 'admin' }, 'victim-tenant'),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(String((res.body as { error: string }).error), /tenant-bound identity/i);
  });

  it('admin without JWT tenant claim cannot revoke via ambient tenant (404)', async () => {
    const { record } = await apiKeys.create('victim-key', ['read'], 'victim-tenant');
    const res = mockRes();
    await invoke(
      router,
      'delete',
      '/api/admin/api-keys/:id',
      makeReq({ id: 'u1', username: 'admin', role: 'admin' }, 'victim-tenant', undefined, {
        id: record.id,
      }),
      res,
    );
    assert.equal(res.statusCode, 404);
    assert.equal(
      (await apiKeys.list())
        .find((k) => k.id === record.id)?.enabled,
      true,
    );
  });

  it('super_admin may mint unscoped key when tenantId omitted (intentional residual)', async () => {
    const res = mockRes();
    await invoke(
      router,
      'post',
      '/api/admin/api-keys',
      makeReq(
        { id: 'su', username: 'root', role: 'super_admin', tenantId: 'platform' },
        'platform',
        { name: 'platform-break-glass', scopes: ['admin'] },
      ),
      res,
    );
    assert.equal(res.statusCode, 201);
    const body = res.body as { record: { tenantId?: string; id: string } };
    assert.equal(body.record.tenantId, undefined);

    // Tenant admin list/revoke must not expose or revoke unscoped platform keys.
    const listRes = mockRes();
    await invoke(
      router,
      'get',
      '/api/admin/api-keys',
      makeReq({ id: 'u1', username: 'admin', role: 'admin', tenantId: 'tenant-a' }, 'tenant-a'),
      listRes,
    );
    assert.equal(listRes.statusCode, 200);
    const keys = (listRes.body as { keys: Array<{ id: string; tenantId?: string }> }).keys;
    assert.ok(!keys.some((k) => k.id === body.record.id));

    const revRes = mockRes();
    await invoke(
      router,
      'delete',
      '/api/admin/api-keys/:id',
      makeReq(
        { id: 'u1', username: 'admin', role: 'admin', tenantId: 'tenant-a' },
        'tenant-a',
        undefined,
        { id: body.record.id },
      ),
      revRes,
    );
    assert.equal(revRes.statusCode, 404);
    assert.equal(
      (await apiKeys.list())
        .find((k) => k.id === body.record.id)?.enabled,
      true,
    );
  });

  it('admin cannot revoke another tenant key (404)', async () => {
    const { record } = await apiKeys.create('b-key', ['read'], 'tenant-b');
    const res = mockRes();
    await invoke(
      router,
      'delete',
      '/api/admin/api-keys/:id',
      makeReq(
        { id: 'u1', username: 'admin', role: 'admin', tenantId: 'tenant-a' },
        'tenant-a',
        undefined,
        { id: record.id },
      ),
      res,
    );
    assert.equal(res.statusCode, 404);
    const listed = (await apiKeys.list())
      .find((k) => k.id === record.id);
    assert.equal(listed?.enabled, true);
  });
});
