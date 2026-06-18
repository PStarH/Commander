import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus, getMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetMetricsCollector } from '../../src/runtime/metricsCollector';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { runWithTenant } from '../../src/runtime/tenantContext';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';

describe('Tenant runtime isolation', () => {
  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetMetricsCollector();
    resetGlobalThreeLayerMemory();
  });

  it('isolates trace stores and message bus history between tenants', async () => {
    const router = new ModelRouter();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const provider = new MockLLMProvider('openai', { defaultResponse: 'ok' });
    runtime.registerProvider('openai', provider);

    const ctx = {
      agentId: 'tenant-agent',
      projectId: 'tenant-project',
      missionId: 'mission-1',
      goal: 'Tenant isolation test.',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
    };

    const resultA = await runWithTenant('tenant-a', () => runtime.execute(ctx));
    const resultB = await runWithTenant('tenant-b', () => runtime.execute(ctx));

    expect(resultA.status).toBe('success');
    expect(resultB.status).toBe('success');
    expect(resultA.runId).not.toBe(resultB.runId);

    // Each tenant-scoped bus instance should only see its own events.
    const busA = runWithTenant('tenant-a', () => getMessageBus());
    const busB = runWithTenant('tenant-b', () => getMessageBus());
    expect(busA).not.toBe(busB);

    const historyA = busA.getHistory('agent.completed');
    const historyB = busB.getHistory('agent.completed');
    expect(historyA.length).toBeGreaterThanOrEqual(1);
    expect(historyB.length).toBeGreaterThanOrEqual(1);
    expect(historyA.some((m) => (m.payload as { runId?: string }).runId === resultA.runId)).toBe(true);
    expect(historyA.some((m) => (m.payload as { runId?: string }).runId === resultB.runId)).toBe(false);
    expect(historyB.some((m) => (m.payload as { runId?: string }).runId === resultB.runId)).toBe(true);
    expect(historyB.some((m) => (m.payload as { runId?: string }).runId === resultA.runId)).toBe(false);
  });
});
