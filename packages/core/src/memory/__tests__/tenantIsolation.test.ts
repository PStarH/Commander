/**
 * Memory system tenant isolation tests.
 *
 * Verifies that each persistence backend scopes reads and writes by tenant,
 * defaults to '__default__' when no tenant context is active, and never
 * leaks data across tenants.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runWithTenant } from '../../runtime/tenantContext';
import { SqliteMemoryStore } from '../sqliteMemoryStore';
import { JsonMemoryStore } from '../jsonStore';
import { ConversationStore } from '../conversationStore';
import { UserModelManager } from '../userModel';

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'commander-memory-tenant-'));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('SqliteMemoryStore tenant isolation', () => {
  async function createStore() {
    const store = new SqliteMemoryStore(join(testRoot, 'memory.db'));
    await store.init();
    return store;
  }

  it('tenant A remember, tenant B recall returns 0 results', async () => {
    const store = await createStore();

    await runWithTenant('tenant-a', () =>
      store.write({
        projectId: 'proj-1',
        kind: 'LESSON',
        title: 'Tenant A lesson',
        content: 'This belongs to tenant A',
        tags: ['tenant-a'],
      }),
    );

    const bResults = await runWithTenant('tenant-b', () =>
      store.searchSemantic('Tenant A lesson', 'proj-1'),
    );
    expect(bResults).toHaveLength(0);

    await store.close();
  });

  it('tenants read and write independently on the same project', async () => {
    const store = await createStore();

    await runWithTenant('tenant-a', () =>
      store.write({
        projectId: 'shared-proj',
        kind: 'DECISION',
        title: 'A decision',
        content: 'Decision for A',
        tags: [],
      }),
    );

    await runWithTenant('tenant-b', () =>
      store.write({
        projectId: 'shared-proj',
        kind: 'DECISION',
        title: 'B decision',
        content: 'Decision for B',
        tags: [],
      }),
    );

    const aResults = await runWithTenant('tenant-a', () =>
      store.search({ projectId: 'shared-proj', query: 'decision' }),
    );
    expect(aResults.items).toHaveLength(1);
    expect(aResults.items[0].content).toBe('Decision for A');

    const bResults = await runWithTenant('tenant-b', () =>
      store.search({ projectId: 'shared-proj', query: 'decision' }),
    );
    expect(bResults.items).toHaveLength(1);
    expect(bResults.items[0].content).toBe('Decision for B');

    await store.close();
  });

  it('defaults to __default__ tenant when no context is active', async () => {
    const store = await createStore();

    await store.write({
      projectId: 'default-proj',
      kind: 'SUMMARY',
      title: 'Default summary',
      content: 'No tenant context',
      tags: [],
    });

    const results = await store.searchSemantic('Default summary', 'default-proj');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('No tenant context');

    await store.close();
  });
});

describe('JsonMemoryStore tenant isolation', () => {
  async function createStore() {
    const store = new JsonMemoryStore(testRoot);
    await store.init();
    return store;
  }

  it('tenant A remember, tenant B recall returns 0 results', async () => {
    const store = await createStore();

    await runWithTenant('tenant-a', () =>
      store.write({
        projectId: 'proj-1',
        kind: 'LESSON',
        title: 'Tenant A lesson',
        content: 'This belongs to tenant A',
        tags: ['tenant-a'],
      }),
    );

    const bResults = await runWithTenant('tenant-b', () =>
      store.searchSemantic('Tenant A lesson', 'proj-1'),
    );
    expect(bResults).toHaveLength(0);

    await store.close();
  });

  it('tenants read and write independently on the same project', async () => {
    const store = await createStore();

    await runWithTenant('tenant-a', () =>
      store.write({
        projectId: 'shared-proj',
        kind: 'DECISION',
        title: 'A decision',
        content: 'Decision for A',
        tags: [],
      }),
    );

    await runWithTenant('tenant-b', () =>
      store.write({
        projectId: 'shared-proj',
        kind: 'DECISION',
        title: 'B decision',
        content: 'Decision for B',
        tags: [],
      }),
    );

    const aResults = await runWithTenant('tenant-a', () =>
      store.search({ projectId: 'shared-proj', query: 'decision' }),
    );
    expect(aResults.items).toHaveLength(1);
    expect(aResults.items[0].content).toBe('Decision for A');

    const bResults = await runWithTenant('tenant-b', () =>
      store.search({ projectId: 'shared-proj', query: 'decision' }),
    );
    expect(bResults.items).toHaveLength(1);
    expect(bResults.items[0].content).toBe('Decision for B');

    await store.close();
  });

  it('defaults to __default__ tenant when no context is active', async () => {
    const store = await createStore();

    await store.write({
      projectId: 'default-proj',
      kind: 'SUMMARY',
      title: 'Default summary',
      content: 'No tenant context',
      tags: [],
    });

    const results = await store.searchSemantic('Default summary', 'default-proj');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('No tenant context');

    await store.close();
  });
});

describe('ConversationStore tenant isolation', () => {
  async function createStore() {
    const store = new ConversationStore({ dbPath: join(testRoot, 'conv.db') });
    await store.init();
    return store;
  }

  it('tenant A session is invisible to tenant B', async () => {
    const store = await createStore();

    const aSession = await runWithTenant('tenant-a', () =>
      store.startSession({ projectId: 'proj-1', goal: 'A goal' }),
    );

    const bSessions = await runWithTenant('tenant-b', () => store.getRecentSessions('proj-1'));
    expect(bSessions).toHaveLength(0);

    const aSessions = await runWithTenant('tenant-a', () => store.getRecentSessions('proj-1'));
    expect(aSessions).toHaveLength(1);
    expect(aSessions[0].id).toBe(aSession.id);

    await store.close();
  });

  it('defaults to __default__ tenant when no context is active', async () => {
    const store = await createStore();

    await store.startSession({ projectId: 'proj-1', goal: 'Default goal' });

    const sessions = await store.getRecentSessions('proj-1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].goal).toBe('Default goal');

    await store.close();
  });
});

describe('UserModelManager tenant isolation', () => {
  async function createManager() {
    return new UserModelManager({ modelPath: join(testRoot, 'user-models') });
  }

  it('tenant A profile is invisible to tenant B', async () => {
    const manager = await createManager();

    await runWithTenant('tenant-a', async () => {
      manager.getProfile('user-1');
      await manager.saveProfile('user-1');
    });

    const bProfile = await runWithTenant('tenant-b', () => manager.loadProfile('user-1'));
    expect(bProfile).toBeNull();

    const aProfile = await runWithTenant('tenant-a', () => manager.loadProfile('user-1'));
    expect(aProfile).not.toBeNull();
    expect(aProfile!.userId).toBe('user-1');

    await manager.close();
  });

  it('defaults to __default__ tenant when no context is active', async () => {
    const manager = await createManager();

    manager.getProfile('user-1');
    await manager.saveProfile('user-1');

    const profile = await manager.loadProfile('user-1');
    expect(profile).not.toBeNull();
    expect(profile!.userId).toBe('user-1');

    await manager.close();
  });
});
