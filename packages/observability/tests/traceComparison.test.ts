import { describe, it, expect, beforeEach } from 'vitest';
import type { TraceEvent, ExecutionTrace } from '@commander/core';
import { compareTraces } from '../src/traceComparison';
import { resetCostModel } from '../src/costModel';

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

function makeTrace(events: TraceEvent[] = [], runId = 'run-1'): ExecutionTrace {
  return {
    runId,
    traceId: `trace-${runId}`,
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

describe('compareTraces', () => {
  beforeEach(() => {
    resetCostModel();
  });

  it('detects identical traces', () => {
    const event = makeEvent({ spanId: 's1', type: 'llm_call', data: {} });
    const traceA = makeTrace([event], 'run-A');
    const traceB = makeTrace([event], 'run-B');
    const comparison = compareTraces(traceA, traceB);
    expect(comparison.summary.unchanged).toBe(1);
    expect(comparison.summary.added).toBe(0);
    expect(comparison.summary.removed).toBe(0);
  });

  it('detects added events', () => {
    const traceA = makeTrace([], 'run-A');
    const traceB = makeTrace([makeEvent({ spanId: 's1' })], 'run-B');
    const comparison = compareTraces(traceA, traceB);
    expect(comparison.summary.added).toBe(1);
  });

  it('detects removed events', () => {
    const traceA = makeTrace([makeEvent({ spanId: 's1' })], 'run-A');
    const traceB = makeTrace([], 'run-B');
    const comparison = compareTraces(traceA, traceB);
    expect(comparison.summary.removed).toBe(1);
  });

  it('detects modified events', () => {
    const traceA = makeTrace(
      [
        makeEvent({
          spanId: 's1',
          type: 'llm_call',
          data: { tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
        }),
      ],
      'run-A',
    );
    const traceB = makeTrace(
      [
        makeEvent({
          spanId: 's1',
          type: 'llm_call',
          data: { tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } },
        }),
      ],
      'run-B',
    );
    const comparison = compareTraces(traceA, traceB);
    expect(comparison.summary.modified).toBe(1);
    expect(comparison.eventDiffs[0]!.changes).toBeDefined();
  });

  it('computes cost delta', () => {
    const traceA = makeTrace(
      [
        makeEvent({
          type: 'llm_call',
          data: {
            modelInfo: { model: 'gpt-4o', provider: 'openai', tier: 'standard' },
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          },
        }),
      ],
      'run-A',
    );
    const traceB = makeTrace(
      [
        makeEvent({
          type: 'llm_call',
          data: {
            modelInfo: { model: 'gpt-4o', provider: 'openai', tier: 'standard' },
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          },
        }),
      ],
      'run-B',
    );
    const comparison = compareTraces(traceA, traceB);
    expect(comparison.costDelta.totalCostA).toBeGreaterThan(0);
    expect(comparison.costDelta.totalCostB).toBeGreaterThan(0);
  });
});
