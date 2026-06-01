import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { JsonMemoryStore } from '../../src/memory/jsonStore';

describe('JsonMemoryStore', () => {
  let store: JsonMemoryStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-test-'));
    filePath = path.join(tmpDir, 'test-memory.json');
    store = new JsonMemoryStore(filePath);
    await store.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('write', () => {
    it('writes a memory item and returns it', async () => {
      const item = await store.write({
        projectId: 'proj-1',
        title: 'Test memory',
        content: 'This is a test memory item',
        kind: 'DECISION',
        tags: ['test'],
      });
      assert.ok(item.id.startsWith('memory-'));
      assert.equal(item.title, 'Test memory');
      assert.equal(item.kind, 'DECISION');
      assert.equal(item.projectId, 'proj-1');
      assert.ok(item.createdAt);
    });

    it('assigns priority based on kind', async () => {
      const decision = await store.write({
        projectId: 'proj-1', title: 'Dec', content: 'content', kind: 'DECISION', tags: [],
      });
      const summary = await store.write({
        projectId: 'proj-1', title: 'Sum', content: 'content', kind: 'SUMMARY', tags: [],
      });
      assert.ok(decision.priority > summary.priority);
    });

    it('boosts priority for mission-linked items', async () => {
      const withMission = await store.write({
        projectId: 'proj-1', title: 'M', content: 'content', kind: 'DECISION', tags: [], missionId: 'm1',
      });
      const withoutMission = await store.write({
        projectId: 'proj-1', title: 'N', content: 'content', kind: 'DECISION', tags: [],
      });
      assert.ok(withMission.priority >= withoutMission.priority);
    });

    it('caps priority at 100', async () => {
      const item = await store.write({
        projectId: 'proj-1', title: 'High', content: 'content', kind: 'LESSON', tags: [],
        missionId: 'm1', agentId: 'a1', evidenceRefs: ['e1', 'e2', 'e3'], priority: 95,
      });
      assert.ok(item.priority <= 100);
    });

    it('sets expiry for EPISODIC items', async () => {
      const item = await store.write({
        projectId: 'proj-1', title: 'Ephemeral', content: 'content', kind: 'DECISION', tags: [],
      });
      assert.ok(item.expiresAt);
    });

    it('does not set expiry for LONG_TERM items', async () => {
      const item = await store.write({
        projectId: 'proj-1', title: 'Permanent', content: 'content', kind: 'DECISION', tags: [],
        duration: 'LONG_TERM',
      });
      assert.equal(item.expiresAt, undefined);
    });
  });

  describe('batchWrite', () => {
    it('writes multiple items', async () => {
      const items = await store.batchWrite([
        { projectId: 'proj-1', title: 'Item 1', content: 'content one', kind: 'DECISION', tags: [] },
        { projectId: 'proj-1', title: 'Item 2', content: 'content two', kind: 'LESSON', tags: [] },
      ]);
      assert.equal(items.length, 2);
      assert.ok(items[0].id !== items[1].id);
    });
  });

  describe('read', () => {
    it('reads an item by ID', async () => {
      const written = await store.write({
        projectId: 'proj-1', title: 'Readable', content: 'content', kind: 'DECISION', tags: [],
      });
      const read = await store.read(written.id, 'proj-1');
      assert.ok(read);
      assert.equal(read!.title, 'Readable');
    });

    it('returns null for non-existent ID', async () => {
      const read = await store.read('nonexistent', 'proj-1');
      assert.equal(read, null);
    });

    it('returns null for wrong project', async () => {
      const written = await store.write({
        projectId: 'proj-1', title: 'Test', content: 'content', kind: 'DECISION', tags: [],
      });
      const read = await store.read(written.id, 'proj-2');
      assert.equal(read, null);
    });

    it('updates lastAccessedAt on read', async () => {
      const written = await store.write({
        projectId: 'proj-1', title: 'Test', content: 'content', kind: 'DECISION', tags: [],
      });
      const before = written.lastAccessedAt;
      // Small delay to ensure timestamp difference
      await new Promise(r => setTimeout(r, 10));
      const read = await store.read(written.id, 'proj-1');
      assert.ok(read!.lastAccessedAt >= before!);
    });
  });

  describe('search', () => {
    it('finds items by text query', async () => {
      await store.write({
        projectId: 'proj-1', title: 'Authentication decision', content: 'We chose JWT tokens', kind: 'DECISION', tags: ['auth'],
      });
      await store.write({
        projectId: 'proj-1', title: 'Database setup', content: 'PostgreSQL configured', kind: 'ACTION', tags: ['db'],
      });
      const results = await store.search({ projectId: 'proj-1', query: 'authentication' });
      assert.ok(results.items.some(i => i.title === 'Authentication decision'));
    });

    it('filters by kind', async () => {
      await store.write({ projectId: 'proj-1', title: 'Dec', content: 'content', kind: 'DECISION', tags: [] });
      await store.write({ projectId: 'proj-1', title: 'Les', content: 'content', kind: 'LESSON', tags: [] });
      const results = await store.search({ projectId: 'proj-1', kind: 'DECISION' });
      assert.ok(results.items.every(i => i.kind === 'DECISION'));
    });

    it('filters by tags', async () => {
      await store.write({ projectId: 'proj-1', title: 'Tagged', content: 'content', kind: 'DECISION', tags: ['important'] });
      await store.write({ projectId: 'proj-1', title: 'Untagged', content: 'content', kind: 'DECISION', tags: [] });
      const results = await store.search({ projectId: 'proj-1', tags: ['important'] });
      assert.ok(results.items.every(i => i.tags.includes('important')));
    });

    it('filters by missionId', async () => {
      await store.write({ projectId: 'proj-1', title: 'M1', content: 'content', kind: 'DECISION', tags: [], missionId: 'mission-1' });
      await store.write({ projectId: 'proj-1', title: 'M2', content: 'content', kind: 'DECISION', tags: [], missionId: 'mission-2' });
      const results = await store.search({ projectId: 'proj-1', missionId: 'mission-1' });
      assert.ok(results.items.every(i => i.missionId === 'mission-1'));
    });

    it('filters by minPriority', async () => {
      await store.write({ projectId: 'proj-1', title: 'High', content: 'content', kind: 'LESSON', tags: [], priority: 90 });
      await store.write({ projectId: 'proj-1', title: 'Low', content: 'content', kind: 'SUMMARY', tags: [], priority: 20 });
      const results = await store.search({ projectId: 'proj-1', minPriority: 50 });
      assert.ok(results.items.every(i => i.priority >= 50));
    });

    it('respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.write({ projectId: 'proj-1', title: `Item ${i}`, content: 'content', kind: 'DECISION', tags: [] });
      }
      const results = await store.search({ projectId: 'proj-1', limit: 3 });
      assert.ok(results.items.length <= 3);
    });

    it('returns total count', async () => {
      for (let i = 0; i < 5; i++) {
        await store.write({ projectId: 'proj-1', title: `Item ${i}`, content: 'content', kind: 'DECISION', tags: [] });
      }
      const results = await store.search({ projectId: 'proj-1', limit: 2 });
      assert.equal(results.total, 5);
    });

    it('sorts by priority descending', async () => {
      await store.write({ projectId: 'proj-1', title: 'Low', content: 'content', kind: 'SUMMARY', tags: [] });
      await store.write({ projectId: 'proj-1', title: 'High', content: 'content', kind: 'LESSON', tags: [] });
      const results = await store.search({ projectId: 'proj-1' });
      assert.ok(results.items[0].priority >= results.items[1].priority);
    });
  });

  describe('searchSemantic', () => {
    it('finds items by semantic query', async () => {
      await store.write({
        projectId: 'proj-1', title: 'JWT authentication', content: 'Using JSON web tokens', kind: 'DECISION', tags: [],
      });
      const results = await store.searchSemantic('authentication tokens', 'proj-1');
      assert.ok(results.length > 0);
    });

    it('returns empty for no matches', async () => {
      await store.write({
        projectId: 'proj-1', title: 'Hello', content: 'world', kind: 'DECISION', tags: [],
      });
      const results = await store.searchSemantic('quantum physics', 'proj-1');
      assert.equal(results.length, 0);
    });
  });

  describe('delete', () => {
    it('deletes an item', async () => {
      const item = await store.write({
        projectId: 'proj-1', title: 'Deletable', content: 'content', kind: 'DECISION', tags: [],
      });
      const deleted = await store.delete(item.id, 'proj-1');
      assert.ok(deleted);
      const read = await store.read(item.id, 'proj-1');
      assert.equal(read, null);
    });

    it('returns false for wrong project', async () => {
      const item = await store.write({
        projectId: 'proj-1', title: 'Test', content: 'content', kind: 'DECISION', tags: [],
      });
      const deleted = await store.delete(item.id, 'proj-2');
      assert.ok(!deleted);
    });
  });

  describe('deleteByMission', () => {
    it('deletes all items for a mission', async () => {
      await store.write({ projectId: 'proj-1', title: 'A', content: 'c', kind: 'DECISION', tags: [], missionId: 'm1' });
      await store.write({ projectId: 'proj-1', title: 'B', content: 'c', kind: 'DECISION', tags: [], missionId: 'm1' });
      await store.write({ projectId: 'proj-1', title: 'C', content: 'c', kind: 'DECISION', tags: [], missionId: 'm2' });
      const count = await store.deleteByMission('m1', 'proj-1');
      assert.equal(count, 2);
      const remaining = await store.search({ projectId: 'proj-1' });
      assert.equal(remaining.items.length, 1);
    });
  });

  describe('deleteExpired', () => {
    it('deletes expired items', async () => {
      // Write an item and manually set its expiry to the past
      const item = await store.write({
        projectId: 'proj-1', title: 'Expired', content: 'content', kind: 'DECISION', tags: [],
      });
      // Access internal items map to set past expiry
      (store as any).items.get(item.id).expiresAt = new Date(Date.now() - 1000).toISOString();
      const count = await store.deleteExpired('proj-1');
      assert.equal(count, 1);
    });
  });

  describe('update', () => {
    it('updates an item', async () => {
      const item = await store.write({
        projectId: 'proj-1', title: 'Original', content: 'content', kind: 'DECISION', tags: [],
      });
      const updated = await store.update({
        id: item.id,
        projectId: 'proj-1',
        updates: { title: 'Updated' },
      });
      assert.equal(updated!.title, 'Updated');
    });

    it('deletes when delete flag is set', async () => {
      const item = await store.write({
        projectId: 'proj-1', title: 'To Delete', content: 'content', kind: 'DECISION', tags: [],
      });
      const result = await store.update({
        id: item.id,
        projectId: 'proj-1',
        delete: true,
      });
      assert.equal(result, null);
      const read = await store.read(item.id, 'proj-1');
      assert.equal(read, null);
    });
  });

  describe('persistence', () => {
    it('persists to disk and reloads', async () => {
      await store.write({
        projectId: 'proj-1', title: 'Persistent', content: 'this should survive reload', kind: 'DECISION', tags: ['test'],
      });
      // Force persist
      await (store as any).persist();

      // Create new store from same file
      const store2 = new JsonMemoryStore(filePath);
      await store2.init();
      const results = await store2.search({ projectId: 'proj-1' });
      assert.ok(results.items.some(i => i.title === 'Persistent'));
    });
  });
});
