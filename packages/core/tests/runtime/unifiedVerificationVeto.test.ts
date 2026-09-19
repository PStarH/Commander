/**
 * Regression tests for the audited Unified Verification Pipeline defects:
 *
 *   VT-01  a Stage-3 judge rejection was outvoted by a higher accumulated
 *          confidence score, so `passed` stayed true
 *   VT-01b `shouldRunLLM` read the constructor provider only, so a configured
 *          evaluator (`setEvaluatorProvider`) never enabled Stage 2
 *   VT-02  `additionalProperties: false` used a prototype-chain `in` check, so
 *          inherited names such as `toString` were treated as declared
 *
 * A required check that throws must surface as unavailable/failure, never as a
 * disguised verification success.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedVerificationPipeline } from '../../src/runtime/unifiedVerification';
import type { UVPTaskContext } from '../../src/runtime/unifiedVerification';
import { resetGoalJudge } from '../../src/runtime/goalJudge';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/runtime/types';

const GOAL = 'Summarize the article';

/** Stage 0 scores this output at exactly 0.7: one high-severity tool error. */
const TOOL_ERROR_OUTPUT =
  'Here are the results:\nError: FileNotFoundError: /tmp/data.csv not found';
const TOOL_ERROR_TOOLS = ['shell_execute'];

interface FakeProviderOptions {
  stage2?: { pass: boolean; fix?: string };
  judge?: { passed: boolean; confidence: number; reasoning?: string };
}

function createFakeProvider(options: FakeProviderOptions): {
  provider: LLMProvider;
  requests: LLMRequest[];
} {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'test-evaluator',
    async call(request: LLMRequest): Promise<LLMResponse> {
      requests.push(request);
      const prompt = request.messages.map((message) => message.content).join('\n');
      // The judge prompt asks for "passed"; the Stage 2 prompt asks for "pass".
      const content = prompt.includes('"passed"')
        ? JSON.stringify({
            passed: options.judge?.passed ?? true,
            confidence: options.judge?.confidence ?? 0.9,
            reasoning: options.judge?.reasoning ?? 'judge reasoning',
            evidence: [],
          })
        : JSON.stringify({
            pass: options.stage2?.pass ?? true,
            fix: options.stage2?.fix ?? '',
          });
      return {
        content,
        model: 'test-model',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  };
  return { provider, requests };
}

function disabledJudge() {
  return { enabled: false, triggerConfidence: 0.85, passThreshold: 0.8, tokenBudget: 800 };
}

function toolErrorContext(): UVPTaskContext {
  return { goal: GOAL, output: TOOL_ERROR_OUTPUT, toolsUsed: TOOL_ERROR_TOOLS };
}

describe('UnifiedVerificationPipeline required-check veto', () => {
  it('rejects output when the judge rejects with confidence above the accumulated score', async () => {
    resetGoalJudge();
    const { provider } = createFakeProvider({
      judge: { passed: false, confidence: 0.9, reasoning: 'goal not met' },
    });
    const pipeline = new UnifiedVerificationPipeline({ enabled: true });
    pipeline.setEvaluatorProvider(provider);

    const report = await pipeline.verify(toolErrorContext());

    assert.ok(report.stagesRun.includes(3), 'Stage 3 judge must have executed');
    assert.equal(report.judgeVerdict?.passed, false);
    // The accumulated score stays above the 0.5 pass threshold and below the
    // judge confidence — exactly the shape that used to pass.
    assert.ok(report.confidence >= 0.5, `accumulated score was ${report.confidence}`);
    assert.ok(
      (report.judgeVerdict?.confidence ?? 0) > report.confidence,
      'judge confidence must outrank the accumulated score for this regression',
    );
    assert.equal(report.passed, false);
  });

  it('accepts output when the judge approves', async () => {
    resetGoalJudge();
    const { provider } = createFakeProvider({
      judge: { passed: true, confidence: 0.9, reasoning: 'goal satisfied' },
    });
    const pipeline = new UnifiedVerificationPipeline({ enabled: true });
    pipeline.setEvaluatorProvider(provider);

    const report = await pipeline.verify(toolErrorContext());

    assert.ok(report.stagesRun.includes(3), 'Stage 3 judge must have executed');
    assert.equal(report.judgeVerdict?.passed, true);
    assert.equal(report.passed, true);
  });

  it('keeps existing behaviour when the judge gate is disabled', async () => {
    const pipeline = new UnifiedVerificationPipeline({ enabled: true, judgeGate: disabledJudge() });

    const report = await pipeline.verify(toolErrorContext());

    assert.equal(report.stagesRun.includes(3), false);
    assert.equal(report.judgeVerdict, undefined);
    assert.equal(report.confidence, 0.7);
    assert.equal(report.passed, true);
  });

  it('runs Stage 2 when the evaluator is configured after construction', async () => {
    resetGoalJudge();
    const { provider, requests } = createFakeProvider({
      stage2: { pass: false, fix: 'cite the sources' },
    });
    const pipeline = new UnifiedVerificationPipeline({ enabled: true, judgeGate: disabledJudge() });
    // Deliberately NOT the constructor's second argument.
    pipeline.setEvaluatorProvider(provider);

    const report = await pipeline.verify({
      goal: 'Is Python good for beginners?',
      output: 'Without a doubt, Python is the best language for beginners.',
    });

    assert.ok(report.stagesRun.includes(2), 'Stage 2 must run for a configured evaluator');
    assert.equal(requests.length, 1);
    assert.ok(report.signals.some((signal) => signal.source === 'llm_verify'));
    assert.equal(report.passed, false);
  });

  it('still runs Stage 2 when the provider comes from the constructor', async () => {
    resetGoalJudge();
    const { provider } = createFakeProvider({ stage2: { pass: false, fix: 'cite the sources' } });
    const pipeline = new UnifiedVerificationPipeline(
      { enabled: true, judgeGate: disabledJudge() },
      provider,
    );

    const report = await pipeline.verify({
      goal: 'Is Python good for beginners?',
      output: 'Without a doubt, Python is the best language for beginners.',
    });

    assert.ok(report.stagesRun.includes(2));
    assert.ok(report.signals.some((signal) => signal.source === 'llm_verify'));
  });

  it('treats a Stage 0 required check that throws as unavailable, not passed', async () => {
    const pipeline = new UnifiedVerificationPipeline({ enabled: true, judgeGate: disabledJudge() });

    const report = await pipeline.verify({
      goal: GOAL,
      output: undefined as unknown as string,
    });

    assert.equal(report.passed, false);
    assert.equal(report.confidence, 0);
    assert.ok(
      report.signals.some(
        (signal) => signal.source === 'check_unavailable' && signal.severity === 'critical',
      ),
    );
  });

  it('treats an unenforceable schema contract as unavailable, not passed', async () => {
    const pipeline = new UnifiedVerificationPipeline({
      enabled: true,
      confidenceSkipThreshold: 0.99,
      judgeGate: disabledJudge(),
    });
    const schema = {
      type: 'object',
      get properties(): Record<string, unknown> {
        throw new Error('schema backend unavailable');
      },
    } as unknown as Record<string, unknown>;

    const report = await pipeline.verify({
      goal: 'Return the incident report',
      output: '{"incidentId":"INC-1"}',
      schema,
    });

    assert.equal(report.passed, false);
    assert.ok(
      report.signals.some(
        (signal) =>
          signal.source === 'check_unavailable' &&
          signal.severity === 'critical' &&
          signal.message.includes('schema backend unavailable'),
      ),
    );
  });

  it('rejects an inherited property name when additionalProperties is false', async () => {
    const pipeline = new UnifiedVerificationPipeline({
      enabled: true,
      confidenceSkipThreshold: 0.99,
      judgeGate: disabledJudge(),
    });

    const report = await pipeline.verify({
      goal: 'Return a structured incident report',
      output: JSON.stringify({ incidentId: 'INC-1', toString: 'not a declared field' }),
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { incidentId: { type: 'string' } },
        required: ['incidentId'],
      },
    });

    assert.ok(
      report.signals.some(
        (signal) =>
          signal.message.includes('Unexpected field') && signal.message.includes('toString'),
      ),
    );
    assert.equal(report.passed, false);
  });

  it('still accepts a declared property when additionalProperties is false', async () => {
    const pipeline = new UnifiedVerificationPipeline({
      enabled: true,
      confidenceSkipThreshold: 0.99,
      judgeGate: disabledJudge(),
    });

    const report = await pipeline.verify({
      goal: 'Return a structured incident report',
      output: JSON.stringify({ incidentId: 'INC-1' }),
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { incidentId: { type: 'string' } },
        required: ['incidentId'],
      },
    });

    assert.equal(report.signals.length, 0);
    assert.equal(report.passed, true);
  });
});
