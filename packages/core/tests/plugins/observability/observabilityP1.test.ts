import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildTimeline } from '../../../src/plugins/builtin/observability/timelineBuilder';
import { buildExecutiveSummary } from '../../../src/plugins/builtin/observability/executiveSummary';
import {
  TokenUsageAnomalyDetector,
  resetAnomalyDetector,
} from '../../../src/observability/anomalyDetector';
import type { ExecutionTrace, TraceEvent } from '../../../src/runtime/types';

function makeTrace(events: TraceEvent[]): ExecutionTrace {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
    startedAt: events[0]?.timestamp ?? '2026-06-05T00:00:00.000Z',
    events,
    summary: {
      totalEvents: events.length,
      totalDurationMs: 0,
      totalTokens: 0,
      llmCalls: 0,
      toolExecutions: 0,
      errors: 0,
      modelUsed: '',
    },
  };
}

function llmEvent(input: string, output: string): TraceEvent {
  return {
    spanId: 's1',
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'agent-1',
    type: 'llm_call',
    timestamp: '2026-06-05T00:00:00.000Z',
    durationMs: 100,
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
    spanId: 's2',
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'agent-1',
    type: 'verification',
    timestamp: '2026-06-05T00:00:01.000Z',
    durationMs: 10,
    data: { evaluationScore: score, evaluationPassed: passed },
  };
}

describe('Observability P1 features', () => {
  it('timeline includes evaluationScore/evaluationPassed from verification events', () => {
    const trace = makeTrace([verificationEvent(true, 0.95)]);
    const timeline = buildTimeline(trace);
    const node = timeline.nodes.find((n) => n.type === 'EVALUATOR');
    assert.ok(node);
    assert.strictEqual(node!.evaluationScore, 0.95);
    assert.strictEqual(node!.evaluationPassed, true);
  });

  it('timeline includes promptContent/completionContent from LLM events', () => {
    const trace = makeTrace([llmEvent('What is 2+2?', 'The answer is 4.')]);
    const timeline = buildTimeline(trace);
    const node = timeline.nodes.find((n) => n.type === 'LLM');
    assert.ok(node);
    assert.strictEqual(node!.promptContent, 'What is 2+2?');
    assert.strictEqual(node!.completionContent, 'The answer is 4.');
  });

  it('executive summary produces narrative with timeline events', () => {
    const trace = makeTrace([llmEvent('q', 'a'), verificationEvent(true, 0.9)]);
    const summary = buildExecutiveSummary(trace);
    assert.ok(summary.narrative.includes('Run run-1'));
    assert.ok(summary.timeline.length > 0);
    assert.ok(summary.totalCostUsd >= 0);
  });

  it('anomaly detector tracks baseline and detects outliers', () => {
    resetAnomalyDetector();
    const detector = new TokenUsageAnomalyDetector();
    for (let i = 0; i < 20; i++) detector.recordUsage('agent-1', 100);
    assert.strictEqual(detector.getBaseline('agent-1'), 100);

    const anomaly = detector.checkForAnomaly('agent-1', 'run-1', 21, 1000);
    assert.ok(anomaly !== null);
    assert.strictEqual(anomaly!.severity, 'critical');

    assert.strictEqual(detector.checkForAnomaly('agent-1', 'run-1', 22, 100), null);
  });

  it('feedback field type is valid on TraceEvent.data', () => {
    const event: TraceEvent = {
      spanId: 's1',
      traceId: 'trace-1',
      runId: 'run-1',
      agentId: 'agent-1',
      type: 'state_change',
      timestamp: '2026-06-05T00:00:00.000Z',
      durationMs: 0,
      data: {
        input: 'feedback',
        feedback: {
          rating: 'positive',
          comment: 'Great job',
          tags: ['helpful'],
          timestamp: new Date().toISOString(),
        },
      },
    };
    assert.ok(event.data.feedback);
    assert.strictEqual(event.data.feedback!.rating, 'positive');
    assert.ok(event.data.feedback!.tags.includes('helpful'));
  });
});
