import { deliberate } from '../../../ultimate/deliberation';
import type { BenchmarkModule, Task } from '../types';
import type { DeliberationPlan, OrchestrationTopology } from '../../../ultimate/types';

interface DeliberationTask extends Task {
  goal: string;
  context?: Record<string, unknown>;
  correctTopology: OrchestrationTopology;
  minTokenBudget: number;
  maxTokenBudget: number;
}

function serialize(plan: DeliberationPlan): string {
  const totalBudget =
    plan.tokenBudget.thinking + plan.tokenBudget.execution + plan.tokenBudget.synthesis;
  return `${plan.recommendedTopology}|${totalBudget}`;
}

function matchesExpected(task: DeliberationTask): (output: string) => boolean {
  return (output: string) => {
    const [topologyStr, budgetStr] = output.split('|');
    const topology = topologyStr as OrchestrationTopology;
    const budget = Number(budgetStr);
    return (
      topology === task.correctTopology &&
      budget >= task.minTokenBudget &&
      budget <= task.maxTokenBudget
    );
  };
}

const taskSuite: DeliberationTask[] = [
  {
    id: 'single-factual',
    prompt: 'What is the capital of France?',
    goal: 'What is the capital of France?',
    correctTopology: 'SINGLE',
    minTokenBudget: 400,
    maxTokenBudget: 700,
  },
  {
    id: 'chain-reasoning',
    prompt:
      'Explain step by step why a recursive algorithm can exceed the call stack when processing deeply nested or unbounded input, how to detect the risk statically by analyzing input constraints, and how to convert the implementation into an iterative approach using an explicit stack or accumulator while preserving correctness and asymptotic complexity. Include concrete before-and-after code examples, discuss when tail-call optimization might help, and identify language runtime limits that affect the decision.',
    goal: 'Explain step by step why a recursive algorithm can exceed the call stack when processing deeply nested or unbounded input, how to detect the risk statically by analyzing input constraints, and how to convert the implementation into an iterative approach using an explicit stack or accumulator while preserving correctness and asymptotic complexity. Include concrete before-and-after code examples, discuss when tail-call optimization might help, and identify language runtime limits that affect the decision.',
    correctTopology: 'CHAIN',
    minTokenBudget: 1500,
    maxTokenBudget: 2500,
  },
  {
    id: 'dispatch-comparison',
    prompt:
      'Compare three leading vector databases side by side across query latency, recall@k, memory footprint, horizontal scaling behavior, licensing cost, and operational maturity. For each database, gather recent benchmark data, community maintenance signals, GitHub issue resolution velocity, and cloud-managed offering availability. Evaluate ingestion throughput, filter support, hybrid search capabilities, and multi-tenant isolation. Then produce a ranked recommendation with clear trade-off reasoning and a risk note for production deployment.',
    goal: 'Compare three leading vector databases side by side across query latency, recall@k, memory footprint, horizontal scaling behavior, licensing cost, and operational maturity. For each database, gather recent benchmark data, community maintenance signals, GitHub issue resolution velocity, and cloud-managed offering availability. Evaluate ingestion throughput, filter support, hybrid search capabilities, and multi-tenant isolation. Then produce a ranked recommendation with clear trade-off reasoning and a risk note for production deployment.',
    correctTopology: 'DISPATCH',
    minTokenBudget: 1500,
    maxTokenBudget: 2500,
  },
  {
    id: 'orchestrator-audit',
    prompt:
      'Research and analyze five competing database platforms across security, cost, compliance, and operational resilience dimensions. Synthesize a board-ready recommendation with migration risks and go/no-go criteria.',
    goal: 'Research and analyze five competing database platforms across security, cost, compliance, and operational resilience dimensions. Synthesize a board-ready recommendation with migration risks and go/no-go criteria.',
    context: {
      availableTools: [
        'cve_lookup',
        'benchmark_fetch',
        'soc2_scan',
        'sla_extractor',
        'failover_sim',
        'cost_model',
        'compliance_check',
        'migration_planner',
        'decision_matrix',
        'report_renderer',
      ],
    },
    correctTopology: 'ORCHESTRATOR',
    minTokenBudget: 3500,
    maxTokenBudget: 4500,
  },
  {
    id: 'dispatch-implementation',
    prompt:
      'Implement a robust, production-ready TypeScript function that parses a directory tree of JSON configuration files, validates each file against a shared JSON schema, normalizes environment-specific overrides with precedence rules, reports validation errors with precise line numbers and suggested fixes, and writes the merged configuration to disk atomically using a temporary file and rename. The function must handle malformed JSON gracefully, support recursive directory traversal with configurable depth limits, emit structured logs for each transformation step, and return a detailed summary of files processed, warnings, and skipped entries.',
    goal: 'Implement a robust, production-ready TypeScript function that parses a directory tree of JSON configuration files, validates each file against a shared JSON schema, normalizes environment-specific overrides with precedence rules, reports validation errors with precise line numbers and suggested fixes, and writes the merged configuration to disk atomically using a temporary file and rename. The function must handle malformed JSON gracefully, support recursive directory traversal with configurable depth limits, emit structured logs for each transformation step, and return a detailed summary of files processed, warnings, and skipped entries.',
    correctTopology: 'DISPATCH',
    minTokenBudget: 1500,
    maxTokenBudget: 2500,
  },
];

// Attach expected validators now that the suite is fully defined.
const taskSuiteWithExpected: DeliberationTask[] = taskSuite.map((task) => ({
  ...task,
  expected: matchesExpected(task),
}));

export const deliberationModule: BenchmarkModule = {
  id: 'deliberation',
  name: 'Deliberation Effectiveness',
  description:
    'Validates that deliberate() dynamically selects the correct topology and token budget based on goal characteristics, outperforming a fixed-topology baseline.',
  path: 'ultimate/deliberation.ts',
  baselineFactory: () => ({
    deliberate: (_goal: string, _context?: Record<string, unknown>) => ({
      recommendedTopology: 'CHAIN' as OrchestrationTopology,
      tokenBudget: { thinking: 1024, execution: 1024, synthesis: 1024 },
    }),
  }),
  treatmentFactory: () => ({
    deliberate: (goal: string, context?: Record<string, unknown>) => deliberate(goal, context),
  }),
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      deliberate: (goal: string, context?: Record<string, unknown>) => DeliberationPlan;
    };
    const deliberationTask = task as unknown as DeliberationTask;
    const plan = impl.deliberate(deliberationTask.goal, deliberationTask.context);
    return {
      output: serialize(plan),
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuiteWithExpected as unknown as Task[],
  metrics: ['successRate'],
};
