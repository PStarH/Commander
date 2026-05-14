import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import type { AgentExecutionContext, Tool, ToolDefinition } from '../../src/runtime/types';

describe('AgentRuntime', () => {
  let runtime: AgentRuntime;
  let mockProvider: MockLLMProvider;
  let router: ModelRouter;

  before(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, router);
    mockProvider = new MockLLMProvider('openai', {
      defaultResponse: 'Task completed successfully. The analysis shows positive results.',
    });
    runtime.registerProvider('openai', mockProvider);
  });

  function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
    return {
      agentId: 'agent-builder',
      projectId: 'project-war-room',
      missionId: 'mission-1',
      goal: 'Analyze the current system architecture and provide recommendations.',
      contextData: {
        governanceProfile: { riskLevel: 'LOW' },
      },
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
      ...overrides,
    };
  }

  describe('execution', () => {
    it('returns a successful result', async () => {
      const result = await runtime.execute(makeContext());
      expect(result.status).toBe('success');
      expect(result.runId).toBeTruthy();
      expect(result.agentId).toBe('agent-builder');
      expect(result.missionId).toBe('mission-1');
    });

    it('includes execution steps', async () => {
      const result = await runtime.execute(makeContext());
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.steps[0].type).toBe('response');
      expect(result.steps[0].content).toBeTruthy();
    });

    it('tracks token usage', async () => {
      const result = await runtime.execute(makeContext());
      expect(result.totalTokenUsage.totalTokens).toBeGreaterThan(0);
      expect(result.totalTokenUsage.promptTokens).toBeGreaterThan(0);
      expect(result.totalTokenUsage.completionTokens).toBeGreaterThan(0);
    });

    it('tracks duration', async () => {
      const result = await runtime.execute(makeContext());
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('calls the LLM provider', async () => {
      expect(mockProvider.callCount).toBe(0);
      await runtime.execute(makeContext());
      expect(mockProvider.callCount).toBeGreaterThan(0);
    });

    it('passes the correct model to the provider', async () => {
      await runtime.execute(makeContext());
      expect(mockProvider.lastRequest).toBeTruthy();
      expect(mockProvider.lastRequest!.model).toBeTruthy();
    });

    it('includes system and user messages', async () => {
      await runtime.execute(makeContext());
      expect(mockProvider.lastRequest!.messages.length).toBeGreaterThanOrEqual(2);
      expect(mockProvider.lastRequest!.messages[0].role).toBe('system');
      expect(mockProvider.lastRequest!.messages[1].role).toBe('user');
    });
  });

  describe('error handling', () => {
    it('returns failed status when provider fails', async () => {
      const failingProvider = new MockLLMProvider('failing', {
        defaultResponse: '',
      });
      vi.spyOn(failingProvider, 'call').mockRejectedValue(new Error('API error'));
      runtime.registerProvider('openai', failingProvider);

      const result = await runtime.execute(makeContext());
      expect(result.status).toBe('failed');
      expect(result.error).toBeTruthy();
    });
  });

  describe('tool execution', () => {
    it('registers and retrieves tools', () => {
      const searchTool: Tool = {
        definition: {
          name: 'search',
          description: 'Search the web',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
        execute: async (args) => `Results for: ${args.q}`,
      };
      runtime.registerTool('search', searchTool);
      expect(runtime.getTool('search')).toBeDefined();
      expect(runtime.getTool('search')!.definition.name).toBe('search');
    });

    it('builds system prompt with available tools', async () => {
      const searchTool: Tool = {
        definition: {
          name: 'search',
          description: 'Search the web for information',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
        execute: async (args) => `Results for: ${args.q}`,
      };
      runtime.registerTool('search', searchTool);

      await runtime.execute(makeContext({ availableTools: ['search'] }));
      const lastMsg = mockProvider.lastRequest!.messages[0].content;
      expect(lastMsg).toContain('search');
    });
  });

  describe('provider management', () => {
    it('registers multiple providers', () => {
      const p1 = new MockLLMProvider('anthropic');
      const p2 = new MockLLMProvider('google');
      runtime.registerProvider('anthropic', p1);
      runtime.registerProvider('google', p2);
      expect(runtime.getProvider('anthropic')).toBe(p1);
      expect(runtime.getProvider('google')).toBe(p2);
    });
  });

  describe('concurrency tracking', () => {
    it('tracks active runs', async () => {
      expect(runtime.getActiveRunCount()).toBe(0);
      const promise = runtime.execute(makeContext());
      await promise;
      expect(runtime.getActiveRunCount()).toBe(0);
    });

    it('checks run activity by id', async () => {
      const result = await runtime.execute(makeContext());
      expect(runtime.isRunActive(result.runId)).toBe(false);
    });
  });

  describe('configuration', () => {
    it('uses custom configuration', () => {
      const custom = new AgentRuntime({ maxStepsPerRun: 5, maxRetries: 3, timeoutMs: 30000 }, router);
      const config = custom.getConfig();
      expect(config.maxStepsPerRun).toBe(5);
      expect(config.maxRetries).toBe(3);
      expect(config.timeoutMs).toBe(30000);
    });

    it('uses defaults for unspecified config', () => {
      const config = runtime.getConfig();
      expect(config.maxRetries).toBe(1);
      expect(config.defaultModelTier).toBe('standard');
    });
  });
});
