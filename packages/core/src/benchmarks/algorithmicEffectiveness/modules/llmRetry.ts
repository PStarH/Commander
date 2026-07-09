import { classifyLLMError, computeBackoff } from '../../../runtime/llmRetry';
import type { BenchmarkModule, Task, TokenUsage } from '../types';

interface Scenario {
  error: unknown;
  successOnAttempt: number;
}

function makeError(message: string, status?: number): Error {
  const err = new Error(message);
  if (status !== undefined) {
    (err as unknown as { status: number }).status = status;
  }
  return err;
}

const SCENARIOS: Record<string, Scenario> = {
  'rate-limit': {
    error: makeError('Rate limit exceeded', 429),
    successOnAttempt: 3,
  },
  'auth-error': {
    error: makeError('Invalid API key', 401),
    successOnAttempt: 0,
  },
  'timeout': {
    error: makeError('Request timeout'),
    successOnAttempt: 2,
  },
  'server-error': {
    error: makeError('Internal server error', 500),
    successOnAttempt: 2,
  },
};

const MAX_ATTEMPTS = 5;
const BASELINE_FIXED_DELAY_MS = 1000;
const TOKENS_PER_ATTEMPT: TokenUsage = {
  input: 10,
  output: 10,
  total: 20,
  cached: 0,
  reasoning: 0,
};

function simulateCall(task: Task, attempt: number): { output: string } {
  const scenario = SCENARIOS[task.id];
  if (!scenario) {
    throw new Error(`Unknown retry scenario: ${task.id}`);
  }
  if (scenario.successOnAttempt > 0 && attempt === scenario.successOnAttempt) {
    return { output: 'success' };
  }
  throw scenario.error;
}

function multiplyTokens(tokens: TokenUsage, attempts: number): TokenUsage {
  return {
    input: tokens.input * attempts,
    output: tokens.output * attempts,
    total: tokens.total * attempts,
    cached: tokens.cached,
    reasoning: tokens.reasoning,
  };
}

interface RetryImplementation {
  call(task: Task): { output: string; attempts: number; latencyMs: number };
}

function runBaseline(task: Task): { output: string; attempts: number; latencyMs: number } {
  let attempts = 0;
  let latencyMs = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const result = simulateCall(task, attempts);
      return { output: result.output, attempts, latencyMs };
    } catch {
      latencyMs += BASELINE_FIXED_DELAY_MS;
    }
  }

  return { output: `failed after ${attempts} attempts`, attempts, latencyMs };
}

function runTreatment(task: Task): { output: string; attempts: number; latencyMs: number } {
  let attempts = 0;
  let latencyMs = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const result = simulateCall(task, attempts);
      return { output: result.output, attempts, latencyMs };
    } catch (err) {
      const classified = classifyLLMError(err);
      if (!classified.retryable) {
        return { output: `gave up: ${classified.message}`, attempts, latencyMs };
      }
      latencyMs += computeBackoff(attempts - 1);
    }
  }

  return { output: `failed after ${attempts} attempts`, attempts, latencyMs };
}

const taskSuite: Task[] = [
  {
    id: 'rate-limit',
    prompt: 'Call an LLM endpoint that returns a 429 rate limit error.',
    expected: (output: string) => output === 'success',
  },
  {
    id: 'auth-error',
    prompt: 'Call an LLM endpoint that returns a 401 authentication error.',
    expected: (output: string) => output === 'success',
  },
  {
    id: 'timeout',
    prompt: 'Call an LLM endpoint that times out before responding.',
    expected: (output: string) => output === 'success',
  },
  {
    id: 'server-error',
    prompt: 'Call an LLM endpoint that returns a 500 internal server error.',
    expected: (output: string) => output === 'success',
  },
];

export const llmRetryModule: BenchmarkModule = {
  id: 'llmRetry',
  name: 'LLM Retry',
  description:
    'Validates that error-classification-aware retries with exponential backoff outperform a naive fixed-delay retry loop.',
  path: 'runtime/llmRetry.ts',
  baselineFactory: () => ({ call: runBaseline }),
  treatmentFactory: () => ({ call: runTreatment }),
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as RetryImplementation;
    const { output, attempts, latencyMs } = impl.call(task);
    return {
      output,
      tokenUsage: multiplyTokens(TOKENS_PER_ATTEMPT, attempts),
      latencyMs,
    };
  },
  taskSuite,
  metrics: ['successRate', 'latency', 'cost'],
};
