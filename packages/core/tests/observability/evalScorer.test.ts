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
import {
  EvalScorer,
  parseJudgeResponse,
  type JudgeProvider,
  type EvalTarget,
  type LLMRequest,
  type LLMResponse,
} from '../../src/observability/evalScorer';
import { score } from '../../src/observability/score';

function mockJudge(
  respond: (req: LLMRequest) => string | Promise<string> | LLMResponse | Promise<LLMResponse>,
): JudgeProvider {
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
    expect(parseJudgeResponse('{"score": 0.8, "reasoning": "good"}')).toEqual({
      score: 0.8,
      reasoning: 'good',
    });
  });
  it('parses JSON wrapped in markdown fences', () => {
    expect(parseJudgeResponse('```json\n{"score": 0.7, "reasoning": "ok"}\n```')).toEqual({
      score: 0.7,
      reasoning: 'ok',
    });
  });
  it('parses JSON buried in prose', () => {
    expect(
      parseJudgeResponse('Sure! Here you go: {"score": 0.5, "reasoning": "meh"} -- enjoy'),
    ).toEqual({ score: 0.5, reasoning: 'meh' });
  });
  it('coerces numeric string score', () => {
    expect(parseJudgeResponse('{"score": "0.42", "reasoning": "ok"}')).toEqual({
      score: 0.42,
      reasoning: 'ok',
    });
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
        capturedPrompt = req.messages.map((m) => m.content).join('\n');
        return {
          content: '{"score": 0.5, "reasoning": "ok"}',
          usage: emptyUsage(),
          finishReason: 'stop',
        };
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
      async call(): Promise<LLMResponse> {
        throw new Error('provider down');
      },
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
        await new Promise((r) => setTimeout(r, 100));
        return {
          content: '{"score": 0.5, "reasoning": "ok"}',
          usage: emptyUsage(),
          finishReason: 'stop',
        };
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
        capturedPrompt = req.messages.map((m) => m.content).join('\n');
        return {
          content: '{"score": 0.7, "reasoning": "ok"}',
          usage: emptyUsage(),
          finishReason: 'stop',
        };
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
    const ids = scorer
      .listRubrics()
      .map((r) => r.id)
      .sort();
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('default-quality');
  });
});

describe('EvalScorer ungraded regression-safety guard', () => {
  it('returns graded=false for undefined expected, skips judge', async () => {
    const scorer = new EvalScorer(null);
    const r = await scorer.score({
      input: { goal: 'x' },
      output: 'y',
      expected: undefined,
    });
    expect(r.graded).toBe(false);
    expect(r.score).toBe(0);
    expect(r.error).toBe('empty_expected_ungraded');
    expect(r.reasoning).toBe('');
    expect(r.judgeTokens.total).toBe(0);
    expect(r.judgeDurationMs).toBe(0);
  });

  it('returns graded=false for null expected', async () => {
    const scorer = new EvalScorer(null);
    const r = await scorer.score({
      input: { goal: 'x' },
      output: 'y',
      expected: null,
    });
    expect(r.graded).toBe(false);
    expect(r.error).toBe('empty_expected_ungraded');
  });

  it('returns graded=false for empty-string expected', async () => {
    const scorer = new EvalScorer(null);
    const r = await scorer.score({
      input: { goal: 'x' },
      output: 'y',
      expected: '',
    });
    expect(r.graded).toBe(false);
    expect(r.error).toBe('empty_expected_ungraded');
  });

  it('returns graded=false for whitespace-only expected', async () => {
    const scorer = new EvalScorer(null);
    const r = await scorer.score({
      input: { goal: 'x' },
      output: 'y',
      expected: '   ',
    });
    expect(r.graded).toBe(false);
    expect(r.error).toBe('empty_expected_ungraded');
  });

  it('returns graded=false for all-punctuation expected (post-normalize empty)', async () => {
    const scorer = new EvalScorer(null);
    const r = await scorer.score({
      input: { goal: 'x' },
      output: 'y',
      expected: '...',
    });
    expect(r.graded).toBe(false);
    expect(r.error).toBe('empty_expected_after_normalize');
  });

  it('does NOT call judge when ungraded (no token consumption)', async () => {
    let judgeCalled = false;
    const judge = mockJudge(() => {
      judgeCalled = true;
      return '{"score":1,"reasoning":"x"}';
    });
    const scorer = new EvalScorer(judge);
    await scorer.score({
      input: { goal: 'x' },
      output: 'y',
      expected: '',
    });
    expect(judgeCalled).toBe(false);
  });

  it('passes non-string object expected to the judge (does NOT mark ungraded)', async () => {
    const judge = mockJudge(() => '{"score":0.5,"reasoning":"ok"}');
    const scorer = new EvalScorer(judge);
    const r = await scorer.score({
      input: { goal: 'x' },
      output: 'y',
      expected: { outputContains: ['y'] },
    });
    // Back-compat default: undefined graded → implicitly true.
    expect(r.graded).toBeUndefined();
    expect(r.score).toBe(0.5);
    expect(r.error).toBeUndefined();
  });

  it('clamps scored result to rubric range even when ungraded (range [-10,10])', async () => {
    const scorer = new EvalScorer(null);
    scorer.registerRubric({
      id: 'wide',
      name: 'Wide',
      promptTemplate: 'p',
      scoreRange: { min: -10, max: 10 },
    });
    const r = await scorer.score(
      { input: 'x', output: 'y', expected: '' },
      'wide',
    );
    expect(r.graded).toBe(false);
    expect(r.score).toBe(0); // clamp(0, -10, 10) = 0 (the natural mid-scale baseline)
  });
});

/**
 * Runtime tests for the asymmetric-parameter-types JSDoc invariant on
 * `score()` in `packages/core/src/observability/score.ts` (the shared
 * scoring module extracted from `scripts/benchmark-gaia.ts`).
 *
 * The invariant has TWO halves:
 *
 *   1. `expected: unknown` (widened) — non-string inputs route through
 *      `classifyExpectedForSubstringMatch()` which emits
 *      `'non_string_expected_not_substring_matchable'` at runtime. The
 *      matching production-side `EvalScorer.score()` uses the GENERAL
 *      `classifyExpected()` for the same inputs (passes them to the
 *      judge); this test documents and locks the SUBSTRING-MATCHER
 *      behavior at the dedicated reason literal.
 *
 *   2. `actual: string | undefined | null` (kept narrow) — the documented
 *      contract matches the `SYNTHETIC_TASKS.mockOutput: string`
 *      fixture shape and the shared `normalizeForMatch()` signature.
 *      The `?? ''` fallback inside `score()` handles nullish cases
 *      deterministically.
 *
 * Closes the JSDoc-vs-test-pair coverage gap: the runtime invariants are
 * now codified as test cases that fail loud if the production scorer
 * drifts. The companion source-of-truth test is the
 * `classifyExpectedForSubstringMatch` describe block above (in
 * `packages/core/tests/observability/normalizeExpected.test.ts`); this
 * block tests the COMPOSITION through `score()` end-to-end.
 */
describe('score() JSDoc-invariant: asymmetric parameter types', () => {
  // ── Half 1: expected widened to unknown — non-string refuses via dedicated literal ──
  it('non-string object expected → UNGRADED with reason non_string_expected_not_substring_matchable', () => {
    const r = score({ outputContains: ['y'] }, 'y');
    expect(r.verdict).toBe('UNGRADED');
    expect(r.reason).toBe('non_string_expected_not_substring_matchable');
    // Spot-check: actual normalization still ran (sanity; the verdict
    // doesn't depend on actual for non-string expected).
    expect(r.normalizedActual).toBe('y');
  });

  it('non-string number expected → UNGRADED with the same reason literal', () => {
    const r = score(42, 'whatever');
    expect(r.verdict).toBe('UNGRADED');
    expect(r.reason).toBe('non_string_expected_not_substring_matchable');
  });

  // ── Half 2: actual stays narrowed to string | undefined | null — nullish coalesces to "" ──
  it('actual: undefined → normalized to "" → INCORRECT for non-empty expected', () => {
    const r = score('Tim Cook', undefined);
    expect(r.verdict).toBe('INCORRECT');
    expect(r.reason).toBe('normalized_substring_no_match');
    expect(r.normalizedActual).toBe('');
    expect(r.normalizedExpected).toBe('tim cook');
  });

  it('actual: null → nullish-coalesce behavior → INCORRECT (same shape as undefined)', () => {
    const r = score('Tim Cook', null);
    expect(r.verdict).toBe('INCORRECT');
    expect(r.normalizedActual).toBe('');
  });

  it('actual: empty string "" → INCORRECT (empty normActual cannot include non-empty normExpected)', () => {
    const r = score('Tim Cook', '');
    expect(r.verdict).toBe('INCORRECT');
    expect(r.normalizedActual).toBe('');
  });

  // ── Sanity: string actual path produces the documented three-way contract ──
  it('actual: matching string → CORRECT (normalized_substring_match)', () => {
    const r = score('Tim Cook', 'Tim Cook is the CEO of Apple.');
    expect(r.verdict).toBe('CORRECT');
    expect(r.reason).toBe('normalized_substring_match');
    expect(r.normalizedExpected).toBe('tim cook');
    expect(r.normalizedActual).toBe('tim cook is the ceo of apple');
  });

  it('actual: non-matching string → INCORRECT (normalized_substring_no_match)', () => {
    const r = score('Tim Cook', 'Sundar Pichai is the CEO of Google.');
    expect(r.verdict).toBe('INCORRECT');
    expect(r.reason).toBe('normalized_substring_no_match');
  });

  // ── Cross-product: empty expected + empty actual → UNGRADED (locks the 69.7% regression) ──
  it('empty expected + empty actual → UNGRADED (regression-safety: never silent INCORRECT via String.includes(""))', () => {
    // Historical regression: `String.prototype.includes('')` returns true
    // for any actual, so the binary pre-fix CORRECT verdict was inflated
    // by 30%. The modern contract is that empty `normalizedExpected`
    // MUST result in UNGRADED — never CORRECT. This test locks that.
    const r = score('', '');
    expect(r.verdict).toBe('UNGRADED');
    expect(r.reason).toBe('empty_expected_ungraded');
  });
});
