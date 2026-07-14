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
    assert.equal((await restarted.getUser('tenant-a', userB.id)), null);
    assert.equal((await restarted.getUser('tenant-b', userA.id)), null);

    assert.equal((await restarted.listGroups('tenant-a')).length, 1);
    assert.equal((await restarted.listGroups('tenant-b')).length, 1);
    assert.equal((await restarted.getGroup('tenant-a', groupB.id)), null);
    assert.equal((await restarted.getGroup('tenant-b', groupA.id)), null);

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

  it('does not store plaintext passwords even when provided in user payload', async () => {
    const user = sampleUser('secretive');
    const payload = { ...(user as unknown as Record<string, unknown>), password: 'super-secret' };
    // The endpoint-level builder ignores password; the store never sees it.
    await store.createUser('acme', payload as ScimUser);

    const fetched = await store.getUser('acme', user.id);
    assert.ok(fetched);
    assert.ok(!('password' in fetched!));
  });
});
