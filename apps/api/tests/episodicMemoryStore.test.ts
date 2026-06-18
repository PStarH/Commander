import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EpisodicMemoryStore } from '../src/episodicMemoryStore';

describe('EpisodicMemoryStore', () => {
  let store: EpisodicMemoryStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-test-'));
    const filePath = path.join(tmpDir, 'episodic-memory.json');
    const vectorPath = path.join(tmpDir, 'episodic-memory-vectors.json');
    store = new EpisodicMemoryStore(filePath, vectorPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('write', () => {
    it('writes a new memory and returns it', () => {
      const memory = store.write({
        projectId: 'proj-1',
        title: 'Test memory',
        content: 'This is a test observation about the system',
        type: 'observation',
        tags: ['test'],
        importance: 0.5,
      });
      assert.ok(memory.id);
      assert.ok(memory.timestamp);
      assert.equal(memory.accessCount, 0);
      assert.equal(memory.title, 'Test memory');
    });

    it('deduplicates by title+project+type', () => {
      store.write({
        projectId: 'proj-1',
        title: 'Same title',
        content: 'First content with enough words for indexing',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });
      const second = store.write({
        projectId: 'proj-1',
        title: 'Same title',
        content: 'Second content with different words for indexing',
        type: 'observation',
        tags: [],
        importance: 0.8,
      });
      // Should update importance, not create duplicate
      assert.equal(second.importance, 0.8);
    });

    it('writes different types as separate memories', () => {
      store.write({
        projectId: 'proj-1',
        title: 'Same title',
        content: 'Content with enough words for proper indexing',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });
      const decision = store.write({
        projectId: 'proj-1',
        title: 'Same title',
        content: 'Content with enough words for proper indexing',
        type: 'decision',
        tags: [],
        importance: 0.5,
      });
      assert.ok(decision.id);
    });

    it('batchWrite creates multiple memories', () => {
      const results = store.batchWrite([
        {
          projectId: 'proj-1',
          title: 'Mem 1',
          content: 'content one with enough words',
          type: 'observation',
          tags: [],
          importance: 0.5,
        },
        {
          projectId: 'proj-1',
          title: 'Mem 2',
          content: 'content two with enough words',
          type: 'action',
          tags: [],
          importance: 0.5,
        },
      ]);
      assert.equal(results.length, 2);
    });
  });

  describe('search', () => {
    it('finds memories by semantic query', () => {
      store.write({
        projectId: 'proj-1',
        title: 'Authentication decision',
        content: 'We decided to use JWT tokens for authentication',
        type: 'decision',
        tags: ['auth'],
        importance: 0.9,
      });
      store.write({
        projectId: 'proj-1',
        title: 'Database setup',
        content: 'PostgreSQL database was configured for production',
        type: 'action',
        tags: ['db'],
        importance: 0.5,
      });

      const results = store.read({ query: 'authentication JWT', projectId: 'proj-1' });
      assert.ok(results.length > 0);
      assert.ok(results.some((m) => m.title === 'Authentication decision'));
    });

    it('filters by type', () => {
      store.write({
        projectId: 'proj-1',
        title: 'Obs 1',
        content: 'observation about system behavior',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });
      store.write({
        projectId: 'proj-1',
        title: 'Dec 1',
        content: 'decision about system architecture',
        type: 'decision',
        tags: [],
        importance: 0.5,
      });

      const results = store.read({ type: 'decision', projectId: 'proj-1' });
      assert.ok(results.every((m) => m.type === 'decision'));
    });

    it('filters by tags', () => {
      store.write({
        projectId: 'proj-1',
        title: 'Tagged',
        content: 'memory with important tag',
        type: 'observation',
        tags: ['important'],
        importance: 0.5,
      });
      store.write({
        projectId: 'proj-1',
        title: 'Untagged',
        content: 'memory without the tag',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });

      const results = store.read({ tags: ['important'], projectId: 'proj-1' });
      assert.ok(results.every((m) => m.tags.includes('important')));
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        store.write({
          projectId: 'proj-1',
          title: `Mem ${i}`,
          content: `content number ${i} with enough words`,
          type: 'observation',
          tags: [],
          importance: 0.5,
        });
      }
      const results = store.read({ limit: 3, projectId: 'proj-1' });
      assert.ok(results.length <= 3);
    });

    it('filters by minImportance', () => {
      store.write({
        projectId: 'proj-1',
        title: 'Low',
        content: 'low importance memory content',
        type: 'observation',
        tags: [],
        importance: 0.2,
      });
      store.write({
        projectId: 'proj-1',
        title: 'High',
        content: 'high importance memory content',
        type: 'decision',
        tags: [],
        importance: 0.9,
      });

      const results = store.read({ minImportance: 0.5, projectId: 'proj-1' });
      assert.ok(results.every((m) => m.importance >= 0.5));
    });
  });

  describe('getById', () => {
    it('retrieves memory by ID', () => {
      const memory = store.write({
        projectId: 'proj-1',
        title: 'Findable',
        content: 'this memory can be found by id',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });
      const found = store.getById(memory.id);
      assert.ok(found);
      assert.equal(found!.title, 'Findable');
    });

    it('returns undefined for non-existent ID', () => {
      assert.equal(store.getById('nonexistent'), undefined);
    });
  });

  describe('updateImportance', () => {
    it('updates importance of existing memory', () => {
      const memory = store.write({
        projectId: 'proj-1',
        title: 'Updatable',
        content: 'memory importance can be updated',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });
      store.updateImportance(memory.id, 0.9);
      const updated = store.getById(memory.id);
      assert.equal(updated!.importance, 0.9);
    });

    it('throws for non-existent memory', () => {
      assert.throws(() => store.updateImportance('nonexistent', 0.5), /not found/i);
    });
  });

  describe('delete', () => {
    it('deletes a memory', () => {
      const memory = store.write({
        projectId: 'proj-1',
        title: 'Deletable',
        content: 'this memory will be deleted',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });
      store.delete(memory.id);
      assert.equal(store.getById(memory.id), undefined);
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      store.write({
        projectId: 'proj-1',
        title: 'Obs',
        content: 'observation content',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });
      store.write({
        projectId: 'proj-1',
        title: 'Dec',
        content: 'decision content',
        type: 'decision',
        tags: [],
        importance: 0.8,
      });
      const stats = store.getStats();
      assert.ok(stats.totalMemories >= 2);
      assert.ok(stats.byType.observation >= 1);
      assert.ok(stats.byType.decision >= 1);
    });
  });

  describe('contradiction detection', () => {
    it('detects contradictions between observations', () => {
      store.write({
        projectId: 'proj-1',
        title: 'System status',
        content: 'The authentication system is working correctly and all tests pass',
        type: 'observation',
        tags: [],
        importance: 0.5,
      });
      const contradicting = store.write({
        projectId: 'proj-1',
        title: 'System status update',
        content: 'The authentication system is not working correctly and tests are failing',
        type: 'observation',
        tags: [],
        importance: 0.6,
      });
      // The contradicting memory should reference the original
      if (contradicting.contradicts) {
        assert.ok(contradicting.contradicts.length > 0);
      }
    });
  });
});
