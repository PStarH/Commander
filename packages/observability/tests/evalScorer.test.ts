import { describe, it, expect, beforeEach } from 'vitest';
import { EvalScorer, parseJudgeResponse } from '../src/evalScorer';

describe('parseJudgeResponse', () => {
  it('parses valid JSON', () => {
    const result = parseJudgeResponse('{"score": 0.8, "reasoning": "good"}');
    expect(result.score).toBe(0.8);
    expect(result.reasoning).toBe('good');
  });

  it('parses JSON wrapped in markdown fences', () => {
    const result = parseJudgeResponse('```json\n{"score": 0.5, "reasoning": "ok"}\n```');
    expect(result.score).toBe(0.5);
  });

  it('parses JSON with surrounding text', () => {
    const result = parseJudgeResponse(
      'Here is the result: {"score": 0.9, "reasoning": "great"} done',
    );
    expect(result.score).toBe(0.9);
  });

  it('returns error for empty response', () => {
    const result = parseJudgeResponse('');
    expect(result.error).toBe('empty_response');
  });

  it('returns error for non-JSON text', () => {
    const result = parseJudgeResponse('this is not json at all');
    expect(result.error).toBe('parse_failed');
  });

  it('returns error for missing score field', () => {
    const result = parseJudgeResponse('{"reasoning": "no score"}');
    expect(result.error).toBe('invalid_score');
  });

  it('handles non-numeric score', () => {
    const result = parseJudgeResponse('{"score": "not a number", "reasoning": "bad"}');
    expect(result.error).toBe('invalid_score');
  });
});

describe('EvalScorer', () => {
  it('returns error when no provider configured', async () => {
    const scorer = new EvalScorer(null);
    const result = await scorer.score({ input: 'test', output: 'test' });
    expect(result.score).toBe(0);
    expect(result.error).toBe('no_provider_configured');
  });

  it('registers and retrieves rubrics', () => {
    const scorer = new EvalScorer(null);
    scorer.registerRubric({
      id: 'custom',
      name: 'Custom',
      promptTemplate: 'Score: {{input}}',
      scoreRange: { min: 0, max: 10 },
    });
    const rubric = scorer.getRubric('custom');
    expect(rubric.id).toBe('custom');
    expect(rubric.scoreRange?.max).toBe(10);
  });

  it('falls back to default rubric for unknown id', () => {
    const scorer = new EvalScorer(null);
    const rubric = scorer.getRubric('nonexistent');
    expect(rubric.id).toBe('default-quality');
  });

  it('lists all rubrics', () => {
    const scorer = new EvalScorer(null);
    scorer.registerRubric({ id: 'r1', name: 'R1', promptTemplate: 'x' });
    scorer.registerRubric({ id: 'r2', name: 'R2', promptTemplate: 'y' });
    expect(scorer.listRubrics()).toHaveLength(3); // default + 2
  });
});
