/**
 * Tests for the P-obs-3 DatasetStore.
 *
 * Coverage:
 *  - CRUD: create / get / list / update / delete
 *  - immutability: id and createdAt can't be overwritten via update
 *  - updatedAt advances on every update
 *  - persistence: save / saveAll writes JSON files; loadFromFile roundtrips;
 *    loadAllFromDir picks up *.json
 *  - malformed JSON in loadFromFile returns undefined
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatasetStore, type Dataset } from '../../src/observability/dataset';

describe('DatasetStore — in-memory CRUD', () => {
  let store: DatasetStore;
  beforeEach(() => {
    store = new DatasetStore();
  });

  it('creates a dataset with auto-generated id + timestamps', () => {
    const ds = store.create({
      name: 'demo',
      rubricId: 'default-quality',
      cases: [{ id: 'c1', input: { goal: 'compute 2+2' } }],
    });
    expect(ds.id).toMatch(/^ds_/);
    expect(ds.createdAt).toBeTruthy();
    expect(ds.updatedAt).toEqual(ds.createdAt);
    expect(ds.cases).toHaveLength(1);
  });

  it('honors caller-provided id', () => {
    const ds = store.create({
      id: 'ds-fixed',
      name: 'fixed',
      rubricId: 'r',
      cases: [],
    });
    expect(ds.id).toBe('ds-fixed');
  });

  it('list() returns datasets sorted newest-first by createdAt', async () => {
    const a = store.create({ name: 'a', rubricId: 'r', cases: [] });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create({ name: 'b', rubricId: 'r', cases: [] });
    expect(store.list().map((d) => d.id)).toEqual([b.id, a.id]);
  });

  it('update() is partial + advances updatedAt + locks id/createdAt', async () => {
    const ds = store.create({ name: 'x', rubricId: 'r', cases: [] });
    await new Promise((r) => setTimeout(r, 5));
    const updated = store.update(ds.id, { name: 'x-renamed', description: 'desc' })!;
    expect(updated.name).toBe('x-renamed');
    expect(updated.description).toBe('desc');
    expect(updated.id).toBe(ds.id);
    expect(updated.createdAt).toBe(ds.createdAt);
    expect(updated.updatedAt).not.toBe(ds.createdAt);
  });

  it('update() rejects attempts to overwrite id/createdAt', () => {
    const ds = store.create({ name: 'x', rubricId: 'r', cases: [] });
    const updated = store.update(ds.id, { id: 'hijacked', createdAt: '1999' } as Partial<Dataset>)!;
    expect(updated.id).toBe(ds.id);
    expect(updated.createdAt).toBe(ds.createdAt);
  });

  it('update() returns undefined for unknown id', () => {
    expect(store.update('ds-missing', { name: 'n' })).toBeUndefined();
  });

  it('get() returns undefined for unknown id', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  it('delete() removes the dataset and returns true', () => {
    const ds = store.create({ name: 'x', rubricId: 'r', cases: [] });
    expect(store.delete(ds.id)).toBe(true);
    expect(store.get(ds.id)).toBeUndefined();
    expect(store.delete(ds.id)).toBe(false);
  });

  it('size() reflects the in-memory count', () => {
    expect(store.size()).toBe(0);
    store.create({ name: 'a', rubricId: 'r', cases: [] });
    store.create({ name: 'b', rubricId: 'r', cases: [] });
    expect(store.size()).toBe(2);
  });
});

describe('DatasetStore — persistence', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-store-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('save() writes a JSON file; loadFromFile roundtrips', () => {
    const store = new DatasetStore({ persistenceDir: tmpDir });
    const ds = store.create({
      id: 'ds-round',
      name: 'round',
      rubricId: 'r',
      cases: [{ id: 'c', input: { goal: 'g' } }],
    });
    expect(store.save(ds.id)).toBe(true);
    const filePath = path.join(tmpDir, `${ds.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const store2 = new DatasetStore({ persistenceDir: tmpDir });
    const loaded = store2.loadFromFile(filePath);
    expect(loaded).toBeTruthy();
    expect(loaded!.name).toBe('round');
    expect(loaded!.cases[0]!.id).toBe('c');
  });

  it('saveAll writes every dataset', () => {
    const store = new DatasetStore({ persistenceDir: tmpDir });
    store.create({ id: 'a', name: 'a', rubricId: 'r', cases: [] });
    store.create({ id: 'b', name: 'b', rubricId: 'r', cases: [] });
    expect(store.saveAll()).toBe(2);
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json')).length).toBe(2);
  });

  it('save() is a no-op when persistence is disabled', () => {
    const store = new DatasetStore();
    const ds = store.create({ name: 'a', rubricId: 'r', cases: [] });
    expect(store.save(ds.id)).toBe(false);
  });

  it('loadAllFromDir picks up every *.json file', () => {
    const store = new DatasetStore();
    store.create({ id: 'a', name: 'a', rubricId: 'r', cases: [] });
    store.create({ id: 'b', name: 'b', rubricId: 'r', cases: [] });
    store.saveAll();

    const store2 = new DatasetStore({ persistenceDir: tmpDir });
    const loaded = store2.loadAllFromDir();
    // Reload from a fresh store that wasn't already populated.
    const store3 = new DatasetStore({ persistenceDir: tmpDir });
    fs.writeFileSync(
      path.join(tmpDir, 'a.json'),
      JSON.stringify({
        id: 'a',
        name: 'a',
        rubricId: 'r',
        cases: [],
        createdAt: '2024',
        updatedAt: '2024',
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'b.json'),
      JSON.stringify({
        id: 'b',
        name: 'b',
        rubricId: 'r',
        cases: [],
        createdAt: '2024',
        updatedAt: '2024',
      }),
    );
    expect(store3.loadAllFromDir()).toBe(2);
    expect(store3.size()).toBe(2);
  });

  it('loadFromFile returns undefined on malformed JSON', () => {
    const store = new DatasetStore({ persistenceDir: tmpDir });
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, 'not json');
    expect(store.loadFromFile(filePath)).toBeUndefined();
  });

  it('loadFromFile rejects payloads missing required fields', () => {
    const store = new DatasetStore({ persistenceDir: tmpDir });
    const filePath = path.join(tmpDir, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({ id: 'x', cases: [] })); // no rubricId
    expect(store.loadFromFile(filePath)).toBeUndefined();
  });
});
