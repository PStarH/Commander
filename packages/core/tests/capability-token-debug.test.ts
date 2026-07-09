import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { ModelRouter, resetModelRouter } from '../src/runtime/modelRouter';
import { resetMessageBus } from '../src/runtime/messageBus';
import { resetTraceRecorder } from '../src/runtime/executionTrace';
import { resetCapabilityTokenState } from '../src/security/capabilityToken';
import type { AgentExecutionContext, Tool, LLMRequest, LLMResponse } from '../src/runtime/types';
import { MockLLMProvider } from '../src/runtime/mockLLMProvider';

class ToolCallMockProvider extends MockLLMProvider {
  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    return {
      content: 'done',
      model: request.model,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
    };
  }
}

function makeTool(name: string, execute: (args: Record<string, unknown>) => Promise<string>): Tool {
  return {
    name,
    definition: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
    execute,
  } as Tool;
}

function makeContext(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    goal: 'test',
    contextData: {},
    availableTools: ['echo'],
    maxSteps: 5,
    tokenBudget: 1000,
    ...overrides,
  };
}

describe('capability token debug', () => {
  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetCapabilityTokenState();
  });

  it('issues and verifies capability token', async () => {
    const router = new ModelRouter();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    runtime.registerTool(
      'echo',
      makeTool('echo', async () => 'ok'),
    );
    runtime.registerProvider('openai', new ToolCallMockProvider('mock'));

    const result = await runtime.execute(makeContext());
    expect(result.status).toBe('success');
  });
});
