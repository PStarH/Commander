import { describe, it, expect, beforeEach } from 'vitest';
import { KernelStepExecutor, KernelStepExecutorError } from '../../src/runtime/kernelStepExecutor';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { createAgentRuntimeFactory } from '../../src/runtime/runtimeFactory';
import { resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';

function makeStep(input: Record<string, unknown>) {
  return {
    id: 'step-1',
    runId: 'run-1',
    tenantId: 'tenant-1',
    kind: 'agent',
    version: 1,
    attempt: 0,
    input,
    lease: {
      workerId: 'worker-1',
      token: 'lease-token',
      fencingEpoch: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

describe('KernelStepExecutor', () => {
  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
  });

  it('requires definitionVersion and providerSnapshot for agent steps', async () => {
    const mockProvider = new MockLLMProvider('mock', { defaultResponse: 'ok' });
    const executor = new KernelStepExecutor(
      createAgentRuntimeFactory({
        providers: { mock: mockProvider },
        config: { defaultProvider: 'mock' },
      }),
      { defaultMaxSteps: 3 },
    );

    await expect(
      executor.execute(makeStep({ goal: 'g', agentId: 'a' }), {
        signal: new AbortController().signal,
        worker: { id: 'w1', kind: 'agent', capabilities: ['agent'] },
      }),
    ).rejects.toThrow(KernelStepExecutorError);
  });

  it('executes a canonical agent step with definitionVersion and providerSnapshot', async () => {
    const mockProvider = new MockLLMProvider('mock', { defaultResponse: 'completed' });
    const executor = new KernelStepExecutor(
      createAgentRuntimeFactory({
        providers: { mock: mockProvider },
        config: { defaultProvider: 'mock' },
      }),
      { defaultMaxSteps: 3 },
    );

    const result = await executor.execute(
      makeStep({
        goal: 'say hello',
        agentId: 'agent-default',
        definitionVersion: 'v1',
        providerSnapshot: { provider: 'mock', model: 'mock-model' },
      }),
      {
        signal: new AbortController().signal,
        worker: { id: 'w1', kind: 'agent', capabilities: ['agent'] },
      },
    );

    expect(result).toBeDefined();
    expect(result?.status).toBe('success');
    expect(result?.summary).toContain('completed');
  });
});
