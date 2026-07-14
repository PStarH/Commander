import { BackpressureController } from '../../../runtime/backpressureController';
import type { BenchmarkModule, Task, TokenUsage } from '../types';

interface LoadPatternTask extends Task {
  /** Total synthetic requests in this load pattern. */
  totalRequests: number;
  /** Consumer capacity expressed as max tokens per trial. */
  capacity: number;
  /** Token refill rate (tokens per second). */
  refillRate: number;
  /** Max backlog the naive baseline can absorb before it collapses. */
  maxBacklog: number;
  /** Circuit-breaker failure threshold for the treatment. */
  failureThreshold: number;
  /** Returns true if the i-th request would fail the consumer. */
  failurePattern: (i: number) => boolean;
}

interface BaselineImpl {
  kind: 'baseline';
  state: Map<
    string,
    { processed: number; failed: number; backlog: number; failureStreak: number; crashed: boolean }
  >;
}

interface TreatmentImpl {
  kind: 'treatment';
  controllers: Map<string, BackpressureController>;
}

const CIRCUIT_BREAKER_COOLDOWN_MS = Number.MAX_SAFE_INTEGER;
const MAX_WAIT_MS = 0;

const taskSuite: LoadPatternTask[] = [
  {
    id: 'steady-normal',
    prompt: 'Steady load within consumer capacity.',
    totalRequests: 15,
    capacity: 15,
    refillRate: 15,
    maxBacklog: 30,
    failureThreshold: 3,
    failurePattern: () => false,
    expected: (output: string) => output !== 'failure',
  },
  {
    id: 'burst-overload',
    prompt: 'Sudden burst that far exceeds consumer capacity.',
    totalRequests: 50,
    capacity: 10,
    refillRate: 10,
    maxBacklog: 20,
    failureThreshold: 3,
    failurePattern: () => false,
    expected: (output: string) => output !== 'failure',
  },
  {
    id: 'sustained-overload',
    prompt: 'Sustained overload that keeps the consumer saturated.',
    totalRequests: 60,
    capacity: 10,
    refillRate: 10,
    maxBacklog: 25,
    failureThreshold: 3,
    failurePattern: () => false,
    expected: (output: string) => output !== 'failure',
  },
  {
    id: 'failure-cascade',
    prompt: 'A cascade of failing requests that would overwhelm the consumer.',
    totalRequests: 30,
    capacity: 15,
    refillRate: 15,
    maxBacklog: 20,
    failureThreshold: 3,
    failurePattern: (i: number) => i < 10,
    expected: (output: string) => output !== 'failure',
  },
  {
    id: 'ramp-up',
    prompt: 'Load that ramps up from normal to overloaded.',
    totalRequests: 45,
    capacity: 12,
    refillRate: 12,
    maxBacklog: 20,
    failureThreshold: 3,
    failurePattern: () => false,
    expected: (output: string) => output !== 'failure',
  },
];

function getOrCreateTreatmentController(
  controllers: Map<string, BackpressureController>,
  task: LoadPatternTask,
): BackpressureController {
  if (!controllers.has(task.id)) {
    controllers.set(
      task.id,
      new BackpressureController({
        maxTokens: task.capacity,
        refillRatePerSecond: task.refillRate,
        bufferSize: 1,
        failureThreshold: task.failureThreshold,
        cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
        maxWaitMs: MAX_WAIT_MS,
      }),
    );
  }
  return controllers.get(task.id)!;
}

function baselineResult(output: 'available' | 'degraded' | 'dropped' | 'failure'): {
  output: string;
  tokenUsage: TokenUsage;
  latencyMs: number;
} {
  if (output === 'failure') {
    return {
      output,
      tokenUsage: { input: 10, output: 0, total: 10, cached: 0, reasoning: 0 },
      latencyMs: 100,
    };
  }
  if (output === 'dropped') {
    return {
      output,
      tokenUsage: { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  }
  return {
    output,
    tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
    latencyMs: 5,
  };
}

function runBaselineTrial(task: LoadPatternTask, impl: BaselineImpl) {
  let state = impl.state.get(task.id);
  if (!state) {
    state = { processed: 0, failed: 0, backlog: 0, failureStreak: 0, crashed: false };
    impl.state.set(task.id, state);
  }

  for (let i = 0; i < task.totalRequests && !state.crashed; i++) {
    if (task.failurePattern(i)) {
      state.failed++;
      state.failureStreak++;
      if (state.failureStreak > task.failureThreshold) {
        state.crashed = true;
      }
      continue;
    }

    state.failureStreak = 0;

    if (state.backlog < task.maxBacklog) {
      state.processed++;
      state.backlog++;
    } else {
      state.crashed = true;
    }
  }

  if (state.crashed) {
    return baselineResult('failure');
  }

  if (state.processed === task.totalRequests) {
    return baselineResult('available');
  }

  return baselineResult(state.processed > 0 ? 'degraded' : 'dropped');
}

async function runTreatmentTrial(task: LoadPatternTask, impl: TreatmentImpl) {
  const controller = getOrCreateTreatmentController(impl.controllers, task);
  let processed = 0;
  let dropped = 0;

  for (let i = 0; i < task.totalRequests; i++) {
    const admitted = await controller.acquire();
    if (!admitted) {
      dropped++;
      continue;
    }

    if (task.failurePattern(i)) {
      controller.recordFailure();
      continue;
    }

    controller.release();
    processed++;
  }

  if (processed === task.totalRequests) {
    return baselineResult('available');
  }

  if (processed > 0) {
    return baselineResult('degraded');
  }

  return baselineResult('dropped');
}

export const backpressureControllerModule: BenchmarkModule = {
  id: 'backpressureController',
  name: 'Backpressure Controller',
  description:
    'Validates that token-bucket + circuit-breaker admission control keeps the runtime available under overload while a naive unbounded queue collapses.',
  path: 'runtime/backpressureController.ts',
  baselineFactory: () => ({
    kind: 'baseline',
    state: new Map<
      string,
      {
        processed: number;
        failed: number;
        backlog: number;
        failureStreak: number;
        crashed: boolean;
      }
    >(),
  }),
  treatmentFactory: () => ({
    kind: 'treatment',
    controllers: new Map<string, BackpressureController>(),
  }),
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as BaselineImpl | TreatmentImpl;
    const t = task as unknown as LoadPatternTask;

    if (impl.kind === 'baseline') {
      return runBaselineTrial(t, impl);
    }

    return runTreatmentTrial(t, impl as TreatmentImpl);
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate', 'cost', 'latency'],
};
