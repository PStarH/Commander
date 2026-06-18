import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ToolMetricsCollector } from '../src/observability/toolMetrics';
import { buildDecisions, decisionsSummary } from '../src/observability/decisionProvenance';
import {
  CostModel,
  getCostModel,
  resetCostModel,
  DEFAULT_PRICING,
} from '../src/observability/costModel';
import { compareTraces } from '../src/observability/traceComparison';
import { dryReplay } from '../src/observability/replay';
import { ExecutionTraceRecorder } from '../src/runtime/executionTrace';
import type { ExecutionTrace, TraceEvent } from '../src/runtime/types';
import type { ReplaySpec } from '../src/observability/types';

function makeTrace(events: TraceEvent[], runId = 'run-1'): ExecutionTrace {
  return {
    runId,
    traceId: `trace-${runId}`,
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

function toolEvent(
  toolName: string,
  opts: Partial<{ durationMs: number; error: string; timestamp: string; spanId: string }> = {},
): TraceEvent {
  return {
    spanId: opts.spanId ?? `s-${toolName}`,
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'agent-1',
    type: 'tool_execution',
    timestamp: opts.timestamp ?? '2026-06-05T00:00:00.000Z',
    durationMs: opts.durationMs ?? 100,
    data: { input: toolName, output: 'ok', ...(opts.error ? { error: opts.error } : {}) },
  };
}

function llmEvent(
  output: string,
  opts: Partial<{ timestamp: string; spanId: string; model: string }> = {},
): TraceEvent {
  return {
    spanId: opts.spanId ?? 's-llm',
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'agent-1',
    type: 'llm_call',
    timestamp: opts.timestamp ?? '2026-06-05T00:00:00.000Z',
    durationMs: 50,
    data: {
      input: { messages: 'test' },
      output,
      modelInfo: { provider: 'openai', model: opts.model ?? 'gpt-4o', tier: 'standard' },
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    },
  };
}

describe('P2-P3 observability features', () => {
  describe('ToolMetricsCollector', () => {
    let collector: ToolMetricsCollector;

    beforeEach(() => {
      collector = new ToolMetricsCollector();
    });

    it('records tool execution and computes stats', () => {
      collector.recordToolExecution(toolEvent('read_file', { durationMs: 50 }));
      collector.recordToolExecution(toolEvent('read_file', { durationMs: 150 }));

      const summary = collector.getSummary();
      assert.strictEqual(summary.totalTools, 1);
      assert.strictEqual(summary.totalInvocations, 2);
      assert.strictEqual(summary.tools[0].avgDurationMs, 100);
      assert.strictEqual(summary.tools[0].successes, 2);
    });

    it('counts failures separately', () => {
      collector.recordToolExecution(toolEvent('write_file', { durationMs: 10 }));
      collector.recordToolExecution(
        toolEvent('write_file', { durationMs: 20, error: 'permission denied' }),
      );

      const summary = collector.getSummary();
      assert.strictEqual(summary.tools[0].failures, 1);
      assert.strictEqual(summary.tools[0].successes, 1);
      assert.strictEqual(summary.overallSuccessRate, 0.5);
    });

    it('ignores non-tool_execution events', () => {
      collector.recordToolExecution(llmEvent('response'));
      assert.strictEqual(collector.getSummary().totalTools, 0);
    });

    it('tracks multiple tools', () => {
      collector.recordToolExecution(toolEvent('read'));
      collector.recordToolExecution(toolEvent('write'));
      collector.recordToolExecution(toolEvent('grep'));

      assert.strictEqual(collector.getSummary().totalTools, 3);
    });
  });

  describe('buildDecisions', () => {
    it('extracts tool decisions with preceding LLM reasoning', () => {
      const trace = makeTrace([
        llmEvent('I should read the file', {
          spanId: 's-llm-1',
          timestamp: '2026-06-05T00:00:00.000Z',
        }),
        toolEvent('read_file', { spanId: 's-tool-1', timestamp: '2026-06-05T00:00:01.000Z' }),
      ]);

      const decisions = buildDecisions(trace);
      assert.strictEqual(decisions.length, 1);
      assert.strictEqual(decisions[0].toolName, 'read_file');
      assert.ok(decisions[0].llmReasoning.includes('should read'));
      assert.strictEqual(decisions[0].thinkDurationMs, 1000);
    });

    it('handles tool events without preceding LLM', () => {
      const trace = makeTrace([toolEvent('grep')]);
      const decisions = buildDecisions(trace);
      assert.strictEqual(decisions.length, 1);
      assert.strictEqual(decisions[0].llmReasoning, undefined);
    });

    it('ignores non-tool events', () => {
      const trace = makeTrace([llmEvent('hello')]);
      assert.strictEqual(buildDecisions(trace).length, 0);
    });
  });

  describe('decisionsSummary', () => {
    it('produces summary from decisions', () => {
      const trace = makeTrace([
        llmEvent('reasoning', { spanId: 's-1' }),
        toolEvent('read', { spanId: 's-2' }),
        toolEvent('write', { spanId: 's-3' }),
      ]);

      const decisions = buildDecisions(trace);
      const summary = decisionsSummary(decisions);
      assert.strictEqual(summary.total, 2);
      assert.ok(summary.byTool.map((t) => t.tool).includes('read'));
      assert.ok(summary.byTool.map((t) => t.tool).includes('write'));
    });
  });

  describe('CostModel', () => {
    beforeEach(() => resetCostModel());

    it('calculates cost for known model', () => {
      const model = getCostModel();
      const cost = model.calculate('openai', 'gpt-4o', {
        input: 1000,
        output: 500,
        cached: 0,
        reasoning: 0,
        total: 1500,
      });
      assert.strictEqual(Math.abs(cost.inputCostUsd - 0.0025) < 0.0001, true);
      assert.strictEqual(Math.abs(cost.outputCostUsd - 0.005) < 0.0001, true);
      assert.strictEqual(Math.abs(cost.totalCostUsd - 0.0075) < 0.0001, true);
    });

    it('uses fallback pricing for unknown model', () => {
      const model = getCostModel();
      const cost = model.calculate('unknown', 'unknown-model', {
        input: 1000,
        output: 1000,
        cached: 0,
        reasoning: 0,
        total: 2000,
      });
      assert.ok(cost.totalCostUsd > 0);
    });

    it('handles cached input pricing', () => {
      const model = getCostModel();
      const cost = model.calculate('openai', 'gpt-4o', {
        input: 1000,
        output: 0,
        cached: 500,
        reasoning: 0,
        total: 1000,
      });
      assert.ok(cost.totalCostUsd > 0);
      assert.ok(cost.totalCostUsd < 0.0025);
    });

    it('includes all default pricing providers', () => {
      const providers = new Set(DEFAULT_PRICING.map((p) => p.provider));
      assert.strictEqual(providers.has('openai'), true);
      assert.strictEqual(providers.has('anthropic'), true);
      assert.strictEqual(providers.has('google'), true);
      assert.strictEqual(providers.has('deepseek'), true);
    });
  });

  describe('compareTraces', () => {
    it('detects identical traces', () => {
      const events = [toolEvent('read', { spanId: 's1' })];
      const traceA = makeTrace(events, 'run-a');
      const traceB = makeTrace(events, 'run-b');

      const diff = compareTraces(traceA, traceB);
      assert.strictEqual(diff.summary.unchanged, 1);
      assert.strictEqual(diff.summary.added, 0);
      assert.strictEqual(diff.summary.removed, 0);
    });

    it('detects added events', () => {
      const traceA = makeTrace([], 'run-a');
      const traceB = makeTrace([toolEvent('write', { spanId: 's1' })], 'run-b');

      const diff = compareTraces(traceA, traceB);
      assert.strictEqual(diff.summary.added, 1);
    });

    it('detects removed events', () => {
      const traceA = makeTrace([toolEvent('delete', { spanId: 's1' })], 'run-a');
      const traceB = makeTrace([], 'run-b');

      const diff = compareTraces(traceA, traceB);
      assert.strictEqual(diff.summary.removed, 1);
    });
  });

  describe('dryReplay', () => {
    it('substitutes tool output in trace', () => {
      const trace = makeTrace([
        toolEvent('read_file', { spanId: 's-read', timestamp: '2026-06-05T00:00:00.000Z' }),
      ]);

      const spec: ReplaySpec = {
        runId: 'run-1',
        substitutions: [{ target: 'tool_output', spanId: 's-read', value: 'new content' }],
        reExecuteLlm: false,
      };

      const result = dryReplay(trace, spec);
      assert.ok(result.diff.changedSpans >= 0);
      assert.ok(result.replayedNodes !== undefined);
    });

    it('substitutes LLM response', () => {
      const trace = makeTrace([
        llmEvent('original reasoning', { spanId: 's-llm', timestamp: '2026-06-05T00:00:00.000Z' }),
      ]);

      const spec: ReplaySpec = {
        runId: 'run-1',
        substitutions: [{ target: 'llm_response', spanId: 's-llm', value: 'different reasoning' }],
        reExecuteLlm: false,
      };

      const result = dryReplay(trace, spec);
      assert.ok(result.replayedNodes !== undefined);
    });

    it('returns zero changed spans when no substitutions match', () => {
      const trace = makeTrace([toolEvent('grep', { spanId: 's-grep' })]);
      const spec: ReplaySpec = { runId: 'run-1', substitutions: [], reExecuteLlm: false };

      const result = dryReplay(trace, spec);
      assert.strictEqual(result.diff.changedSpans, 0);
    });
  });

  describe('Verification gate breakdown (extended TraceEvent)', () => {
    it('recordVerification stores evaluation data', () => {
      const recorder = new ExecutionTraceRecorder();
      recorder.startRun('run-v1', 'agent-1');

      recorder.recordVerification('run-v1', true, 0.92, 2, 100);

      const trace = recorder.getTrace('run-v1');
      assert.ok(trace);
      const verification = trace!.events.find((e: TraceEvent) => e.type === 'verification');
      assert.ok(verification);
      assert.strictEqual(verification!.data.evaluationPassed, true);
      assert.strictEqual(verification!.data.evaluationScore, 0.92);
      assert.deepStrictEqual(verification!.data.input, {
        passed: true,
        confidence: 0.92,
        signalCount: 2,
      });
      assert.deepStrictEqual(verification!.data.output, {
        passed: true,
        confidence: 0.92,
        signalCount: 2,
      });
    });
  });

  describe('Pipeline phase timing (decision events)', () => {
    it('recordDecision captures phase timing', () => {
      const recorder = new ExecutionTraceRecorder();
      recorder.startRun('run-phase', 'agent-1');

      recorder.recordDecision(
        'run-phase',
        'phase:deliberation taskType=coding confidence=0.85',
        1500,
      );
      recorder.recordDecision(
        'run-phase',
        'phase:effort_scaling level=medium minAgents=2 maxAgents=5',
        200,
      );
      recorder.recordDecision(
        'run-phase',
        'phase:topology_routing topology=PARALLEL expectedCost=$0.05',
        300,
      );

      const trace = recorder.getTrace('run-phase');
      assert.ok(trace);
      const decisions = trace!.events.filter((e: TraceEvent) => e.type === 'decision');
      assert.strictEqual(decisions.length, 3);
      assert.ok(decisions[0]!.data.output.includes('phase:deliberation'));
      assert.strictEqual(decisions[0]!.durationMs, 1500);
      assert.ok(decisions[1]!.data.output.includes('phase:effort_scaling'));
      assert.ok(decisions[2]!.data.output.includes('phase:topology_routing'));
    });
  });

  describe('Full LLM I/O audit trail', () => {
    it('recordLLMCall stores full prompt and response', () => {
      const recorder = new ExecutionTraceRecorder();
      recorder.startRun('run-llm', 'agent-1');

      const fullPrompt = {
        messages: [{ role: 'user', content: 'Write a function to validate emails' }],
      };
      const fullResponse = {
        content: 'function validateEmail(email) { return /^[^@]+@[^@]+$/.test(email); }',
      };

      recorder.recordLLMCall(
        'run-llm',
        'gpt-4o',
        'openai',
        'standard',
        fullPrompt,
        fullResponse,
        {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
        500,
      );

      const trace = recorder.getTrace('run-llm');
      assert.ok(trace);
      const llmEvent = trace!.events.find((e: TraceEvent) => e.type === 'llm_call');
      assert.ok(llmEvent);
      assert.deepStrictEqual(llmEvent!.data.input, fullPrompt);
      assert.deepStrictEqual(llmEvent!.data.output, fullResponse);
      assert.strictEqual(llmEvent!.data.modelInfo?.model, 'gpt-4o');
    });
  });
});
