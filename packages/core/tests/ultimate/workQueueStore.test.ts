import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InMemoryWorkQueueStore } from '../../src/ultimate/inMemoryWorkQueueStore';
import { SqliteWorkQueueStore } from '../../src/ultimate/sqliteWorkQueueStore';
import type { WorkItem } from '../../src/ultimate/workCoordinator';

const makeItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: overrides.id ?? `wko_${Math.random().toString(36).slice(2, 10)}`,
  runId: 'run-1',
  parentNodeId: 'node-A',
  goal: 'do the thing',
  tools: ['file_write', 'web_search'],
  dependsOn: [],
  status: 'PENDING',
  attempts: 0,
  maxAttempts: 2,
  tokenBudget: 50_000,
  priority: 50,
  createdAt: new Date().toISOString(),
  fencingEpoch: 0,
  ...overrides,
});

describe('InMemoryWorkQueueStore', () => {
  let store: InMemoryWorkQueueStore;
  beforeEach(() => {
    store = new InMemoryWorkQueueStore();
  });

  it('enqueue + loadAll round-trip preserves all fields', () => {
    const item = makeItem({
      id: 'x1',
      goal: 'complex goal',
      tools: ['a', 'b'],
      dependsOn: ['dep1'],
    });
    store.enqueue(item);
    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(item);
  });

  it('update mutates fields and loadAll sees the change', () => {
    const item = makeItem({ id: 'x1' });
    store.enqueue(item);
    item.status = 'COMPLETED';
    item.completedAt = '2026-01-01T00:00:00.000Z';
    store.update(item);
    const loaded = store.loadAll();
    expect(loaded[0].status).toBe('COMPLETED');
    expect(loaded[0].completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('updateMany applies a batch atomically (all-or-nothing visible)', () => {
    const items = Array.from({ length: 100 }, (_, i) => makeItem({ id: `batch-${i}` }));
    for (const i of items) store.enqueue(i);
    const updated = items.map((i) => ({
      ...i,
      status: 'COMPLETED' as const,
      completedAt: '2026-01-01T00:00:00.000Z',
    }));
    store.updateMany(updated);
    const loaded = store.loadAll();
    expect(loaded).toHaveLength(100);
    expect(loaded.every((i) => i.status === 'COMPLETED')).toBe(true);
  });

  it('remove deletes items matching predicate', () => {
    store.enqueue(makeItem({ id: 'a', runId: 'run-1' }));
    store.enqueue(makeItem({ id: 'b', runId: 'run-2' }));
    store.enqueue(makeItem({ id: 'c', runId: 'run-1' }));
    const removed = store.remove((i) => i.runId === 'run-1');
    expect(removed).toBe(2);
    expect(
      store
        .loadAll()
        .map((i) => i.id)
        .sort(),
    ).toEqual(['b']);
  });
});

describe('SqliteWorkQueueStore', () => {
  let tmpDir: string;
  let dbPath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqueue-sqlite-'));
    dbPath = path.join(tmpDir, 'queue.db');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueue + loadAll round-trip preserves all fields', () => {
    const store = new SqliteWorkQueueStore({ filePath: dbPath });
    const item = makeItem({
      id: 'sql-1',
      goal: 'sql test',
      tools: ['x', 'y'],
      dependsOn: ['d1', 'd2'],
    });
    store.enqueue(item);
    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('sql-1');
    expect(loaded[0].goal).toBe('sql test');
    expect(loaded[0].tools).toEqual(['x', 'y']);
    expect(loaded[0].dependsOn).toEqual(['d1', 'd2']);
    store.close();
  });

  it('update + reload survives close/reopen (crash recovery)', () => {
    const s1 = new SqliteWorkQueueStore({ filePath: dbPath });
    const item = makeItem({ id: 'crash-1', runId: 'team-X' });
    s1.enqueue(item);
    item.status = 'CLAIMED';
    item.claimedBy = 'agent-A';
    item.claimedAt = new Date().toISOString();
    item.attempts = 1;
    s1.update(item);
    s1.close();

    const s2 = new SqliteWorkQueueStore({ filePath: dbPath });
    const loaded = s2.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('crash-1');
    expect(loaded[0].status).toBe('CLAIMED');
    expect(loaded[0].claimedBy).toBe('agent-A');
    expect(loaded[0].attempts).toBe(1);
    s2.close();
  });

  it('1000 items enqueue + loadAll < 2000ms', () => {
    const store = new SqliteWorkQueueStore({ filePath: dbPath });
    const items = Array.from({ length: 1000 }, (_, i) =>
      makeItem({ id: `perf-${i}`, priority: i % 100 }),
    );
    const t0 = Date.now();
    for (const i of items) store.enqueue(i);
    const loaded = store.loadAll();
    const elapsed = Date.now() - t0;
    expect(loaded).toHaveLength(1000);
    expect(elapsed).toBeLessThan(2000);
    store.close();
  });

  it('updateMany in transaction applies all 50 reassignments', () => {
    const store = new SqliteWorkQueueStore({ filePath: dbPath });
    for (let i = 0; i < 50; i++) store.enqueue(makeItem({ id: `tx-${i}` }));
    const all = store.loadAll();
    const reassigned = all.map((i) => ({
      ...i,
      status: 'PENDING' as const,
      claimedBy: undefined,
      claimedAt: undefined,
    }));
    store.updateMany(reassigned);
    const reloaded = store.loadAll();
    expect(reloaded.every((i) => i.status === 'PENDING')).toBe(true);
    expect(reloaded.every((i) => i.claimedBy === undefined)).toBe(true);
    store.close();
  });

  it('remove deletes by predicate from persisted rows', () => {
    const store = new SqliteWorkQueueStore({ filePath: dbPath });
    store.enqueue(makeItem({ id: 'p-1', runId: 'r1' }));
    store.enqueue(makeItem({ id: 'p-2', runId: 'r2' }));
    store.enqueue(makeItem({ id: 'p-3', runId: 'r1' }));
    const removed = store.remove((i) => i.runId === 'r1');
    expect(removed).toBe(2);
    expect(
      store
        .loadAll()
        .map((i) => i.id)
        .sort(),
    ).toEqual(['p-2']);
    store.close();
  });
});

describe('WorkQueueStore parity: InMemory vs Sqlite', () => {
  it('identical lifecycle yields identical state', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqueue-parity-'));
    try {
      const inMem = new InMemoryWorkQueueStore();
      const sqlite = new SqliteWorkQueueStore({ filePath: path.join(tmpDir, 'p.db') });

      const ops: Array<(s: InMemoryWorkQueueStore | SqliteWorkQueueStore) => void> = [
        (s) => s.enqueue(makeItem({ id: 'a' })),
        (s) => s.enqueue(makeItem({ id: 'b' })),
        (s) => {
          const i = makeItem({ id: 'c' });
          s.enqueue(i);
          s.update({ ...i, status: 'CLAIMED', claimedBy: 'agt' });
        },
        (s) => s.remove((i) => i.id === 'b'),
      ];
      for (const op of ops) {
        op(inMem);
        op(sqlite);
      }

      const stripUndefined = (i: WorkItem): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(i)) {
          if (v !== undefined) out[k] = v;
        }
        // Normalize timestamps to 1s resolution to avoid flaky 1ms differences
        if (typeof out.createdAt === 'string')
          out.createdAt = (out.createdAt as string).slice(0, -4) + '000';
        return out;
      };
      const a = (inMem.loadAll() as WorkItem[])
        .map(stripUndefined)
        .sort((x, y) => (x.id as string).localeCompare(y.id as string));
      const b = (sqlite.loadAll() as WorkItem[])
        .map(stripUndefined)
        .sort((x, y) => (x.id as string).localeCompare(y.id as string));
      expect(a).toEqual(b);
      sqlite.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('WorkQueueStore — GAP-M2.4 multi-process tryClaim', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqueue-mp-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('InMemoryWorkQueueStore.tryClaim returns true for PENDING, false for already-claimed', () => {
    const store = new InMemoryWorkQueueStore();
    for (let i = 0; i < 10; i++) {
      store.enqueue(makeItem({ id: `m-${i}` }));
    }
    let firstWins = 0;
    for (let i = 0; i < 10; i++) {
      if (store.tryClaim('agent-A', `m-${i}`, `lease-${i}`, new Date().toISOString())) firstWins++;
    }
    expect(firstWins).toBe(10);
    let secondWins = 0;
    for (let i = 0; i < 10; i++) {
      if (store.tryClaim('agent-B', `m-${i}`, `lease-b-${i}`, new Date().toISOString()))
        secondWins++;
    }
    expect(secondWins).toBe(0);
  });

  it('SqliteWorkQueueStore.tryClaim succeeds once then fails on same workId', () => {
    const store = new SqliteWorkQueueStore({ filePath: path.join(tmpDir, 'atomic.db') });
    store.enqueue(makeItem({ id: 'once' }));
    expect(store.tryClaim('a1', 'once', 'lease-1', new Date().toISOString())).toBe(true);
    expect(store.tryClaim('a2', 'once', 'lease-2', new Date().toISOString())).toBe(false);
    expect(store.tryClaim('a3', 'once', 'lease-3', new Date().toISOString())).toBe(false);
    const row = store.loadAll()[0];
    expect(row.claimedBy).toBe('a1');
    expect(row.leaseToken).toBe('lease-1');
    expect(row.fencingEpoch).toBe(1);
    store.close();
  });

  it('2-process sequential claim: second process tries same id, fails, picks next candidate', () => {
    const store = new SqliteWorkQueueStore({ filePath: path.join(tmpDir, 'twoproc.db') });
    for (const i of [
      { id: 'task-1', priority: 90 },
      { id: 'task-2', priority: 50 },
      { id: 'task-3', priority: 10 },
    ]) {
      store.enqueue(makeItem(i));
    }
    const t0 = new Date().toISOString();
    const procAWon = store.tryClaim('process-A', 'task-1', 'lease-A', t0);
    const procBLost = store.tryClaim('process-B', 'task-1', 'lease-B', t0);
    expect(procAWon).toBe(true);
    expect(procBLost).toBe(false);
    const procBSuccess = store.tryClaim('process-B', 'task-2', 'lease-B2', t0);
    expect(procBSuccess).toBe(true);
    const all = store.loadAll();
    const claimed1 = all.find((i) => i.id === 'task-1')!;
    const claimed2 = all.find((i) => i.id === 'task-2')!;
    const pending3 = all.find((i) => i.id === 'task-3')!;
    expect(claimed1.claimedBy).toBe('process-A');
    expect(claimed1.leaseToken).toBe('lease-A');
    expect(claimed2.claimedBy).toBe('process-B');
    expect(claimed2.leaseToken).toBe('lease-B2');
    expect(pending3.status).toBe('PENDING');
    expect(pending3.leaseToken).toBeUndefined();
    store.close();
  });

  it('releaseClaim clears lease so the same workId can be re-claimed', () => {
    const store = new SqliteWorkQueueStore({ filePath: path.join(tmpDir, 'release.db') });
    store.enqueue(makeItem({ id: 'cycle' }));
    const t0 = new Date().toISOString();
    expect(store.tryClaim('a1', 'cycle', 'lease-1', t0)).toBe(true);
    expect(store.tryClaim('a2', 'cycle', 'lease-2', t0)).toBe(false);
    store.releaseClaim('lease-1');
    const item = store.loadAll()[0];
    expect(item.leaseToken).toBeUndefined();
    expect(item.status).toBe('CLAIMED');
    expect(store.tryClaim('a2', 'cycle', 'lease-2', t0)).toBe(false);
    store.update({ ...item, status: 'PENDING' });
    expect(store.tryClaim('a2', 'cycle', 'lease-2', t0)).toBe(true);
    const reclaimed = store.loadAll()[0];
    expect(reclaimed.claimedBy).toBe('a2');
    expect(reclaimed.leaseToken).toBe('lease-2');
    store.close();
  });

  it('fencingEpoch increments on each successful tryClaim', () => {
    const store = new SqliteWorkQueueStore({ filePath: path.join(tmpDir, 'fence.db') });
    store.enqueue(makeItem({ id: 'epoch' }));
    const t0 = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      expect(store.tryClaim('a1', 'epoch', `lease-${i}`, t0)).toBe(true);
      const row = store.loadAll()[0];
      expect(row.fencingEpoch).toBe(i + 1);
      store.releaseClaim(`lease-${i}`);
      store.update({ ...row, status: 'PENDING' });
    }
    store.close();
  });
});
