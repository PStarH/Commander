import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatasetStore } from '../src/dataset';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('DatasetStore', () => {
  let store: DatasetStore;

  beforeEach(() => {
    store = new DatasetStore();
  });

  it('creates a dataset', () => {
    const dataset = store.create({
      name: 'Test Dataset',
      rubricId: 'default',
      cases: [],
    });
    expect(dataset.id).toBeDefined();
    expect(dataset.name).toBe('Test Dataset');
    expect(dataset.rubricId).toBe('default');
  });

  it('lists datasets', () => {
    store.create({ name: 'A', rubricId: 'r1', cases: [] });
    store.create({ name: 'B', rubricId: 'r2', cases: [] });
    expect(store.list()).toHaveLength(2);
  });

  it('gets a dataset by id', () => {
    const created = store.create({ name: 'Test', rubricId: 'r1', cases: [] });
    const found = store.get(created.id);
    expect(found?.name).toBe('Test');
  });

  it('returns undefined for unknown id', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('updates a dataset', () => {
    const created = store.create({ name: 'Original', rubricId: 'r1', cases: [] });
    const updated = store.update(created.id, { name: 'Updated' });
    expect(updated?.name).toBe('Updated');
    expect(updated?.id).toBe(created.id);
  });

  it('returns undefined when updating non-existent dataset', () => {
    expect(store.update('nonexistent', { name: 'x' })).toBeUndefined();
  });

  it('deletes a dataset', () => {
    const created = store.create({ name: 'Test', rubricId: 'r1', cases: [] });
    expect(store.delete(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
  });

  it('returns false when deleting non-existent dataset', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('returns size', () => {
    expect(store.size()).toBe(0);
    store.create({ name: 'A', rubricId: 'r1', cases: [] });
    expect(store.size()).toBe(1);
  });

  it('preserves id and createdAt on update', () => {
    const created = store.create({ name: 'Test', rubricId: 'r1', cases: [] });
    const updated = store.update(created.id, { name: 'Updated' });
    expect(updated?.id).toBe(created.id);
    expect(updated?.createdAt).toBe(created.createdAt);
  });

  describe('persistence', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves and loads from disk', () => {
      const persistentStore = new DatasetStore({ persistenceDir: tmpDir });
      const dataset = persistentStore.create({
        name: 'Persistent',
        rubricId: 'r1',
        cases: [{ id: 'c1', input: { goal: 'test' } }],
      });
      expect(persistentStore.save(dataset.id)).toBe(true);

      const loaded = persistentStore.loadFromFile(path.join(tmpDir, `${dataset.id}.json`));
      expect(loaded?.name).toBe('Persistent');
      expect(loaded?.cases).toHaveLength(1);
    });

    it('saveAll returns count', () => {
      const persistentStore = new DatasetStore({ persistenceDir: tmpDir });
      persistentStore.create({ name: 'A', rubricId: 'r1', cases: [] });
      persistentStore.create({ name: 'B', rubricId: 'r2', cases: [] });
      expect(persistentStore.saveAll()).toBe(2);
    });

    it('loadAllFromDir loads all files', () => {
      const persistentStore = new DatasetStore({ persistenceDir: tmpDir });
      persistentStore.create({ name: 'A', rubricId: 'r1', cases: [] });
      persistentStore.create({ name: 'B', rubricId: 'r2', cases: [] });
      persistentStore.saveAll();

      const newStore = new DatasetStore({ persistenceDir: tmpDir });
      const loaded = newStore.loadAllFromDir();
      expect(loaded).toBe(2);
    });

    it('returns false when no persistence dir configured', () => {
      const noPersistStore = new DatasetStore();
      expect(noPersistStore.save('x')).toBe(false);
      expect(noPersistStore.saveAll()).toBe(0);
      expect(noPersistStore.loadAllFromDir()).toBe(0);
    });
  });
});
