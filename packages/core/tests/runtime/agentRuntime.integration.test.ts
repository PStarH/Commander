import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { ServiceContainer, resetServiceContainer } from '../../src/runtime/serviceContainer';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_TOKEN_GOVERNOR_BUDGET,
  CIRCUIT_BREAKER_THRESHOLD,
} from '../../src/runtime/runtimeConstants';
import type { AgentExecutionContext, Tool, ToolDefinition } from '../../src/runtime/types';

describe('AgentRuntime Integration', () => {
  let runtime: AgentRuntime;
  let mockProvider: MockLLMProvider;
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    resetServiceContainer();
    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, router);
    mockProvider = new MockLLMProvider('openai', {
      defaultResponse: 'Task completed successfully.',
    });
    runtime.registerProvider('openai', mockProvider);
  });

  function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
    return {
      agentId: 'test-agent',
      projectId: 'test-project',
      missionId: 'test-mission',
      goal: 'Test goal for integration testing.',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
      ...overrides,
    };
  }

  describe('ServiceContainer integration', () => {
    it('resolves dependencies via ServiceContainer when overrides are set', async () => {
      const container = ServiceContainer.getInstance();
      const mockMetrics = {
        incrementCounter: vi.fn(),
        setGauge: vi.fn(),
        recordHistogram: vi.fn(),
        recordCircuitTransition: vi.fn(),
        exportOpenMetrics: vi.fn().mockReturnValue(''),
      };
      container.setOverrides({ metricsCollector: mockMetrics as any });

      const result = await runtime.execute(makeContext());
      expect(result.status).toBe('success');

      container.clearOverrides();
    });

    it('falls back to global accessors when no overrides are set', async () => {
      const result = await runtime.execute(makeContext());
      expect(result.status).toBe('success');
    });
  });

  describe('Tool execution with dependencies', () => {
    it('executes tools that depend on other tools', async () => {
      const step1Tool: Tool = {
        definition: {
          name: 'step1',
          description: 'First step',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => 'step1 result',
      };

      const step2Tool: Tool = {
        definition: {
          name: 'step2',
          description: 'Second step depends on step1',
          inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
        },
        execute: async (args) => `step2 result using ${args.input}`,
      };

      runtime.registerTool('step1', step1Tool);
      runtime.registerTool('step2', step2Tool);

      const result = await runtime.execute(
        makeContext({
          availableTools: ['step1', 'step2'],
          goal: 'Execute step1 then step2 with step1 output',
        }),
      );

      expect(result.status).toBe('success');
      expect(result.steps.length).toBeGreaterThan(0);
    });

    it('handles tool execution errors gracefully', async () => {
      const failingTool: Tool = {
        definition: {
          name: 'failing_tool',
          description: 'A tool that always fails',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          throw new Error('Tool execution failed');
        },
      };

      runtime.registerTool('failing_tool', failingTool);

      const result = await runtime.execute(
        makeContext({
          availableTools: ['failing_tool'],
          goal: 'Use the failing tool',
        }),
      );

      expect(result.status).toBe('success');
    });
  });

  describe('Circuit breaker behavior', () => {
    it('opens circuit after threshold failures', async () => {
      const failingProvider = new MockLLMProvider('failing', {
        defaultResponse: '',
      });
      vi.spyOn(failingProvider, 'call').mockRejectedValue(new Error('Provider error'));

      const runtimeWithRetries = new AgentRuntime(
        { maxRetries: CIRCUIT_BREAKER_THRESHOLD + 1, timeoutMs: 5000 },
        new ModelRouter(),
      );
      runtimeWithRetries.registerProvider('openai', failingProvider);

      const result = await runtimeWithRetries.execute(makeContext());
      expect(result.status).toBe('failed');
    });
  });

  describe('Token governor behavior', () => {
    it('uses default budget when not specified', async () => {
      const result = await runtime.execute(makeContext());
      expect(result.status).toBe('success');
    });
  });

  describe('Retry logic', () => {
    it('fails after exhausting retries', async () => {
      const persistentFailingProvider = new MockLLMProvider('failing', {
        defaultResponse: '',
      });

      vi.spyOn(persistentFailingProvider, 'call').mockRejectedValue(
        new Error('Persistent error'),
      );

      const runtimeWithRetries = new AgentRuntime(
        { maxRetries: 2, timeoutMs: 5000 },
        new ModelRouter(),
      );
      runtimeWithRetries.registerProvider('openai', persistentFailingProvider);

      const result = await runtimeWithRetries.execute(makeContext());
      expect(result.status).toBe('failed');
    });
  });

  describe('Configuration constants', () => {
    it('uses correct default context window tokens', () => {
      expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(128000);
    });

    it('uses correct default token governor budget', () => {
      expect(DEFAULT_TOKEN_GOVERNOR_BUDGET).toBe(200000);
    });

    it('uses correct circuit breaker threshold', () => {
      expect(CIRCUIT_BREAKER_THRESHOLD).toBe(5);
    });
  });

  describe('Memory integration', () => {
    it('has null memory store by default', async () => {
      expect(runtime.getMemoryStore()).toBeNull();
    });
  });

  describe('Concurrent execution', () => {
    it('handles multiple concurrent executions', async () => {
      const promises = [
        runtime.execute(makeContext({ goal: 'Task 1' })),
        runtime.execute(makeContext({ goal: 'Task 2' })),
        runtime.execute(makeContext({ goal: 'Task 3' })),
      ];

      const results = await Promise.all(promises);
      results.forEach((result) => {
        expect(result.status).toBe('success');
      });
    });
  });
});
