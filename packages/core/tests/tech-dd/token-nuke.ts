#!/usr/bin/env node
/**
 * Token Nuke Test — Tech DD Extreme Scenario #2
 *
 * Simulates an LLM call that explodes the context window and returns
 * HTTP 400 / context_length_exceeded. The runtime must:
 *   1. Catch the error as a context-length overflow (not a permanent 400)
 *   2. Trigger semantic compaction
 *   3. Log [Warn] 上下文超载，已启动语义压缩
 *   4. Retry with compacted context and complete successfully
 */

import { AgentRuntime } from '../../src';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src';

let callCount = 0;

const mockProvider: LLMProvider = {
  name: 'mock-context-nuke',
  async call(request: LLMRequest): Promise<LLMResponse> {
    callCount += 1;

    if (callCount === 1) {
      // Simulate OpenAI context-length 400.
      const err = new Error(
        "400 Bad Request: This model's maximum context length is 8192 tokens, however you requested 12000 tokens.",
      ) as Error & { status?: number };
      err.status = 400;
      throw err;
    }

    return {
      content: `Recovered after compaction. Messages now: ${request.messages.length}`,
      model: 'mock-context-nuke',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      finishReason: 'stop',
    };
  },
};

async function main() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return originalOut(chunk, ...(args as [any]));
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return originalErr(chunk, ...(args as [any]));
  }) as typeof process.stderr.write;

  const runtime = new AgentRuntime({
    maxRetries: 1,
    maxConcurrency: 1,
    budgetHardCapTokens: 2000, // Force compaction to act on a modest message history.
  });
  runtime.registerProvider('mock-context-nuke', mockProvider);

  // Inflate the goal so the built-in prompt exceeds the 2000-token context ceiling.
  // This guarantees the semantic compactor has something to drop after the 400 error.
  const filler = 'tokenoverload '.repeat(5000);
  const goal = `Demonstrate recovery from context-length overflow. ${filler}`;

  let result: Awaited<ReturnType<typeof runtime.execute>>;
  try {
    result = await runtime.execute({
      agentId: 'token-nuke-tester',
      projectId: 'default',
      goal,
      contextData: {},
      availableTools: [],
      maxSteps: 3,
      tokenBudget: 2000,
    });
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  const combined = stdoutChunks.join('') + '\n' + stderrChunks.join('');

  if (!combined.includes('[Warn] 上下文超载，已启动语义压缩')) {
    throw new Error('Expected context-length warning log not found');
  }
  if (result.status !== 'success') {
    throw new Error(`Expected run to succeed after compaction, got ${result.status}: ${result.error}`);
  }

  console.log('✅ Token nuke test passed');
  console.log(`   Run status: ${result.status}`);
  console.log(`   Provider calls: ${callCount}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Token nuke test failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
