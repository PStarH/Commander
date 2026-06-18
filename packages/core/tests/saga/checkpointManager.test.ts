import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CheckpointManager, CheckpointError } from '../../src/saga/checkpointManager';
import { InMemorySagaStore } from '../../src/saga/sagaStore';
import type { SagaStateSnapshot, SagaEvent } from '../../src/saga/types';

function makeSnapshot(runId: string, version: number = 1): SagaStateSnapshot {
  return {
    runId,
    state: 'EXECUTING' as const,
    intentHash: 'hash',
    fencingEpoch: 1,
    nodeStates: { a: 'completed' as const },
    childRunIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checkpointVersion: version,
  };
}

function makeEvent(runId: string, kind: string): SagaEvent {
  return {
    runId,
    fencingEpoch: 1,
    timestamp: new Date().toISOString(),
    kind: kind as SagaEvent['kind'],
  };
}

describe('CheckpointManager', () => {
  it('saves and loads snapshot', async () => {
    const mgr = new CheckpointManager(new InMemorySagaStore());
    await mgr.saveSnapshot(makeSnapshot('r1'));
    const snap = await mgr.loadSnapshot('r1');
    assert.ok(snap);
  });

  it('appends and loads events', async () => {
    const mgr = new CheckpointManager(new InMemorySagaStore());
    await mgr.appendEvent(makeEvent('r1', 'begin'));
    await mgr.appendEvent(makeEvent('r1', 'commit'));
    const events = await mgr.loadEvents('r1');
    assert.strictEqual(events.length, 2);
  });

  it('recover returns undefined for unknown run', async () => {
    const mgr = new CheckpointManager(new InMemorySagaStore());
    const rec = await mgr.recover('nope');
    assert.strictEqual(rec, undefined);
  });

  it('recover returns snapshot + events after snapshot', async () => {
    const mgr = new CheckpointManager(new InMemorySagaStore());
    const snap = makeSnapshot('r1');
    await mgr.saveSnapshot(snap);
    await new Promise((r) => setTimeout(r, 5));
    await mgr.appendEvent(makeEvent('r1', 'step.completed'));
    const rec = await mgr.recover('r1');
    assert.ok(rec);
    assert.strictEqual(rec!.snapshot.runId, 'r1');
    assert.strictEqual(rec!.eventsAfterSnapshot.length, 1);
  });

  it('recover throws if events exist but no snapshot', async () => {
    const mgr = new CheckpointManager(new InMemorySagaStore());
    await mgr.appendEvent(makeEvent('r1', 'begin'));
    await assert.rejects(mgr.recover('r1'), CheckpointError);
  });

  it('createSnapshot increments version on subsequent calls', () => {
    const mgr = new CheckpointManager(new InMemorySagaStore());
    const first = mgr.createSnapshot({
      runId: 'r1',
      state: 'EXECUTING' as const,
      intentHash: 'h',
      fencingEpoch: 1,
      nodeStates: { a: 'completed' as const },
    });
    const second = mgr.createSnapshot({
      runId: 'r1',
      state: 'EXECUTING' as const,
      intentHash: 'h',
      fencingEpoch: 1,
      nodeStates: { a: 'completed' as const, b: 'running' as const },
      previous: first,
    });
    assert.strictEqual(first.checkpointVersion, 1);
    assert.strictEqual(second.checkpointVersion, 2);
    assert.strictEqual(second.createdAt, first.createdAt);
  });

  it('deleteRun removes snapshot and events', async () => {
    const mgr = new CheckpointManager(new InMemorySagaStore());
    await mgr.saveSnapshot(makeSnapshot('r1'));
    await mgr.appendEvent(makeEvent('r1', 'begin'));
    await mgr.deleteRun('r1');
    const snap = await mgr.loadSnapshot('r1');
    const events = await mgr.loadEvents('r1');
    assert.strictEqual(snap, undefined);
    assert.strictEqual(events.length, 0);
  });
});
