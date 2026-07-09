import {
  classifyTask,
  getAdaptiveParams,
  getSamplingParams,
  type SamplingParams,
} from '../../../runtime/parameterController';
import type { BenchmarkModule, Task } from '../types';

const BASELINE_PARAMS = {
  temperature: 0.7,
  topP: 1.0,
  maxTokens: 1024,
};

function serializeParams(params: SamplingParams & { maxTokens?: number }): string {
  return JSON.stringify({
    temperature: params.temperature,
    topP: params.topP,
    maxTokens: params.maxTokens ?? BASELINE_PARAMS.maxTokens,
  });
}

function parseParams(output: string): Partial<SamplingParams & { maxTokens?: number }> {
  try {
    return JSON.parse(output);
  } catch {
    return {};
  }
}

const taskSuite: Task[] = [
  {
    id: 'creative-writing',
    prompt: 'Write a creative short story about a robot discovering emotions.',
    expected: (output: string) => {
      const p = parseParams(output);
      return (
        typeof p.temperature === 'number' &&
        p.temperature >= 0.7 &&
        typeof p.topP === 'number' &&
        p.topP <= 0.95
      );
    },
  },
  {
    id: 'code-generation',
    prompt: 'Implement a function that reverses a linked list in TypeScript.',
    expected: (output: string) => {
      const p = parseParams(output);
      return typeof p.temperature === 'number' && p.temperature <= 0.3;
    },
  },
  {
    id: 'factual-qa',
    prompt: 'Explain what machine learning is and list three real-world applications.',
    expected: (output: string) => {
      const p = parseParams(output);
      return typeof p.temperature === 'number' && p.temperature >= 0.45 && p.temperature <= 0.65;
    },
  },
  {
    id: 'tool-calling',
    prompt: 'Search the web for the latest AI research papers.',
    expected: (output: string) => {
      const p = parseParams(output);
      return typeof p.temperature === 'number' && p.temperature <= 0.1;
    },
  },
  {
    id: 'retry-scenario',
    prompt: 'Fix the bug in this failing test (first retry).',
    expected: (output: string) => {
      const p = parseParams(output);
      return typeof p.temperature === 'number' && p.temperature >= 0.25 && p.temperature <= 0.5;
    },
  },
];

export const parameterControllerModule: BenchmarkModule = {
  id: 'parameterController',
  name: 'Parameter Controller',
  description:
    'Validates that adaptive temperature/topP selection outperforms a fixed sampling profile across diverse task types.',
  path: 'runtime/parameterController.ts',
  baselineFactory: () => ({
    getParams: () => BASELINE_PARAMS,
  }),
  treatmentFactory: () => ({
    getParams: (task: Task) => {
      if (task.id === 'retry-scenario') {
        const params = getAdaptiveParams(task.prompt, [], 1);
        return { ...params, maxTokens: BASELINE_PARAMS.maxTokens };
      }
      const profile = classifyTask(task.prompt);
      const params = getSamplingParams(profile);
      return { ...params, maxTokens: BASELINE_PARAMS.maxTokens };
    },
  }),
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      getParams: (task: Task) => SamplingParams & { maxTokens?: number };
    };
    const params = impl.getParams(task);
    return {
      output: serializeParams(params),
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
