import { ProviderFallbackChain, ProviderEntry } from '../../../runtime/providerFallbackChain';
import type { BenchmarkModule, Task } from '../types';

interface ProviderTask extends Task {
  answer: string;
}

const taskSuite: ProviderTask[] = [
  {
    id: 'arithmetic-add',
    prompt: 'What is 2 + 2?',
    answer: '4',
    expected: (output: string) => output.includes('4'),
  },
  {
    id: 'string-concat',
    prompt: 'Concatenate "a" and "b"',
    answer: 'ab',
    expected: (output: string) => output.includes('ab'),
  },
  {
    id: 'string-uppercase',
    prompt: 'Convert "hello" to uppercase',
    answer: 'HELLO',
    expected: (output: string) => output.includes('HELLO'),
  },
  {
    id: 'string-reverse',
    prompt: 'Reverse "abc"',
    answer: 'cba',
    expected: (output: string) => output.includes('cba'),
  },
  {
    id: 'count-letters',
    prompt: 'Count the letters in "cat"',
    answer: '3',
    expected: (output: string) => output.includes('3'),
  },
];

interface SyntheticProvider {
  name: string;
  shouldFail: (trialIndex: number) => boolean;
}

interface FallbackImpl {
  chain: ProviderFallbackChain<string>;
  providers: SyntheticProvider[];
  trialIndex: number;
}

function createImplementation(providers: SyntheticProvider[]): FallbackImpl {
  return {
    chain: new ProviderFallbackChain<string>(),
    providers,
    trialIndex: 0,
  };
}

export const providerFallbackChainModule: BenchmarkModule = {
  id: 'providerFallbackChain',
  name: 'Provider Fallback Chain',
  description:
    'Validates that an ordered provider fallback chain recovers when the primary provider fails.',
  path: 'runtime/providerFallbackChain.ts',
  baselineFactory: () =>
    createImplementation([
      // Primary provider: fails 80% of the time deterministically.
      { name: 'primary', shouldFail: (i) => i % 5 !== 0 },
    ]),
  treatmentFactory: () =>
    createImplementation([
      { name: 'primary', shouldFail: (i) => i % 5 !== 0 },
      { name: 'backup', shouldFail: (i) => i % 10 === 0 },
      { name: 'tertiary', shouldFail: (i) => i % 20 === 0 },
      { name: 'quaternary', shouldFail: (i) => i % 50 === 0 },
      { name: 'quinary', shouldFail: () => false },
    ]),
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as FallbackImpl;
    const t = task as unknown as ProviderTask;
    const trialIndex = impl.trialIndex++;

    const providers: ProviderEntry<string>[] = impl.providers.map((cfg) => ({
      name: cfg.name,
      attempt: async () => {
        if (cfg.shouldFail(trialIndex)) {
          throw new Error(`provider ${cfg.name} unavailable`);
        }
        return t.answer;
      },
    }));

    try {
      const { result } = await impl.chain.tryProviders(providers);
      return {
        output: result,
        tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
        latencyMs: 1,
      };
    } catch {
      return {
        output: '',
        tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
        latencyMs: 1,
      };
    }
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
