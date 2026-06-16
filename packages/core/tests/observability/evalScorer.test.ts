/**
 * Tests for the P-obs-3 EvalScorer (LLM-as-judge).
 *
 * Coverage:
 *  - parseJudgeResponse: direct JSON, fenced JSON, prose-wrapped, invalid → error
 *  - EvalScorer: prompt rendering, score clamping, judge model selection,
 *    rubric registration, missing provider (error='no_provider_configured')
 *  - score() never throws — judge errors surface as EvalScore.error
 *  - timeoutMs honored — slow judges return error='judge_call_timeout_*ms'
 */
import { describe, it, expect } from 'vitest';
import { EvalScorer, parseJudgeResponse, type JudgeProvider, type EvalTarget, type LLMRequest, type LLMResponse } from '../../src/observability/evalScorer';

function mockJudge(respond: (req: LLMRequest) => string | Promise<string> | LLMResponse | Promise<LLMResponse>): JudgeProvider {
  return {
    name: 'mock',
    async call(request: LLMRequest): Promise<LLMResponse> {
      const r = await respond(request);
      if (typeof r === 'string') {
        return {
          content: r,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: 'stop',
        };
      }
      return r;
    },
  };
}

function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

const sampleTarget: EvalTarget = {
  input: { goal: 'compute 2+2' },
  output: '4',
  expected: { outputContains: ['4'] },
  toolsCalled: ['calculator'],
  durationMs: 250,
  costUsd: 0.001,
  tokens: 50,
};

describe('parseJudgeResponse', () => {
  it('parses direct JSON', () => {
    expect(parseJudgeResponse('{"score": 0.8, "reasoning": "good"}'))
      .toEqual({ score: 0.8, reasoning: 'good' });
  });
  it('parses JSON wrapped in markdown fences', () => {
    expect(parseJudgeResponse('```json\n{"score": 0.7, "reasoning": "ok"}\n```'))
      .toEqual({ score: 0.7, reasoning: 'ok' });
  });
  it('parses JSON buried in prose', () => {
    expect(parseJudgeResponse('Sure! Here you go: {"score": 0.5, "reasoning": "meh"} -- enjoy'))
      .toEqual({ score: 0.5, reasoning: 'meh' });
  });
  it('coerces numeric string score', () => {
    expect(parseJudgeResponse('{"score": "0.42", "reasoning": "ok"}'))
      .toEqual({ score: 0.42, reasoning: 'ok' });
  });
  it('returns error for non-JSON', () => {
    expect(parseJudgeResponse('not json at all').error).toBeTruthy();
  });
  it('returns error for empty input', () => {
    expect(parseJudgeResponse('').error).toBe('empty_response');
  });
  it('returns error when score is missing or invalid', () => {
    expect(parseJudgeResponse('{"reasoning": "no score"}').error).toBeTruthy();
  });
});

describe('EvalScorer', () => {
  it('returns no_provider_configured when provider is null', async () => {
    const scorer = new EvalScorer(null);
    const r = await scorer.score(sampleTarget);
    expect(r.error).toBe('no_provider_configured');
    expect(r.score).toBe(0);
  });

  it('scores a target using the default rubric and clamps to range', async () => {
    const judge = mockJudge(() => '{"score": 1.5, "reasoning": "great"}');
    const scorer = new EvalScorer(judge);
    const r = await scorer.score(sampleTarget);
    expect(r.score).toBe(1.0); // clamped to rubric max
    expect(r.reasoning).toBe('great');
    expect(r.judgeModel).toBe('gpt-4o-mini');
    expect(r.judgeTokens.total).toBe(30);
    expect(r.error).toBeUndefined();
  });

  it('clamps negative scores up to the rubric min', async () => {
    const judge = mockJudge(() => '{"score": -0.5, "reasoning": "no"}');
    const scorer = new EvalScorer(judge);
    const r = await scorer.score(sampleTarget);
    expect(r.score).toBe(0);
  });

  it('selects the named rubric when provided', async () => {
    let capturedPrompt = '';
    const judge: JudgeProvider = {
      name: 'mock',
      async call(req: LLMRequest): Promise<LLMResponse> {
        capturedPrompt = req.messages.map(m => m.content).join('\n');
        return { content: '{"score": 0.5, "reasoning": "ok"}', usage: emptyUsage(), finishReason: 'stop' };
      },
    };
    const scorer = new EvalScorer(judge);
    scorer.registerRubric({
      id: 'strict',
      name: 'Strict',
      promptTemplate: 'STRICT_RUBRIC: {{input}} vs {{expected}}',
      scoreRange: { min: 0, max: 1 },
      judgeModel: 'claude-haiku-4-5',
    });
    const r = await scorer.score(sampleTarget, 'strict');
    expect(capturedPrompt).toContain('STRICT_RUBRIC');
    expect(r.judgeModel).toBe('claude-haiku-4-5');
  });

  it('falls back to default rubric when id is unknown', async () => {
    const judge = mockJudge(() => '{"score": 0.4, "reasoning": "ok"}');
    const scorer = new EvalScorer(judge);
    const r = await scorer.score(sampleTarget, 'does-not-exist');
    expect(r.score).toBe(0.4);
  });

  it('returns error string when judge throws (no rethrow)', async () => {
    const judge: JudgeProvider = {
      name: 'broken',
      async call(): Promise<LLMResponse> { throw new Error('provider down'); },
    };
    const scorer = new EvalScorer(judge);
    const r = await scorer.score(sampleTarget);
    expect(r.error).toContain('provider down');
    expect(r.score).toBe(0);
  });

  it('returns error string when judge response is unparseable', async () => {
    const judge = mockJudge(() => 'totally not json');
    const scorer = new EvalScorer(judge);
    const r = await scorer.score(sampleTarget);
    expect(r.error).toBeTruthy();
    expect(r.score).toBe(0);
  });

  it('times out slow judges with judge_call_timeout_*ms error', async () => {
    const judge: JudgeProvider = {
      name: 'slow',
      async call(): Promise<LLMResponse> {
        await new Promise(r => setTimeout(r, 100));
        return { content: '{"score": 0.5, "reasoning": "ok"}', usage: emptyUsage(), finishReason: 'stop' };
      },
    };
    const scorer = new EvalScorer(judge, { timeoutMs: 20 });
    const r = await scorer.score(sampleTarget);
    expect(r.error).toContain('judge_call_timeout_20ms');
  });

  it('renders placeholders into the prompt', async () => {
    let capturedPrompt = '';
    const judge: JudgeProvider = {
      name: 'mock',
      async call(req: LLMRequest): Promise<LLMResponse> {
        capturedPrompt = req.messages.map(m => m.content).join('\n');
        return { content: '{"score": 0.7, "reasoning": "ok"}', usage: emptyUsage(), finishReason: 'stop' };
      },
    };
    const scorer = new EvalScorer(judge);
    await scorer.score(sampleTarget);
    expect(capturedPrompt).toContain('compute 2+2');
    expect(capturedPrompt).toContain('"4"');
    expect(capturedPrompt).toContain('calculator');
    expect(capturedPrompt).toContain('250');
  });

  it('listRubrics returns the registered set', () => {
    const judge = mockJudge(() => '{"score": 0.5, "reasoning": "ok"}');
    const scorer = new EvalScorer(judge);
    scorer.registerRubric({ id: 'a', name: 'A', promptTemplate: 'p' });
    scorer.registerRubric({ id: 'b', name: 'B', promptTemplate: 'p' });
    const ids = scorer.listRubrics().map(r => r.id).sort();
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('default-quality');
  });
});
