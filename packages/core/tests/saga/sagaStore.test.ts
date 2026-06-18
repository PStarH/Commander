import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSagaStore, InMemorySagaStore } from '../../src/saga/sagaStore';
import type { SagaStateSnapshot, SagaEvent } from '../../src/saga/types';

function makeSnapshot(runId: string): SagaStateSnapshot {
  return {
    runId,
    state: 'EXECUTING' as const,
    intentHash: 'hash-' + runId,
    fencingEpoch: 1,
    nodeStates: { a: 'completed' as const, b: 'running' as const },
    childRunIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checkpointVersion: 1,
  };
}

function makeEvent(runId: string, kind: string, idx: number): SagaEvent {
  return {
    runId,
    fencingEpoch: 1,
    timestamp: new Date().toISOString(),
    kind: kind as SagaEvent['kind'],
    index: idx,
  };
}

describe('InMemorySagaStore', () => {
  it('appends and reads events', async () => {
    const s = new InMemorySagaStore();
    await s.appendEvent(makeEvent('r1', 'begin', 0));
    await s.appendEvent(makeEvent('r1', 'commit', 1));
    const events = await s.readEvents('r1');
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].kind, 'begin');
  });

  it('returns empty for missing run', async () => {
    const s = new InMemorySagaStore();
    const events = await s.readEvents('nonexistent');
    assert.deepStrictEqual(events, []);
  });

  it('writes and reads snapshot', async () => {
    const s = new InMemorySagaStore();
    await s.writeSnapshot(makeSnapshot('r1'));
    const snap = await s.readSnapshot('r1');
    assert.ok(snap);
    assert.strictEqual(snap!.runId, 'r1');
  });

  it('returns undefined for missing snapshot', async () => {
    const s = new InMemorySagaStore();
    const snap = await s.readSnapshot('nonexistent');
    assert.strictEqual(snap, undefined);
  });

  it('lists run ids from events and snapshots', async () => {
    const s = new InMemorySagaStore();
    await s.appendEvent(makeEvent('r1', 'begin', 0));
    await s.writeSnapshot(makeSnapshot('r2'));
    const ids = await s.listRunIds();
    assert.ok(ids.includes('r1'));
    assert.ok(ids.includes('r2'));
  });

  it('deletes run', async () => {
    const s = new InMemorySagaStore();
    await s.appendEvent(makeEvent('r1', 'begin', 0));
    await s.writeSnapshot(makeSnapshot('r1'));
    await s.deleteRun('r1');
    const events = await s.readEvents('r1');
    const snap = await s.readSnapshot('r1');
    assert.strictEqual(events.length, 0);
    assert.strictEqual(snap, undefined);
  });
});

describe('FileSagaStore', () => {
  let baseDir: string;

  before(async () => {
    baseDir = join(tmpdir(), 'saga-test-' + Date.now());
    await fs.mkdir(baseDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('appends and reads events from disk', async () => {
    const s = new FileSagaStore({ baseDir });
    await s.appendEvent(makeEvent('r1', 'begin', 0));
    await s.appendEvent(makeEvent('r1', 'commit', 1));
    const events = await s.readEvents('r1');
    assert.strictEqual(events.length, 2);
  });

  it('returns empty for missing run', async () => {
    const s = new FileSagaStore({ baseDir });
    const events = await s.readEvents('missing');
    assert.deepStrictEqual(events, []);
  });

  it('writes and reads snapshot atomically', async () => {
    const s = new FileSagaStore({ baseDir });
    await s.writeSnapshot(makeSnapshot('r2'));
    const snap = await s.readSnapshot('r2');
    assert.ok(snap);
    assert.strictEqual(snap!.runId, 'r2');
  });

  it('lists run ids', async () => {
    const s = new FileSagaStore({ baseDir });
    const ids = await s.listRunIds();
    assert.ok(ids.length > 0);
  });

  it('deletes run', async () => {
    const s = new FileSagaStore({ baseDir });
    await s.writeSnapshot(makeSnapshot('to-delete'));
    await s.deleteRun('to-delete');
    const snap = await s.readSnapshot('to-delete');
    assert.strictEqual(snap, undefined);
  });

  it('returns empty list when baseDir missing', async () => {
    const s = new FileSagaStore({ baseDir: join(baseDir, 'nonexistent') });
    const ids = await s.listRunIds();
    assert.deepStrictEqual(ids, []);
  });
});
