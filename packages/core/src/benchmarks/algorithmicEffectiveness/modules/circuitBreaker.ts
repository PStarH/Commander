import { CircuitBreaker } from '../../../runtime/circuitBreaker';
import type { BenchmarkModule, Task } from '../types';

interface ProviderSequenceTask extends Task {
  sequence: boolean[];
}

interface BaselineImpl {
  counters: Map<string, number>;
}

interface TreatmentImpl {
  counters: Map<string, number>;
  breakers: Map<string, CircuitBreaker>;
}

const THRESHOLD = 3;
const RECOVERY_TIME_MS = Number.MAX_SAFE_INTEGER;

function createSequence(length: number, generator: (i: number) => boolean): boolean[] {
  return Array.from({ length }, (_, i) => generator(i));
}

const taskSuite: ProviderSequenceTask[] = [
  {
    id: 'permanent-outage',
    prompt: 'Call a provider that is permanently unavailable.',
    sequence: createSequence(200, () => false),
    expected: (output: string) => output === 'success' || output === 'circuit_open',
  },
  {
    id: 'long-degradation',
    prompt: 'Call a provider during an extended degradation window.',
    sequence: createSequence(200, (i) => i >= 190),
    expected: (output: string) => output === 'success' || output === 'circuit_open',
  },
  {
    id: 'burst-failure',
    prompt: 'Call a provider that fails in bursts.',
    sequence: createSequence(200, (i) => {
      const phase = i % 12;
      return phase >= 10;
    }),
    expected: (output: string) => output === 'success' || output === 'circuit_open',
  },
  {
    id: 'intermittent-flakiness',
    prompt: 'Call a provider with intermittent flakiness.',
    sequence: createSequence(200, (i) => i % 2 === 0),
    expected: (output: string) => output === 'success' || output === 'circuit_open',
  },
  {
    id: 'recovery-after-outage',
    prompt: 'Call a provider that recovers after a sustained outage.',
    sequence: createSequence(200, (i) => i >= 50),
    expected: (output: string) => output === 'success' || output === 'circuit_open',
  },
];

function getProviderOutcome(
  task: ProviderSequenceTask,
  impl: { counters: Map<string, number> },
): boolean {
  const index = impl.counters.get(task.id) ?? 0;
  impl.counters.set(task.id, index + 1);
  return task.sequence[index % task.sequence.length];
}

function successOutput(): {
  output: string;
  tokenUsage: { input: number; output: number; total: number; cached: number; reasoning: number };
  latencyMs: number;
} {
  return {
    output: 'success',
    tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
    latencyMs: 10,
  };
}

function failureOutput(): {
  output: string;
  tokenUsage: { input: number; output: number; total: number; cached: number; reasoning: number };
  latencyMs: number;
} {
  return {
    output: 'failure',
    tokenUsage: { input: 1, output: 0, total: 1, cached: 0, reasoning: 0 },
    latencyMs: 50,
  };
}

function skippedOutput(): {
  output: string;
  tokenUsage: { input: number; output: number; total: number; cached: number; reasoning: number };
  latencyMs: number;
} {
  return {
    output: 'circuit_open',
    tokenUsage: { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 },
    latencyMs: 1,
  };
}

export const circuitBreakerModule: BenchmarkModule = {
  id: 'circuitBreaker',
  name: 'Circuit Breaker',
  description:
    'Validates that a circuit breaker stops hammering a failing provider once it opens, while a baseline without protection keeps attempting calls.',
  path: 'runtime/circuitBreaker.ts',
  baselineFactory: () => ({
    counters: new Map<string, number>(),
  }),
  treatmentFactory: () => ({
    counters: new Map<string, number>(),
    breakers: new Map<string, CircuitBreaker>(),
  }),
  runTrial: async ({ implementation, task }) => {
    const t = task as unknown as ProviderSequenceTask;
    const providerSucceeds = getProviderOutcome(t, implementation as BaselineImpl & TreatmentImpl);

    // Baseline: always attempt the call, no circuit breaker protection.
    if (!('breakers' in implementation)) {
      return providerSucceeds ? successOutput() : failureOutput();
    }

    // Treatment: use a circuit breaker per task.
    const impl = implementation as TreatmentImpl;
    if (!impl.breakers.has(t.id)) {
      impl.breakers.set(t.id, new CircuitBreaker(THRESHOLD, RECOVERY_TIME_MS, 1));
    }
    const breaker = impl.breakers.get(t.id)!;

    if (!breaker.isAvailable()) {
      return skippedOutput();
    }

    if (providerSucceeds) {
      breaker.onSuccess();
      return successOutput();
    }

    breaker.onFailure();
    return failureOutput();
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
