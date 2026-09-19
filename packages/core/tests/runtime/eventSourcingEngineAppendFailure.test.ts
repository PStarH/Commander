/**
 * Regression for RCH-02: a WAL append that fails must NOT resolve as success,
 * and must not corrupt the in-memory hot window or the hash chain.
 *
 * The defect: `append()` rolled back only `this.events.length`, but `pushHot()`
 * `shift()`s the evicted head at capacity, so the rollback could not restore
 * the previous head. Worse, the rejected append still returned the freshly
 * generated event to its caller — an unpersisted event presented as durable.
 *
 * Failure injection is real, not mocked: the WAL path is replaced by a
 * directory, so `fs.promises.appendFile` fails with EISDIR.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  EventSourcingEngine,
  resetGlobalEventSourcingEngine,
} from '../../src/runtime/eventSourcingEngine';

describe('EventSourcingEngine — rejected WAL append is fail-closed', () => {
  let tmpDir: string;

  afterEach(async () => {
    await resetGlobalEventSourcingEngine();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('rejects instead of resolving when the durable append fails', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-appendfail-'));
    const blockedWal = path.join(tmpDir, 'blocked.wal');
    fs.mkdirSync(blockedWal);

    const engine = new EventSourcingEngine({ walPath: blockedWal });
    await engine.init();

    await assert.rejects(
      engine.append({ type: 'test.event', correlationId: 'run-a', payload: { i: 1 } }),
      /EISDIR|illegal operation on a directory|directory/i,
    );

    // A rejected write must publish nothing: no count, no replayable event.
    assert.equal(engine.getEventCount(), 0);
    assert.equal(engine.getEventsByCorrelationId('run-a').length, 0);
  });

  it('preserves the hot-window head and the chain across a rejected append', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-appendfail-'));
    const walPath = path.join(tmpDir, 'events.wal');

    // hotWindowSize 1 makes the head-eviction path (pushHot.shift) reachable.
    const engine = new EventSourcingEngine({ walPath, hotWindowSize: 1 });
    await engine.init();

    const first = await engine.append({
      type: 'test.event',
      correlationId: 'run-a',
      payload: { seq: 1 },
    });
    const durableBytes = fs.readFileSync(walPath);

    // Turn the WAL path into a directory so the next append fails for real.
    fs.rmSync(walPath);
    fs.mkdirSync(walPath);
    await assert.rejects(
      engine.append({ type: 'test.event', correlationId: 'run-a', payload: { seq: 2 } }),
    );

    // The rejected event must not have evicted the retained head.
    assert.equal(engine.getEventCount(), 1);
    const retained = engine.getEventsByCorrelationId('run-a');
    assert.equal(retained.length, 1);
    assert.equal(retained[0].id, first.id);
    assert.deepEqual(retained[0].payload, { seq: 1 });

    // Restore a writable WAL and prove the serialising lock survived the failure
    // and that the hash chain still extends from the durable head — not from the
    // rejected phantom event.
    fs.rmdirSync(walPath);
    fs.writeFileSync(walPath, durableBytes);
    const third = await engine.append({
      type: 'test.event',
      correlationId: 'run-a',
      payload: { seq: 3 },
    });

    assert.equal(engine.getEventCount(), 2);
    assert.notEqual(third.id, first.id);
    assert.equal(await engine.verifyIntegrity(), true);
  });

  it('still appends normally to an in-memory engine with no WAL path', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-appendfail-'));
    const engine = new EventSourcingEngine();
    await engine.init();

    const event = await engine.append({
      type: 'test.event',
      correlationId: 'run-mem',
      payload: { i: 1 },
    });
    assert.ok(event.id);
    assert.equal(engine.getEventCount(), 1);
    assert.equal(engine.getEventsByCorrelationId('run-mem').length, 1);
  });
});
