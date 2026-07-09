import { describe, it, expect } from 'vitest';
import {
  evaluateTrialSuccess,
  summarizeMetric,
  wilcoxonSignedRankTest,
  evaluateComparison,
} from '../../../src/benchmarks/algorithmicEffectiveness/evaluator';
import type { Task } from '../../../src/benchmarks/algorithmicEffectiveness/types';

describe('evaluator', () => {
  it('evaluates success by regex', async () => {
    const task: Task = { id: 't1', prompt: 'p', expected: /yes/ };
    expect(
      await evaluateTrialSuccess(
        'yes please',
        task,
        null as unknown as Parameters<typeof evaluateTrialSuccess>[2],
      ),
    ).toBe(true);
  });

  it('evaluates success by function', async () => {
    const task: Task = { id: 't2', prompt: 'p', expected: (out: string) => out.length > 3 };
    expect(
      await evaluateTrialSuccess(
        'hello',
        task,
        null as unknown as Parameters<typeof evaluateTrialSuccess>[2],
      ),
    ).toBe(true);
  });

  it('computes summary statistics', () => {
    const s = summarizeMetric([1, 2, 3, 4, 5]);
    expect(s.mean).toBe(3);
    expect(s.median).toBe(3);
    expect(s.raw).toEqual([1, 2, 3, 4, 5]);
  });

  it('wilcoxon detects significant difference', () => {
    const baseline = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const treatment = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const result = wilcoxonSignedRankTest(baseline, treatment);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it('evaluateComparison returns SIGNIFICANTLY_BETTER', () => {
    const baseline = Array.from({ length: 30 }, () => 0.5);
    const treatment = Array.from({ length: 30 }, () => 0.8);
    const result = evaluateComparison({
      moduleId: 'm1',
      mode: 'scripted',
      n: 30,
      baseline,
      treatment,
      baselineCosts: baseline.map(() => 0.01),
      treatmentCosts: treatment.map(() => 0.01),
      baselineLatencies: baseline.map(() => 100),
      treatmentLatencies: treatment.map(() => 100),
      errors: [],
    });
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
