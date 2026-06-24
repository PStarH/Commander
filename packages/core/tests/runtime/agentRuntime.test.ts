import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { SingleFlightRequestCache } from '../../src/runtime/singleFlightRequestCache';
import type { AgentExecutionContext, Tool, ToolDefinition } from '../../src/runtime/types';

describe('AgentRuntime', () => {
  let runtime: AgentRuntime;
  let mockProvider: MockLLMProvider;
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
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
      expect(mockProvider.lastRequest!.messages.length).toBeGreaterThanOrEqual(3);
      // buildSystemPrompt split: cache-stable prefix + dynamic suffix = 2 system messages
      expect(mockProvider.lastRequest!.messages[0].role).toBe('system');
      expect(mockProvider.lastRequest!.messages[1].role).toBe('system');
      expect(mockProvider.lastRequest!.messages[2].role).toBe('user');
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
      const custom = new AgentRuntime(
        { maxStepsPerRun: 5, maxRetries: 3, timeoutMs: 30000 },
        router,
      );
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

  describe('semantic cache', () => {
    it('defaults to disabled with zero entries', () => {
      const stats = runtime.getSemanticCacheStats();
      expect(stats.totalEntries).toBe(0);
    });

    it('stays disabled when enabled=true but no OPENAI_API_KEY is available', () => {
      const r = new AgentRuntime(
        { maxRetries: 1, timeoutMs: 5000, semanticCache: { enabled: true } },
        new ModelRouter(),
      );
      const stats = r.getSemanticCacheStats();
      expect(stats.totalEntries).toBe(0);
    });

    it('enables cache when enabled=true with explicit openaiApiKey', () => {
      const r = new AgentRuntime(
        {
          maxRetries: 1,
          timeoutMs: 5000,
          semanticCache: { enabled: true, openaiApiKey: 'sk-test', similarityThreshold: 0.9 },
        },
        new ModelRouter(),
      );
      const stats = r.getSemanticCacheStats();
      expect(stats.totalEntries).toBe(0);
      expect(typeof stats.estimatedCostSavedUsd).toBe('number');
    });
  });

  describe('prompt cache config', () => {
    it('defaults cacheTtl to 5m and derives promptCacheKey per request', async () => {
      await runtime.execute(makeContext());
      const req = mockProvider.lastRequest;
      expect(req).toBeDefined();
      expect(req!.cacheConfig?.cacheTtl).toBe('5m');
      expect(req!.cacheConfig?.promptCacheKey).toMatch(/^[^:]+:[^:]+:[a-z0-9]{1,12}$/);
    });

    it('uses explicit promptCacheKey when configured', async () => {
      const r = new AgentRuntime(
        { maxRetries: 1, timeoutMs: 5000, promptCacheKey: 'tenant-a:agent-x:fixed' },
        new ModelRouter(),
      );
      const p = new MockLLMProvider('openai', { defaultResponse: 'ok' });
      r.registerProvider('openai', p);
      await r.execute(makeContext());
      expect(p.lastRequest?.cacheConfig?.promptCacheKey).toBe('tenant-a:agent-x:fixed');
    });

    it('keeps cacheTtl at 5m by default (does not opt into 1h premium)', async () => {
      await runtime.execute(makeContext());
      expect(mockProvider.lastRequest?.cacheConfig?.cacheTtl).toBe('5m');
    });

    it('honors promptCacheTtl=1h when governor is not in critical phase', async () => {
      const r = new AgentRuntime(
        { maxRetries: 1, timeoutMs: 5000, promptCacheTtl: '1h' },
        new ModelRouter(),
      );
      const p = new MockLLMProvider('openai', { defaultResponse: 'ok' });
      r.registerProvider('openai', p);
      await r.execute(makeContext());
      expect(p.lastRequest?.cacheConfig?.cacheTtl).toBe('1h');
    });
  });

  describe('single-flight request dedup', () => {
    it('dedupes concurrent identical requests so provider is called once', async () => {
      const slowProvider = new MockLLMProvider('openai', { defaultResponse: 'ok' });
      const origCall = slowProvider.call.bind(slowProvider);
      let callCount = 0;
      slowProvider.call = async (req) => {
        callCount++;
        await new Promise((r) => setTimeout(r, 30));
        return origCall(req);
      };
      const r = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, new ModelRouter());
      r.registerProvider('openai', slowProvider);
      const ctx = makeContext();
      const [a, b, c] = await Promise.all([r.execute(ctx), r.execute(ctx), r.execute(ctx)]);
      expect(a.status).toBe('success');
      expect(b.status).toBe('success');
      expect(c.status).toBe('success');
      expect(callCount).toBe(1);
    });

    it('does NOT dedupe sequential calls (the in-flight is already resolved)', async () => {
      const r = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, new ModelRouter());
      const p = new MockLLMProvider('openai', { defaultResponse: 'ok' });
      r.registerProvider('openai', p);
      await r.execute(makeContext());
      p.callCount = 0;
      await r.execute(makeContext());
      expect(p.callCount).toBe(1);
    });

    it('exposes single-flight stats for observability', async () => {
      await runtime.execute(makeContext());
      const stats = runtime.getSingleFlightStats();
      expect(stats.totalRequests).toBeGreaterThan(0);
      expect(typeof stats.hitRate).toBe('number');
      expect(stats.inflight).toBe(0);
    });

    it('disabled singleFlight bypasses dedup (provider is called every time)', async () => {
      const r = new AgentRuntime(
        { maxRetries: 1, timeoutMs: 5000, singleFlight: { enabled: false } },
        new ModelRouter(),
      );
      const p = new MockLLMProvider('openai', { defaultResponse: 'ok' });
      r.registerProvider('openai', p);
      const [a, b] = await Promise.all([r.execute(makeContext()), r.execute(makeContext())]);
      expect(a.status).toBe('success');
      expect(b.status).toBe('success');
      expect(p.callCount).toBe(2);
    });

    it('SingleFlightRequestCache.computeKey isolates by tenantId', () => {
      const request = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      };
      const keyA = SingleFlightRequestCache.computeKey(request, 'tenant-a');
      const keyB = SingleFlightRequestCache.computeKey(request, 'tenant-b');
      const keyNull = SingleFlightRequestCache.computeKey(request);
      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toBe(keyNull);
      expect(keyB).not.toBe(keyNull);
    });
  });

  describe('execute with mock provider', () => {
    it('is fully drivable by a mock provider without external API calls', async () => {
      const r = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, new ModelRouter());
      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Mock-driven result',
      });
      r.registerProvider('openai', provider);

      const result = await r.execute(makeContext());

      expect(result.status).toBe('success');
      expect(result.summary).toContain('Mock-driven result');
      expect(provider.callCount).toBeGreaterThan(0);
      expect(provider.lastRequest).toBeTruthy();
    });

    it('delegates execute() to the registered provider', async () => {
      const r = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, new ModelRouter());
      const provider = new MockLLMProvider('openai', { defaultResponse: 'delegated' });
      const spy = vi.spyOn(provider, 'call');
      r.registerProvider('openai', provider);

      await r.execute(makeContext());

      expect(spy).toHaveBeenCalled();
      const req = spy.mock.calls[0][0];
      expect(req.messages.some((m) => m.role === 'user')).toBe(true);
    });

    it('surfaces provider errors as failed results', async () => {
      const r = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, new ModelRouter());
      const provider = new MockLLMProvider('openai', { defaultResponse: '' });
      vi.spyOn(provider, 'call').mockRejectedValue(new Error('provider down'));
      r.registerProvider('openai', provider);

      const result = await r.execute(makeContext());

      expect(result.status).toBe('failed');
      expect(result.error).toBeTruthy();
    });
  });
});
