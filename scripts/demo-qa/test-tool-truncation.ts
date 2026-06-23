#!/usr/bin/env node
/**
 * Tool Output Truncation E2E Test — verifies verbose tool output is truncated
 * and the metric counter is incremented.
 */

import { AgentRuntime } from '../../src';
import { getMetricsCollector } from '../../src';
import type { LLMProvider, LLMRequest, LLMResponse, Tool } from '../../src';

const hugeOutput = 'x'.repeat(12_000);

const mockProvider: LLMProvider = {
  name: 'mock-truncator',
  async call(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: '',
      model: 'mock-model',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'tc_1',
          name: 'long_output_tool',
          arguments: {},
        },
      ],
    };
  },
};

const longOutputTool: Tool = {
  definition: {
    name: 'long_output_tool',
    description: 'Returns a huge payload',
    inputSchema: { type: 'object', properties: {} },
  },
  async execute() {
    return hugeOutput;
  },
};

async function main() {
  const runtime = new AgentRuntime({ maxRetries: 0, maxConcurrency: 1 });
  runtime.registerProvider('mock-truncator', mockProvider);
  runtime.registerTool('long_output_tool', longOutputTool);

  const before = getMetricsCollector().getCounterTotal('tool_truncations_total');

  const result = await runtime.execute({
    agentId: 'truncation-tester',
    goal: 'Trigger tool output truncation',
    projectId: 'default',
    contextData: {},
    availableTools: ['long_output_tool'],
    maxSteps: 5,
    tokenBudget: 4000,
  });

  const after = getMetricsCollector().getCounterTotal('tool_truncations_total');

  if (after <= before) {
    throw new Error(`tool_truncations_total did not increase: ${before} -> ${after}`);
  }
  if (result.status !== 'success') {
    throw new Error(`Expected run to succeed, got ${result.status}`);
  }

  console.log('✅ Tool output truncation test passed');
  console.log(`   tool_truncations_total: ${before} -> ${after}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(
    '❌ Tool truncation test failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
