import { describe, it, expect, beforeEach } from 'vitest';
import type { TraceEvent, ExecutionTrace } from '@commander/core';
import { resetCostModel } from '../src/costModel';
import { dryReplay } from '../src/replay';
import type { ReplaySpec } from '../src/types';

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

describe('dryReplay', () => {
  beforeEach(() => {
    resetCostModel();
  });

  it('returns a replay result with no changes', () => {
    const trace = makeTrace([makeEvent()]);
    const spec: ReplaySpec = {
      runId: 'run-1',
      substitutions: [],
      reExecuteLlm: false,
    };
    const result = dryReplay(trace, spec);
    expect(result.runId).toBe('run-1');
    expect(result.diff.changedSpans).toBe(0);
    expect(result.diff.newSpans).toBe(0);
  });

  it('applies tool_output substitution', () => {
    const spanId = 'tool-span-1';
    const trace = makeTrace([
      makeEvent({
        spanId,
        type: 'tool_execution',
        data: { input: 'tool1', output: 'original output' },
      }),
    ]);
    const spec: ReplaySpec = {
      runId: 'run-1',
      substitutions: [{ target: 'tool_output', spanId, value: 'new output' }],
      reExecuteLlm: false,
    };
    const result = dryReplay(trace, spec);
    expect(result.diff.changedSpans).toBe(1);
  });

  it('applies llm_response substitution', () => {
    const spanId = 'llm-span-1';
    const trace = makeTrace([
      makeEvent({
        spanId,
        type: 'llm_call',
        data: { output: 'original reasoning' },
      }),
    ]);
    const spec: ReplaySpec = {
      runId: 'run-1',
      substitutions: [{ target: 'llm_response', spanId, value: 'new reasoning' }],
      reExecuteLlm: false,
    };
    const result = dryReplay(trace, spec);
    expect(result.diff.changedSpans).toBe(1);
  });

  it('computes cost and token deltas', () => {
    const trace = makeTrace([makeEvent()]);
    const spec: ReplaySpec = {
      runId: 'run-1',
      substitutions: [],
      reExecuteLlm: false,
    };
    const result = dryReplay(trace, spec);
    expect(result.diff.costDeltaUsd).toBe(0);
    expect(result.diff.tokenDelta).toBe(0);
  });
});
