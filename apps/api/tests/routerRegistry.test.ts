/**
 * Router Registry Tests — verify the endpoint mounting contract.
 *
 * Adding an endpoint requires only ONE declarative registerRouter() call
 * instead of the previous 3-step (create file + import in index.ts + app.use
 * in index.ts). These tests guard that contract.
 *
 * Tested:
 *   - registerRouter stores entries
 *   - registration order = mount order (preserved)
 *   - mountRegisteredRouters calls each factory + mounts at path
 *   - resetRouterRegistry clears for test isolation
 *   - default mountPath normalization ('' → '/')
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import http from 'node:http';

import {
  registerRouter,
  listRegisteredRouters,
  mountRegisteredRouters,
  resetRouterRegistry,
} from '../src/routerRegistry';

describe('routerRegistry', () => {
  beforeEach(() => resetRouterRegistry());
  afterEach(() => resetRouterRegistry());

  it('registerRouter stores an entry', () => {
    registerRouter({
      name: 'test',
      mountPath: '/test',
      factory: () => express.Router().get('/', (_req, res) => res.json({ ok: true })),
    });
    const list = listRegisteredRouters();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'test');
    assert.strictEqual(list[0].mountPath, '/test');
  });

  it('preserves registration order (= mount order)', () => {
    registerRouter({ name: 'first', mountPath: '/first', factory: () => express.Router() });
    registerRouter({ name: 'second', mountPath: '/second', factory: () => express.Router() });
    registerRouter({ name: 'third', mountPath: '/third', factory: () => express.Router() });

    const names = listRegisteredRouters().map((r) => r.name);
    assert.deepEqual(names, ['first', 'second', 'third']);
  });

  it('normalizes empty mountPath to "/"', () => {
    registerRouter({
      name: 'root',
      mountPath: '' as any,
      factory: () => express.Router(),
    });
    assert.strictEqual(listRegisteredRouters()[0].mountPath, '/');
  });

  it('mountRegisteredRouters mounts every router at its path', async () => {
    registerRouter({
      name: 'health',
      mountPath: '/healthz',
      factory: () => express.Router().get('/', (_req, res) => res.json({ status: 'ok' })),
    });
    registerRouter({
      name: 'echo',
      mountPath: '/echo',
      factory: () => express.Router().get('/', (_req, res) => res.json({ path: 'echo' })),
    });

    const app = express();
    mountRegisteredRouters(app);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as http.AddressInfo).port;

    try {
      const r1 = await fetch(`http://localhost:${port}/healthz`);
      const b1 = await r1.json();
      assert.strictEqual(b1.status, 'ok');

      const r2 = await fetch(`http://localhost:${port}/echo`);
      const b2 = await r2.json();
      assert.strictEqual(b2.path, 'echo');
    } finally {
      server.close();
    }
  });

  it('mountRegisteredRouters invokes each factory exactly once', () => {
    let callCount = 0;
    const factory = () => {
      callCount++;
      return express.Router();
    };
    registerRouter({ name: 'a', mountPath: '/a', factory });
    registerRouter({ name: 'b', mountPath: '/b', factory });
    registerRouter({ name: 'c', mountPath: '/c', factory });

    const app = express();
    mountRegisteredRouters(app);
    assert.strictEqual(callCount, 3);
  });

  it('resetRouterRegistry clears all entries', () => {
    registerRouter({ name: 'a', mountPath: '/a', factory: () => express.Router() });
    registerRouter({ name: 'b', mountPath: '/b', factory: () => express.Router() });
    assert.strictEqual(listRegisteredRouters().length, 2);

    resetRouterRegistry();
    assert.strictEqual(listRegisteredRouters().length, 0);
  });

  it('listRegisteredRouters returns a readonly view (mutations do not affect internal state)', () => {
    registerRouter({ name: 'a', mountPath: '/a', factory: () => express.Router() });
    const list = listRegisteredRouters();
    // Attempt mutation — should not affect the registry's internal array.
    (list as Array<{ name: string; mountPath: string; factory: () => any }>).push({
      name: 'injected',
      mountPath: '/injected',
      factory: () => express.Router(),
    });
    assert.strictEqual(listRegisteredRouters().length, 1, 'push must not have grown registry');
  });
});
