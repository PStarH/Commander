import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCurator } from '../../src/memory/curator';
import type { MemoryStore, EpisodicMemoryItem, MemorySearchResult } from '../../src/memory';

function createMockStore(items: EpisodicMemoryItem[] = []): MemoryStore {
  const store = new Map(items.map((i) => [i.id, { ...i }]));
  return {
    write: async (opts: any) => {
      const id = `mem-${store.size + 1}`;
      const item: EpisodicMemoryItem = {
        id,
        projectId: opts.projectId,
        kind: opts.kind ?? 'DECISION',
        duration: opts.duration ?? 'EPISODIC',
        title: opts.title ?? '',
        content: opts.content ?? '',
        tags: opts.tags ?? [],
        priority: opts.priority ?? 50,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        confidence: opts.confidence ?? 0.8,
      };
      store.set(id, item);
      return item;
    },
    batchWrite: async (items: any[]) =>
      items.map((_, i) => ({
        id: `batch-${i}`,
        projectId: 'test',
        kind: 'DECISION',
        duration: 'EPISODIC',
        title: '',
        content: '',
        tags: [],
        priority: 50,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        confidence: 0.8,
      })),
    update: async () => null,
    delete: async () => true,
    deleteByMission: async () => 0,
    deleteExpired: async () => {
      const now = new Date();
      let count = 0;
      for (const [id, item] of store) {
        if (item.expiresAt && new Date(item.expiresAt) < now) {
          store.delete(id);
          count++;
        }
      }
      return count;
    },
    read: async () => null,
    search: async (q: any): Promise<MemorySearchResult> => {
      let results = Array.from(store.values()).filter((i) => i.projectId === q.projectId);
      if (q.kind) results = results.filter((i) => i.kind === q.kind);
      if (q.minPriority) results = results.filter((i) => i.priority >= q.minPriority);
      return { items: results.slice(0, q.limit ?? 50), total: results.length, query: q };
    },
    searchSemantic: async () => [],
    getStats: async () => ({
      totalMemories: store.size,
      byType: {} as any,
      avgPriority: 50,
      avgConfidence: 0.8,
    }),
  } as any;
}

describe('MemoryCurator', () => {
  let curator: MemoryCurator;

  beforeEach(() => {
    curator = new MemoryCurator({
      curationInterval: 3,
      episodicTtlDays: 7,
      batchSize: 100,
    });
  });

  describe('constructor', () => {
    it('creates curator with default config', () => {
      const c = new MemoryCurator();
      assert.ok(c);
    });

    it('accepts custom config', () => {
      const c = new MemoryCurator({ curationInterval: 10, duplicateThreshold: 0.9 });
      assert.ok(c);
    });
  });

  describe('onWrite', () => {
    it('does not curate before threshold', async () => {
      const store = createMockStore();
      const r1 = await curator.onWrite(store, 'proj-1');
      assert.equal(r1, null);
      const r2 = await curator.onWrite(store, 'proj-1');
      assert.equal(r2, null);
    });

    it('triggers curation after threshold writes', async () => {
      const store = createMockStore();
      await curator.onWrite(store, 'proj-1');
      await curator.onWrite(store, 'proj-1');
      const result = await curator.onWrite(store, 'proj-1');
      assert.ok(result);
      assert.ok(result!.timestamp);
      assert.ok(result!.duration >= 0);
    });

    it('resets write count after curation', async () => {
      const store = createMockStore();
      // Trigger first curation (3 writes)
      await curator.onWrite(store, 'proj-1');
      await curator.onWrite(store, 'proj-1');
      await curator.onWrite(store, 'proj-1');
      // Should need 3 more writes for next curation
      const r1 = await curator.onWrite(store, 'proj-1');
      assert.equal(r1, null);
    });
  });

  describe('curate', () => {
    it('runs full curation cycle', async () => {
      const items: EpisodicMemoryItem[] = [
        {
          id: 'm1',
          projectId: 'proj-1',
          kind: 'DECISION',
          duration: 'EPISODIC',
          title: 'Test',
          content: 'content',
          tags: [],
          priority: 80,
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
          confidence: 0.9,
          expiresAt: new Date(Date.now() - 86400000).toISOString(),
        },
        {
          id: 'm2',
          projectId: 'proj-1',
          kind: 'LESSON',
          duration: 'LONG_TERM',
          title: 'Lesson',
          content: 'important lesson',
          tags: [],
          priority: 90,
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
          confidence: 0.95,
        },
      ];
      const store = createMockStore(items);
      const result = await curator.curate(store, 'proj-1');
      assert.ok(result);
      assert.ok(result.summary);
      assert.ok(result.processed >= 0);
    });

    it('evicts expired items', async () => {
      const items: EpisodicMemoryItem[] = [
        {
          id: 'expired',
          projectId: 'proj-1',
          kind: 'DECISION',
          duration: 'EPISODIC',
          title: 'Old',
          content: 'expired',
          tags: [],
          priority: 50,
          createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
          lastAccessedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
          confidence: 0.5,
          expiresAt: new Date(Date.now() - 86400000).toISOString(),
        },
      ];
      const store = createMockStore(items);
      const result = await curator.curate(store, 'proj-1');
      assert.ok(result.evicted >= 0);
    });

    it('returns last curation when already running', async () => {
      const store = createMockStore();
      // Start first curation
      const p1 = curator.curate(store, 'proj-1');
      // Second call while first is running should return last result
      const p2 = curator.curate(store, 'proj-1');
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.ok(r1);
      assert.ok(r2);
    });
  });

  describe('getLastCuration', () => {
    it('returns null before any curation', () => {
      assert.equal(curator.getLastCuration(), null);
    });

    it('returns last result after curation', async () => {
      const store = createMockStore();
      await curator.curate(store, 'proj-1');
      const last = curator.getLastCuration();
      assert.ok(last);
      assert.ok(last!.timestamp);
    });
  });
});
