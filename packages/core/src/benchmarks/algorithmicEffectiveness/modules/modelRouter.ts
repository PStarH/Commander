import { ModelRouter } from '../../../runtime/modelRouter';
import type { ModelConfig } from '../../../runtime/types';
import type { AgentExecutionContext } from '../../../runtime/types';
import type { BenchmarkModule, Task } from '../types';

/**
 * Minimal two-model registry for the benchmark.
 * - cheap-model: eco tier, very low cost, low true success rate.
 * - strong-model: power tier, expensive, high true success rate.
 */
const BENCHMARK_MODELS: ModelConfig[] = [
  {
    id: 'cheap-model',
    provider: 'mock',
    tier: 'eco',
    costPer1MInput: 0.1,
    costPer1MOutput: 0.4,
    capabilities: ['code', 'analysis'],
    contextWindow: 128000,
    priority: 0,
  },
  {
    id: 'strong-model',
    provider: 'mock',
    tier: 'power',
    costPer1MInput: 10,
    costPer1MOutput: 40,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 0,
  },
];

/**
 * True success rates for each model, independent of task.
 * The cheap model fails most of the time; the strong model succeeds most of the time.
 */
const TRUE_SUCCESS_RATES: Record<string, number> = {
  'cheap-model': 0.25,
  'strong-model': 0.95,
};

const taskSuite: Task[] = [
  {
    id: 'implement-sort',
    prompt: 'Implement a TypeScript function that sorts an array of numbers in ascending order.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
  {
    id: 'debug-python',
    prompt: 'Debug this Python function that throws a TypeError when iterating over None.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
  {
    id: 'refactor-react',
    prompt: 'Refactor this React class component to use functional component hooks.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
  {
    id: 'compare-databases',
    prompt: 'Compare three cloud database providers for an early-stage startup.',
    expected: (output: string) => output.endsWith(':success:true'),
  },
  {
    id: 'analyze-tradeoffs',
    prompt: 'Analyze the trade-offs between REST and GraphQL API design.',
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
    tokenBudget: 4000,
  };
}

function simulateSuccess(modelId: string): boolean {
  const rate = TRUE_SUCCESS_RATES[modelId] ?? 0.5;
  return Math.random() < rate;
}

function executeModel(modelId: string): { output: string; success: boolean } {
  const success = simulateSuccess(modelId);
  return { output: `${modelId}:success:${success}`, success };
}

interface BaselineImpl {
  router: ModelRouter;
  route: (task: Task) => { modelId: string };
}

interface TreatmentImpl {
  router: ModelRouter;
  routeWithCascade: (task: Task) => { modelId: string; output: string };
}

export const modelRouterModule: BenchmarkModule = {
  id: 'modelRouter',
  name: 'Model Router Cascade',
  description:
    'Validates that routeWithCascade achieves higher success rate than single cheapest-model routing by escalating from cheap to strong models on failure.',
  path: 'runtime/modelRouter.ts',
  baselineFactory: () => {
    const router = new ModelRouter(BENCHMARK_MODELS);
    // Fixed cost objective: always prefer the cheapest model regardless of quality.
    router.setRoutingObjective({ type: 'cost_at_quality_floor', minQuality: 0 });
    return {
      router,
      route: (task: Task) => {
        const ctx = makeContext(task.prompt);
        return router.route(ctx, 'relaxed');
      },
    };
  },
  treatmentFactory: () => {
    const router = new ModelRouter(BENCHMARK_MODELS);
    return {
      router,
      routeWithCascade: (task: Task) => {
        const ctx = makeContext(task.prompt);
        // critical governor forces FrugalGPT-style cascade: start cheap, escalate on failure.
        const { initial, escalationChain } = router.routeWithCascade(
          ctx,
          'critical',
          undefined,
          new Set(['mock']),
        );

        // Try the initial (cheapest) model first.
        let result = executeModel(initial.modelId);

        // Escalate through the chain until success or exhaustion.
        if (!result.success) {
          for (const next of escalationChain) {
            result = executeModel(next.id);
            if (result.success) break;
          }
        }

        return { modelId: result.success ? result.output.split(':')[0] : 'failed', ...result };
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as BaselineImpl | TreatmentImpl;
    let modelId: string;
    let success: boolean;

    if ('routeWithCascade' in impl) {
      const result = impl.routeWithCascade(task);
      modelId = result.modelId;
      success = result.output.endsWith(':success:true');
    } else {
      const decision = impl.route(task);
      const result = executeModel(decision.modelId);
      modelId = decision.modelId;
      success = result.success;
    }

    // Record the outcome so the router can learn (learning is not required for
    // the cascade advantage, but it keeps the benchmark realistic).
    impl.router.recordOutcome(modelId, 'benchmark', success, 1, 150);

    return {
      output: `${modelId}:success:${success}`,
      tokenUsage: { input: 100, output: 50, total: 150, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
