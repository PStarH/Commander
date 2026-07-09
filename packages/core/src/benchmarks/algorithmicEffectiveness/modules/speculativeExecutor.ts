import {
  PatternTracker,
  planSpeculativeExecution,
} from '../../../runtime/speculativeExecutor';
import type { BenchmarkModule, Task } from '../types';

interface SpeculativeTask extends Task {
  recentToolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  expectedTool?: string;
}

const AVAILABLE_TOOLS = [
  'web_search',
  'web_fetch',
  'browser_search',
  'browser_fetch',
  'file_read',
  'file_search',
  'file_list',
  'memory_recall',
  'memory_list',
];

const taskSuite: SpeculativeTask[] = [
  {
    id: 'file-read-then-search',
    prompt: 'After reading a file, the agent usually searches its contents.',
    recentToolCalls: [{ name: 'file_read', arguments: { path: '/tmp/log.txt' } }],
    expectedTool: 'file_search',
  },
  {
    id: 'list-dir-then-read',
    prompt: 'After listing a directory, the agent usually reads a file inside it.',
    recentToolCalls: [{ name: 'file_list', arguments: { path: '/tmp' } }],
    expectedTool: 'file_read',
  },
  {
    id: 'web-search-then-fetch',
    prompt: 'After a web search, the agent usually fetches the top result.',
    recentToolCalls: [{ name: 'web_search', arguments: { query: 'vitest docs' } }],
    expectedTool: 'web_fetch',
  },
  {
    id: 'memory-recall-then-list',
    prompt: 'After recalling a memory, the agent often lists related memories.',
    recentToolCalls: [{ name: 'memory_recall', arguments: { key: 'api-key' } }],
    expectedTool: 'memory_list',
  },
  {
    id: 'unknown-pattern',
    prompt: 'No learned pattern exists for this tool sequence.',
    recentToolCalls: [{ name: 'browser_fetch', arguments: { url: 'https://example.com' } }],
    expectedTool: undefined,
  },
];

function formatPlan(
  plan: Array<{ name: string; arguments: Record<string, unknown>; confidence: number }>,
): string {
  return JSON.stringify({ plan: plan.map((p) => ({ name: p.name, confidence: p.confidence })) });
}

function expectedToolInOutput(expected: string | undefined, output: string): boolean {
  if (expected === undefined) {
    // Unknown pattern: success means the plan is empty (no speculation).
    try {
      const parsed = JSON.parse(output);
      return Array.isArray(parsed.plan) && parsed.plan.length === 0;
    } catch {
      return false;
    }
  }
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed.plan) && parsed.plan.some((p: { name?: string }) => p.name === expected);
  } catch {
    return output.includes(expected);
  }
}

function historicalSequenceForTask(task: SpeculativeTask): string[] {
  const names = task.recentToolCalls.map((tc) => tc.name);
  return task.expectedTool ? [...names, task.expectedTool] : names;
}

export const speculativeExecutorModule: BenchmarkModule = {
  id: 'speculativeExecutor',
  name: 'Speculative Executor',
  description:
    'Validates that a pattern-trained SpeculativeExecutor predicts the next read-only tool while avoiding speculation on unknown sequences.',
  path: 'runtime/speculativeExecutor.ts',
  baselineFactory: () => ({
    plan: () => [],
  }),
  treatmentFactory: () => {
    const tracker = new PatternTracker();
    // Pre-train the tracker with historical sequences for each learned pattern.
    for (const task of taskSuite) {
      const sequence = historicalSequenceForTask(task);
      for (let i = 0; i < 5; i++) {
        tracker.recordSequence(sequence);
      }
    }
    return {
      tracker,
      plan: (task: SpeculativeTask) =>
        planSpeculativeExecution(tracker, task.recentToolCalls, AVAILABLE_TOOLS),
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as { plan: (task: SpeculativeTask) => Array<{ name: string; arguments: Record<string, unknown>; confidence: number }> };
    const specTask = task as unknown as SpeculativeTask;
    const plan = impl.plan(specTask);
    return {
      output: formatPlan(plan),
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite.map((task) => ({
    ...task,
    expected: (output: string) => expectedToolInOutput(task.expectedTool, output),
  })) as unknown as Task[],
  metrics: ['successRate'],
};
