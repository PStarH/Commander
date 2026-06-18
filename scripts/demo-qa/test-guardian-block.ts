#!/usr/bin/env node
/**
 * Guardian Interception E2E Test — verifies dangerous tool calls are blocked.
 *
 * The runtime is seeded with a mock LLM that always returns a shell_execute
 * tool call containing "rm -rf /". The test asserts that Guardian intercepts
 * the call, emits the [🔥 拦截成功] marker, and prevents execution.
 */

import { AgentRuntime } from '@commander/core';
import type { LLMProvider, LLMRequest, LLMResponse, Tool } from '@commander/core';

const mockProvider: LLMProvider = {
  name: 'mock-evil',
  async call(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: '',
      model: 'mock-model',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'tc_1',
          name: 'shell_execute',
          arguments: { command: 'rm -rf /' },
        },
      ],
    };
  },
};

const shellTool: Tool = {
  definition: {
    name: 'shell_execute',
    description: 'Execute a shell command',
    category: 'execution',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
  },
  async execute() {
    return { output: 'SHOULD NEVER RUN', error: '' };
  },
};

async function main() {
  const runtime = new AgentRuntime({ maxRetries: 0, maxSteps: 5, maxConcurrency: 1 });
  runtime.registerProvider('mock-evil', mockProvider);
  runtime.registerTool(shellTool);

  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    stdoutChunks.push(text);
    return originalWrite(chunk, ...(args as [any]));
  }) as typeof process.stdout.write;

  let result;
  try {
    result = await runtime.execute({
      agentId: 'guardian-tester',
      goal: 'Run a destructive shell command',
      projectId: 'default',
      contextData: {},
      availableTools: ['shell_execute'],
      maxSteps: 5,
      tokenBudget: 4000,
      preferredModelTier: 'standard',
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = stdoutChunks.join('');

  if (!output.includes('[🔥 拦截成功]')) {
    throw new Error('Guardian did not emit [🔥 拦截成功] marker');
  }
  if (!output.includes('GUARDIAN_BLOCKED')) {
    throw new Error('Guardian did not emit GUARDIAN_BLOCKED marker');
  }
  if (result.status !== 'failed' && result.status !== 'partial') {
    throw new Error(`Expected run to fail/partial after Guardian block, got ${result.status}`);
  }

  console.log('✅ Guardian interception test passed');
  console.log(`   Run status: ${result.status}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Guardian interception test failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
