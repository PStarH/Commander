import { describe, it, expect } from 'vitest';
import { runComparison } from '../../../src/benchmarks/algorithmicEffectiveness/runner';
import { createScriptedLLM } from '../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import type { BenchmarkModule, Task } from '../../../src/benchmarks/algorithmicEffectiveness/types';

describe('runner', () => {
  it('runs A/B comparison and treatment wins', async () => {
    const tasks: Task[] = [{ id: 't1', prompt: 'task', expected: /good/ }];

    const mod: BenchmarkModule = {
      id: 'dummy',
      name: 'Dummy',
      description: '',
      path: '',
      baselineFactory: () => ({ predict: () => 'bad' }),
      treatmentFactory: () => ({ predict: () => 'good' }),
      runTrial: async ({ implementation, task }) => {
        const out = (implementation as { predict: () => string }).predict();
        return {
          output: out,
          tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
          latencyMs: 1,
        };
      },
      taskSuite: tasks,
      metrics: ['successRate'],
    };

    const result = await runComparison(
      { moduleId: 'dummy', mode: 'scripted', n: 10, seed: 1 },
      mod,
      () => createScriptedLLM({ responses: {} }),
    );

    expect(result.moduleId).toBe('dummy');
    expect(result.treatment.mean).toBeGreaterThan(result.baseline.mean);
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
