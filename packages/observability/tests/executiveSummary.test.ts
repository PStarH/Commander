import { describe, it, expect, beforeEach } from 'vitest';
import type { TraceEvent, ExecutionTrace } from '@commander/core';
import { resetCostModel } from '../src/costModel';
import { buildExecutiveSummary } from '../src/executiveSummary';

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

function makeTrace(
  events: TraceEvent[] = [],
  overrides: Partial<ExecutionTrace> = {},
): ExecutionTrace {
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
    ...overrides,
  };
}

describe('buildExecutiveSummary', () => {
  beforeEach(() => {
    resetCostModel();
  });

  it('returns a summary with correct metadata', () => {
    const trace = makeTrace([makeEvent()]);
    const summary = buildExecutiveSummary(trace);
    expect(summary.runId).toBe('run-1');
    expect(summary.traceId).toBe('trace-1');
    expect(summary.status).toBe('success');
  });

  it('marks status as error when errors present', () => {
    const trace = makeTrace([makeEvent({ type: 'error', data: { error: 'fail' } })]);
    const summary = buildExecutiveSummary(trace);
    expect(summary.status).toBe('error');
  });

  it('counts LLM calls and tool calls', () => {
    const trace = makeTrace([
      makeEvent({ type: 'llm_call', data: {} }),
      makeEvent({ type: 'llm_call', data: {} }),
      makeEvent({ type: 'tool_execution', data: { input: 'web_search' } }),
    ]);
    const summary = buildExecutiveSummary(trace);
    expect(summary.llmCalls).toBe(2);
    expect(summary.toolCalls).toBe(1);
    expect(summary.toolsUsed).toContain('web_search');
  });

  it('tracks models used', () => {
    const trace = makeTrace([
      makeEvent({
        type: 'llm_call',
        data: { modelInfo: { model: 'gpt-4o', provider: 'openai', tier: 'standard' } },
      }),
    ]);
    const summary = buildExecutiveSummary(trace);
    expect(summary.modelsUsed).toContain('gpt-4o');
  });

  it('generates highlights for high tool usage', () => {
    const events = Array.from({ length: 15 }, (_, i) =>
      makeEvent({ type: 'tool_execution', data: { input: `tool${i}` } }),
    );
    const trace = makeTrace(events);
    const summary = buildExecutiveSummary(trace);
    expect(summary.highlights.some((h) => h.includes('High tool usage'))).toBe(true);
  });

  it('generates narrative with cost and tokens', () => {
    const trace = makeTrace([makeEvent()]);
    const summary = buildExecutiveSummary(trace);
    expect(summary.narrative).toContain('run-1');
    expect(summary.narrative).toContain('Duration');
  });

  it('builds timeline events', () => {
    const trace = makeTrace([
      makeEvent({
        type: 'llm_call',
        data: { modelInfo: { model: 'gpt-4o', provider: 'openai', tier: 'standard' } },
      }),
      makeEvent({ type: 'tool_execution', data: { input: 'tool1' } }),
    ]);
    const summary = buildExecutiveSummary(trace);
    expect(summary.timeline).toHaveLength(2);
    expect(summary.timeline[0]!.label).toContain('LLM');
    expect(summary.timeline[1]!.label).toContain('Tool');
  });
});
