import { classifyEffortLevel, selectTopologyForEffort } from '../../../ultimate/effortScaler';
import type { OrchestrationTopology } from '../../../ultimate/types';
import type { BenchmarkModule, Task } from '../types';

interface EffortTask extends Task {
  goal: string;
  dag?: {
    parallelismWidth: number;
    criticalPathDepth: number;
    interSubtaskCoupling: number;
  };
  correctTopology: OrchestrationTopology;
}

const taskSuite: EffortTask[] = [
  {
    id: 'simple-single-helper',
    prompt:
      'Write a concise one-line helper that trims leading and trailing whitespace from a string and returns the cleaned result, without any extra validation or explanation.',
    goal: 'Write a concise one-line helper that trims leading and trailing whitespace from a string and returns the cleaned result, without any extra validation or explanation.',
    correctTopology: 'SINGLE',
    dag: { parallelismWidth: 1, criticalPathDepth: 1, interSubtaskCoupling: 0.1 },
    expected: (output: string) => output === 'SINGLE',
  },
  {
    id: 'moderate-dispatch-comparison',
    prompt:
      'Compare four competing authentication libraries across security, performance, license compatibility, and community maintenance. For each library, gather release history, CVE counts, benchmark results, and GitHub activity, then produce a ranked recommendation with concise justification.',
    goal: 'Compare four competing authentication libraries across security, performance, license compatibility, and community maintenance. For each library, gather release history, CVE counts, benchmark results, and GitHub activity, then produce a ranked recommendation with concise justification.',
    correctTopology: 'DISPATCH',
    dag: { parallelismWidth: 5, criticalPathDepth: 2, interSubtaskCoupling: 0.2 },
    expected: (output: string) => output === 'DISPATCH',
  },
  {
    id: 'complex-chain-report',
    prompt:
      'Produce a comprehensive quarterly engineering report that weaves together incident post-mortems, reliability metrics, roadmap progress, and headcount planning. The narrative must cross-reference incidents to roadmap delays, map reliability trends to staffing decisions, and maintain a single coherent storyline suitable for executive review.',
    goal: 'Produce a comprehensive quarterly engineering report that weaves together incident post-mortems, reliability metrics, roadmap progress, and headcount planning. The narrative must cross-reference incidents to roadmap delays, map reliability trends to staffing decisions, and maintain a single coherent storyline suitable for executive review.',
    correctTopology: 'CHAIN',
    dag: { parallelismWidth: 2, criticalPathDepth: 4, interSubtaskCoupling: 0.85 },
    expected: (output: string) => output === 'CHAIN',
  },
  {
    id: 'deep-research-dispatch',
    prompt:
      'Conduct a deep literature and code review on self-evolving multi-agent systems. Search academic sources, open-source repositories, and vendor documentation for at least twelve distinct approaches. Summarize each approach, identify common failure modes, compare evaluation methodologies, and synthesize a research agenda that highlights the most promising open problems and reproducible baselines.',
    goal: 'Conduct a deep literature and code review on self-evolving multi-agent systems. Search academic sources, open-source repositories, and vendor documentation for at least twelve distinct approaches. Summarize each approach, identify common failure modes, compare evaluation methodologies, and synthesize a research agenda that highlights the most promising open problems and reproducible baselines.',
    correctTopology: 'DISPATCH',
    dag: { parallelismWidth: 6, criticalPathDepth: 2, interSubtaskCoupling: 0.3 },
    expected: (output: string) => output === 'DISPATCH',
  },
];

function baselineSelect(goal: string): OrchestrationTopology {
  // Naive heuristic: any non-trivial goal is routed to the heaviest topology.
  // This is the common anti-pattern the treatment is designed to beat.
  const keywordCount = goal.split(/\s+/).length;
  if (goal.length > 100 || keywordCount > 15) {
    return 'ORCHESTRATOR';
  }
  return 'SINGLE';
}

function treatmentSelect(goal: string, dag?: EffortTask['dag']): OrchestrationTopology {
  const level = classifyEffortLevel(goal, {
    toolCount: dag?.parallelismWidth,
    depth: dag?.criticalPathDepth,
  });
  return selectTopologyForEffort(level, dag);
}

export const effortScalerModule: BenchmarkModule = {
  id: 'effortScaler',
  name: 'Effort Scaler',
  description:
    'Validates that effort-aware topology selection with DAG hints outperforms a naive length/keyword heuristic.',
  path: 'ultimate/effortScaler.ts',
  baselineFactory: () => ({
    select: (task: EffortTask) => baselineSelect(task.goal),
  }),
  treatmentFactory: () => ({
    select: (task: EffortTask) => treatmentSelect(task.goal, task.dag),
  }),
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as { select: (task: EffortTask) => OrchestrationTopology };
    const effortTask = task as unknown as EffortTask;
    const output = impl.select(effortTask);
    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
