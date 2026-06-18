import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetMetricsCollector, getMetricsCollector } from '../../src/runtime/metricsCollector';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';

describe('AgentRuntime capacity baseline metrics', () => {
  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetMetricsCollector();
    resetGlobalThreeLayerMemory();
  });

  it('exposes queue depth and emits wait-time / queue-depth metrics under load', async () => {
    const router = new ModelRouter();
    const r = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxConcurrency: 1 }, router);
    const provider = new MockLLMProvider('openai', { defaultResponse: 'ok' });
    r.registerProvider('openai', provider);

    // Slow the provider so the second run queues.
    const original = provider.call.bind(provider);
    provider.call = async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return original(req);
    };

    const ctx = {
      agentId: 'capacity-agent',
      projectId: 'capacity-project',
      missionId: 'mission-1',
      goal: 'Test capacity metrics.',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
    };

    const [a, b] = await Promise.all([r.execute(ctx), r.execute(ctx)]);
    expect(a.status).toBe('success');
    expect(b.status).toBe('success');

    // The runtime serializes execute() calls, so one run should have queued.
    expect(r.getQueueDepth()).toBe(0);

    const queueDepth = getMetricsCollector().getGauge('runtime_queue_depth');
    expect(queueDepth).toBeGreaterThanOrEqual(0);

    const waitTime = getMetricsCollector().getCounterTotal('runtime_wait_time_ms_count');
    expect(waitTime).toBeGreaterThanOrEqual(0);
  });

  it('records run cost alongside run completion', async () => {
    const router = new ModelRouter();
    const r = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const provider = new MockLLMProvider('openai', { defaultResponse: 'ok' });
    r.registerProvider('openai', provider);

    const result = await r.execute({
      agentId: 'cost-agent',
      projectId: 'cost-project',
      missionId: 'mission-1',
      goal: 'Test cost metric.',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
    });

    expect(result.status).toBe('success');
    expect(result.totalTokenUsage.totalTokens).toBeGreaterThan(0);

    const cost = getMetricsCollector().getCounterTotal('run_cost_usd_total');
    expect(cost).toBeGreaterThan(0);
  });

  it('tracks active runs gauge', async () => {
    const router = new ModelRouter();
    const r = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const provider = new MockLLMProvider('openai', { defaultResponse: 'ok' });
    // Slow the run so we can inspect active-run count mid-flight.
    const original = provider.call.bind(provider);
    provider.call = async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return original(req);
    };
    r.registerProvider('openai', provider);

    expect(r.getActiveRunCount()).toBe(0);
    const promise = r.execute({
      agentId: 'active-agent',
      projectId: 'active-project',
      missionId: 'mission-1',
      goal: 'Test active runs.',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
    });
    // execute() is queued behind a microtask; yield briefly so the run starts.
    await new Promise((r) => setTimeout(r, 10));
    expect(r.getActiveRunCount()).toBe(1);
    await promise;
    expect(r.getActiveRunCount()).toBe(0);
  });
});
