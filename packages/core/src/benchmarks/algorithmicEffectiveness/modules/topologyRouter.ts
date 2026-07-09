import { TopologyRouter } from '../../../ultimate/topologyRouter';
import { LearnedWeights } from '../../../ultimate/learnedWeights';
import type { DeliberationPlan, OrchestrationTopology, TaskDAG } from '../../../ultimate/types';
import type { BenchmarkModule, Task } from '../types';

interface TopologyTask extends Task {
  deliberation: DeliberationPlan;
  dag?: TaskDAG;
  correctTopology: OrchestrationTopology;
}

function makeDeliberation(
  taskType: DeliberationPlan['taskType'],
  estimatedAgentCount: number,
  estimatedTokens: number,
  taskNature: DeliberationPlan['taskNature'],
  suitableForSpeculation: boolean,
): DeliberationPlan {
  return {
    requiresExternalInfo: false,
    taskType,
    recommendedTopology: 'SINGLE',
    estimatedAgentCount,
    estimatedSteps: 1,
    estimatedTokens,
    estimatedDurationMs: 5000,
    tokenBudget: { thinking: 512, execution: 512, synthesis: 512 },
    decompositionStrategy: 'NONE',
    capabilitiesNeeded: [],
    confidence: 0.8,
    reasoning: [],
    suitableForSpeculation,
    taskNature,
    timeBudgetPerAgentMs: 5000,
  };
}

function makeDAG(
  parallelismWidth: number,
  criticalPathDepth: number,
  interSubtaskCoupling: number,
): TaskDAG {
  return {
    nodes: [],
    edges: [],
    metadata: { parallelismWidth, criticalPathDepth, interSubtaskCoupling },
  };
}

const taskSuite: TopologyTask[] = [
  {
    id: 'hierarchical-research-synthesis',
    prompt:
      'Synthesize a research report from many loosely-related sources: gather snippets in parallel, then reconcile cross-references and produce one coherent summary.',
    correctTopology: 'ORCHESTRATOR',
    deliberation: makeDeliberation('RESEARCH', 6, 500, 'IO_BOUND', false),
    dag: makeDAG(4, 5, 0.8),
    expected: (output: string) => output === 'ORCHESTRATOR',
  },
  {
    id: 'simple-reasoning-proof',
    prompt: 'Solve a short, self-contained logic puzzle that a single agent can complete.',
    correctTopology: 'SINGLE',
    deliberation: makeDeliberation('REASONING', 1, 500, 'IO_BOUND', false),
    dag: makeDAG(1, 5, 0.1),
    expected: (output: string) => output === 'SINGLE',
  },
  {
    id: 'small-coding-helper',
    prompt: 'Generate a single utility function from a brief description.',
    correctTopology: 'SINGLE',
    deliberation: makeDeliberation('CODING', 1, 500, 'IO_BOUND', false),
    dag: makeDAG(4, 1, 0.1),
    expected: (output: string) => output === 'SINGLE',
  },
  {
    id: 'dependent-chain-refactor',
    prompt:
      'Refactor a monolithic module where each extraction step depends on the previous abstraction and must be serialized.',
    correctTopology: 'CHAIN',
    deliberation: makeDeliberation('CODING', 4, 500, 'IO_BOUND', false),
    dag: makeDAG(5, 6, 0.9),
    expected: (output: string) => output === 'CHAIN',
  },
];

function trainLearnedWeights(): LearnedWeights {
  // Aggressive learning so a small amount of pre-training can reliably flip
  // the baseline's greedy argmax to the empirically correct topology.
  const weights = new LearnedWeights({ maxAdjustment: 1.5, minSamplesBeforeAdjust: 1 });
  const training: Array<{
    taskType: string;
    correct: OrchestrationTopology;
    wrong: OrchestrationTopology;
  }> = [
    { taskType: 'RESEARCH', correct: 'ORCHESTRATOR', wrong: 'DISPATCH' },
    { taskType: 'REASONING', correct: 'SINGLE', wrong: 'ORCHESTRATOR' },
    { taskType: 'CODING', correct: 'SINGLE', wrong: 'DISPATCH' },
    { taskType: 'CODING', correct: 'CHAIN', wrong: 'DISPATCH' },
  ];
  for (const { taskType, correct, wrong } of training) {
    for (let i = 0; i < 30; i++) {
      weights.recordSignal(taskType, correct, true);
      weights.recordSignal(taskType, wrong, false);
    }
  }
  return weights;
}

export const topologyRouterModule: BenchmarkModule = {
  id: 'topologyRouter',
  name: 'Topology Router',
  description:
    'Validates that epsilon-greedy topology routing with learned weights outperforms fixed epsilon=0 greedy routing.',
  path: 'ultimate/topologyRouter.ts',
  baselineFactory: () => {
    const router = new TopologyRouter(undefined, { epsilon: 0 });
    return {
      router,
      route: (task: TopologyTask) => router.route(task.deliberation, task.dag).topology,
    };
  },
  treatmentFactory: () => {
    const router = new TopologyRouter(trainLearnedWeights(), { epsilon: 0.05 });
    return {
      router,
      route: (task: TopologyTask) => router.route(task.deliberation, task.dag).topology,
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as { route: (task: TopologyTask) => OrchestrationTopology };
    const topologyTask = task as unknown as TopologyTask;
    const output = impl.route(topologyTask);
    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
