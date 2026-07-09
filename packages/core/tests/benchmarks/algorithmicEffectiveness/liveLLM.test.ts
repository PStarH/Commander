import { describe, it, expect, vi } from 'vitest';
import { createLiveLLM } from '../../../src/benchmarks/algorithmicEffectiveness/liveLLM';

describe('liveLLM', () => {
  it('throws when no API key is configured', () => {
    expect(() => createLiveLLM({ provider: 'openai', model: 'gpt-4o-mini' })).toThrow(/API key/);
  });

  it('returns response via injected fetch', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    });

    const llm = createLiveLLM({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fetch: mockFetch as unknown as typeof fetch,
    });
    const res = await llm.complete('hi');
    expect(res.text).toBe('hello');
    expect(res.tokens.input).toBe(2);
    expect(res.tokens.output).toBe(1);
    delete process.env.OPENAI_API_KEY;
  });
});
