import { describe, it, expect } from 'vitest';
import { createScriptedLLM } from '../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';

describe('scriptedLLM', () => {
  it('returns configured response and deterministic tokens', async () => {
    const llm = createScriptedLLM({ responses: { hello: 'world' } });
    const res = await llm.complete('hello');
    expect(res.text).toBe('world');
    expect(res.tokens.total).toBeGreaterThan(0);
  });

  it('falls back to default response when prompt not matched', async () => {
    const llm = createScriptedLLM({ defaultResponse: 'fallback' });
    const res = await llm.complete('unknown');
    expect(res.text).toBe('fallback');
  });

  it('matches by regex key', async () => {
    const llm = createScriptedLLM({
      responses: { '/score.*/': '42' },
      useRegex: true,
    });
    const res = await llm.complete('score please');
    expect(res.text).toBe('42');
  });
});
