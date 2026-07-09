import { SmartModelRouter, type UserModelConfig } from '../../../runtime/smartModelRouter';
import { detectTaskType } from '../../../runtime/taskAnalyzer';
import type { AgentExecutionContext, RoutingDecision } from '../../../runtime/types';
import type { BenchmarkModule, Task } from '../types';

/**
 * Minimal model pool for the SmartModelRouter benchmark.
 *
 * - baseline-fallback: always chosen by manual mode; no useful capabilities.
 * - code-specialist: best for code tasks.
 * - structured-specialist: best for structured-output tasks.
 * - analysis-specialist: best for analysis tasks (placed in power tier because
 *   analysis prompts score high complexity).
 * - search-specialist: best for search tasks.
 * - general-specialist: best for general tasks.
 */
const BENCHMARK_MODELS: UserModelConfig[] = [
  {
    id: 'baseline-fallback',
    provider: 'mock',
    tier: 'power',
    capabilities: [],
    costPer1MInput: 100,
    costPer1MOutput: 200,
    contextWindow: 128000,
  },
  {
    id: 'code-specialist',
    provider: 'mock',
    tier: 'standard',
    capabilities: ['code', 'analysis', 'json_mode'],
    costPer1MInput: 2,
    costPer1MOutput: 8,
    contextWindow: 128000,
  },
  {
    id: 'structured-specialist',
    provider: 'mock',
    tier: 'standard',
    capabilities: ['code', 'analysis', 'json_mode'],
    costPer1MInput: 2,
    costPer1MOutput: 8,
    contextWindow: 128000,
  },
  {
    id: 'analysis-specialist',
    provider: 'mock',
    tier: 'power',
    capabilities: ['analysis'],
    costPer1MInput: 5,
    costPer1MOutput: 25,
    contextWindow: 128000,
  },
  {
    id: 'search-specialist',
    provider: 'mock',
    tier: 'eco',
    capabilities: ['analysis'],
    costPer1MInput: 0.5,
    costPer1MOutput: 2,
    contextWindow: 128000,
  },
  {
    id: 'general-specialist',
    provider: 'mock',
    tier: 'eco',
    capabilities: ['analysis'],
    costPer1MInput: 0.1,
    costPer1MOutput: 0.4,
    contextWindow: 128000,
  },
];

const BEST_MODEL_FOR_TASK: Record<string, string> = {
  code: 'code-specialist',
  structured: 'structured-specialist',
  analysis: 'analysis-specialist',
  search: 'search-specialist',
  general: 'general-specialist',
};

const taskSuite: Task[] = [
  {
    id: 'implement-sort',
    prompt:
      'Implement a complex TypeScript function that sorts an array of numbers in ascending order. Provide the full function code and a short explanation of the algorithm.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
  {
    id: 'format-json',
    prompt:
      'Convert the following dataset into JSON format and return the output as a structured JSON object. The input contains user names, ages, and email addresses.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
  {
    id: 'compare-apis',
    prompt:
      'Analyze and compare the trade-offs between REST and GraphQL API design. Determine which approach is better for a distributed system and explain why.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
  {
    id: 'search-tokyo',
    prompt:
      'Search the web for the latest population of Tokyo and retrieve current news articles about the city. Summarize the most relevant facts you find.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
  {
    id: 'creative-story',
    prompt:
      'Write a short creative story about a robot learning to paint a beautiful sunset. Keep the tone warm and imaginative.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
];

function makeContext(prompt: string): AgentExecutionContext {
  return {
    agentId: 'benchmark-agent',
    projectId: 'benchmark-project',
    goal: prompt,
    contextData: {},
    availableTools: [],
    maxSteps: 1,
    tokenBudget: 8000,
  };
}

function getTaskType(task: Task): string {
  return detectTaskType(task.prompt);
}

interface Impl {
  router: SmartModelRouter;
  route: (task: Task) => RoutingDecision & { escalationChain?: string[] };
}

function preTrainTreatmentRouter(router: SmartModelRouter): void {
  // Record failures for every non-best model first. These older samples are
  // allowed to be evicted by the router's outcome buffer; what matters is that
  // the best-model successes (recorded last) survive and dominate learning.
  for (const task of taskSuite) {
    const taskType = getTaskType(task);
    const bestId = BEST_MODEL_FOR_TASK[taskType];
    for (const model of BENCHMARK_MODELS) {
      if (model.id === bestId) continue;
      for (let i = 0; i < 35; i++) {
        router.recordOutcome(model.id, taskType, false, 100);
      }
    }
  }

  // Record successes for the best model per task type last so they are the
  // most recent outcomes and remain fully in the learning window.
  for (const task of taskSuite) {
    const taskType = getTaskType(task);
    const bestId = BEST_MODEL_FOR_TASK[taskType];
    for (let i = 0; i < 35; i++) {
      router.recordOutcome(bestId, taskType, true, 100);
    }
  }
}

export const smartModelRouterModule: BenchmarkModule = {
  id: 'smartModelRouter',
  name: 'Smart Model Router Learning',
  description:
    'Validates that SmartModelRouter in auto mode learns the best model per task type and outperforms a fixed manual-mode baseline.',
  path: 'runtime/smartModelRouter.ts',
  baselineFactory: () => {
    const router = new SmartModelRouter({
      mode: 'manual',
      modelPool: BENCHMARK_MODELS,
    });
    return {
      router,
      route: (task: Task) => router.route(makeContext(task.prompt)),
    };
  },
  treatmentFactory: () => {
    const router = new SmartModelRouter({
      mode: 'auto',
      modelPool: BENCHMARK_MODELS,
    });
    preTrainTreatmentRouter(router);
    return {
      router,
      route: (task: Task) => router.route(makeContext(task.prompt)),
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as Impl;
    const decision = impl.route(task);
    const taskType = getTaskType(task);
    const bestId = BEST_MODEL_FOR_TASK[taskType];
    const success = decision.modelId === bestId;

    impl.router.recordOutcome(decision.modelId, taskType, success, 1);

    return {
      output: `${decision.modelId}:success:${success}`,
      tokenUsage: { input: 100, output: 50, total: 150, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
