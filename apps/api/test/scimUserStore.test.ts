import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  ScimUserStore,
  ScimConflictError,
  type ScimUser,
  type ScimGroup,
} from '../src/scimUserStore';

describe('ScimUserStore', () => {
  let tmpDir: string;
  let store: ScimUserStore;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scim-store-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    store = new ScimUserStore(tmpDir);
    await store.reset();
  });

  function sampleUser(userName: string): ScimUser {
    const id = `user-${userName}-${randomUUID().slice(0, 8)}`;
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id,
      userName,
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

  it('creates and retrieves a user', async () => {
    const user = sampleUser('alice');
    await store.createUser('acme', user);
    const fetched = await store.getUser('acme', user.id);
    assert.equal(fetched?.userName, 'alice');
  });

  it('lists users with optional filter', async () => {
    await store.createUser('acme', sampleUser('alice'));
    await store.createUser('acme', {
      ...sampleUser('bob'),
      emails: [{ value: 'bob@example.com', primary: true }],
    });

    const all = await store.listUsers('acme');
    assert.equal(all.length, 2);

    const filtered = await store.listUsers('acme', 'userName eq "alice"');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].userName, 'alice');

    const byEmail = await store.listUsers('acme', 'emails eq "bob@example.com"');
    assert.equal(byEmail.length, 1);
    assert.equal(byEmail[0].userName, 'bob');
  });

  it('updates a user', async () => {
    const user = sampleUser('alice');
    await store.createUser('acme', user);

    const updated = await store.updateUser('acme', user.id, {
      active: false,
      emails: [{ value: 'alice@example.com', primary: true }],
    });

    assert.ok(updated);
    assert.equal(updated!.active, false);
    assert.equal(updated!.emails?.[0].value, 'alice@example.com');

    const fetched = await store.getUser('acme', user.id);
    assert.equal(fetched?.active, false);
  });

  it('deletes a user', async () => {
    const user = sampleUser('alice');
    await store.createUser('acme', user);
    assert.equal(await store.deleteUser('acme', user.id), true);
    assert.equal(await store.getUser('acme', user.id), null);
    assert.equal(await store.deleteUser('acme', user.id), false);
  });

  it('rejects duplicate userName on create', async () => {
    await store.createUser('acme', sampleUser('alice'));
    await assert.rejects(
      () => store.createUser('acme', { ...sampleUser('alice2'), userName: 'alice' }),
      ScimConflictError,
    );
  });

  it('isolates tenants', async () => {
    await store.createUser('tenant-a', sampleUser('alice'));
    await store.createUser('tenant-b', sampleUser('alice'));

    const aUsers = await store.listUsers('tenant-a');
    const bUsers = await store.listUsers('tenant-b');
    assert.equal(aUsers.length, 1);
    assert.equal(bUsers.length, 1);
    assert.notEqual(aUsers[0].id, bUsers[0].id);

    assert.equal(await store.getUser('tenant-a', bUsers[0].id), null);
    assert.equal(await store.getUser('tenant-b', aUsers[0].id), null);
  });

  it('falls back to default tenant when tenantId is empty', async () => {
    const user = sampleUser('alice');
    await store.createUser(undefined, user);
    const fetched = await store.getUser('', user.id);
    assert.equal(fetched?.userName, 'alice');
  });

  it('persists across store instances (process restart simulation)', async () => {
    const user = sampleUser('alice');
    await store.createUser('acme', user);

    // New store instance pointing at the same directory.
    const restarted = new ScimUserStore(tmpDir);
    const fetched = await restarted.getUser('acme', user.id);
    assert.equal(fetched?.userName, 'alice');
  });

  it('creates, updates, lists and deletes groups', async () => {
    const group = sampleGroup('Engineering');
    await store.createGroup('acme', group);

    const fetched = await store.getGroup('acme', group.id);
    assert.equal(fetched?.displayName, 'Engineering');

    const updated = await store.updateGroup('acme', group.id, {
      members: [{ value: 'user-alice', type: 'User' }],
    });
    assert.ok(updated);
    assert.equal(updated!.members?.length, 1);

    const groups = await store.listGroups('acme', 'displayName eq "Engineering"');
    assert.equal(groups.length, 1);

    assert.equal(await store.deleteGroup('acme', group.id), true);
    assert.equal(await store.getGroup('acme', group.id), null);
  });
});
