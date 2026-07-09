import { describe, it, expect } from 'vitest';
import type { Task, LLMClient, BenchmarkModule, ComparisonResult } from '../../../src/benchmarks/algorithmicEffectiveness/types';

describe('types compile and shape is correct', () => {
  it('Task accepts expected function', () => {
    const task: Task = {
      id: 't1',
      prompt: 'hello',
      expected: (output: string) => output.includes('world'),
    };
    expect(task.id).toBe('t1');
  });

  it('LLMClient complete returns text and tokens', async () => {
    const client: LLMClient = {
      complete: async () => ({ text: 'ok', tokens: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 } }),
    };
    const res = await client.complete('hi');
    expect(res.text).toBe('ok');
  });

  it('ComparisonResult has required fields', () => {
    const result: ComparisonResult = {
      moduleId: 'm1',
      mode: 'scripted',
      n: 10,
      baseline: { mean: 0, median: 0, p95: 0, stdDev: 0, raw: [] },
      treatment: { mean: 1, median: 1, p95: 1, stdDev: 0, raw: [] },
      pValues: { successRate: 0.01, cost: 1, latency: 1, llmScore: 1 },
      effectSizes: { successRate: 0.5, cost: 0, latency: 0, llmScore: 0 },
      conclusion: 'SIGNIFICANTLY_BETTER',
      errors: [],
    };
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
