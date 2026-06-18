#!/usr/bin/env node
/**
 * Provider Fallback E2E Test — verifies failover when the primary LLM fails.
 *
 * The runtime is seeded with two mock providers:
 *   - mock-openai: always throws a retryable 429 error
 *   - mock-anthropic: always succeeds
 * The test asserts that the fallback chain logs the [Fallback] OpenAI 切换至 marker
 * and the run ultimately succeeds.
 */

import { AgentRuntime } from '../../src';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src';

const failingProvider: LLMProvider = {
  name: 'mock-openai',
  async call(_request: LLMRequest): Promise<LLMResponse> {
    const err = new Error('429 Rate limit exceeded');
    (err as any).status = 429;
    throw err;
  },
};

const fallbackProvider: LLMProvider = {
  name: 'mock-anthropic',
  async call(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'Fallback succeeded',
      model: 'mock-anthropic-model',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      finishReason: 'stop',
    };
  },
};

async function main() {
  const runtime = new AgentRuntime({ maxRetries: 0, maxConcurrency: 1 });
  runtime.registerProvider('mock-openai', failingProvider);
  runtime.registerProvider('mock-anthropic', fallbackProvider);

  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    stdoutChunks.push(text);
    return originalWrite(chunk, ...(args as [any]));
  }) as typeof process.stdout.write;

  let result: Awaited<ReturnType<typeof runtime.execute>>;
  try {
    result = await runtime.execute({
      agentId: 'fallback-tester',
      goal: 'Demonstrate provider failover',
      projectId: 'default',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 4000,
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = stdoutChunks.join('');

  if (!output.includes('[Fallback] mock-openai 切换至 mock-anthropic')) {
    throw new Error('Fallback marker not found in stdout');
  }
  if (result.status !== 'success') {
    throw new Error(`Expected run to succeed after fallback, got ${result.status}`);
  }

  console.log('✅ Provider fallback test passed');
  console.log(`   Run status: ${result.status}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(
    '❌ Provider fallback test failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
