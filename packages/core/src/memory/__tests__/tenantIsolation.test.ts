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
import { ConversationStore } from '../conversationStore';
import { UserModelManager } from '../userModel';

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'commander-memory-tenant-'));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
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
