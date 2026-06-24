import { describe, it, expect } from 'vitest';
import { PromptVersionTracker } from '../src/promptVersioning';
import type { TraceEvent } from '@commander/core';

function makeLlmEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `evt_${Date.now()}_${Math.random()}`,
    spanId: `span_${Date.now()}_${Math.random()}`,
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'agent-1',
    type: 'llm_call',
    timestamp: new Date().toISOString(),
    durationMs: 100,
    data: {
      input: { messages: 'Hello, how are you?' },
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    },
    ...overrides,
  };
}

function makeTrace(events: TraceEvent[] = []) {
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

describe('PromptVersionTracker', () => {
  it('records LLM events', () => {
    const tracker = new PromptVersionTracker();
    tracker.recordEvent(makeLlmEvent());
    const versions = tracker.getAllVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.runCount).toBe(1);
  });

  it('groups same prompts into same version', () => {
    const tracker = new PromptVersionTracker();
    tracker.recordEvent(makeLlmEvent({ spanId: 's1' }));
    tracker.recordEvent(makeLlmEvent({ spanId: 's2' }));
    expect(tracker.getAllVersions()).toHaveLength(1);
    expect(tracker.getAllVersions()[0]!.runCount).toBe(2);
  });

  it('creates separate versions for different prompts', () => {
    const tracker = new PromptVersionTracker();
    tracker.recordEvent(makeLlmEvent({ spanId: 's1', data: { input: { messages: 'Hello' } } }));
    tracker.recordEvent(makeLlmEvent({ spanId: 's2', data: { input: { messages: 'Goodbye' } } }));
    expect(tracker.getAllVersions()).toHaveLength(2);
  });

  it('ignores non-LLM events', () => {
    const tracker = new PromptVersionTracker();
    tracker.recordEvent({
      id: 'evt-1',
      spanId: 's1',
      traceId: 'trace-1',
      runId: 'run-1',
      agentId: 'agent-1',
      type: 'tool_execution',
      timestamp: new Date().toISOString(),
      durationMs: 100,
      data: { input: 'tool1' },
    });
    expect(tracker.getAllVersions()).toHaveLength(0);
  });

  it('recordFromTrace records all LLM events', () => {
    const tracker = new PromptVersionTracker();
    const events = [
      makeLlmEvent({ spanId: 's1' }),
      makeLlmEvent({ spanId: 's2' }),
      makeLlmEvent({ spanId: 's3', data: { input: { messages: 'Different' } } }),
    ];
    tracker.recordFromTrace(makeTrace(events));
    expect(tracker.getAllVersions()).toHaveLength(2);
  });

  it('getVersionForEvent returns version', () => {
    const tracker = new PromptVersionTracker();
    tracker.recordEvent(makeLlmEvent({ spanId: 's1' }));
    const version = tracker.getVersionForEvent('s1');
    expect(version).toBeDefined();
    expect(version!.runCount).toBe(1);
  });

  it('compareVersions computes similarity', () => {
    const tracker = new PromptVersionTracker();
    tracker.recordEvent(makeLlmEvent({ spanId: 's1', data: { input: { messages: 'Hello world' } } }));
    tracker.recordEvent(makeLlmEvent({ spanId: 's2', data: { input: { messages: 'Hello world!' } } }));
    const versions = tracker.getAllVersions();
    const diff = tracker.compareVersions(versions[0]!.versionId, versions[1]!.versionId);
    expect(diff).toBeDefined();
    expect(diff!.similarity).toBeGreaterThan(0.8);
  });

  it('getSummary returns correct stats', () => {
    const tracker = new PromptVersionTracker();
    tracker.recordFromTrace(makeTrace([
      makeLlmEvent({ spanId: 's1' }),
      makeLlmEvent({ spanId: 's2' }),
    ]));
    const summary = tracker.getSummary();
    expect(summary.totalVersions).toBe(1);
    expect(summary.totalEvents).toBe(2);
    expect(summary.mostUsedVersion).toBeDefined();
  });
});
