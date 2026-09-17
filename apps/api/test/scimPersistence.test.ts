import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ScimStore, type ScimUser, type ScimGroup } from '../src/scimStore';

describe('ScimStore persistence', () => {
  let tmpDir: string;
  let store: ScimStore;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scim-persistence-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    store = new ScimStore(tmpDir);
    await store.reset();
  });

  function sampleUser(userName: string, email?: string): ScimUser {
    const id = `user-${userName}-${randomUUID().slice(0, 8)}`;
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id,
      userName,
      emails: email ? [{ value: email, primary: true }] : undefined,
      active: true,
      meta: {
        resourceType: 'User',
        created: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        location: `http://localhost/scim/v2/Users/${id}`,
      },
    };
  }

  function sampleGroup(displayName: string): ScimGroup {
    const id = `group-${displayName}-${randomUUID().slice(0, 8)}`;
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      id,
      displayName,
      meta: {
        resourceType: 'Group',
        created: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        location: `http://localhost/scim/v2/Groups/${id}`,
      },
    };
  }

  it('created user is readable after a new store instance loads the same directory', async () => {
    const user = sampleUser('persisted', 'persisted@example.com');
    await store.createUser('acme', user);

    const restarted = new ScimStore(tmpDir);
    const fetched = await restarted.getUser('acme', user.id);
    assert.ok(fetched);
    assert.equal(fetched!.userName, 'persisted');
    assert.equal(fetched!.emails?.[0].value, 'persisted@example.com');
  });

  it('deleted user is no longer readable after a new store instance loads the same directory', async () => {
    const user = sampleUser('to-delete');
    await store.createUser('acme', user);
    assert.equal(await store.deleteUser('acme', user.id), true);

    const restarted = new ScimStore(tmpDir);
    assert.equal(await restarted.getUser('acme', user.id), null);
    assert.equal(await restarted.deleteUser('acme', user.id), false);
  });

  it('updated group members persist across store instances', async () => {
    const group = sampleGroup('Engineering');
    await store.createGroup('acme', group);

    const updated = await store.updateGroup('acme', group.id, {
      members: [
        { value: 'user-alice', type: 'User', display: 'Alice' },
        { value: 'user-bob', type: 'User', display: 'Bob' },
      ],
    });
    assert.ok(updated);
    assert.equal(updated!.members?.length, 2);

    const restarted = new ScimStore(tmpDir);
    const fetched = await restarted.getGroup('acme', group.id);
    assert.ok(fetched);
    assert.equal(fetched!.displayName, 'Engineering');
    assert.equal(fetched!.members?.length, 2);
    assert.equal(fetched!.members?.[0].value, 'user-alice');
  });

  it('isolates users and groups per tenant on disk', async () => {
    const userA = sampleUser('alice');
    const userB = sampleUser('bob');
    await store.createUser('tenant-a', userA);
    await store.createUser('tenant-b', userB);

    const groupA = sampleGroup('team-a');
    const groupB = sampleGroup('team-b');
    await store.createGroup('tenant-a', groupA);
    await store.createGroup('tenant-b', groupB);

    const restarted = new ScimStore(tmpDir);

    assert.equal((await restarted.listUsers('tenant-a')).length, 1);
    assert.equal((await restarted.listUsers('tenant-b')).length, 1);
    assert.equal(await restarted.getUser('tenant-a', userB.id), null);
    assert.equal(await restarted.getUser('tenant-b', userA.id), null);

    assert.equal((await restarted.listGroups('tenant-a')).length, 1);
    assert.equal((await restarted.listGroups('tenant-b')).length, 1);
    assert.equal(await restarted.getGroup('tenant-a', groupB.id), null);
    assert.equal(await restarted.getGroup('tenant-b', groupA.id), null);

    // Files are physically separate.
    assert.ok(fs.existsSync(path.join(tmpDir, 'data', 'scim', 'tenant-a', 'users.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'data', 'scim', 'tenant-b', 'users.json')));
  });

  it('finds users by email case-insensitively and prefers primary', async () => {
    const alice = sampleUser('alice');
    alice.emails = [
      { value: 'alice@work.example', primary: false },
      { value: 'Alice@Primary.Example', primary: true },
    ];
    const bob = sampleUser('bob');
    bob.emails = [{ value: 'bob@example.com', primary: true }];

    await store.createUser('acme', alice);
    await store.createUser('acme', bob);

    const byPrimary = await store.findByEmail('acme', 'alice@primary.example');
    assert.equal(byPrimary?.userName, 'alice');
    assert.equal(byPrimary?.emails?.find((e) => e.primary)?.value, 'Alice@Primary.Example');

    const bySecondary = await store.findByEmail('acme', 'alice@work.example');
    assert.equal(bySecondary?.userName, 'alice');

    const missing = await store.findByEmail('acme', 'charlie@example.com');
    assert.equal(missing, null);

    const wrongTenant = await store.findByEmail('other-tenant', 'bob@example.com');
    assert.equal(wrongTenant, null);
  });

  it('does not persist a plaintext password supplied directly to the store', async () => {
    const user = sampleUser('secretive');
    const payload = { ...(user as unknown as Record<string, unknown>), password: 'super-secret' };
    // AUDIT F-B-22: the store's own defence-in-depth (ScimStore.createUser
    // deletes `password`) is the control this case proves. The HTTP-level
    // builder path is covered separately below.
    await store.createUser('acme', payload as ScimUser);

    const fetched = await store.getUser('acme', user.id);
    assert.ok(fetched);
    assert.ok(!('password' in fetched!));
    assert.doesNotMatch(JSON.stringify(fetched), /super-secret/);
  });

  it('never persists a plaintext password supplied over the SCIM HTTP surface', async () => {
    // AUDIT F-B-22 (endpoint half): drive the real router so the body builder
    // and the store both run on a password-bearing payload.
    const { createScimRouter } = await import('../src/scimEndpoints.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { id: 'admin', role: 'admin' };
      (req as unknown as { tenantId: string }).tenantId = 'acme';
      next();
    });
    app.use('/scim/v2', createScimRouter(store));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/scim/v2/Users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'http-secretive',
          password: 'http-super-secret',
          emails: [{ value: 'http-secretive@example.test', primary: true }],
          active: true,
        }),
      });
      assert.equal(res.status, 201);
      const created = (await res.json()) as { id: string; password?: unknown };
      assert.ok(!('password' in created));

      // The router resolves the tenant from the ambient tenant context (not
      // from a raw header), so read the user back through the same surface.
      const read = await fetch(`http://127.0.0.1:${addr.port}/scim/v2/Users/${created.id}`);
      assert.equal(read.status, 200);
      const persisted = (await read.json()) as Record<string, unknown>;
      assert.equal(persisted.userName, 'http-secretive');
      assert.ok(!('password' in persisted));
      assert.doesNotMatch(JSON.stringify(persisted), /http-super-secret/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
