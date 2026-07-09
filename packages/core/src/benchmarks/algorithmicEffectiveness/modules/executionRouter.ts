import type { BenchmarkModule, LLMClient, Task } from '../types';

export interface ExecutionRouterDeps {
  llm: LLMClient;
}

export interface RouteParams {
  task: RouterTask;
}

export interface RouteResult {
  mode: 'single' | 'multi' | 'local';
  reasoning: string;
}

interface RouterTask extends Task {
  complexity: number;
  parallelism: number;
  privacySensitive: boolean;
  expectedMode: 'single' | 'multi' | 'local';
}

/**
 * ExecutionRouter chooses between single-agent, multi-agent, and local-model
 * execution paths based on task complexity / parallelism hints and privacy
 * sensitivity. It is instantiated through dependency injection and holds no
 * global state.
 */
export class ExecutionRouter {
  constructor(private readonly deps: ExecutionRouterDeps) {}

  async route(params: RouteParams): Promise<RouteResult> {
    const { task } = params;

    // Privacy is a hard override: sensitive tasks never leave the local model.
    if (task.privacySensitive) {
      return {
        mode: 'local',
        reasoning: 'Privacy-sensitive content detected; route to local model.',
      };
    }

    // Consult a scripted LLM for a recommendation. The final decision still
    // respects the structured hints so the benchmark stays deterministic.
    const prompt = `Execution routing decision:
Task: "${task.prompt}"
Complexity (0-1): ${task.complexity}
Parallelism (0-1): ${task.parallelism}
Should this run as SINGLE or MULTI? Respond with one word.`;

    const { text } = await this.deps.llm.complete(prompt);
    const recommendation = text.trim().toUpperCase();

    const hintsSuggestMulti = task.parallelism >= 0.6 && task.complexity >= 0.5;
    const llmSuggestsMulti = recommendation.includes('MULTI');

    if (hintsSuggestMulti || llmSuggestsMulti) {
      return {
        mode: 'multi',
        reasoning: `High complexity/parallelism (${task.complexity}/${task.parallelism}) or LLM recommendation; use multi-agent.`,
      };
    }

    return {
      mode: 'single',
      reasoning: `Low complexity/parallelism (${task.complexity}/${task.parallelism}); use single-agent.`,
    };
  }
}

interface BaselineImpl {
  route: () => Promise<RouteResult>;
}

interface TreatmentImpl {
  router: ExecutionRouter;
  route: (task: RouterTask) => Promise<RouteResult>;
}

function makeTask(
  id: string,
  prompt: string,
  complexity: number,
  parallelism: number,
  privacySensitive: boolean,
  expectedMode: 'single' | 'multi' | 'local',
): RouterTask {
  return {
    id,
    prompt,
    complexity,
    parallelism,
    privacySensitive,
    expectedMode,
    expected: (output: string) => output === expectedMode,
  };
}

const taskSuite: RouterTask[] = [
  makeTask('simple-greeting', 'Say hello to the user', 0.1, 0.0, false, 'single'),
  makeTask(
    'code-utility',
    'Write a single utility function from a brief description',
    0.3,
    0.1,
    false,
    'single',
  ),
  makeTask(
    'multi-step-research',
    'Research five topics in parallel and synthesize the findings',
    0.8,
    0.9,
    false,
    'multi',
  ),
  makeTask(
    'data-pipeline',
    'Process three independent data files and merge the results',
    0.7,
    0.8,
    false,
    'multi',
  ),
  makeTask(
    'privacy-pii',
    'Summarize this medical record containing patient identifiers',
    0.5,
    0.0,
    true,
    'local',
  ),
];

export const executionRouterModule: BenchmarkModule = {
  id: 'executionRouter',
  name: 'Execution Router',
  description:
    'Validates that ExecutionRouter outperforms a fixed single-agent baseline by routing complex/parallel tasks to multi-agent execution and privacy-sensitive tasks to a local model.',
  path: 'benchmarks/algorithmicEffectiveness/modules/executionRouter.ts',
  baselineFactory: () => ({
    route: async () => ({
      mode: 'single',
      reasoning: 'Baseline: always route to single-agent execution.',
    }),
  }),
  treatmentFactory: ({ llm }: { llm: LLMClient }) => {
    const router = new ExecutionRouter({ llm });
    return {
      router,
      route: (task: RouterTask) => router.route({ task }),
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as BaselineImpl | TreatmentImpl;
    const routerTask = task as unknown as RouterTask;

    const result = await impl.route(routerTask);

    return {
      output: result.mode,
      tokenUsage: { input: 10, output: 10, total: 20, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
