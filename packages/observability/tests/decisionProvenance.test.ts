import { describe, it, expect } from 'vitest';
import type { TraceEvent, ExecutionTrace } from '@commander/core';
import { buildDecisions, decisionsSummary } from '../src/decisionProvenance';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `evt_${Date.now()}_${Math.random()}`,
    spanId: `span_${Date.now()}_${Math.random()}`,
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'agent-1',
    type: 'llm_call',
    timestamp: new Date().toISOString(),
    durationMs: 100,
    data: {},
    ...overrides,
  };
}

function makeTrace(events: TraceEvent[] = []): ExecutionTrace {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
    startedAt: new Date().toISOString(),
    completedAt: new Date(Date.now() + 1000).toISOString(),
    events,
    summary: {
      totalEvents: events.length,
      totalDurationMs: events.reduce((s, e) => s + e.durationMs, 0),
      totalTokens: 0,
      llmCalls: events.filter((e) => e.type === 'llm_call').length,
      toolExecutions: events.filter((e) => e.type === 'tool_execution').length,
      errors: events.filter((e) => e.type === 'error').length,
      modelUsed: '',
    },
  };
}

describe('buildDecisions', () => {
  it('returns empty array for no tool executions', () => {
    const trace = makeTrace([makeEvent({ type: 'llm_call', data: {} })]);
    expect(buildDecisions(trace)).toHaveLength(0);
  });

  it('builds decisions from tool executions', () => {
    const llmEvent = makeEvent({
      spanId: 'llm-1',
      type: 'llm_call',
      timestamp: '2024-01-01T00:00:00.000Z',
      data: { output: 'I will use web_search' },
    });
    const toolEvent = makeEvent({
      spanId: 'tool-1',
      type: 'tool_execution',
      timestamp: '2024-01-01T00:00:01.000Z',
      data: { input: 'web_search', toolName: 'web_search' },
    });
    const trace = makeTrace([llmEvent, toolEvent]);
    const decisions = buildDecisions(trace);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.toolName).toBe('web_search');
    expect(decisions[0]!.decisionReason).toBe('I will use web_search');
    expect(decisions[0]!.llmSpanId).toBe('llm-1');
  });

  it('computes thinkDurationMs from preceding LLM call', () => {
    const llmEvent = makeEvent({
      spanId: 'llm-1',
      type: 'llm_call',
      timestamp: '2024-01-01T00:00:00.000Z',
      data: {},
    });
    const toolEvent = makeEvent({
      spanId: 'tool-1',
      type: 'tool_execution',
      timestamp: '2024-01-01T00:00:02.500Z',
      data: { input: 'tool1' },
    });
    const trace = makeTrace([llmEvent, toolEvent]);
    const decisions = buildDecisions(trace);
    expect(decisions[0]!.thinkDurationMs).toBe(2500);
  });

  it('handles tool execution with no preceding LLM call', () => {
    const toolEvent = makeEvent({
      spanId: 'tool-1',
      type: 'tool_execution',
      data: { input: 'tool1' },
    });
    const trace = makeTrace([toolEvent]);
    const decisions = buildDecisions(trace);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decisionReason).toBe('no preceding LLM call captured');
    expect(decisions[0]!.thinkDurationMs).toBe(0);
  });
});

describe('decisionsSummary', () => {
  it('returns empty summary for no decisions', () => {
    const summary = decisionsSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.avgThinkMs).toBe(0);
    expect(summary.byTool).toHaveLength(0);
  });

  it('computes summary statistics', () => {
    const decisions = [
      { thinkDurationMs: 100, toolName: 'tool1' },
      { thinkDurationMs: 200, toolName: 'tool1' },
      { thinkDurationMs: 300, toolName: 'tool2' },
    ] as ReturnType<typeof buildDecisions>;
    const summary = decisionsSummary(decisions);
    expect(summary.total).toBe(3);
    expect(summary.avgThinkMs).toBe(200);
    expect(summary.p95ThinkMs).toBe(200);
    expect(summary.byTool).toHaveLength(2);
    const tool1Stats = summary.byTool.find((t) => t.tool === 'tool1');
    expect(tool1Stats?.count).toBe(2);
    expect(tool1Stats?.avgThinkMs).toBe(150);
  });
});
