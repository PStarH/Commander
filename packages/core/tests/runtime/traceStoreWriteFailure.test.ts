/**
 * RC-05 — a failed trace-buffer write must retain the batch, surface the
 * failure, and never treat an unpersisted event as persisted.
 *
 * node:test file (auto-discovered by packages/core/scripts/run-node-tests.mjs);
 * the vitest half of the suite is unaffected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PersistentTraceStore } from '../../src/runtime/traceStore';
import type { TraceEvent } from '../../src/runtime/types';

function makeEvent(runId: string, seq: number): TraceEvent {
  return {
    id: `${runId}-${seq}`,
    spanId: `span-${seq}`,
    traceId: `trace-${runId}`,
    runId,
    agentId: 'agent-test',
    type: 'state_change',
    timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
    durationMs: seq,
    data: { output: seq },
  };
}

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-failure-'));
}

function readEvents(filePath: string): TraceEvent[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

describe('PersistentTraceStore write-failure durability (RC-05)', () => {
  it('retains the buffer and surfaces the failure when the append fails', () => {
    const base = tempBase();
    try {
      const store = new PersistentTraceStore(base);
      const runId = 'run-retain';
      // A directory where the ndjson file belongs makes every append fail with
      // EISDIR — a real write error, no fs mocking.
      fs.mkdirSync(path.join(base, `${runId}.ndjson`));

      store.append(makeEvent(runId, 1));
      store.append(makeEvent(runId, 2));
      assert.equal(store.getBufferCount(runId), 2);

      assert.throws(() => store.flush(runId), /EISDIR|illegal operation on a directory/i);
      assert.equal(store.getBufferCount(runId), 2, 'uncommitted events must stay buffered');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('writes the retained events exactly once after a later successful flush', () => {
    const base = tempBase();
    try {
      const store = new PersistentTraceStore(base);
      const runId = 'run-retry';
      const filePath = path.join(base, `${runId}.ndjson`);
      fs.mkdirSync(filePath);

      store.append(makeEvent(runId, 1));
      store.append(makeEvent(runId, 2));
      assert.throws(() => store.flush(runId));

      // Clear the obstruction: the retained batch must now reach disk.
      fs.rmdirSync(filePath);
      store.flush(runId);

      assert.deepEqual(
        readEvents(filePath).map((event) => event.data.output),
        [1, 2],
      );
      assert.equal(store.getBufferCount(runId), 0);

      // A second flush must not replay anything.
      store.flush(runId);
      assert.equal(readEvents(filePath).length, 2);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps events appended during an in-flight async flush', async () => {
    const base = tempBase();
    try {
      const store = new PersistentTraceStore(base);
      const runId = 'run-inflight';
      const filePath = path.join(base, `${runId}.ndjson`);

      store.append(makeEvent(runId, 1));
      store.append(makeEvent(runId, 2));

      const inFlight = store.flushAsync(runId);
      // Appended after the drain snapshotted its batch, before it committed:
      // a correct drain deletes only the events it actually wrote.
      store.append(makeEvent(runId, 3));
      await inFlight;

      assert.equal(store.getBufferCount(runId), 1, 'event 3 must stay buffered');

      await store.flushAsync(runId);
      assert.deepEqual(
        readEvents(filePath).map((event) => event.data.output),
        [1, 2, 3],
      );
      assert.equal(store.getBufferCount(runId), 0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects an async flush that fails and still writes the batch on retry', async () => {
    const base = tempBase();
    try {
      const store = new PersistentTraceStore(base);
      const runId = 'run-async-retry';
      const filePath = path.join(base, `${runId}.ndjson`);
      fs.mkdirSync(filePath);

      store.append(makeEvent(runId, 1));
      store.append(makeEvent(runId, 2));
      await assert.rejects(() => store.flushAsync(runId), /EISDIR|illegal operation/i);
      assert.equal(store.getBufferCount(runId), 2);

      fs.rmdirSync(filePath);
      await store.flushAsync(runId);

      assert.deepEqual(
        readEvents(filePath).map((event) => event.data.output),
        [1, 2],
      );
      assert.equal(store.getBufferCount(runId), 0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
