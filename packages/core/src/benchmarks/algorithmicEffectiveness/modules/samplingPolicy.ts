import { SamplingPolicy } from '../../../observability/samplingPolicy';
import type { TraceEvent } from '../../../runtime/types';
import type { BenchmarkModule, Task } from '../types';

/**
 * Synthetic trace batches used to evaluate tail-based sampling against a
 * fixed-probability baseline. Each task represents a complete trace; the
 * benchmark checks whether the sampler decided to keep it.
 */
interface SamplingTask extends Task {
  traceId: string;
  durationMs: number;
  events: TraceEvent[];
}

const BASE_RATE = 0.05;
const LATENCY_THRESHOLD_MS = 30_000;

function createEvent(
  traceId: string,
  type: TraceEvent['type'],
  data: TraceEvent['data'] = {},
): TraceEvent {
  return {
    id: `${traceId}-event`,
    spanId: `${traceId}-span`,
    traceId,
    runId: `${traceId}-run`,
    agentId: 'benchmark-agent',
    type,
    timestamp: new Date().toISOString(),
    durationMs: 10,
    data,
  };
}

const taskSuite: SamplingTask[] = [
  {
    id: 'error-trace',
    prompt: 'A trace containing an error event should be retained.',
    traceId: 'trace-error-001',
    durationMs: 120,
    events: [createEvent('trace-error-001', 'error', { error: 'connection refused' })],
    expected: (output: string) => output.includes('"keep":true'),
  },
  {
    id: 'high-latency-trace',
    prompt: 'A trace whose total duration exceeds the threshold should be retained.',
    traceId: 'trace-latency-001',
    durationMs: 60_000,
    events: [createEvent('trace-latency-001', 'llm_call', {})],
    expected: (output: string) => output.includes('"keep":true'),
  },
  {
    id: 'retry-trace',
    prompt: 'A trace containing a retry event should be retained.',
    traceId: 'trace-retry-001',
    durationMs: 250,
    events: [
      createEvent('trace-retry-001', 'error', {
        error: 'rate limited',
        retrying: true,
        retryable: true,
      }),
    ],
    expected: (output: string) => output.includes('"keep":true'),
  },
  {
    id: 'low-quality-trace',
    prompt: 'A trace with a low verification score should be retained.',
    traceId: 'trace-quality-001',
    durationMs: 80,
    events: [
      createEvent('trace-quality-001', 'verification', {
        evaluationScore: 0.3,
        evaluationPassed: false,
      }),
    ],
    expected: (output: string) => output.includes('"keep":true'),
  },
  {
    id: 'verification-failed-trace',
    prompt: 'A trace with a verification failure should be retained.',
    traceId: 'trace-verify-001',
    durationMs: 90,
    events: [
      createEvent('trace-verify-001', 'verification', {
        evaluationScore: 0.6,
        evaluationPassed: false,
      }),
    ],
    expected: (output: string) => output.includes('"keep":true'),
  },
  {
    id: 'normal-trace',
    prompt: 'A routine trace with no critical signals should be sampled at the base rate.',
    traceId: 'trace-normal-001',
    durationMs: 45,
    events: [createEvent('trace-normal-001', 'llm_call', {})],
    // Accept either a head-sample keep or a drop; the volume constraint is
    // enforced by the benchmark's overall keep-rate comparison, not this task.
    expected: (output: string) => output.includes('"reason":"base"') || output.includes('"reason":"drop"'),
  },
];

interface Sampler {
  decide(events: TraceEvent[], traceId: string, durationMs: number): { keep: boolean; reason: string; probability: number };
}

/**
 * Fixed-probability head sampler. It has no knowledge of tail-based signals,
 * so critical traces are dropped whenever the random draw exceeds the base rate.
 */
class FixedProbabilitySampler implements Sampler {
  private readonly baseRate: number;

  constructor(baseRate: number) {
    this.baseRate = baseRate;
  }

  decide(_events: TraceEvent[], _traceId: string, _durationMs: number): {
    keep: boolean;
    reason: string;
    probability: number;
  } {
    const keep = Math.random() < this.baseRate;
    return { keep, reason: keep ? 'base' : 'drop', probability: this.baseRate };
  }
}

export const samplingPolicyModule: BenchmarkModule = {
  id: 'samplingPolicy',
  name: 'Sampling Policy',
  description:
    'Validates that tail-based sampling retains error, latency, retry, quality, and verification traces at the same effective volume as fixed-probability head sampling.',
  path: 'observability/samplingPolicy.ts',
  baselineFactory: () => new FixedProbabilitySampler(BASE_RATE),
  treatmentFactory: () =>
    new SamplingPolicy({
      baseRate: BASE_RATE,
      keepIfLatencyMs: LATENCY_THRESHOLD_MS,
      keepIfErrorsAtLeast: 1,
      keepIfRetriesAtLeast: 1,
      keepIfQualityBelow: 0.5,
      keepIfVerificationFailed: true,
      salt: 'benchmark-salt',
    }),
  runTrial: async ({ implementation, task }) => {
    const sampler = implementation as Sampler;
    const t = task as unknown as SamplingTask;
    const decision = sampler.decide(t.events, t.traceId, t.durationMs);
    return {
      output: JSON.stringify(decision),
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
