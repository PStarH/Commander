/**
 * Regression for RCH-09 / RCH-10 (ExecutionTraceRecorder):
 *
 * RCH-09 — `recordToolExecution` accepted a `toolName` and dropped it, while
 *   `sopExport.extractToolName` reads the name from `data.toolCallId`. Ordinary
 *   `{path: ...}` file-write traces were therefore unidentified and every file
 *   access was classified as a read.
 *
 * RCH-10 — `evictOldestCompleted` examined only the head of the insertion order
 *   and `break`ed when that head was still active, so ONE long-running run
 *   disabled eviction for every later completed run and the tracer grew without
 *   bound.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionTraceRecorder } from '../../src/runtime/executionTrace';

describe('ExecutionTraceRecorder — tool identity (RCH-09)', () => {
  it('stores the tool name where consumers read it', () => {
    const tracer = new ExecutionTraceRecorder(10);
    tracer.startRun('run-1', 'agent-1');
    tracer.recordToolExecution('run-1', 'file_write', { path: 'a.txt' }, 'ok', 5);

    const trace = tracer.getTrace('run-1');
    assert.ok(trace);
    const event = trace.events.find((e) => e.type === 'tool_execution');
    assert.ok(event, 'a tool_execution event must be recorded');
    assert.equal(event.data.toolCallId, 'file_write');
  });

  it('keeps the name distinct per tool call', () => {
    const tracer = new ExecutionTraceRecorder(10);
    tracer.startRun('run-2', 'agent-1');
    tracer.recordToolExecution('run-2', 'file_read', { path: 'a.txt' }, 'contents', 1);
    tracer.recordToolExecution('run-2', 'file_write', { path: 'b.txt' }, 'ok', 2);

    const names = tracer
      .getTrace('run-2')!
      .events.filter((e) => e.type === 'tool_execution')
      .map((e) => e.data.toolCallId);
    assert.deepEqual(names, ['file_read', 'file_write']);
  });
});

describe('ExecutionTraceRecorder — eviction with an active oldest trace (RCH-10)', () => {
  it('evicts the oldest COMPLETED trace even when an older run is active', () => {
    const tracer = new ExecutionTraceRecorder(2);
    tracer.startRun('active-1', 'agent-1');
    tracer.startRun('done-1', 'agent-1');
    tracer.completeRun('done-1');
    tracer.startRun('done-2', 'agent-1');
    tracer.completeRun('done-2');
    tracer.startRun('done-3', 'agent-1');
    tracer.completeRun('done-3');

    assert.ok(tracer.getTrace('active-1'), 'an active trace must never be evicted');
    assert.equal(tracer.getTrace('done-1'), undefined, 'the oldest completed trace must go');
    assert.equal(tracer.getTrace('done-2'), undefined, 'the next completed trace must go');
    assert.ok(tracer.getTrace('done-3'), 'the newest completed trace is retained');
    assert.equal(tracer.listTraces(undefined, 100).length, 2);
  });

  it('never evicts when every trace is active', () => {
    const tracer = new ExecutionTraceRecorder(1);
    tracer.startRun('a', 'agent-1');
    tracer.startRun('b', 'agent-1');
    tracer.startRun('c', 'agent-1');

    for (const runId of ['a', 'b', 'c']) {
      assert.ok(tracer.getTrace(runId), `${runId} must survive while active`);
    }
  });
});
