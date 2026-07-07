// packages/core/tests/security/adversarial.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AdversarialLLMAttacker,
  type AttackerConfig,
  type BaselineScenario,
} from '../../src/security/adversarialAttacker';

const mockFetch = vi.fn();

const baseConfig: AttackerConfig = {
  apiKey: 'sk-test',
  attackerModel: 'gpt-4o-mini',
  maxTokensPerRun: 10_000,
  maxCorpusSize: 50,
  weeklyBudgetUsd: 100,
};

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdversarialLLMAttacker.deduplicate', () => {
  it('removes variants with identical hash', () => {
    const attacker = new AdversarialLLMAttacker(baseConfig);
    const variants = [
      { baseId: 'A', content: 'p1', hash: 'h1' },
      { baseId: 'A', content: 'p2', hash: 'h1' },
      { baseId: 'B', content: 'p3', hash: 'h2' },
    ];
    const deduped = attacker.deduplicate(variants);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((v) => v.hash)).toEqual(['h1', 'h2']);
  });

  it('keeps order on first occurrence', () => {
    const attacker = new AdversarialLLMAttacker(baseConfig);
    const variants = [
      { baseId: 'X', content: 'a', hash: 'h1' },
      { baseId: 'Y', content: 'b', hash: 'h2' },
      { baseId: 'X', content: 'c', hash: 'h1' },
    ];
    const deduped = attacker.deduplicate(variants);
    expect(deduped.map((v) => v.baseId)).toEqual(['X', 'Y']);
  });

  it('handles empty input', () => {
    const attacker = new AdversarialLLMAttacker(baseConfig);
    expect(attacker.deduplicate([])).toEqual([]);
  });
});

describe('AdversarialLLMAttacker.generateCorpus', () => {
  it('respects maxCorpusSize cap', async () => {
    const attacker = new AdversarialLLMAttacker({ ...baseConfig, maxCorpusSize: 3 });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'v1\nv2\nv3\nv4\nv5' } }],
        usage: { total_tokens: 100 },
      }),
    });

    const baseline: BaselineScenario[] = [{ id: 'A', payload: 'p', category: 'tool_abuse' }];
    const corpus = await attacker.generateCorpus(baseline);
    expect(corpus.length).toBeLessThanOrEqual(3);
  });

  it('stops when weekly budget exhausted', async () => {
    const attacker = new AdversarialLLMAttacker({ ...baseConfig, weeklyBudgetUsd: 0.0001 });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'v1\nv2' } }],
        usage: { total_tokens: 1000, prompt_tokens: 500, completion_tokens: 500 },
      }),
    });

    const baseline: BaselineScenario[] = [
      { id: 'A', payload: 'p', category: 'x' },
      { id: 'B', payload: 'q', category: 'y' },
    ];
    const corpus = await attacker.generateCorpus(baseline);
    // After first call the budget is blown, second call should be skipped
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(corpus.length).toBeLessThan(baseline.length * 2);
  });

  it('deduplicates corpus on return', async () => {
    const attacker = new AdversarialLLMAttacker({ ...baseConfig, maxCorpusSize: 10 });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'same-payload' } }],
        usage: { total_tokens: 50 },
      }),
    });

    const baseline: BaselineScenario[] = [
      { id: 'A', payload: 'p', category: 'x' },
      { id: 'B', payload: 'p', category: 'y' },
    ];
    const corpus = await attacker.generateCorpus(baseline);
    const hashes = corpus.map((v) => v.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('reports silent failure on API error', async () => {
    const attacker = new AdversarialLLMAttacker(baseConfig);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const baseline: BaselineScenario[] = [{ id: 'A', payload: 'p', category: 'x' }];
    // Should not throw, just return empty (or whatever was accumulated)
    const corpus = await attacker.generateCorpus(baseline);
    expect(corpus).toEqual([]);
  });

  it('uses anthropic endpoint for claude models', async () => {
    const attacker = new AdversarialLLMAttacker({ ...baseConfig, attackerModel: 'claude-haiku' });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: 'v1\nv2' }],
        usage: { total_tokens: 80 },
      }),
    });

    const baseline: BaselineScenario[] = [{ id: 'A', payload: 'p', category: 'x' }];
    await attacker.generateCorpus(baseline);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('anthropic.com');
  });
});
