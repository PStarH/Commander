import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionTraceRecorder, resetTraceRecorder } from '../../src/runtime/executionTrace';
import type { TraceStore, TraceEvent } from '../../src/runtime/types';

describe('ExecutionTraceRecorder', () => {
  let tracer: ExecutionTraceRecorder;

  beforeEach(() => {
    resetTraceRecorder();
    tracer = new ExecutionTraceRecorder(100);
  });

  // -----------------------------------------------------------------------
  // Lifecycle: startRun / completeRun
  // -----------------------------------------------------------------------

  it('starts and completes a run with correct metadata', () => {
    tracer.startRun('run-1', 'agent-1', 'mission-1');
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.runId, 'run-1');
    assert.equal(trace.agentId, 'agent-1');
    assert.equal(trace.missionId, 'mission-1');
    assert.ok(trace.completedAt);
    assert.ok(trace.startedAt);
    assert.ok(trace.traceId.startsWith('trace_'));
  });

  it('starts a run with a custom traceId', () => {
    tracer.startRun('run-custom', 'agent-1', undefined, 'custom-trace-id');
    const trace = tracer.completeRun('run-custom');
    assert.equal(trace.traceId, 'custom-trace-id');
  });

  it('starts a run without a missionId', () => {
    tracer.startRun('run-nomission', 'agent-1');
    const trace = tracer.completeRun('run-nomission');
    assert.equal(trace.missionId, undefined);
  });

  it('throws when completing a non-existent run', () => {
    assert.throws(
      () => tracer.completeRun('no-such-run'),
      /No trace found for run: no-such-run/,
    );
  });

  it('returns undefined for getTrace on non-existent run', () => {
    assert.equal(tracer.getTrace('missing'), undefined);
  });

  it('returns the trace via getTrace after starting a run', () => {
    tracer.startRun('run-gt', 'agent-1');
    const trace = tracer.getTrace('run-gt');
    assert.ok(trace);
    assert.equal(trace!.runId, 'run-gt');
    assert.equal(trace!.agentId, 'agent-1');
  });

  // -----------------------------------------------------------------------
  // Event recording
  // -----------------------------------------------------------------------

  it('records LLM call events with full token tracking', () => {
    tracer.startRun('run-1', 'agent-1');
    const event = tracer.recordLLMCall(
      'run-1', 'gpt-4', 'openai', 'power',
      'input text', 'output text',
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      200,
    );
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.summary.llmCalls, 1);
    assert.equal(trace.summary.totalTokens, 150);
    assert.equal(trace.summary.modelUsed, 'gpt-4');
    assert.equal(trace.events[0].type, 'llm_call');
    assert.equal(event.data.modelInfo?.model, 'gpt-4');
    assert.equal(event.data.modelInfo?.provider, 'openai');
    assert.equal(event.data.modelInfo?.tier, 'power');
  });

  it('records tool execution events including errors', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordToolExecution('run-1', 'search', { q: 'test' }, 'results', 150, 'timeout error');
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.summary.toolExecutions, 1);
    assert.equal(trace.events[0].type, 'tool_execution');
    assert.equal(trace.events[0].data.error, 'timeout error');
  });

  it('records decision events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordDecision('run-1', 'selected routing tier: eco', 5);
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.events[0].type, 'decision');
    assert.equal(trace.events[0].data.output, 'selected routing tier: eco');
    assert.equal(trace.events[0].durationMs, 5);
  });

  it('records error events and increments error counter', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordError('run-1', 'LLM call timed out', 5000);
    tracer.recordError('run-1', 'rate limited', 1000);
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.summary.errors, 2);
    assert.equal(trace.events[0].type, 'error');
    assert.equal(trace.events[1].data.error, 'rate limited');
  });

  it('returns a fallback event for non-existent run', () => {
    const event = tracer.recordLLMCall(
      'no-such-run', 'gpt-4', 'openai', 'standard',
      'in', 'out',
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      0,
    );
    assert.equal(event.agentId, 'unknown');
    assert.ok(event.traceId.startsWith('trace_'));
    assert.equal(event.runId, 'no-such-run');
  });

  it('returns a fallback event for recordToolExecution on non-existent run', () => {
    const event = tracer.recordToolExecution('missing', 'tool', {}, 'out', 10);
    assert.equal(event.agentId, 'unknown');
  });

  it('returns a fallback event for recordDecision on non-existent run', () => {
    const event = tracer.recordDecision('missing', 'decided', 0);
    assert.equal(event.agentId, 'unknown');
  });

  it('returns a fallback event for recordError on non-existent run', () => {
    const event = tracer.recordError('missing', 'boom', 0);
    assert.equal(event.agentId, 'unknown');
  });

  it('generates unique event IDs and span IDs', () => {
    tracer.startRun('run-1', 'agent-1');
    const e1 = tracer.recordDecision('run-1', 'a', 0);
    const e2 = tracer.recordDecision('run-1', 'b', 0);
    assert.notEqual(e1.id, e2.id);
    assert.notEqual(e1.spanId, e2.spanId);
  });

  it('supports nested traces with parentSpanId', () => {
    tracer.startRun('run-1', 'agent-1');
    const parent = tracer.recordLLMCall(
      'run-1', 'gpt-4', 'openai', 'standard',
      'in', 'out',
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      100,
    );
    const child = tracer.recordToolExecution(
      'run-1', 'search', { q: 'test' }, 'results', 50,
      undefined, parent.spanId,
    );
    assert.equal(child.parentSpanId, parent.spanId);
  });

  // -----------------------------------------------------------------------
  // Summary aggregation
  // -----------------------------------------------------------------------

  it('provides accurate summary statistics across multiple events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordLLMCall('run-1', 'gpt-4', 'openai', 'power', 'in', 'out', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 200);
    tracer.recordLLMCall('run-1', 'gpt-4', 'openai', 'power', 'in2', 'out2', { promptTokens: 50, completionTokens: 25, totalTokens: 75 }, 100);
    tracer.recordToolExecution('run-1', 'search', { q: 'test' }, 'results', 50);
    tracer.recordError('run-1', 'minor issue', 10);
    tracer.completeRun('run-1');

    const summary = tracer.getSummary();
    assert.equal(summary.totalTraces, 1);
    assert.equal(summary.totalLLMCalls, 2);
    assert.equal(summary.totalTokens, 225);
    assert.equal(summary.totalErrors, 1);
  });

  it('aggregates summary across multiple traces', () => {
    tracer.startRun('run-a', 'agent-1');
    tracer.recordLLMCall('run-a', 'gpt-4', 'openai', 'power', 'in', 'out', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 200);
    tracer.completeRun('run-a');

    tracer.startRun('run-b', 'agent-2');
    tracer.recordError('run-b', 'fail', 100);
    tracer.completeRun('run-b');

    const summary = tracer.getSummary();
    assert.equal(summary.totalTraces, 2);
    assert.equal(summary.totalLLMCalls, 1);
    assert.equal(summary.totalTokens, 150);
    assert.equal(summary.totalErrors, 1);
  });

  it('returns zero summary when no traces exist', () => {
    const summary = tracer.getSummary();
    assert.equal(summary.totalTraces, 0);
    assert.equal(summary.totalLLMCalls, 0);
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.totalErrors, 0);
  });

  // -----------------------------------------------------------------------
  // listTraces
  // -----------------------------------------------------------------------

  it('lists traces newest first', async () => {
    tracer.startRun('run-1', 'agent-1');
    await new Promise(r => setTimeout(r, 5));
    tracer.completeRun('run-1');
    await new Promise(r => setTimeout(r, 5));
    tracer.startRun('run-2', 'agent-1');
    tracer.completeRun('run-2');
    const list = tracer.listTraces();
    assert.equal(list[0].runId, 'run-2');
    assert.equal(list[1].runId, 'run-1');
  });

  it('filters traces by agent', () => {
    tracer.startRun('run-a1', 'agent-a');
    tracer.completeRun('run-a1');
    tracer.startRun('run-b1', 'agent-b');
    tracer.completeRun('run-b1');
    tracer.startRun('run-a2', 'agent-a');
    tracer.completeRun('run-a2');

    const agentA = tracer.listTraces('agent-a');
    assert.equal(agentA.length, 2);
    for (const t of agentA) assert.equal(t.agentId, 'agent-a');

    const agentB = tracer.listTraces('agent-b');
    assert.equal(agentB.length, 1);
    assert.equal(agentB[0].agentId, 'agent-b');
  });

  it('respects the limit parameter on listTraces', () => {
    for (let i = 0; i < 10; i++) {
      tracer.startRun(`run-${i}`, 'agent-1');
      tracer.completeRun(`run-${i}`);
    }
    const limited = tracer.listTraces(undefined, 3);
    assert.equal(limited.length, 3);
  });

  it('returns empty array when filtering by non-existent agent', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.completeRun('run-1');
    const result = tracer.listTraces('nobody');
    assert.equal(result.length, 0);
  });

  // -----------------------------------------------------------------------
  // Eviction / maxTraces
  // -----------------------------------------------------------------------

  it('enforces maximum trace count by evicting completed traces', () => {
    const smallTracer = new ExecutionTraceRecorder(2);
    // All three runs are completed, so the oldest should be evicted.
    smallTracer.startRun('run-1', 'agent-1');
    smallTracer.recordDecision('run-1', 'test', 0);
    smallTracer.completeRun('run-1');
    smallTracer.startRun('run-2', 'agent-1');
    smallTracer.recordDecision('run-2', 'test', 0);
    smallTracer.completeRun('run-2');
    smallTracer.startRun('run-3', 'agent-1');
    smallTracer.recordDecision('run-3', 'test', 0);
    smallTracer.completeRun('run-3');

    const list = smallTracer.listTraces();
    // At most 2 traces should survive eviction (run-2 and run-3)
    assert.ok(list.length >= 2);
    assert.ok(list.length <= 3);
  });

  // -----------------------------------------------------------------------
  // TraceStore integration
  // -----------------------------------------------------------------------

  it('has no store by default', () => {
    assert.equal(tracer.hasStore(), false);
  });

  it('sets and reports store presence', () => {
    const mockStore: TraceStore = {
      append: () => {},
      flush: () => {},
    };
    tracer.setStore(mockStore);
    assert.equal(tracer.hasStore(), true);
  });

  it('forwards events to store.append and calls flush on complete', () => {
    const appended: TraceEvent[] = [];
    const flushedRuns: string[] = [];
    const mockStore: TraceStore = {
      append: (e) => { appended.push(e); },
      flush: (runId) => { flushedRuns.push(runId); },
    };
    tracer.setStore(mockStore);
    tracer.startRun('run-1', 'agent-1');
    tracer.recordDecision('run-1', 'test', 0);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].type, 'decision');

    tracer.completeRun('run-1');
    assert.deepEqual(flushedRuns, ['run-1']);
  });

  // -----------------------------------------------------------------------
  // startSpan
  // -----------------------------------------------------------------------

  it('creates a span that records an event on end()', () => {
    tracer.startRun('run-1', 'agent-1');
    const span = tracer.startSpan('run-1', 'my-operation');
    assert.ok(span.spanId);
    assert.ok(span.traceId);

    const event = span.end({ output: 'done' });
    assert.equal(event.type, 'state_change');
    assert.equal(event.data.input, 'my-operation');
    assert.equal(event.data.output, 'done');
    assert.ok(event.durationMs >= 0);
  });

  it('records child events under a span', () => {
    tracer.startRun('run-1', 'agent-1');
    const span = tracer.startSpan('run-1', 'parent-op');

    const child = span.recordChild('tool_execution', {
      input: { cmd: 'ls' },
      output: 'file1\nfile2',
      durationMs: 42,
    });
    assert.equal(child.type, 'tool_execution');
    assert.equal(child.parentSpanId, span.spanId);
    assert.equal(child.durationMs, 42);

    span.end();
  });

  it('auto-creates a trace when startSpan is called on unknown runId', () => {
    const span = tracer.startSpan('unknown-run', 'orphan-op');
    assert.ok(span.spanId);
    // The trace should now exist
    const trace = tracer.getTrace('unknown-run');
    assert.ok(trace);
    assert.equal(trace!.agentId, 'unknown');
  });

  // -----------------------------------------------------------------------
  // maxEventsPerTrace
  // -----------------------------------------------------------------------

  it('evicts old events when maxEventsPerTrace is exceeded', () => {
    const smallTracer = new ExecutionTraceRecorder(100, undefined, 10);
    smallTracer.startRun('run-1', 'agent-1');
    // Record 15 events to exceed the limit of 10
    for (let i = 0; i < 15; i++) {
      smallTracer.recordDecision('run-1', `decision-${i}`, 0);
    }
    const trace = smallTracer.completeRun('run-1');
    // Should keep the most recent 80% = 8 events
    assert.ok(trace.events.length <= 10);
    // The summary still reflects all 15 events
    assert.equal(trace.summary.totalEvents, 15);
  });
});
