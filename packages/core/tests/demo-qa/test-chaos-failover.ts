#!/usr/bin/env node
/**
 * Chaos Failover Test — simulates pulling the network plug on OpenAI.
 *
 * A real OpenAI provider is pointed at localhost:9 (closed port), so every
 * request gets ECONNREFUSED. The test asserts the runtime fails over to the
 * mock Anthropic backup, logs the [Fallback] marker, and completes successfully
 * without crashing.
 */

import { AgentRuntime } from '../../src';
import { OpenAIProvider } from '../../src/runtime/providers/openaiProvider';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src';

// Simulated OpenAI that hits a closed port → ECONNREFUSED.
const openaiProvider = new OpenAIProvider({
  apiKey: 'sk-fake-corrupted-key',
  baseUrl: 'http://localhost:9',
  defaultModel: 'gpt-4o',
});

const anthropicProvider: LLMProvider = {
  name: 'anthropic',
  async call(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'Recovered via Anthropic fallback',
      model: 'claude-3',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      finishReason: 'stop',
    };
  },
};

async function main() {
  const runtime = new AgentRuntime({ maxRetries: 0, maxConcurrency: 1 });
  runtime.registerProvider('openai', openaiProvider);
  runtime.registerProvider('anthropic', anthropicProvider);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    stdoutChunks.push(text);
    return originalOut(chunk, ...(args as [any]));
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    stderrChunks.push(text);
    return originalErr(chunk, ...(args as [any]));
  }) as typeof process.stderr.write;

  let result: Awaited<ReturnType<typeof runtime.execute>>;
  try {
    result = await runtime.execute({
      agentId: 'chaos-failover-tester',
      goal: 'Demonstrate failover after network cut',
      projectId: 'default',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 4000,
    });
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  const combined = stdoutChunks.join('') + '\n' + stderrChunks.join('');

  if (combined.includes('ECONNREFUSED') && !combined.includes('[Fallback]')) {
    throw new Error('OpenAI ECONNREFUSED crashed the process instead of failing over');
  }
  if (!combined.includes('[Fallback] openai 切换至 anthropic')) {
    throw new Error('Expected [Fallback] openai 切换至 anthropic marker not found');
  }
  if (result.status !== 'success') {
    throw new Error(`Expected run to succeed after failover, got ${result.status}`);
  }

  console.log('✅ Chaos failover test passed');
  console.log(`   Run status: ${result.status}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Chaos failover test failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
