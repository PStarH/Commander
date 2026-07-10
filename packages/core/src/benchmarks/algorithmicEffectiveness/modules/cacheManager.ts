import { CacheManager } from '../../../runtime/cacheManager';
import type { BenchmarkModule, LLMClient, Task, TokenUsage } from '../types';
import type { LLMRequest, LLMResponse } from '../../../runtime/types';
import type { ToolCall, ToolResult } from '../../../runtime/types';

/**
 * Scripted responses used by both baseline and treatment. The treatment gains
 * its advantage by caching these deterministic responses instead of recomputing
 * (i.e. re-invoking the scripted LLM) on every request.
 */
export const SCRIPTED_RESPONSES: Record<string, string> = {
  'What is the capital of France?':
    'The capital of France is Paris, known for the Eiffel Tower and rich history.',
  'Tell me the capital city of France.':
    'The capital city of France is Paris, known for the Eiffel Tower and rich history.',
  'List three benefits of unit testing.':
    'Three benefits of unit testing are regression detection, design feedback, and living documentation.',
  'What are three advantages of unit testing?':
    'Three advantages of unit testing are regression detection, design feedback, and living documentation.',
  'Explain the benefits of caching in one sentence.':
    'Caching reduces latency and cost by avoiding redundant computation.',
};

const MODEL = 'benchmark-gpt-4o';

interface SequenceStep {
  type: 'llm' | 'tool' | 'concurrent';
  query?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  /** Single-flight key for concurrent LLM steps. */
  key?: string;
  /** Number of identical in-flight requests to fire concurrently. */
  concurrency?: number;
}

interface CacheManagerTask extends Task {
  sequence: SequenceStep[];
}

const SEQUENCES: Record<string, SequenceStep[]> = {
  'semantic-repeat': [
    { type: 'llm', query: 'What is the capital of France?' },
    { type: 'llm', query: 'What is the capital of France?' },
    { type: 'llm', query: 'Tell me the capital city of France.' },
    { type: 'llm', query: 'What is the capital of France?' },
  ],
  'semantic-paraphrase': [
    { type: 'llm', query: 'List three benefits of unit testing.' },
    { type: 'llm', query: 'What are three advantages of unit testing?' },
    { type: 'llm', query: 'List three benefits of unit testing.' },
    { type: 'llm', query: 'List three benefits of unit testing.' },
  ],
  'tool-repeat': [
    { type: 'tool', toolName: 'weather_lookup', args: { city: 'Paris' } },
    { type: 'tool', toolName: 'weather_lookup', args: { city: 'Paris' } },
    { type: 'tool', toolName: 'weather_lookup', args: { city: 'Paris' } },
  ],
  'single-flight-concurrent': [
    {
      type: 'concurrent',
      key: 'cache-benefits',
      query: 'Explain the benefits of caching in one sentence.',
      concurrency: 2,
    },
    { type: 'llm', query: 'Explain the benefits of caching in one sentence.' },
  ],
  'mixed-workload': [
    { type: 'llm', query: 'What is the capital of France?' },
    { type: 'tool', toolName: 'weather_lookup', args: { city: 'Paris' } },
    {
      type: 'concurrent',
      key: 'cache-benefits',
      query: 'Explain the benefits of caching in one sentence.',
      concurrency: 2,
    },
  ],
};

const taskSuite: CacheManagerTask[] = [
  {
    id: 'semantic-repeat',
    prompt: 'Repeated identical semantic queries should hit the cache after the first request.',
    expected: (output: string) => output.includes('Paris'),
    sequence: SEQUENCES['semantic-repeat'],
  },
  {
    id: 'semantic-paraphrase',
    prompt: 'Paraphrased queries with high n-gram overlap should hit the semantic cache.',
    expected: (output: string) => output.includes('regression'),
    sequence: SEQUENCES['semantic-paraphrase'],
  },
  {
    id: 'tool-repeat',
    prompt: 'Repeated deterministic read-only tool calls should be served from the tool cache.',
    expected: (output: string) => output.includes('22°C'),
    sequence: SEQUENCES['tool-repeat'],
  },
  {
    id: 'single-flight-concurrent',
    prompt: 'Concurrent identical LLM requests should be deduplicated to a single in-flight call.',
    expected: (output: string) => output.includes('latency') || output.includes('Caching'),
    sequence: SEQUENCES['single-flight-concurrent'],
  },
  {
    id: 'mixed-workload',
    prompt: 'A mixed sequence exercises semantic, tool, and single-flight caching together.',
    expected: (output: string) => output.includes('latency') || output.includes('Caching'),
    sequence: SEQUENCES['mixed-workload'],
  },
];

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 };
}

function addTokens(sum: TokenUsage, tokens: TokenUsage): void {
  sum.input += tokens.input;
  sum.output += tokens.output;
  sum.total += tokens.total;
  sum.cached += tokens.cached;
  sum.reasoning += tokens.reasoning;
}

function makeRequest(query: string): LLMRequest {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: query }],
    temperature: 0,
  };
}

function makeResponse(text: string, tokens: TokenUsage): LLMResponse {
  return {
    content: text,
    model: MODEL,
    usage: {
      promptTokens: tokens.input,
      completionTokens: tokens.output,
      totalTokens: tokens.total,
      cacheReadTokens: tokens.cached,
    },
    finishReason: 'stop',
  };
}

function estimateOutputTokens(text: string): TokenUsage {
  const output = Math.max(1, Math.ceil(text.length / 4));
  return {
    input: 0,
    output,
    total: output,
    cached: 0,
    reasoning: 0,
  };
}

/**
 * Resolve a deterministic benchmark response for known queries. This keeps the
 * CacheManager benchmark focused on caching behavior rather than LLM output
 * quality, so it remains stable across both scripted and live CLI modes.
 */
function resolveBenchmarkResponse(query: string): { text: string; tokens: TokenUsage } | undefined {
  const text = SCRIPTED_RESPONSES[query];
  if (!text) return undefined;
  return { text, tokens: estimateOutputTokens(text) };
}

function simulateTool(toolName: string, args: Record<string, unknown>): { output: string; durationMs: number } {
  if (toolName === 'weather_lookup' && args.city === 'Paris') {
    return { output: 'The weather in Paris is 22°C and sunny.', durationMs: 4 };
  }
  return { output: `Tool ${toolName} result for ${JSON.stringify(args)}.`, durationMs: 4 };
}

interface SequenceResult {
  output: string;
  tokenUsage: TokenUsage;
  latencyMs: number;
}

interface BaselineImpl {
  runSequence: (task: CacheManagerTask) => Promise<SequenceResult>;
}

interface TreatmentImpl {
  cacheManager: CacheManager;
  runSequence: (task: CacheManagerTask) => Promise<SequenceResult>;
}

async function runBaselineSequence(
  _impl: BaselineImpl,
  task: CacheManagerTask,
  llm: LLMClient,
): Promise<SequenceResult> {
  const tokenUsage = emptyTokens();
  let latencyMs = 0;
  let output = '';

  for (const step of task.sequence) {
    if (step.type === 'llm' && step.query) {
      const result = resolveBenchmarkResponse(step.query) ?? (await llm.complete(step.query));
      addTokens(tokenUsage, result.tokens);
      latencyMs += 8;
      output = result.text;
    } else if (step.type === 'tool' && step.toolName) {
      const { output: toolOutput, durationMs } = simulateTool(step.toolName, step.args ?? {});
      addTokens(tokenUsage, estimateOutputTokens(toolOutput));
      latencyMs += durationMs;
      output = toolOutput;
    } else if (step.type === 'concurrent' && step.query && step.concurrency) {
      const calls = Array.from({ length: step.concurrency }, () =>
        Promise.resolve(resolveBenchmarkResponse(step.query!) ?? llm.complete(step.query!)),
      );
      const results = await Promise.all(calls);
      for (const r of results) {
        addTokens(tokenUsage, r.tokens);
      }
      latencyMs += 8 * step.concurrency;
      output = results[0].text;
    }
  }

  return { output, tokenUsage, latencyMs };
}

async function runTreatmentSequence(
  impl: TreatmentImpl,
  task: CacheManagerTask,
  llm: LLMClient,
): Promise<SequenceResult> {
  const { cacheManager } = impl;
  const tokenUsage = emptyTokens();
  let latencyMs = 0;
  let output = '';

  for (const step of task.sequence) {
    if (step.type === 'llm' && step.query) {
      const request = makeRequest(step.query);
      const cached = await cacheManager.lookupSemantic(request);
      if (cached) {
        output = cached.content;
        latencyMs += 0.2;
        // Cache hits are billed as zero fresh tokens.
        continue;
      }

      const result = resolveBenchmarkResponse(step.query) ?? (await llm.complete(step.query));
      addTokens(tokenUsage, result.tokens);
      latencyMs += 10;
      output = result.text;
      await cacheManager.storeSemantic(request, makeResponse(result.text, result.tokens));
    } else if (step.type === 'tool' && step.toolName) {
      const toolCache = cacheManager.getToolCache();
      const toolCall: ToolCall = {
        id: 'tc-benchmark',
        name: step.toolName,
        arguments: step.args ?? {},
      };
      const cached = toolCache.get(toolCall);
      if (cached) {
        output = cached.output;
        latencyMs += 0.2;
        continue;
      }

      const { output: toolOutput, durationMs } = simulateTool(step.toolName, step.args ?? {});
      addTokens(tokenUsage, estimateOutputTokens(toolOutput));
      latencyMs += durationMs;
      output = toolOutput;

      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        name: step.toolName,
        output: toolOutput,
        durationMs: 0,
      };
      toolCache.set(toolCall, toolResult);
    } else if (step.type === 'concurrent' && step.query && step.concurrency && step.key) {
      const request = makeRequest(step.query);
      let factoryExecuted = false;

      const factory = async (): Promise<LLMResponse> => {
        // Single-flight collapses concurrent duplicate calls; this factory runs once.
        const result = resolveBenchmarkResponse(step.query!) ?? (await llm.complete(step.query!));
        if (!factoryExecuted) {
          addTokens(tokenUsage, result.tokens);
          latencyMs += 10;
          factoryExecuted = true;
        }
        const response = makeResponse(result.text, result.tokens);
        await cacheManager.storeSemantic(request, response);
        return response;
      };

      const calls = Array.from({ length: step.concurrency }, () =>
        cacheManager.dedupeSingleFlight(step.key!, factory),
      );
      const results = await Promise.all(calls);
      output = results[0].content;
      latencyMs += 0.5;
    }
  }

  return { output, tokenUsage, latencyMs };
}

export const cacheManagerModule: BenchmarkModule = {
  id: 'cacheManager',
  name: 'CacheManager Effectiveness',
  description:
    'Validates that CacheManager lowers latency and cost compared to a no-cache baseline across semantic, tool, and single-flight caching scenarios.',
  path: 'runtime/cacheManager.ts',
  baselineFactory: ({ llm }) => ({
    runSequence: (task: CacheManagerTask) => runBaselineSequence({} as BaselineImpl, task, llm),
  }),
  treatmentFactory: ({ llm }) => {
    const cacheManager = new CacheManager({
      semanticCache: {
        enabled: true,
        similarityThreshold: 0.6,
        maxEntries: 1_000,
        defaultTtlMs: 60_000,
        pruneIntervalMs: 0,
      },
      enableToolCaching: true,
      singleFlight: { enabled: true, maxInFlight: 100 },
      geminiCache: { enabled: false },
    });
    return {
      cacheManager,
      runSequence: (task: CacheManagerTask) => runTreatmentSequence({ cacheManager } as TreatmentImpl, task, llm),
    };
  },
  runTrial: async ({ implementation, task, llm }) => {
    const impl = implementation as BaselineImpl | TreatmentImpl;
    const result = await impl.runSequence(task as CacheManagerTask);
    return result;
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate', 'cost', 'latency'],
};
