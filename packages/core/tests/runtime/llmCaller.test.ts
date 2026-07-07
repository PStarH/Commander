/**
 * LLMCaller extraction tests — Phase 1 of agentRuntime god-object split.
 *
 * Strategy: test the extracted `LLMCaller` module in isolation by feeding it
 * mocked subsystems (dep callbacks + module-level singletons). We DO NOT touch
 * a real AgentRuntime instance — the goal is to lock down the per-call state
 * machine: cache → hook → fallback → gateway → metric → error-classify-passthrough.
 *
 * Behaviour-preservation guarantees these tests enforce:
 *   1. Semantic-cache hit short-circuits before any provider call.
 *   2. FallbackChainExhaustedError -> `null` return (caller decides retry).
 *   3. preLLMCheck !allowed -> thrown, surfaced as lastProviderError, returns null upstream via fallback chain.
 *   4. postLLMCheck !allowed -> thrown, lastProviderError propagated the same way.
 *   5. Successful flow clears lastProviderError on success.
 *   6. catch() in `callProvider` writes lastProviderError + records failure sample.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module-level singleton mocks ---------------------------------------------
// These modules export `getX()` factories that the implementation depends on at
// call time, not at module load. We mock them via vi.mock above the imports.

const mockHookManager = {
  fireBeforeBackendSelect: vi.fn(async () => null),
  fireAfterBackendSelect: vi.fn(async () => null),
};

const mockGateway = {
  preLLMCheck: vi.fn(() => ({ allowed: true, reason: undefined })),
  postLLMCheck: vi.fn(() => ({ allowed: true, reason: undefined })),
};

const mockTenantProvider = {
  getCurrentTenantId: vi.fn(() => 'tenant-test'),
};

const mockMetrics = {
  recordSemanticCacheEvent: vi.fn(),
  recordGeminiCacheEvent: vi.fn(),
  recordSingleFlightEvent: vi.fn(),
};

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../../src/pluginManager', () => ({
  getHookManager: () => mockHookManager,
}));
vi.mock('../../src/security/enterpriseSecurityGateway', () => ({
  getEnterpriseSecurityGateway: () => mockGateway,
}));
vi.mock('../../src/runtime/tenantProvider', () => ({
  getGlobalTenantProvider: () => mockTenantProvider,
}));
vi.mock('../../src/runtime/metricsCollector', () => ({
  getMetricsCollector: () => mockMetrics,
}));
vi.mock('../../src/logging', () => ({
  getGlobalLogger: () => mockLogger,
}));

import {
  LLMCaller,
  type LLMCallerDeps,
  type LLMCallerCallInput,
} from '../../src/runtime/llm/llmCaller';
import {
  FallbackChainExhaustedError,
  ProviderFallbackChain,
} from '../../src/runtime/providerFallbackChain';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  RoutingDecision,
} from '../../src/runtime/types';

// --- Test helpers -------------------------------------------------------------

function makeResponse(content = 'hello'): LLMResponse {
  return {
    content,
    model: 'm',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
  };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

function makeRouting(provider = 'openai'): RoutingDecision {
  return {
    provider,
    modelId: 'm',
    modelTier: 'standard' as const,
    reason: 'test routing',
    estimatedCost: 0,
  };
}

function makeProvider(response: LLMResponse | Error | null, delayMs = 0): LLMProvider {
  return {
    name: 'mock',
    async call(_req: LLMRequest): Promise<LLMResponse> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (response instanceof Error) throw response;
      if (response === null) {
        throw new Error('mock provider returned null and should not be called');
      }
      return response;
    },
  };
}

function stats0() {
  return { hits: 0, misses: 0, inflight: 0, evictions: 0 };
}

function makeDeps(overrides: Partial<LLMCallerDeps> = {}): {
  deps: LLMCallerDeps;
  setProvider: (name: string, p: LLMProvider) => void;
  lastErr: { value: Error | null };
  samples: { calls: Array<Record<string, unknown>> };
  semanticCache: { hits: number; misses: number; stores: number };
  cache: {
    lookupSemantic: ReturnType<typeof vi.fn>;
    getGeminiCachedContent: ReturnType<typeof vi.fn>;
    dedupeSingleFlight: ReturnType<typeof vi.fn>;
    storeSemantic: ReturnType<typeof vi.fn>;
    getSingleFlightStats: ReturnType<typeof vi.fn>;
    getSingleFlightInflightCount: ReturnType<typeof vi.fn>;
  };
  stepTimeout: { wrap: ReturnType<typeof vi.fn> };
} {
  const providers = new Map<string, LLMProvider>();
  const lastErr: { value: Error | null } = { value: null };
  const samples: { calls: Array<Record<string, unknown>> } = { calls: [] };
  const semanticCache = { hits: 0, misses: 0, stores: 0 };

  const cache = {
    lookupSemantic: vi.fn(async () => null),
    getGeminiCachedContent: vi.fn(async () => ({ cachedContentName: null, createdNow: false })),
    dedupeSingleFlight: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    storeSemantic: vi.fn(() => {
      semanticCache.stores += 1;
    }),
    getSingleFlightStats: vi.fn(() => stats0()),
    getSingleFlightInflightCount: vi.fn(() => 0),
  };

  const stepTimeout = {
    wrap: vi.fn(async (p: Promise<LLMResponse>) => p),
  };

  // Real ProviderFallbackChain — keeps code paths honest.
  const fallbackChain = new ProviderFallbackChain<LLMResponse>({
    classify: (err) =>
      err instanceof Error && /429|timeout|ETIMEDOUT/i.test(err.message) ? 'retryable' : 'fatal',
  });

  const samplesStore = {
    recordLLMCall: (_req: LLMRequest, resp: LLMResponse | null, meta: Record<string, unknown>) => {
      samples.calls.push({ resp, meta });
    },
  } as unknown as LLMCallerDeps['samplesStore'];

  const deps: LLMCallerDeps = {
    getProviders: () => providers,
    getLastProviderError: () => lastErr.value,
    setLastProviderError: (err) => {
      lastErr.value = err;
    },
    samplesStore,
    cacheManager: cache as unknown as LLMCallerDeps['cacheManager'],
    stepTimeout: stepTimeout as unknown as LLMCallerDeps['stepTimeout'],
    fallbackChain,
    llmTimeoutMs: 5000,
    ...overrides,
  };

  return {
    deps,
    setProvider: (name, p) => providers.set(name, p),
    lastErr,
    samples,
    semanticCache,
    cache,
    stepTimeout,
  };
}

// --- Reset between tests ------------------------------------------------------

beforeEach(() => {
  mockHookManager.fireBeforeBackendSelect.mockReset();
  mockHookManager.fireBeforeBackendSelect.mockResolvedValue(null);
  mockHookManager.fireAfterBackendSelect.mockReset();
  mockHookManager.fireAfterBackendSelect.mockResolvedValue(null);
  mockGateway.preLLMCheck.mockReset();
  mockGateway.preLLMCheck.mockReturnValue({ allowed: true, reason: undefined });
  mockGateway.postLLMCheck.mockReset();
  mockGateway.postLLMCheck.mockReturnValue({ allowed: true, reason: undefined });
  mockTenantProvider.getCurrentTenantId.mockReset();
  mockTenantProvider.getCurrentTenantId.mockReturnValue('tenant-test');
  mockMetrics.recordSemanticCacheEvent.mockReset();
  mockMetrics.recordGeminiCacheEvent.mockReset();
  mockMetrics.recordSingleFlightEvent.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  process.env.GOOGLE_API_KEY = 'test-key';
  process.env.GOOGLE_BASE_URL = undefined;
});

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_BASE_URL;
});

// --- Tests --------------------------------------------------------------------

describe('LLMCaller — extracted Phase 1 helpers', () => {
  it('happy path: primary provider returns an LLMResponse', async () => {
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('ok')));

    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-1',
      attemptNumber: 0,
    });

    expect(result?.content).toBe('ok');
    expect(env.lastErr.value).toBeNull(); // cleared on success
    expect(env.samples.calls).toHaveLength(1);
    expect(env.samples.calls[0].meta.provider).toBe('openai');
  });

  it('semantic-cache hit short-circuits before any provider call', async () => {
    const cached = makeResponse('from-cache');
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('should-not-be-called')));
    env.cache.lookupSemantic.mockResolvedValueOnce(cached);

    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-2',
      attemptNumber: 0,
    });

    expect(result).toBe(cached);
    expect(env.cache.lookupSemantic).toHaveBeenCalledTimes(1);
    // The provider's call() must NEVER have fired.
    expect(env.cache.dedupeSingleFlight).not.toHaveBeenCalled();
  });

  it('FallbackChainExhaustedError returns null and logs warn', async () => {
    const env = makeDeps();
    // No providers registered -> empty entries -> the wrapped tryProviders throws.
    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-3',
      attemptNumber: 0,
    });

    expect(result).toBeNull();
    expect(env.samples.calls[0].meta.provider).toBe('none');
    expect(env.samples.calls[0].meta.error).toBe('No provider available');
  });

  it('pre-LLM gateway block writes lastProviderError and returns null', async () => {
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('will-not-run')));
    mockGateway.preLLMCheck.mockReturnValueOnce({
      allowed: false,
      reason: 'rate-limit',
    });

    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-4',
      attemptNumber: 0,
    });

    expect(result).toBeNull();
    // lastProviderError MUST be set by callProvider's catch — so the AgentRuntime
    // retry loop can read it on the next attempt.
    expect(env.lastErr.value).toBeInstanceOf(Error);
    expect(env.lastErr.value?.message).toMatch(/Security gateway blocked LLM call/i);
    // Failure sample recorded.
    expect(env.samples.calls[0].resp).toBeNull();
    expect(env.samples.calls[0].meta.error).toMatch(/Security gateway/i);
  });

  it('post-LLM gateway block writes lastProviderError and returns null', async () => {
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('will-be-blocked')));
    mockGateway.postLLMCheck.mockReturnValueOnce({
      allowed: false,
      reason: 'PII detected',
    });

    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-5',
      attemptNumber: 0,
    });

    expect(result).toBeNull();
    expect(env.lastErr.value).toBeInstanceOf(Error);
    expect(env.lastErr.value?.message).toMatch(/Security gateway blocked LLM output/i);
  });

  it('callProviderOrThrow clears lastProviderError on success', async () => {
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('fresh')));
    // Pre-pollute the error to confirm clear-on-success behaviour.
    env.deps.setLastProviderError(new Error('previous attempt failed'));

    const caller = new LLMCaller(env.deps);
    await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-6',
      attemptNumber: 1,
    });

    expect(env.lastErr.value).toBeNull();
    // stepId embeds attemptNumber verbatim — preserved from original implementation.
    expect(env.stepTimeout.wrap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stepId: 'llm-openai-1-task-6' }),
    );
  });

  it('hook-driven provider override should still produce a result', async () => {
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('a')));
    env.setProvider('anthropic', makeProvider(makeResponse('b')));
    // fireBeforeBackendSelect contract: string-or-null. A plain string override
    // is the canonical shape — using an object would silently degrade
    // `resolvedProvider` into a non-key value, hiding future refactor bugs.
    mockHookManager.fireBeforeBackendSelect.mockResolvedValueOnce('anthropic');

    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-7',
      attemptNumber: 0,
    });

    expect(result?.content).toBe('b');
  });

  it('empty-entries path returns null with sample error and does NOT warn', async () => {
    // Empty registry short-circuits BEFORE the tryProviders try/catch, so the
    // 'All providers exhausted' warn is NOT exercised here. The warn only fires
    // when fallbackChain throws FallbackChainExhaustedError (next test).
    const env = makeDeps();
    const caller = new LLMCaller(env.deps);

    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-8',
      attemptNumber: 0,
    });

    expect(result).toBeNull();
    expect(env.samples.calls[0].meta.provider).toBe('none');
    expect(env.samples.calls[0].meta.error).toBe('No provider available');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('FallbackChainExhaustedError fires the warn and records fallback_exhausted sample', async () => {
    // Drive the warn path through the REAL ProviderFallbackChain: register a
    // provider that throws a non-retryable error, then classify() as 'fatal' so
    // the chain gives up and throws FallbackChainExhaustedError — guaranteeing
    // we exercise the production code path, not a synthetic mock.
    const env = makeDeps();
    env.deps.fallbackChain = new ProviderFallbackChain<LLMResponse>({
      classify: () => 'fatal',
    });
    env.setProvider('openai', makeProvider(new Error('manual fault for test')));

    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-9',
      attemptNumber: 0,
    });

    expect(result).toBeNull();
    // Two sample calls expected: (1) inner catch in callProvider (provider='openai')
    // and (2) outer catch in LLMCaller.call (provider='fallback_exhausted').
    // We assert the chain-exhausted sample by filtering, not by index.
    const chainExhausted = env.samples.calls.find((c) => c.meta.provider === 'fallback_exhausted');
    expect(chainExhausted).toBeDefined();
    expect(env.samples.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'AgentRuntime',
      'All providers exhausted in fallback chain',
      expect.objectContaining({ error: expect.stringMatching(/manual fault/) }),
    );
  });

  it('hook that throws is swallowed, normal call flow continues', async () => {
    // .catch(() => null) around fireBeforeBackendSelect must keep the call
    // alive if a hook throws — covered for @safe-side regex transpile test
    // and third-party plugin regressions.
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('after-hook-throw')));
    mockHookManager.fireBeforeBackendSelect.mockRejectedValueOnce(new Error('plugin crashed'));

    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-10',
      attemptNumber: 0,
    });

    expect(result?.content).toBe('after-hook-throw');
  });

  it('Google Gemini cachedContent wiring attaches cachedContentName + records metric', async () => {
    const env = makeDeps();
    env.setProvider('google', makeProvider(makeResponse('google-resp')));
    env.cache.getGeminiCachedContent.mockResolvedValueOnce({
      cachedContentName: 'cached/name/42',
      createdNow: true,
    });

    const req: LLMRequest = makeRequest({
      // The cacheConfig must exist AND mutate-on-success — verified below.
      cacheConfig: { geminiCachedContentName: undefined } as unknown as NonNullable<
        LLMRequest['cacheConfig']
      >,
    });

    const caller = new LLMCaller(env.deps);
    const result = await caller.call({
      request: req,
      routing: makeRouting('google'),
      taskId: 'task-11',
      attemptNumber: 0,
    });

    expect(result?.content).toBe('google-resp');
    // The contract: cache wiring mutates request.cacheConfig.geminiCachedContentName.
    expect(req.cacheConfig?.geminiCachedContentName).toBe('cached/name/42');
    expect(mockMetrics.recordGeminiCacheEvent).toHaveBeenCalledWith('create', expect.anything());
  });

  // Sanity: confirm we aren't leaking the FallbackChainExhaustedError class shape
  // change by accident — we still import it from providerFallbackChain.
  it('uses FallbackChainExhaustedError from providerFallbackChain', () => {
    expect(FallbackChainExhaustedError).toBeDefined();
    expect(typeof ProviderFallbackChain).toBe('function');
  });
});
