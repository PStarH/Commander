import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../src/memory';
import {
  runMemoryBenchmark,
  aggregateScore,
  retrievalBenchmark,
  forgettingBenchmark,
} from '../src/benchmarks/memoryBenchmark';

describe('memoryBenchmark', () => {
  it('runs all default suites and returns normalized scores', async () => {
    const store = new InMemoryMemoryStore();
    const results = await runMemoryBenchmark(store);

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.score >= 0 && r.score <= 1)).toBe(true);

    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['forgetting', 'long-range', 'retrieval', 'test-time-learning']);
  });

  it('retrieval benchmark rewards top-ranked hits', async () => {
    const store = new InMemoryMemoryStore();
    const result = await retrievalBenchmark.run(store);
    expect(result.score).toBeGreaterThan(0);
  });

  it('forgetting benchmark removes expired items but keeps long-term', async () => {
    const store = new InMemoryMemoryStore();
    const result = await forgettingBenchmark.run(store);
    expect(result.score).toBe(1);
    expect(result.details.removed).toBe(1);
  });

  it('aggregateScore computes the mean', () => {
    const results = [
      { name: 'a', score: 1, details: {} },
      { name: 'b', score: 0.5, details: {} },
      { name: 'c', score: 0, details: {} },
    ];
    expect(aggregateScore(results)).toBe(0.5);
  });
});
