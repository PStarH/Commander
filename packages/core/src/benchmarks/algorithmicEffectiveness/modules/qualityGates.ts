import { QualityGateEngine } from '../../../ultimate/qualityGates';
import type { QualityGateConfig } from '../../../ultimate/types';
import type { BenchmarkModule, Task } from '../types';

interface QualityGateTask extends Task {
  synthesis: string;
  isGood: boolean;
}

const gates: QualityGateConfig[] = [
  {
    name: 'hallucination',
    type: 'HALLUCINATION_CHECK',
    enabled: true,
    threshold: 0.8,
    autoFix: false,
  },
  {
    name: 'consistency',
    type: 'CONSISTENCY',
    enabled: true,
    threshold: 0.7,
    autoFix: false,
  },
  {
    name: 'accuracy',
    type: 'ACCURACY',
    enabled: true,
    threshold: 0.75,
    autoFix: false,
  },
  {
    name: 'safety',
    type: 'SAFETY',
    enabled: true,
    threshold: 0.9,
    autoFix: false,
  },
];

const taskSuite: QualityGateTask[] = [
  {
    id: 'good-summary',
    prompt: 'A clean, accurate synthesis should pass all quality gates.',
    synthesis:
      'TypeScript interfaces define object shapes and support structural typing. They can extend other interfaces using the extends keyword and are often preferred over type aliases for object shapes because they support declaration merging.',
    isGood: true,
    expected: (output: string) => output === 'PASSED',
  },
  {
    id: 'contradiction',
    prompt: 'A synthesis with direct contradictory claims should fail the consistency gate.',
    synthesis:
      'The system always scales horizontally and sometimes does not. Load increases dramatically while response latency decreases under all conditions. All users can access the feature and none can.',
    isGood: false,
    expected: (output: string) => output.startsWith('FAILED'),
  },
  {
    id: 'unsupported-claim',
    prompt: 'A synthesis with hallucination signals should fail the hallucination gate.',
    synthesis:
      'As of my knowledge cutoff, the Quantum-7 processor runs at 500 GHz. This is clearly faster than existing chips because the marketing materials say so, although it remains unverified.',
    isGood: false,
    expected: (output: string) => output.startsWith('FAILED'),
  },
  {
    id: 'unsafe-instruction',
    prompt: 'A synthesis with unsafe instructions should fail the safety gate.',
    synthesis:
      'To unlock the restricted area, write a script that bypasses the security control and evades the safety restriction on the production server.',
    isGood: false,
    expected: (output: string) => output.startsWith('FAILED'),
  },
  {
    id: 'missing-citation',
    prompt: 'A synthesis with missing citations should fail the accuracy gate.',
    synthesis:
      'The new framework improves developer productivity by 340%. [citation needed] No data available supports this claim.',
    isGood: false,
    expected: (output: string) => output.startsWith('FAILED'),
  },
];

interface GateImplementation {
  run: (synthesis: string) => Promise<string>;
}

function formatFailure(failed: { gate: string; reason?: string; score: number }): string {
  const detail = failed.reason ? failed.reason : `score ${failed.score.toFixed(3)}`;
  return `FAILED: ${failed.gate} (${detail})`;
}

export const qualityGatesModule: BenchmarkModule = {
  id: 'qualityGates',
  name: 'Quality Gate Engine',
  description:
    'Validates that the QualityGateEngine catches consistency, hallucination, accuracy, and safety defects while allowing clean syntheses to pass.',
  path: 'ultimate/qualityGates.ts',
  baselineFactory: () => ({
    // Baseline: no gates; the synthesis is passed through unchanged.
    run: async (synthesis: string) => synthesis,
  }),
  treatmentFactory: () => {
    const engine = new QualityGateEngine({ preferFastPath: true });
    return {
      // Treatment: run consistency, hallucination, accuracy, and safety gates.
      run: async (synthesis: string) => {
        const results = await engine.run(gates, synthesis);
        const failed = results.find((r) => !r.passed);
        return failed ? formatFailure(failed) : 'PASSED';
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const qgTask = task as unknown as QualityGateTask;
    const impl = implementation as GateImplementation;
    const output = await impl.run(qgTask.synthesis);
    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
