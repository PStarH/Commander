import { describe, it, expect, beforeEach } from 'vitest';
import { createAgentRuntimeFactory, AgentRuntime } from '../../src/runtime';
import { resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { getGlobalThreeLayerMemory, resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';

describe('createAgentRuntimeFactory', () => {
  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
  });

  it('returns a factory that creates an AgentRuntime per tenant', () => {
    const factory = createAgentRuntimeFactory({ maxRetries: 2 });
    const runtime = factory('tenant-a');
    expect(runtime).toBeInstanceOf(AgentRuntime);
    expect((runtime as AgentRuntime).getConfig().maxRetries).toBe(2);
  });

  it('injects providers into each tenant runtime', async () => {
    const mockProvider = new MockLLMProvider('mock', {
      defaultResponse: 'hello from mock',
    });
    const factory = createAgentRuntimeFactory({
      config: { maxRetries: 1, timeoutMs: 5000 },
      providers: { mock: mockProvider },
    });

    const runtime = factory('tenant-b');
    const result = await runtime.execute({
      agentId: 'agent-default',
      missionId: 'm1',
      projectId: 'p1',
      goal: 'say hello',
      contextData: {},
      availableTools: [],
      maxSteps: 3,
      tokenBudget: 1000,
    });

    expect(result.status).toBe('success');
    expect(result.summary).toContain('hello from mock');
  });

  it('creates isolated runtimes per tenant', () => {
    const factory = createAgentRuntimeFactory({});
    const runtimeA = factory('tenant-a');
    const runtimeB = factory('tenant-b');
    expect(runtimeA).not.toBe(runtimeB);
  });
});
