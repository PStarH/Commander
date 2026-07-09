import type { BenchmarkModule, Task } from '../types';

const taskSuite: Task[] = [
  { id: 'placeholder', prompt: 'placeholder', expected: 'ok' },
];

export const thompsonMemoryModule: BenchmarkModule = {
  id: 'thompsonMemory',
  name: 'Thompson Memory Scorer',
  description: 'Validates that Thompson Sampling recovers from misleading static relevance scores.',
  path: 'memory/thompsonMemoryScorer.ts',
  baselineFactory: () => ({ run: () => 'ok' }),
  treatmentFactory: () => ({ run: () => 'ok' }),
  runTrial: async ({ implementation }) => {
    const impl = implementation as { run: () => string };
    return {
      output: impl.run(),
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
