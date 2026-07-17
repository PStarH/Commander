import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { InMemoryMemoryService } from '../../../packages/core/src/memory/inMemoryMemoryService.ts';
import { MemoryStoreFacade } from '../../../packages/core/src/memory/memoryStoreFacade.ts';
import { createNamespacedMemoryRouter } from '../src/namespacedMemoryEndpoints.ts';

describe('namespaced memory audit via queryAudit (WS6)', () => {
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;
  let store: MemoryStoreFacade;
  let currentRole: string | undefined = 'developer';
  let currentScopes: string[] | undefined;
  let apiKeyId: string | undefined = 'key-1';

  before(async () => {
    store = new MemoryStoreFacade(new InMemoryMemoryService(), 'tenant-test');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (apiKeyId) (req as any).apiKeyId = apiKeyId;
      if (currentRole) (req as any).user = { role: currentRole };
      if (currentScopes) (req as any).apiScopes = currentScopes;
      next();
    });
    app.use(createNamespacedMemoryRouter(store as any));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('rejects unauthenticated audit reads', async () => {
    apiKeyId = undefined;
    currentRole = undefined;
    currentScopes = undefined;
    const res = await fetch(`${baseUrl}/api/namespaced-memory/ns-a/audit`);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'Authentication required');
    apiKeyId = 'key-1';
    currentRole = 'developer';
  });

  it('returns store-backed audit when queryAudit is available', async () => {
    const write = await fetch(`${baseUrl}/api/namespaced-memory/ns-a/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'k1', value: 'v1', projectId: 'default' }),
    });
    assert.equal(write.status, 200);

    const res = await fetch(`${baseUrl}/api/namespaced-memory/ns-a/audit?projectId=default`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      source: string;
      count: number;
      entries: Array<{ action?: string; success?: boolean }>;
    };
    assert.equal(body.source, 'store');
    assert.ok(body.count >= 1);
    assert.ok(
      body.entries.some((e) => e.action === 'store' && e.success === true),
      'expected durable store audit success entry',
    );
  });

  it('non-admin cannot override projectId for audit', async () => {
    currentRole = 'developer';
    const res = await fetch(`${baseUrl}/api/namespaced-memory/ns-a/audit?projectId=other`);
    assert.equal(res.status, 403);
  });
});
