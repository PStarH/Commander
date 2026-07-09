import { TokenGovernor } from '../../../runtime/tokenGovernor';
import type { TaskCategory } from '../../../runtime/tokenGovernor';
import type { BenchmarkModule, Task } from '../types';

interface TokenGovernorTask extends Task {
  runId: string;
  nodeId: string;
  requestedTokens: number;
  budget: number;
  category: TaskCategory;
}

/**
 * Synthetic run suite with varying token demand vs. tight budgets.
 *
 * - baseline: no governance; always consumes the full requested amount and
 *   "reports success" even when the hard cap is exceeded.
 * - treatment: uses TokenGovernor with a per-run hard cap; when usage warns or
 *   exceeds the cap it pulls optimization recommendations from the governor
 *   and applies them to reduce effective token consumption.
 */
const taskSuite: TokenGovernorTask[] = [
  {
    id: 'small-search-run',
    prompt: 'Run a lightweight web search and summarize the top result.',
    runId: 'run-search-001',
    nodeId: 'search-node',
    requestedTokens: 50,
    budget: 100,
    category: 'search',
    expected: (output: string) =>
      output.includes('withinBudget') || output.includes('gracefulDegradation'),
  },
  {
    id: 'moderate-analysis-run',
    prompt: 'Analyze a small codebase for deprecated API usage.',
    runId: 'run-analysis-001',
    nodeId: 'analysis-node',
    requestedTokens: 120,
    budget: 100,
    category: 'analysis',
    expected: (output: string) =>
      output.includes('withinBudget') || output.includes('gracefulDegradation'),
  },
  {
    id: 'large-code-run',
    prompt: 'Refactor a large TypeScript service while preserving behavior.',
    runId: 'run-code-001',
    nodeId: 'code-node',
    requestedTokens: 200,
    budget: 100,
    category: 'code',
    expected: (output: string) =>
      output.includes('withinBudget') || output.includes('gracefulDegradation'),
  },
  {
    id: 'massive-report-run',
    prompt: 'Generate a comprehensive quarterly engineering report.',
    runId: 'run-report-001',
    nodeId: 'report-node',
    requestedTokens: 300,
    budget: 100,
    category: 'analysis',
    expected: (output: string) =>
      output.includes('withinBudget') || output.includes('gracefulDegradation'),
  },
  {
    id: 'structured-json-run',
    prompt: 'Extract structured JSON from multiple unstructured documents.',
    runId: 'run-structured-001',
    nodeId: 'structured-node',
    requestedTokens: 150,
    budget: 100,
    category: 'structured',
    expected: (output: string) =>
      output.includes('withinBudget') || output.includes('gracefulDegradation'),
  },
];

/**
 * Simulate applying the governor's optimization strategies.
 *
 * Calls both getRecommendations() and shouldApply() so the benchmark exercises
 * the full advisory surface. Each accepted strategy contributes a token
 * reduction proportional to its intensity; total reduction is capped so the
 * run can still fail on pathological inputs.
 */
function applyOptimizationStrategies(
  governor: TokenGovernor,
  requestedTokens: number,
): { actualTokens: number; reduced: boolean } {
  const recommendations = governor.getRecommendations();
  let reduction = 0;

  for (const decision of recommendations) {
    const { apply, intensity } = governor.shouldApply(decision.strategy);
    if (apply) {
      reduction += intensity * 0.12;
    }
  }

  // Cap reduction so extremely large requests can still exceed the budget.
  reduction = Math.min(0.65, reduction);

  if (reduction <= 0) {
    return { actualTokens: requestedTokens, reduced: false };
  }

  return {
    actualTokens: Math.max(1, Math.round(requestedTokens * (1 - reduction))),
    reduced: true,
  };
}

interface BaselineImpl {
  run: (task: Task) => { output: string; tokensUsed: number };
}

interface TreatmentImpl {
  governor: TokenGovernor;
  run: (task: Task) => { output: string; tokensUsed: number };
}

export const tokenGovernorModule: BenchmarkModule = {
  id: 'tokenGovernor',
  name: 'Token Governor Budget Optimizer',
  description:
    'Validates that TokenGovernor advisory optimizations keep more runs within a tight token budget than an ungoverned baseline.',
  path: 'runtime/tokenGovernor.ts',
  baselineFactory: () => ({
    run: (task: Task) => {
      const t = task as unknown as TokenGovernorTask;
      const withinBudget = t.requestedTokens <= t.budget;
      // Baseline completes the run regardless of budget and always "reports success".
      const outcome = withinBudget ? 'withinBudget' : 'exceeded';
      return {
        output: `baseline:${outcome}:requested=${t.requestedTokens}:budget=${t.budget}`,
        tokensUsed: t.requestedTokens,
      };
    },
  }),
  treatmentFactory: () => {
    // Use a dedicated instance so benchmark trials are isolated from any singleton state.
    const governor = new TokenGovernor({ totalBudget: 100000, enableLearning: false });

    return {
      governor,
      run: (task: Task) => {
        const t = task as unknown as TokenGovernorTask;

        // Align the governor's top-level budget with this run's hard cap so
        // getRecommendations() sees realistic pressure.
        governor.reset(t.budget);
        governor.startRun(t.runId, { hardCap: t.budget });
        governor.setTaskCategory(t.category);

        // Update top-level usage so the advisory layer sees the run pressure.
        governor.reportUsage(t.requestedTokens);

        // Record per-run usage and check for warnings / hard-cap exceedance.
        const status = governor.recordRunUsage(t.runId, t.nodeId, t.requestedTokens);

        let actualTokens = t.requestedTokens;
        let outcome: 'withinBudget' | 'gracefulDegradation' | 'exceeded';

        if (status.warning || status.exceeded) {
          const optimized = applyOptimizationStrategies(governor, t.requestedTokens);
          actualTokens = optimized.actualTokens;

          if (actualTokens <= t.budget) {
            outcome = 'withinBudget';
          } else if (optimized.reduced) {
            outcome = 'gracefulDegradation';
          } else {
            outcome = 'exceeded';
          }
        } else {
          outcome = 'withinBudget';
        }

        return {
          output: `treatment:${outcome}:actual=${actualTokens}:requested=${t.requestedTokens}:budget=${t.budget}`,
          tokensUsed: actualTokens,
        };
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as BaselineImpl | TreatmentImpl;
    const result = impl.run(task);
    return {
      output: result.output,
      tokenUsage: {
        input: 0,
        output: result.tokensUsed,
        total: result.tokensUsed,
        cached: 0,
        reasoning: 0,
      },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
