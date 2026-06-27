/**
 * Tests for Round 2 Provider Optimizations
 *
 * Covers:
 *   - GLM: cached_tokens parsing (non-streaming) + prompt_cache_key + reasoning
 *   - Xiaomi: cached_tokens parsing (non-streaming) + prompt_cache_key + reasoning
 *   - MiMo: cached_tokens parsing (non-streaming) + prompt_cache_key
 *   - StepFun: respects request.reasoningConfig instead of hardcoding 'medium'
 *   - MiniMax: provider instantiation + base class inheritance
 *   - CostModel: MiniMax, GLM, Xiaomi, MiMo, StepFun pricing entries
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GLMProvider } from '../../src/runtime/providers/glmProvider';
import { XiaomiProvider } from '../../src/runtime/providers/xiaomiProvider';
import { MiMoProvider } from '../../src/runtime/providers/mimoProvider';
import { StepFunProvider } from '../../src/runtime/providers/stepfunProvider';
import { MiniMaxProvider } from '../../src/runtime/providers/minimaxProvider';
import type { LLMRequest } from '../../src/runtime/types/llm';
import { DEFAULT_PRICING } from '../../src/observability/costModel';

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 1000,
    ...overrides,
  };
}

/**
 * Create a mock fetch that returns a JSON response and captures the request body.
 */
function mockFetchWithCapture(responseData: unknown): {
  restore: () => void;
  getBody: () => any;
} {
  const originalFetch = global.fetch;
  let capturedBody: any;
  global.fetch = (async (_url: any, init: any) => {
    if (init?.body) capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    restore: () => { global.fetch = originalFetch; },
    getBody: () => capturedBody,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Round 2 Provider Optimizations', () => {

  // ==========================================================================
  // GLM Provider
  // ==========================================================================
  describe('GLM — cached_tokens parsing + prompt_cache_key + reasoning', () => {
    it('parses cached_tokens from non-streaming response', async () => {
      const provider = new GLMProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          total_tokens: 1050,
          prompt_tokens_details: { cached_tokens: 700 },
        },
      });
      try {
        const result = await provider.call(makeRequest({
          model: 'glm-4.7',
          cacheConfig: { cacheSystemPrompt: false, cacheTools: false, useCacheControl: false },
        }));
        assert.strictEqual(result.usage.cacheReadTokens ?? 0, 700);
      } finally {
        mock.restore();
      }
    });

    it('sets cacheReadTokens to 0 when no cache fields present', async () => {
      const provider = new GLMProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      });
      try {
        const result = await provider.call(makeRequest({
          model: 'glm-4.7',
          cacheConfig: { cacheSystemPrompt: false, cacheTools: false, useCacheControl: false },
        }));
        assert.strictEqual(result.usage.cacheReadTokens ?? 0, 0);
      } finally {
        mock.restore();
      }
    });

    it('includes prompt_cache_key in body when cacheConfig.promptCacheKey is set', async () => {
      const provider = new GLMProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'glm-4.7',
          cacheConfig: {
            cacheSystemPrompt: true,
            cacheTools: false,
            useCacheControl: false,
            promptCacheKey: 'glm-cache-001',
          },
        }));
        assert.strictEqual(mock.getBody().prompt_cache_key, 'glm-cache-001');
      } finally {
        mock.restore();
      }
    });

    it('includes enable_thinking + reasoning_effort + max_thinking_tokens when reasoningConfig enabled', async () => {
      const provider = new GLMProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'glm-4.7',
          reasoningConfig: { enabled: true, effort: 'high', budget: 4096 },
          cacheConfig: { useCacheControl: false },
        }));
        const body = mock.getBody();
        assert.strictEqual(body.enable_thinking, true);
        assert.strictEqual(body.reasoning_effort, 'high');
        assert.strictEqual(body.max_thinking_tokens, 4096);
      } finally {
        mock.restore();
      }
    });

    it('does not include reasoning fields when reasoningConfig absent', async () => {
      const provider = new GLMProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'glm-4.7',
          cacheConfig: { useCacheControl: false },
        }));
        const body = mock.getBody();
        assert.strictEqual(body.enable_thinking, undefined);
        assert.strictEqual(body.reasoning_effort, undefined);
      } finally {
        mock.restore();
      }
    });
  });

  // ==========================================================================
  // Xiaomi Provider
  // ==========================================================================
  describe('Xiaomi — cached_tokens parsing + prompt_cache_key + reasoning', () => {
    it('parses cached_tokens from non-streaming response', async () => {
      const provider = new XiaomiProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 800,
          completion_tokens: 30,
          total_tokens: 830,
          prompt_tokens_details: { cached_tokens: 500 },
        },
      });
      try {
        const result = await provider.call(makeRequest({
          model: 'mimo-v2-flash',
          cacheConfig: { cacheSystemPrompt: false, cacheTools: false, useCacheControl: false },
        }));
        assert.strictEqual(result.usage.cacheReadTokens ?? 0, 500);
      } finally {
        mock.restore();
      }
    });

    it('includes prompt_cache_key in body when set', async () => {
      const provider = new XiaomiProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'mimo-v2-flash',
          cacheConfig: {
            cacheSystemPrompt: true,
            cacheTools: false,
            useCacheControl: false,
            promptCacheKey: 'xm-cache-99',
          },
        }));
        assert.strictEqual(mock.getBody().prompt_cache_key, 'xm-cache-99');
      } finally {
        mock.restore();
      }
    });

    it('includes enable_thinking + reasoning_effort when reasoningConfig enabled', async () => {
      const provider = new XiaomiProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'mimo-v2-pro',
          reasoningConfig: { enabled: true, effort: 'low', budget: 1024 },
          cacheConfig: { useCacheControl: false },
        }));
        const body = mock.getBody();
        assert.strictEqual(body.enable_thinking, true);
        assert.strictEqual(body.reasoning_effort, 'low');
        assert.strictEqual(body.max_thinking_tokens, 1024);
      } finally {
        mock.restore();
      }
    });
  });

  // ==========================================================================
  // MiMo Provider
  // ==========================================================================
  describe('MiMo — cached_tokens parsing + prompt_cache_key', () => {
    it('parses cached_tokens from non-streaming response', async () => {
      const provider = new MiMoProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 600,
          completion_tokens: 20,
          total_tokens: 620,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      });
      try {
        const result = await provider.call(makeRequest({
          model: 'mimo-v2.5',
          cacheConfig: { cacheSystemPrompt: false, cacheTools: false, useCacheControl: false },
        }));
        assert.strictEqual(result.usage.cacheReadTokens ?? 0, 400);
      } finally {
        mock.restore();
      }
    });

    it('sets cacheReadTokens to 0 when no cache fields present', async () => {
      const provider = new MiMoProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      });
      try {
        const result = await provider.call(makeRequest({
          model: 'mimo-v2.5',
          cacheConfig: { cacheSystemPrompt: false, cacheTools: false, useCacheControl: false },
        }));
        assert.strictEqual(result.usage.cacheReadTokens ?? 0, 0);
      } finally {
        mock.restore();
      }
    });

    it('includes prompt_cache_key in body when set', async () => {
      const provider = new MiMoProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'mimo-v2.5',
          cacheConfig: {
            cacheSystemPrompt: true,
            cacheTools: false,
            useCacheControl: false,
            promptCacheKey: 'mimo-key-42',
          },
        }));
        assert.strictEqual(mock.getBody().prompt_cache_key, 'mimo-key-42');
      } finally {
        mock.restore();
      }
    });

    it('does not include prompt_cache_key when cacheConfig absent', async () => {
      const provider = new MiMoProvider({ apiKey: 'test' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'mimo-v2.5',
          cacheConfig: { useCacheControl: false },
        }));
        assert.strictEqual(mock.getBody().prompt_cache_key, undefined);
      } finally {
        mock.restore();
      }
    });
  });

  // ==========================================================================
  // StepFun Provider
  // ==========================================================================
  describe('StepFun — respects request.reasoningConfig', () => {
    it('uses request.reasoningConfig.effort when provided', async () => {
      const provider = new StepFunProvider({ apiKey: 'test', defaultModel: 'step-3.7-flash' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'step-3.7-flash',
          reasoningConfig: { enabled: true, effort: 'high' },
          cacheConfig: { useCacheControl: false },
        }));
        const body = mock.getBody();
        assert.strictEqual(body.reasoning_effort, 'high');
      } finally {
        mock.restore();
      }
    });

    it('includes max_thinking_tokens when budget is set', async () => {
      const provider = new StepFunProvider({ apiKey: 'test', defaultModel: 'step-3.5-flash' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'step-3.5-flash',
          reasoningConfig: { enabled: true, effort: 'low', budget: 512 },
          cacheConfig: { useCacheControl: false },
        }));
        const body = mock.getBody();
        assert.strictEqual(body.reasoning_effort, 'low');
        assert.strictEqual(body.max_thinking_tokens, 512);
      } finally {
        mock.restore();
      }
    });

    it('falls back to medium when no reasoningConfig provided', async () => {
      const provider = new StepFunProvider({ apiKey: 'test', defaultModel: 'step-3.7-flash' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'step-3.7-flash',
          cacheConfig: { useCacheControl: false },
        }));
        assert.strictEqual(mock.getBody().reasoning_effort, 'medium');
      } finally {
        mock.restore();
      }
    });

    it('base class still propagates reasoning_effort for non-step-3 models when explicitly set', async () => {
      const provider = new StepFunProvider({ apiKey: 'test', defaultModel: 'step-router-v1' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'step-router-v1',
          reasoningConfig: { enabled: true, effort: 'high' },
          cacheConfig: { useCacheControl: false },
        }));
        // Base class propagates reasoning_effort regardless of model name;
        // StepFun's getExtraBody only adds defaults for step-3 models
        assert.strictEqual(mock.getBody().reasoning_effort, 'high');
      } finally {
        mock.restore();
      }
    });

    it('does not set reasoning_effort when reasoningConfig.enabled is false', async () => {
      const provider = new StepFunProvider({ apiKey: 'test', defaultModel: 'step-3.7-flash' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'step-3.7-flash',
          reasoningConfig: { enabled: false },
          cacheConfig: { useCacheControl: false },
        }));
        // When reasoningConfig.enabled === false, should NOT set any reasoning_effort
        assert.strictEqual(mock.getBody().reasoning_effort, undefined);
      } finally {
        mock.restore();
      }
    });
  });

  // ==========================================================================
  // MiniMax Provider
  // ==========================================================================
  describe('MiniMax — provider instantiation + base class inheritance', () => {
    it('creates provider with correct defaults', () => {
      const provider = new MiniMaxProvider({ apiKey: 'test' });
      assert.strictEqual(provider.name, 'minimax');
    });

    it('uses custom base URL and model when provided', () => {
      const provider = new MiniMaxProvider({
        apiKey: 'test',
        baseUrl: 'https://custom.minimax.io/v1',
        defaultModel: 'MiniMax-M3-custom',
      });
      assert.strictEqual(provider.name, 'minimax');
    });

    it('inherits prompt_cache_key propagation from base class', async () => {
      const provider = new MiniMaxProvider({ apiKey: 'test', defaultModel: 'MiniMax-M3' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'MiniMax-M3',
          cacheConfig: {
            cacheSystemPrompt: true,
            cacheTools: false,
            useCacheControl: false,
            promptCacheKey: 'mm-cache-007',
          },
        }));
        assert.strictEqual(mock.getBody().prompt_cache_key, 'mm-cache-007');
      } finally {
        mock.restore();
      }
    });

    it('inherits reasoning_effort propagation from base class', async () => {
      const provider = new MiniMaxProvider({ apiKey: 'test', defaultModel: 'MiniMax-M3' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      try {
        await provider.call(makeRequest({
          model: 'MiniMax-M3',
          reasoningConfig: { enabled: true, effort: 'high' },
          cacheConfig: { useCacheControl: false },
        }));
        assert.strictEqual(mock.getBody().reasoning_effort, 'high');
      } finally {
        mock.restore();
      }
    });

    it('parses cached_tokens from non-streaming response', async () => {
      const provider = new MiniMaxProvider({ apiKey: 'test', defaultModel: 'MiniMax-M3' });
      const mock = mockFetchWithCapture({
        choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 100,
          total_tokens: 2100,
          prompt_tokens_details: { cached_tokens: 1500 },
        },
      });
      try {
        const result = await provider.call(makeRequest({
          model: 'MiniMax-M3',
          cacheConfig: { cacheSystemPrompt: false, cacheTools: false, useCacheControl: false },
        }));
        assert.strictEqual(result.usage.cacheReadTokens ?? 0, 1500);
      } finally {
        mock.restore();
      }
    });
  });

  // ==========================================================================
  // CostModel — Round 2 pricing entries
  // ==========================================================================
  describe('CostModel — Round 2 pricing entries', () => {
    it('returns pricing for MiniMax M3', () => {
      const entry = DEFAULT_PRICING.find(
        (p) => p.provider === 'minimax' && p.model === 'MiniMax-M3',
      );
      assert.ok(entry);
      assert.ok(entry!.cachedInputPer1k !== undefined);
      assert.strictEqual(entry!.cachedInputPer1k!, 0.0001);
    });

    it('returns pricing for GLM 4.7', () => {
      const entry = DEFAULT_PRICING.find(
        (p) => p.provider === 'glm' && p.model === 'glm-4.7',
      );
      assert.ok(entry);
      assert.ok(entry!.cachedInputPer1k !== undefined);
      assert.strictEqual(entry!.cachedInputPer1k!, 0.00007);
    });

    it('returns pricing for GLM 4.6', () => {
      const entry = DEFAULT_PRICING.find(
        (p) => p.provider === 'glm' && p.model === 'glm-4.6',
      );
      assert.ok(entry);
      assert.ok(entry!.cachedInputPer1k !== undefined);
    });

    it('returns pricing for Xiaomi MiMo v2-flash', () => {
      const entry = DEFAULT_PRICING.find(
        (p) => p.provider === 'xiaomi' && p.model === 'mimo-v2-flash',
      );
      assert.ok(entry);
      assert.ok(entry!.cachedInputPer1k !== undefined);
      assert.strictEqual(entry!.cachedInputPer1k!, 0.000018);
    });

    it('returns pricing for Xiaomi MiMo v2-pro', () => {
      const entry = DEFAULT_PRICING.find(
        (p) => p.provider === 'xiaomi' && p.model === 'mimo-v2-pro',
      );
      assert.ok(entry);
      assert.ok(entry!.cachedInputPer1k !== undefined);
    });

    it('returns pricing for MiMo v2.5', () => {
      const entry = DEFAULT_PRICING.find(
        (p) => p.provider === 'mimo' && p.model === 'mimo-v2.5',
      );
      assert.ok(entry);
      assert.ok(entry!.cachedInputPer1k !== undefined);
    });

    it('returns pricing for StepFun step-3.7-flash', () => {
      const entry = DEFAULT_PRICING.find(
        (p) => p.provider === 'stepfun' && p.model === 'step-3.7-flash',
      );
      assert.ok(entry);
      assert.ok(entry!.cachedInputPer1k !== undefined);
      assert.strictEqual(entry!.cachedInputPer1k!, 0.00003);
    });
  });
});
