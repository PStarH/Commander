#!/usr/bin/env node
/**
 * Dangerous-call interception E2E test — verifies dangerous tool calls are
 * blocked and that the denial names the layer that actually denied it.
 *
 * The runtime is seeded with a mock LLM that always returns a shell_execute
 * tool call containing "rm -rf /". The side-effect policy layer denies it,
 * emits the [🔥 拦截成功] marker, and execution never happens.
 *
 * Provenance note (RUN-02): this denial comes from the side-effect *policy*
 * layer, so it is asserted as POLICY_DENIED. It used to be relabelled
 * GUARDIAN_BLOCKED in ToolExecutionService purely so this script's string
 * assertion matched — that rename erased the denying layer and has been
 * removed. The genuine Guardian layer still emits GUARDIAN_BLOCKED.
 */

import { AgentRuntime, getMessageBus } from '../../src';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src';
import type { Tool } from '../../src/runtime/types';

let executed = false;

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
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
  },
  async execute() {
    executed = true;
    return 'SHOULD NEVER RUN';
  },
};

async function main() {
  const runtime = new AgentRuntime({ maxRetries: 0, maxConcurrency: 1 });
  runtime.registerProvider('mock-evil', mockProvider);
  runtime.registerTool('shell_execute', shellTool);

  // Capture the layer-accurate `tool.blocked` event. Asserting the marker on
  // the run-level error was wrong: after the model retries, the run error is
  // the retry-loop cause, and it only ever carried a denial because that
  // string leaked from an earlier call (RUN-02).
  const blockedEvents: Array<{ reason?: string; detail?: string; toolName?: string }> = [];
  const unsubscribe = getMessageBus().subscribe('tool.blocked', (msg) => {
    blockedEvents.push(msg.payload as { reason?: string; detail?: string; toolName?: string });
  });

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
    unsubscribe();
  }

  const output = stdoutChunks.join('');

  if (!output.includes('[🔥 拦截成功]')) {
    throw new Error('Security layer did not emit [🔥 拦截成功] marker');
  }
  const policyDenial = blockedEvents.find((e) => e.reason === 'POLICY_DENIED');
  if (!policyDenial) {
    throw new Error(
      `Expected a POLICY_DENIED tool.blocked event, saw ${JSON.stringify(blockedEvents)}`,
    );
  }
  if (!String(policyDenial.detail ?? '').startsWith('POLICY_DENIED:')) {
    throw new Error(`Policy denial carried the wrong layer marker: ${String(policyDenial.detail)}`);
  }
  if (String(policyDenial.detail).includes('GUARDIAN_BLOCKED')) {
    throw new Error('Policy denial was misattributed to the Guardian layer');
  }
  if (executed) {
    throw new Error('Policy blocked the call but the tool still executed');
  }

  console.log('✅ Dangerous-call interception test passed');
  console.log(`   Run status: ${result.status}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(
    '❌ Guardian interception test failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
