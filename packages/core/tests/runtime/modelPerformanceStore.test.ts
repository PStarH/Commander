import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ModelPerformanceStore } from '../../src/runtime/modelPerformanceStore';

const TEST_DIR = path.join(__dirname, '../../.test_model_outcomes');

describe('ModelPerformanceStore', () => {
  let store: ModelPerformanceStore;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    store = new ModelPerformanceStore({ baseDir: TEST_DIR, flushIntervalMs: 0, maxRecords: 100 });
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('record and getAll', () => {
    it('records and retrieves outcomes', () => {
      store.record({
        modelId: 'gpt-4o', taskType: 'code', success: true,
        durationMs: 1000, tokensUsed: 5000, timestamp: Date.now(),
      });
      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].modelId).toBe('gpt-4o');
    });

    it('accumulates multiple records', () => {
      for (let i = 0; i < 5; i++) {
        store.record({
          modelId: `model-${i}`, taskType: 'code', success: true,
          durationMs: 1000, tokensUsed: 5000, timestamp: Date.now(),
        });
      }
      expect(store.getAll()).toHaveLength(5);
    });
  });

  describe('flush', () => {
    it('persists records to disk', () => {
      store.record({
        modelId: 'gpt-4o', taskType: 'code', success: true,
        durationMs: 1000, tokensUsed: 5000, timestamp: Date.now(),
      });
      store.flush();

      const filePath = path.join(TEST_DIR, 'model_outcomes.ndjson');
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('gpt-4o');
    });

    it('loads records from disk on construction', () => {
      // Write records directly
      const filePath = path.join(TEST_DIR, 'model_outcomes.ndjson');
      const records = [
        { modelId: 'gpt-4o', taskType: 'code', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() },
        { modelId: 'claude', taskType: 'search', success: false, durationMs: 2000, tokensUsed: 3000, timestamp: Date.now() },
      ];
      fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');

      const newStore = new ModelPerformanceStore({ baseDir: TEST_DIR, flushIntervalMs: 0, maxRecords: 100 });
      expect(newStore.getAll()).toHaveLength(2);
      newStore.dispose();
    });
  });

  describe('getFiltered', () => {
    it('filters by model ID', () => {
      store.record({ modelId: 'gpt-4o', taskType: 'code', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() });
      store.record({ modelId: 'claude', taskType: 'code', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() });

      const filtered = store.getFiltered({ modelId: 'gpt-4o' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].modelId).toBe('gpt-4o');
    });

    it('filters by task type', () => {
      store.record({ modelId: 'gpt-4o', taskType: 'code', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() });
      store.record({ modelId: 'gpt-4o', taskType: 'search', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() });

      const filtered = store.getFiltered({ taskType: 'code' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].taskType).toBe('code');
    });
  });

  describe('getAggregatedStats', () => {
    it('computes success rate per model per task type', () => {
      for (let i = 0; i < 8; i++) {
        store.record({ modelId: 'gpt-4o', taskType: 'code', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() });
      }
      store.record({ modelId: 'gpt-4o', taskType: 'code', success: false, durationMs: 2000, tokensUsed: 3000, timestamp: Date.now() });

      const stats = store.getAggregatedStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].successRate).toBeCloseTo(0.88, 0);
      expect(stats[0].count).toBe(9);
    });

    it('sorts by count descending', () => {
      for (let i = 0; i < 10; i++) {
        store.record({ modelId: 'gpt-4o', taskType: 'code', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() });
      }
      store.record({ modelId: 'claude', taskType: 'search', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() });

      const stats = store.getAggregatedStats();
      expect(stats[0].modelId).toBe('gpt-4o');
      expect(stats[0].count).toBe(10);
    });
  });

  describe('size', () => {
    it('returns correct count', () => {
      expect(store.size).toBe(0);
      store.record({ modelId: 'gpt-4o', taskType: 'code', success: true, durationMs: 1000, tokensUsed: 5000, timestamp: Date.now() });
      expect(store.size).toBe(1);
    });
  });
});
