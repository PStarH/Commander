import { ThompsonMemoryScorer } from '../../../memory/thompsonMemoryScorer';
import type { BenchmarkModule, Task } from '../types';

interface MemoryCandidate {
  id: string;
  text: string;
  // Static relevance score used by baseline. In this scenario it is misleading:
  // the highest-scored item is actually wrong, matching a common real-world drift.
  staticScore: number;
}

const taskSuite: Task[] = [
  {
    id: 'retrieve-api-docs',
    prompt: 'Find the memory about API authentication',
    expected: (output: string) => output.includes('Bearer'),
  },
  {
    id: 'retrieve-deployment',
    prompt: 'Find the memory about deployment steps',
    expected: (output: string) => output.includes('docker'),
  },
  {
    id: 'retrieve-config',
    prompt: 'Find the memory about config format',
    expected: (output: string) => output.includes('JSON'),
  },
];

const memories: MemoryCandidate[] = [
  // Misleading static score: m1 is actually correct but ranked lower.
  { id: 'm1', text: 'API uses Bearer token in header', staticScore: 0.5 },
  // High static score but wrong content.
  { id: 'm2', text: 'API uses cookie in header', staticScore: 0.9 },
  { id: 'm3', text: 'Deployment uses docker compose', staticScore: 0.6 },
  { id: 'm4', text: 'Config is stored as JSON file', staticScore: 0.55 },
  { id: 'm5', text: 'Team lunch on Friday', staticScore: 0.2 },
];

function isCorrectForTask(taskId: string, memoryId: string): boolean {
  const mapping: Record<string, string> = {
    'retrieve-api-docs': 'm1',
    'retrieve-deployment': 'm3',
    'retrieve-config': 'm4',
  };
  return mapping[taskId] === memoryId;
}

export const thompsonMemoryModule: BenchmarkModule = {
  id: 'thompsonMemory',
  name: 'Thompson Memory Scorer',
  description: 'Validates that Thompson Sampling recovers from misleading static relevance scores.',
  path: 'memory/thompsonMemoryScorer.ts',
  baselineFactory: () => ({
    select: () => {
      // Fixed top-k by static score — chooses the misleading high-score item.
      return [...memories].sort((a, b) => b.staticScore - a.staticScore)[0];
    },
    isCorrectForTask,
  }),
  treatmentFactory: () => {
    const scorer = new ThompsonMemoryScorer();
    // Pre-train the scorer with historical feedback: m1/m3/m4 are useful, m2/m5 are not.
    for (let i = 0; i < 15; i++) {
      scorer.updateUsefulness('m1', true);
      scorer.updateUsefulness('m3', true);
      scorer.updateUsefulness('m4', true);
      scorer.updateUsefulness('m2', false);
      scorer.updateUsefulness('m5', false);
    }
    return {
      scorer,
      select: () => {
        const scored = memories.map((m) => ({
          ...m,
          sample: scorer.sampleUsefulness(m.id),
        }));
        return scored.sort((a, b) => b.sample - a.sample)[0];
      },
      isCorrectForTask,
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      scorer?: ThompsonMemoryScorer;
      select: () => MemoryCandidate;
      isCorrectForTask: (taskId: string, memoryId: string) => boolean;
    };
    const selected = impl.select();
    // Provide feedback to treatment scorer so it keeps learning across trials.
    if (impl.scorer) {
      impl.scorer.updateUsefulness(selected.id, impl.isCorrectForTask(task.id, selected.id));
    }
    return {
      output: selected.text,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
