import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createScimRouter } from '../src/scimEndpoints';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import { ScimStore } from '../src/scimStore';

/** B3 SCIM gate requires an admin JWT role or scim/admin API-key scope. */
function injectScimAdmin(app: express.Express): void {
  app.use((req, _res, next) => {
    req.user = { id: 'scim-test', username: 'scim-admin', role: 'admin' };
    next();
  });
}

describe('SCIM 2.0 endpoints', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;
  let tmpDir: string;
  let store: ScimStore;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scim-endpoints-test-'));
    store = new ScimStore(tmpDir);

    app = express();
    app.use(express.json());
    injectScimAdmin(app);
    app.use('/scim/v2', tenantContextMiddleware, createScimRouter(store));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await store.reset();
  });

  it('creates and retrieves a SCIM user', async () => {
    const create = await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: 'jdoe',
        name: { givenName: 'John', familyName: 'Doe' },
        emails: [{ value: 'jdoe@example.com', primary: true }],
        active: true,
      }),
    });
    assert.equal(create.status, 201);
    const user = (await create.json()) as { id: string; userName: string };
    assert.equal(user.userName, 'jdoe');

    const get = await fetch(`${baseUrl}/scim/v2/Users/${user.id}`);
    assert.equal(get.status, 200);
    const fetched = (await get.json()) as { userName: string };
    assert.equal(fetched.userName, 'jdoe');
  });

  it('lists SCIM users', async () => {
    await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: 'alice' }),
    });
    await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: 'bob' }),
    });

    const list = await fetch(`${baseUrl}/scim/v2/Users`);
    assert.equal(list.status, 200);
    const body = (await list.json()) as { totalResults: number; Resources: unknown[] };
    assert.equal(body.totalResults, 2);
    assert.equal(body.Resources.length, 2);
  });

  it('deletes a SCIM user', async () => {
    const create = await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: 'delete-me' }),
    });
    const user = (await create.json()) as { id: string };

    const del = await fetch(`${baseUrl}/scim/v2/Users/${user.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const get = await fetch(`${baseUrl}/scim/v2/Users/${user.id}`);
    assert.equal(get.status, 404);
  });

  it('updates a SCIM user', async () => {
    const create = await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: 'alice', active: true }),
    });
    const user = (await create.json()) as { id: string };

    const update = await fetch(`${baseUrl}/scim/v2/Users/${user.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(update.status, 200);
    const updated = (await update.json()) as { active: boolean };
    assert.equal(updated.active, false);
  });

  it('partially updates a SCIM user via PATCH', async () => {
    const create = await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: 'alice',
        active: true,
        emails: [{ value: 'alice@old.example', primary: true }],
      }),
    });
    const user = (await create.json()) as { id: string; active: boolean };
    assert.equal(user.active, true);

    const patch = await fetch(`${baseUrl}/scim/v2/Users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'Replace', path: 'active', value: false },
          {
            op: 'Replace',
            path: 'emails',
            value: [{ value: 'alice@new.example', primary: true }],
          },
        ],
      }),
    });
    assert.equal(patch.status, 200);
    const updated = (await patch.json()) as {
      active: boolean;
      emails: { value: string }[];
      meta: { lastModified: string };
    };
    assert.equal(updated.active, false);
    assert.equal(updated.emails[0].value, 'alice@new.example');

    const get = await fetch(`${baseUrl}/scim/v2/Users/${user.id}`);
    const fetched = (await get.json()) as { active: boolean; emails: { value: string }[] };
    assert.equal(fetched.active, false);
    assert.equal(fetched.emails[0].value, 'alice@new.example');
  });

  it('creates and retrieves a SCIM group', async () => {
    const create = await fetch(`${baseUrl}/scim/v2/Groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Engineering' }),
    });
    assert.equal(create.status, 201);
    const group = (await create.json()) as { id: string; displayName: string };
    assert.equal(group.displayName, 'Engineering');

    const get = await fetch(`${baseUrl}/scim/v2/Groups/${group.id}`);
    assert.equal(get.status, 200);
    const fetched = (await get.json()) as { displayName: string };
    assert.equal(fetched.displayName, 'Engineering');
  });

  it('returns 404 for unknown resources', async () => {
    const res = await fetch(`${baseUrl}/scim/v2/Users/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('isolates users per tenant', async () => {
    const createA = await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': 'tenant-a' },
      body: JSON.stringify({ userName: 'alice' }),
    });
    const userA = (await createA.json()) as { id: string };

    await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': 'tenant-b' },
      body: JSON.stringify({ userName: 'bob' }),
    });

    const listA = await fetch(`${baseUrl}/scim/v2/Users`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    const bodyA = (await listA.json()) as { totalResults: number };
    assert.equal(bodyA.totalResults, 1);

    const getInB = await fetch(`${baseUrl}/scim/v2/Users/${userA.id}`, {
      headers: { 'X-Tenant-ID': 'tenant-b' },
    });
    assert.equal(getInB.status, 404);
  });

  it('persists data across server restart simulation', async () => {
    const create = await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: 'persisted' }),
    });
    const user = (await create.json()) as { id: string };

    // Simulate a new process: instantiate a fresh store and rebuild the router.
    const restartedStore = new ScimStore(tmpDir);
    const restartedApp = express();
    restartedApp.use(express.json());
    injectScimAdmin(restartedApp);
    restartedApp.use('/scim/v2', tenantContextMiddleware, createScimRouter(restartedStore));
    const restartedServer = restartedApp.listen(0);
    await new Promise<void>((resolve) => restartedServer.on('listening', resolve));
    const addr = restartedServer.address() as AddressInfo;
    const restartedUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const get = await fetch(`${restartedUrl}/scim/v2/Users/${user.id}`);
      assert.equal(get.status, 200);
      const fetched = (await get.json()) as { userName: string };
      assert.equal(fetched.userName, 'persisted');
    } finally {
      await new Promise<void>((resolve, reject) =>
        restartedServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
