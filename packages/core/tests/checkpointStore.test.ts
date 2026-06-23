import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CheckpointStore,
  resetCheckpointStores,
  type CheckpointSnapshot,
  type CheckpointRecord,
} from '../src/runtime/checkpointStore';

const makeSnapshot = ({ checkpoint: cpOverrides, ...rest }: Partial<CheckpointSnapshot> = {}): CheckpointSnapshot => ({
  checkpoint: {
    id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId: 'test-run',
    label: 'test-checkpoint',
    stepNumber: 1,
    tokenCount: 100,
    createdAt: new Date().toISOString(),
    version: 1,
    ...cpOverrides,
  },
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ],
  filesRead: ['file1.ts', 'file2.ts'],
  filesModified: ['file3.ts'],
  ...rest,
});

describe('CheckpointStore — basic CRUD', () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = new CheckpointStore({ filePath: ':memory:' });
  });

  afterEach(() => {
    store.close();
    resetCheckpointStores();
  });

  it('save + getCheckpoint round-trips record metadata', () => {
    const snap = makeSnapshot({ checkpoint: { id: 'cp-1', label: 'first', stepNumber: 1 } });
    const saved = store.save(snap);
    expect(saved.id).toBe('cp-1');
    expect(saved.version).toBeGreaterThanOrEqual(1);

    const loaded = store.getCheckpoint('cp-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.label).toBe('first');
    expect(loaded!.stepNumber).toBe(1);
    expect(loaded!.runId).toBe('test-run');
  });

  it('getSnapshot returns full message and file payload', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'world', tool_calls: [{ id: 'tc1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] },
    ];
    const snap = makeSnapshot({
      checkpoint: { id: 'cp-full' },
      messages,
      filesRead: ['a.ts', 'b.ts'],
      filesModified: ['c.ts'],
    });
    store.save(snap);

    const loaded = store.getSnapshot('cp-full');
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].content).toBe('hello');
    expect(loaded!.messages[1].tool_calls).toHaveLength(1);
    expect(loaded!.filesRead).toEqual(['a.ts', 'b.ts']);
    expect(loaded!.filesModified).toEqual(['c.ts']);
  });

  it('listByRun returns summaries ordered by step descending', () => {
    const runId = 'list-run';
    store.save(makeSnapshot({ checkpoint: { id: 'cp-s1', runId, stepNumber: 1, label: 'first' } }));
    store.save(makeSnapshot({ checkpoint: { id: 'cp-s2', runId, stepNumber: 2, label: 'second' } }));
    store.save(makeSnapshot({ checkpoint: { id: 'cp-s3', runId, stepNumber: 3, label: 'third' } }));

    const list = store.listByRun(runId);
    expect(list).toHaveLength(3);
    expect(list[0].label).toBe('third');
    expect(list[0].stepNumber).toBe(3);
    expect(list[1].label).toBe('second');
    expect(list[2].label).toBe('first');
  });

  it('getLatestByRun returns the highest step number', () => {
    const runId = 'latest-run';
    store.save(makeSnapshot({ checkpoint: { id: 'cp-l1', runId, stepNumber: 1 } }));
    store.save(makeSnapshot({ checkpoint: { id: 'cp-l2', runId, stepNumber: 5 } }));
    store.save(makeSnapshot({ checkpoint: { id: 'cp-l3', runId, stepNumber: 2 } }));

    const latest = store.getLatestByRun(runId);
    expect(latest).not.toBeNull();
    expect(latest!.stepNumber).toBe(5);
    expect(latest!.id).toBe('cp-l2');
  });

  it('returns null for unknown checkpoint', () => {
    expect(store.getCheckpoint('nonexistent')).toBeNull();
    expect(store.getSnapshot('nonexistent')).toBeNull();
    expect(store.getLatestByRun('no-run')).toBeNull();
  });
});

describe('CheckpointStore — rewind', () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = new CheckpointStore({ filePath: ':memory:' });
  });

  afterEach(() => {
    store.close();
    resetCheckpointStores();
  });

  it('rewindTo deletes later checkpoints and returns messages', () => {
    const runId = 'rewind-run';
    store.save(makeSnapshot({
      checkpoint: { id: 'cp-r1', runId, stepNumber: 1, label: 'start' },
      messages: [{ role: 'user', content: 'begin' }],
    }));
    store.save(makeSnapshot({
      checkpoint: { id: 'cp-r2', runId, stepNumber: 2, label: 'middle' },
      messages: [{ role: 'user', content: 'wasted effort' }],
    }));
    store.save(makeSnapshot({
      checkpoint: { id: 'cp-r3', runId, stepNumber: 3, label: 'dead end' },
      messages: [{ role: 'user', content: 'wrong path' }],
    }));

    expect(store.listByRun(runId)).toHaveLength(3);

    const messages = store.rewindTo('cp-r1');
    expect(messages).not.toBeNull();
    expect(messages![0].content).toBe('begin');

    const remaining = store.listByRun(runId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('cp-r1');
  });

  it('returns null for unknown checkpoint id', () => {
    expect(store.rewindTo('nope')).toBeNull();
  });
});

describe('CheckpointStore — delete and prune', () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = new CheckpointStore({ filePath: ':memory:', maxPerRun: 3 });
  });

  afterEach(() => {
    store.close();
    resetCheckpointStores();
  });

  it('deleteRun removes all checkpoints for a run', () => {
    const runId = 'del-run';
    store.save(makeSnapshot({ checkpoint: { id: 'cp-d1', runId, stepNumber: 1 } }));
    store.save(makeSnapshot({ checkpoint: { id: 'cp-d2', runId, stepNumber: 2 } }));
    expect(store.listByRun(runId)).toHaveLength(2);

    store.deleteRun(runId);
    expect(store.listByRun(runId)).toHaveLength(0);
  });

  it('pruneRun removes oldest when over limit', () => {
    const runId = 'prune-run';
    store.save(makeSnapshot({ checkpoint: { id: 'cp-p1', runId, stepNumber: 1 } }));
    store.save(makeSnapshot({ checkpoint: { id: 'cp-p2', runId, stepNumber: 2 } }));
    store.save(makeSnapshot({ checkpoint: { id: 'cp-p3', runId, stepNumber: 3 } }));
    // maxPerRun is 3, so this should be fine
    expect(store.listByRun(runId)).toHaveLength(3);

    // Adding a 4th should prune oldest (cp-p1)
    store.save(makeSnapshot({ checkpoint: { id: 'cp-p4', runId, stepNumber: 4 } }));
    const list = store.listByRun(runId);
    expect(list).toHaveLength(3);
    expect(list.find((c) => c.id === 'cp-p1')).toBeUndefined();
    expect(list.find((c) => c.id === 'cp-p4')).toBeDefined();
  });

  it('deleteExpired removes expired checkpoints', () => {
    const past = new Date(Date.now() - 100_000).toISOString();
    store.save(makeSnapshot({
      checkpoint: { id: 'cp-e1', runId: 'expired', createdAt: past, expiresAt: past },
    }));
    store.save(makeSnapshot({
      checkpoint: { id: 'cp-e2', runId: 'fresh', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    }));

    const deleted = store.deleteExpired();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(store.getCheckpoint('cp-e1')).toBeNull();
    expect(store.getCheckpoint('cp-e2')).not.toBeNull();
  });
});

describe('CheckpointStore — crash recovery / persistence', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-store-'));
    dbPath = path.join(tmpDir, 'checkpoints.db');
  });

  afterEach(() => {
    resetCheckpointStores();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('data survives close + reopen', () => {
    const s1 = new CheckpointStore({ filePath: dbPath });
    s1.save(makeSnapshot({
      checkpoint: { id: 'crash-cp', runId: 'persist-run', stepNumber: 1, label: 'survived' },
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
    }));
    s1.close();

    const s2 = new CheckpointStore({ filePath: dbPath });
    const loaded = s2.getSnapshot('crash-cp');
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpoint.label).toBe('survived');
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].content).toBe('hello');
    s2.close();
  });

  it('multiple checkpoints per run are all preserved', () => {
    const s1 = new CheckpointStore({ filePath: dbPath });
    s1.save(makeSnapshot({ checkpoint: { id: 'cp-a', runId: 'multi', stepNumber: 1 } }));
    s1.save(makeSnapshot({ checkpoint: { id: 'cp-b', runId: 'multi', stepNumber: 2 } }));
    s1.save(makeSnapshot({ checkpoint: { id: 'cp-c', runId: 'other', stepNumber: 1 } }));
    s1.close();

    const s2 = new CheckpointStore({ filePath: dbPath });
    expect(s2.listByRun('multi')).toHaveLength(2);
    expect(s2.listByRun('other')).toHaveLength(1);
    s2.close();
  });

  it('isHealthy returns true for active store, false after close', () => {
    const store = new CheckpointStore({ filePath: dbPath });
    expect(store.isHealthy()).toBe(true);
    store.close();

    const s2 = new CheckpointStore({ filePath: dbPath });
    expect(s2.isHealthy()).toBe(true);
    s2.close();
  });

  it('empty database returns empty lists', () => {
    const store = new CheckpointStore({ filePath: dbPath });
    expect(store.listByRun('any')).toHaveLength(0);
    expect(store.getLatestByRun('any')).toBeNull();
    expect(store.getCheckpoint('nope')).toBeNull();
    store.close();
  });

  it('version monotonically increases per run', () => {
    const store = new CheckpointStore({ filePath: dbPath });
    const r1 = store.save(makeSnapshot({ checkpoint: { id: 'v1', runId: 'ver', stepNumber: 1 } }));
    const r2 = store.save(makeSnapshot({ checkpoint: { id: 'v2', runId: 'ver', stepNumber: 2 } }));
    const r3 = store.save(makeSnapshot({ checkpoint: { id: 'v3', runId: 'ver', stepNumber: 3 } }));
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    expect(r3.version).toBe(3);
    store.close();
  });
});

describe('CheckpointStore — file tracking', () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = new CheckpointStore({ filePath: ':memory:' });
  });

  afterEach(() => {
    store.close();
    resetCheckpointStores();
  });

  it('preserves file read/modified lists', () => {
    store.save(makeSnapshot({
      checkpoint: { id: 'cp-files' },
      filesRead: ['a.js', 'b.js', 'c.js'],
      filesModified: ['d.js'],
    }));

    const snap = store.getSnapshot('cp-files');
    expect(snap!.filesRead).toEqual(['a.js', 'b.js', 'c.js']);
    expect(snap!.filesModified).toEqual(['d.js']);
  });
});
