import { describe, it, expect } from 'vitest';
import { buildTimeline } from '../src/observability/timelineBuilder';
import { buildExecutiveSummary } from '../src/observability/executiveSummary';
import { TokenUsageAnomalyDetector, resetAnomalyDetector } from '../src/observability/anomalyDetector';
import type { ExecutionTrace, TraceEvent } from '../src/runtime/types';

function makeTrace(events: TraceEvent[]): ExecutionTrace {
  return {
    runId: 'run-1', traceId: 'trace-1', agentId: 'agent-1',
    startedAt: events[0]?.timestamp ?? '2026-06-05T00:00:00.000Z',
    events,
    summary: { totalEvents: events.length, totalDurationMs: 0, totalTokens: 0, llmCalls: 0, toolExecutions: 0, errors: 0, modelUsed: '' },
  };
}

function llmEvent(input: string, output: string): TraceEvent {
  return {
    spanId: 's1', traceId: 'trace-1', runId: 'run-1', agentId: 'agent-1',
    type: 'llm_call', timestamp: '2026-06-05T00:00:00.000Z', durationMs: 100,
    data: {
      input: { messages: input },
      output,
      modelInfo: { provider: 'openai', model: 'gpt-4o', tier: 'standard' },
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    },
  };
}

function verificationEvent(passed: boolean, score: number): TraceEvent {
  return {
    spanId: 's2', traceId: 'trace-1', runId: 'run-1', agentId: 'agent-1',
    type: 'verification', timestamp: '2026-06-05T00:00:01.000Z', durationMs: 10,
    data: { evaluationScore: score, evaluationPassed: passed },
  };
}

describe('Observability P1 features (vitest)', () => {
  it('timeline includes evaluationScore/evaluationPassed from verification events', () => {
    const trace = makeTrace([verificationEvent(true, 0.95)]);
    const timeline = buildTimeline(trace);
    const node = timeline.nodes.find(n => n.type === 'EVALUATOR');
    expect(node).toBeDefined();
    expect(node!.evaluationScore).toBe(0.95);
    expect(node!.evaluationPassed).toBe(true);
  });

  it('timeline includes promptContent/completionContent from LLM events', () => {
    const trace = makeTrace([llmEvent('What is 2+2?', 'The answer is 4.')]);
    const timeline = buildTimeline(trace);
    const node = timeline.nodes.find(n => n.type === 'LLM');
    expect(node).toBeDefined();
    expect(node!.promptContent).toBe('What is 2+2?');
    expect(node!.completionContent).toBe('The answer is 4.');
  });

  it('executive summary produces narrative with timeline events', () => {
    const trace = makeTrace([llmEvent('q', 'a'), verificationEvent(true, 0.9)]);
    const summary = buildExecutiveSummary(trace);
    expect(summary.narrative).toContain('Run run-1');
    expect(summary.timeline.length).toBeGreaterThan(0);
    expect(summary.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('anomaly detector tracks baseline and detects outliers', () => {
    resetAnomalyDetector();
    const detector = new TokenUsageAnomalyDetector();
    for (let i = 0; i < 20; i++) detector.recordUsage('agent-1', 100);
    expect(detector.getBaseline('agent-1')).toBe(100);

    const anomaly = detector.checkForAnomaly('agent-1', 'run-1', 21, 1000);
    expect(anomaly).not.toBeNull();
    expect(anomaly!.severity).toBe('critical');

    expect(detector.checkForAnomaly('agent-1', 'run-1', 22, 100)).toBeNull();
  });

  it('feedback field type is valid on TraceEvent.data', () => {
    const event: TraceEvent = {
      spanId: 's1', traceId: 'trace-1', runId: 'run-1', agentId: 'agent-1',
      type: 'state_change', timestamp: '2026-06-05T00:00:00.000Z', durationMs: 0,
      data: {
        input: 'feedback',
        feedback: { rating: 'positive', comment: 'Great job', tags: ['helpful'], timestamp: new Date().toISOString() },
      },
    };
    expect(event.data.feedback).toBeDefined();
    expect(event.data.feedback!.rating).toBe('positive');
    expect(event.data.feedback!.tags).toContain('helpful');
  });
});
