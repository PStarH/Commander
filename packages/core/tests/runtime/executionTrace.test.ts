import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { ExecutionTraceRecorder, resetTraceRecorder } from '../../src/runtime/executionTrace';

describe('ExecutionTraceRecorder', () => {
  let tracer: ExecutionTraceRecorder;

  before(() => {
    resetTraceRecorder();
    tracer = new ExecutionTraceRecorder(100);
  });

  it('starts and completes a run', () => {
    tracer.startRun('run-1', 'agent-1', 'mission-1');
    const trace = tracer.completeRun('run-1');
    expect(trace.runId).toBe('run-1');
    expect(trace.agentId).toBe('agent-1');
    expect(trace.missionId).toBe('mission-1');
    expect(trace.completedAt).toBeTruthy();
    expect(trace.startedAt).toBeTruthy();
  });

  it('records LLM call events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordLLMCall('run-1', 'gpt-4', 'openai', 'power', 'input', 'output', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 200);
    const trace = tracer.completeRun('run-1');
    expect(trace.summary.llmCalls).toBe(1);
    expect(trace.summary.totalTokens).toBe(150);
    expect(trace.summary.modelUsed).toBe('gpt-4');
    expect(trace.events[0].type).toBe('llm_call');
  });

  it('records tool execution events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordToolExecution('run-1', 'search', { q: 'test' }, 'results', 150);
    const trace = tracer.completeRun('run-1');
    expect(trace.summary.toolExecutions).toBe(1);
    expect(trace.events[0].type).toBe('tool_execution');
  });

  it('records decision events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordDecision('run-1', 'selected routing tier: eco', 0);
    const trace = tracer.completeRun('run-1');
    expect(trace.events[0].type).toBe('decision');
    expect(trace.events[0].data.output).toBe('selected routing tier: eco');
  });

  it('records error events', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordError('run-1', 'LLM call timed out', 5000);
    const trace = tracer.completeRun('run-1');
    expect(trace.summary.errors).toBe(1);
    expect(trace.events[0].type).toBe('error');
  });

  it('lists traces newest first', async () => {
    tracer.startRun('run-1', 'agent-1');
    await new Promise(r => setTimeout(r, 5));
    tracer.completeRun('run-1');
    await new Promise(r => setTimeout(r, 5));
    tracer.startRun('run-2', 'agent-1');
    tracer.completeRun('run-2');
    const list = tracer.listTraces();
    expect(list[0].runId).toBe('run-2');
  });

  it('filters traces by agent', () => {
    tracer.startRun('run-a1', 'agent-a');
    tracer.completeRun('run-a1');
    tracer.startRun('run-b1', 'agent-b');
    tracer.completeRun('run-b1');
    const agentA = tracer.listTraces('agent-a');
    expect(agentA.length).toBe(1);
    expect(agentA[0].agentId).toBe('agent-a');
  });

  it('provides summary statistics', () => {
    tracer.startRun('run-1', 'agent-1');
    tracer.recordLLMCall('run-1', 'gpt-4', 'openai', 'power', 'in', 'out', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 200);
    tracer.recordLLMCall('run-1', 'gpt-4', 'openai', 'power', 'in2', 'out2', { promptTokens: 50, completionTokens: 25, totalTokens: 75 }, 100);
    tracer.recordToolExecution('run-1', 'search', { q: 'test' }, 'results', 50);
    tracer.recordError('run-1', 'minor issue', 10);
    tracer.completeRun('run-1');

    const summary = tracer.getSummary();
    expect(summary.totalTraces).toBe(1);
    expect(summary.totalLLMCalls).toBe(2);
    expect(summary.totalTokens).toBe(225);
    expect(summary.totalErrors).toBe(1);
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
    expect(smallTracer.listTraces().length).toBeGreaterThanOrEqual(2);
  });

  it('throws when recording to non-existent run', () => {
    expect(() => tracer.recordLLMCall('no-such-run', 'gpt-4', 'openai', 'standard', 'in', 'out', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 0)).toThrow();
  });

  it('supports nested traces with parentId', () => {
    tracer.startRun('run-1', 'agent-1');
    const parent = tracer.recordLLMCall('run-1', 'gpt-4', 'openai', 'standard', 'in', 'out', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 100);
    const child = tracer.recordToolExecution('run-1', 'search', { q: 'test' }, 'results', 50, undefined, parent.id);
    expect(child.parentId).toBe(parent.id);
  });
});
