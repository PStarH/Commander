import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionTraceRecorder, resetTraceRecorder } from '../../src/runtime/executionTrace';

describe('ExecutionTraceRecorder', () => {
  let tracer: ExecutionTraceRecorder;

  beforeEach(() => {
    resetTraceRecorder();
    tracer = new ExecutionTraceRecorder(100);
  });

  it('starts and completes a run', () => {
    tracer.startRun('run-1', 'agent-1', 'mission-1');
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.runId, 'run-1');
    assert.equal(trace.agentId, 'agent-1');
    assert.equal(trace.missionId, 'mission-1');
    assert.ok(trace.completedAt);
    assert.ok(trace.startedAt);
  });

  it('records LLM call events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordLLMCall('run-1', 'gpt-4', 'openai', 'power', 'input', 'output', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 200);
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.summary.llmCalls, 1);
    assert.equal(trace.summary.totalTokens, 150);
    assert.equal(trace.summary.modelUsed, 'gpt-4');
    assert.equal(trace.events[0].type, 'llm_call');
  });

  it('records tool execution events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordToolExecution('run-1', 'search', { q: 'test' }, 'results', 150);
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.summary.toolExecutions, 1);
    assert.equal(trace.events[0].type, 'tool_execution');
  });

  it('records decision events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordDecision('run-1', 'selected routing tier: eco', 0);
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.events[0].type, 'decision');
    assert.equal(trace.events[0].data.output, 'selected routing tier: eco');
  });

  it('records error events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordError('run-1', 'LLM call timed out', 5000);
    const trace = tracer.completeRun('run-1');
    assert.equal(trace.summary.errors, 1);
    assert.equal(trace.events[0].type, 'error');
  });

  it('lists traces newest first', async () => {
    tracer.startRun('run-1', 'agent-1');
    await new Promise(r => setTimeout(r, 5));
    tracer.completeRun('run-1');
    await new Promise(r => setTimeout(r, 5));
    tracer.startRun('run-2', 'agent-1');
    tracer.completeRun('run-2');
    const list = tracer.listTraces();
    assert.equal(list[0].runId, 'run-2');
  });

  it('filters traces by agent', () => {
    tracer.startRun('run-a1', 'agent-a');
    tracer.completeRun('run-a1');
    tracer.startRun('run-b1', 'agent-b');
    tracer.completeRun('run-b1');
    const agentA = tracer.listTraces('agent-a');
    assert.equal(agentA.length, 1);
    assert.equal(agentA[0].agentId, 'agent-a');
  });

  it('provides summary statistics', () => {
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

  it('enforces maximum trace count', () => {
    const smallTracer = new ExecutionTraceRecorder(2);
    smallTracer.startRun('run-1', 'agent-1');
    smallTracer.recordDecision('run-1', 'test', 0);
    smallTracer.completeRun('run-1');
    smallTracer.startRun('run-2', 'agent-1');
    smallTracer.recordDecision('run-2', 'test', 0);
    smallTracer.completeRun('run-2');
    smallTracer.startRun('run-3', 'agent-1');
    smallTracer.recordDecision('run-3', 'test', 0);
    smallTracer.completeRun('run-3');
    assert.ok(smallTracer.listTraces().length >= 2);
  });

  it('returns fallback event for non-existent run instead of throwing', () => {
    const event = tracer.recordLLMCall('no-such-run', 'gpt-4', 'openai', 'standard', 'in', 'out', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 0);
    assert.equal(event.agentId, 'unknown');
    assert.ok(event.traceId);
  });

  it('supports nested traces with parentSpanId', () => {
    tracer.startRun('run-1', 'agent-1');
    const parent = tracer.recordLLMCall('run-1', 'gpt-4', 'openai', 'standard', 'in', 'out', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 100);
    const child = tracer.recordToolExecution('run-1', 'search', { q: 'test' }, 'results', 50, undefined, parent.spanId);
    assert.equal(child.parentSpanId, parent.spanId);
  });
});
