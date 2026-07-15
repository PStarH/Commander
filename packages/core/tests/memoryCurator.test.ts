import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/memory';
import { MemoryCurator } from '../src/memory/curator';

describe('MemoryCurator TTL path (merged stack)', () => {
  let store: InMemoryMemoryStore;
  let curator: MemoryCurator;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    curator = new MemoryCurator(store);
  });

  afterEach(() => {
    curator.close();
  });

  it('deletes expired episodic memories', async () => {
    const item = await store.write({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'expired',
      content: 'expired content',
      tags: [],
      duration: 'EPISODIC',
    });

    await store.update({
      id: item.id,
      projectId: 'p1',
      updates: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });

    const removed = await curator.runForProject('p1');
    expect(removed).toBe(1);
    expect(await store.read(item.id, 'p1')).toBeNull();
  });

  it('does not delete non-expired memories', async () => {
    const item = await store.write({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'fresh',
      content: 'fresh content',
      tags: [],
      duration: 'EPISODIC',
    });

    const removed = await curator.runForProject('p1');
    expect(removed).toBe(0);
    expect(await store.read(item.id, 'p1')).not.toBeNull();
  });

  it('deletes long-term memories with no access beyond threshold', async () => {
    const item = await store.write({
      projectId: 'p1',
      kind: 'SOP',
      title: 'old sop',
      content: 'old content',
      tags: [],
      duration: 'LONG_TERM',
    });

    await store.update({
      id: item.id,
      projectId: 'p1',
      updates: { lastAccessedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString() },
    });

    const customCurator = new MemoryCurator(store, { longTermInactivityDays: 90 });
    const removed = await customCurator.runForProject('p1');
    expect(removed).toBe(1);
    expect(await store.read(item.id, 'p1')).toBeNull();
    customCurator.close();
  });

  it('only affects the targeted project', async () => {
    const p1Item = await store.write({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'p1 expired',
      content: 'content',
      tags: [],
      duration: 'EPISODIC',
    });
    const p2Item = await store.write({
      projectId: 'p2',
      kind: 'LESSON',
      title: 'p2 fresh',
      content: 'content',
      tags: [],
      duration: 'EPISODIC',
    });

    await store.update({
      id: p1Item.id,
      projectId: 'p1',
      updates: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });

    const removed = await curator.runForProject('p1');
    expect(removed).toBe(1);
    expect(await store.read(p1Item.id, 'p1')).toBeNull();
    expect(await store.read(p2Item.id, 'p2')).not.toBeNull();
  });

  it('full curate includes TTL eviction in CurationResult.evicted', async () => {
    const item = await store.write({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'expired',
      content: 'expired content',
      tags: [],
      duration: 'EPISODIC',
    });
    await store.update({
      id: item.id,
      projectId: 'p1',
      updates: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });

    const result = await curator.curate(store, 'p1');
    expect(result.evicted).toBeGreaterThanOrEqual(1);
    expect(await store.read(item.id, 'p1')).toBeNull();
  });
});
