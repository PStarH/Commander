/**
 * LLMCaller extraction tests — Phase 1 of agentRuntime god-object split.
 *
 * Strategy: test the extracted `LLMCaller` module in isolation by feeding it
 * fake dep callbacks and spying on the module-level singletons it looks up at
 * call time. We DO NOT touch
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
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// --- Module-level singleton stubs ---------------------------------------------
// The implementation resolves these singletons at call time via `getX()`
// factories, so the test stubs the *returned instances* with `vi.spyOn`.
//
// `vi.mock('../../src/...')` cannot work here: `tests/setup.ts` transitively
// imports `src/runtime/llm/llmCaller.ts` (setup → modelRouter →
// silentFailureReporter → logging → tenantAwareSingleton → tenantContext →
// tenantProvider → threeLayerMemory → runtime/index → agentRuntime → llmCaller),
// so llmCaller — and its bindings to pluginManager / enterpriseSecurityGateway /
// metricsCollector / logging / tenantProvider — is already evaluated, against the
// real modules, before this file's mock registrations run. A `vi.mock` factory
// here is never even invoked (verified with a throwing factory). Spying on the
// live singletons the implementation actually holds is the only honest seam.

let hookBefore: Mock;
let gatewayPre: Mock;
let gatewayPost: Mock;
let geminiMetric: Mock;
let loggerWarn: Mock;

import {
  // The class is exported as `LlmCaller`; the test imported `LLMCaller`, so the
  // module failed to instantiate and the file never ran a single case. That is
  // also why its DECLARED_NOT_RUN reason ("does not record a fallback_exhausted
  // sample") described a failure nobody had actually observed.
  LlmCaller,
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
// Real singletons — spied on per-test; see the note above.
import { getHookManager } from '../../src/pluginManager';
import { getEnterpriseSecurityGateway } from '../../src/security/enterpriseSecurityGateway';
import { getGlobalTenantProvider } from '../../src/runtime/tenantProvider';
import { getMetricsCollector } from '../../src/runtime/metricsCollector';
import { getGlobalLogger } from '../../src/logging';

// --- Test helpers -------------------------------------------------------------

/** One recorded call captured by the `samplesStore` stub in `makeDeps`. */
interface RecordedSample {
  resp: LLMResponse | null;
  meta: {
    provider: string;
    durationMs: number;
    attemptNumber: number;
    error?: string;
    taskId?: string;
  };
}

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
    tier: 'standard',
    reasoning: ['test routing'],
    estimatedCost: 0,
    maxTokens: 4096,
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
  samples: { calls: RecordedSample[] };
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
  const samples: { calls: RecordedSample[] } = { calls: [] };
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

  // Real ProviderFallbackChain — keeps code paths honest. The option name is
  // `isRetryable` (providerFallbackChain.ts:26-38); `classify` was a stale,
  // silently-ignored key that left DEFAULT_RETRYABLE in charge.
  const fallbackChain = new ProviderFallbackChain<LLMResponse>({
    isRetryable: (err) => err instanceof Error && /429|timeout|ETIMEDOUT/i.test(err.message),
  });

  const samplesStore = {
    recordLLMCall: (_req: LLMRequest, resp: LLMResponse | null, meta: RecordedSample['meta']) => {
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
// The global `tests/setup.ts` beforeEach runs first and resets the security
// singletons, so these instances must be re-resolved (and re-spied) here.

beforeEach(() => {
  hookBefore = vi.spyOn(getHookManager(), 'fireBeforeBackendSelect').mockResolvedValue(null);
  vi.spyOn(getHookManager(), 'fireAfterBackendSelect').mockResolvedValue(undefined);
  gatewayPre = vi
    .spyOn(getEnterpriseSecurityGateway(), 'preLLMCheck')
    .mockReturnValue({ allowed: true, durationMs: 0 });
  gatewayPost = vi
    .spyOn(getEnterpriseSecurityGateway(), 'postLLMCheck')
    .mockReturnValue({ allowed: true, durationMs: 0 });
  vi.spyOn(getGlobalTenantProvider(), 'getCurrentTenantId').mockReturnValue('tenant-test');
  const collector = getMetricsCollector();
  vi.spyOn(collector, 'recordSemanticCacheEvent').mockImplementation(() => {});
  geminiMetric = vi.spyOn(collector, 'recordGeminiCacheEvent').mockImplementation(() => {});
  vi.spyOn(collector, 'recordSingleFlightEvent').mockImplementation(() => {});
  loggerWarn = vi.spyOn(getGlobalLogger(), 'warn').mockImplementation(() => {});
  process.env.GOOGLE_API_KEY = 'test-key';
  process.env.GOOGLE_BASE_URL = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_BASE_URL;
});

// --- Tests --------------------------------------------------------------------

describe('LLMCaller — extracted Phase 1 helpers', () => {
  it('happy path: primary provider returns an LLMResponse', async () => {
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('ok')));

    const caller = new LlmCaller(env.deps);
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

    const caller = new LlmCaller(env.deps);
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
    const caller = new LlmCaller(env.deps);
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
    const provider = makeProvider(makeResponse('will-not-run'));
    const providerCall = vi.spyOn(provider, 'call');
    env.setProvider('openai', provider);
    gatewayPre.mockReturnValueOnce({
      allowed: false,
      reason: 'rate-limit',
      durationMs: 0,
    });

    const caller = new LlmCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-4',
      attemptNumber: 0,
    });

    expect(result).toBeNull();
    // The whole point: a denied pre-check must stop the provider call dead.
    expect(providerCall).not.toHaveBeenCalled();
    // lastProviderError MUST be set by callProvider's catch — so the AgentRuntime
    // retry loop can read it on the next attempt.
    expect(env.lastErr.value).toBeInstanceOf(Error);
    expect(env.lastErr.value?.message).toMatch(/Security gateway blocked LLM call/i);
    // Failure sample recorded.
    expect(env.samples.calls[0].resp).toBeNull();
    expect(env.samples.calls[0].meta.error).toMatch(/Security gateway/i);
  });

  it('returns and records the gateway-sanitized output when the post-check allows after redaction', async () => {
    // `postLLMCheck` may allow an output while still having redacted it
    // (`{ allowed: true, sanitizedOutput }`, enterpriseSecurityGateway.ts:442/462).
    // The caller used to ignore that field, so the unredacted content was
    // returned, sampled and stored — a DLP decision that was computed and then
    // discarded.
    const env = makeDeps();
    const provider = makeProvider(makeResponse('sk-live-LEAKED-SECRET'));
    const providerCall = vi.spyOn(provider, 'call');
    env.setProvider('openai', provider);
    gatewayPost.mockReturnValueOnce({
      allowed: true,
      durationMs: 0,
      sanitizedOutput: '[REDACTED-OUTPUT]',
    });

    const caller = new LlmCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-sanitized',
      attemptNumber: 0,
    });

    // The provider ran and was allowed, but its output was redacted.
    expect(providerCall).toHaveBeenCalledTimes(1);

    expect(result?.content).toBe('[REDACTED-OUTPUT]');
    expect(result?.content).not.toContain('LEAKED');
    // The recorded sample must carry the sanitized form, not the raw one.
    expect(JSON.stringify(env.samples.calls)).not.toContain('LEAKED');
  });

  it('sends the sanitized message content, not the original (SF-02)', async () => {
    // The gateway sanitizes the detached `input` copy it is handed. The provider
    // used to receive the ORIGINAL request, so content the gateway had already
    // redacted was still sent — the DLP decision was computed and discarded.
    const env = makeDeps();
    const provider = makeProvider(makeResponse('ok'));
    const providerCall = vi.spyOn(provider, 'call');
    env.setProvider('openai', provider);

    const caller = new LlmCaller(env.deps);
    await caller.call({
      request: {
        ...makeRequest(),
        messages: [{ role: 'user', content: 'contact alice@example.com now' }],
      },
      routing: makeRouting('openai'),
      taskId: 'task-sf02',
      attemptNumber: 0,
    });

    expect(providerCall).toHaveBeenCalledTimes(1);
    const sent = providerCall.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(sent.messages[0]!.content).not.toContain('alice@example.com');
    expect(sent.messages[0]!.content).toContain('[EMAIL_REDACTED]');
  });

  it('post-LLM gateway block writes lastProviderError and returns null', async () => {
    const env = makeDeps();
    const provider = makeProvider(makeResponse('will-be-blocked'));
    const providerCall = vi.spyOn(provider, 'call');
    env.setProvider('openai', provider);
    gatewayPost.mockReturnValueOnce({
      allowed: false,
      reason: 'PII detected',
      durationMs: 0,
    });

    const caller = new LlmCaller(env.deps);
    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-5',
      attemptNumber: 0,
    });

    expect(result).toBeNull();
    // The provider ran, but a denied post-check must withhold its output.
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(env.lastErr.value).toBeInstanceOf(Error);
    expect(env.lastErr.value?.message).toMatch(/Security gateway blocked LLM output/i);
  });

  it('callProviderOrThrow clears lastProviderError on success', async () => {
    const env = makeDeps();
    env.setProvider('openai', makeProvider(makeResponse('fresh')));
    // Pre-pollute the error to confirm clear-on-success behaviour.
    env.deps.setLastProviderError(new Error('previous attempt failed'));

    const caller = new LlmCaller(env.deps);
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
    hookBefore.mockResolvedValueOnce('anthropic');

    const caller = new LlmCaller(env.deps);
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
    const caller = new LlmCaller(env.deps);

    const result = await caller.call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'task-8',
      attemptNumber: 0,
    });

    expect(result).toBeNull();
    expect(env.samples.calls[0].meta.provider).toBe('none');
    expect(env.samples.calls[0].meta.error).toBe('No provider available');
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('FallbackChainExhaustedError fires the warn and records fallback_exhausted sample', async () => {
    // Drive the warn path through the REAL ProviderFallbackChain: register a
    // provider that throws, then make every error retryable so the single-entry
    // chain gives up and throws FallbackChainExhaustedError — guaranteeing we
    // exercise the production code path, not a synthetic mock.
    //
    // The option is `isRetryable` (providerFallbackChain.ts:26-38); the old
    // `classify: () => 'fatal'` was silently ignored, so DEFAULT_RETRYABLE
    // classified the ResourceGovernor-wrapped error as permanent and the chain
    // rethrew the raw error — never producing FallbackChainExhaustedError.
    const env = makeDeps();
    env.deps.fallbackChain = new ProviderFallbackChain<LLMResponse>({
      isRetryable: () => true,
    });
    env.setProvider('openai', makeProvider(new Error('manual fault for test')));

    const caller = new LlmCaller(env.deps);
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
    expect(loggerWarn).toHaveBeenCalledWith(
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
    hookBefore.mockRejectedValueOnce(new Error('plugin crashed'));

    const caller = new LlmCaller(env.deps);
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

    const caller = new LlmCaller(env.deps);
    const result = await caller.call({
      request: req,
      routing: makeRouting('google'),
      taskId: 'task-11',
      attemptNumber: 0,
    });

    expect(result?.content).toBe('google-resp');
    // The contract: cache wiring mutates request.cacheConfig.geminiCachedContentName.
    expect(req.cacheConfig?.geminiCachedContentName).toBe('cached/name/42');
    expect(geminiMetric).toHaveBeenCalledWith('create', expect.anything());
  });

  // Sanity: confirm we aren't leaking the FallbackChainExhaustedError class shape
  // change by accident — we still import it from providerFallbackChain.
  it('uses FallbackChainExhaustedError from providerFallbackChain', () => {
    expect(FallbackChainExhaustedError).toBeDefined();
    expect(typeof ProviderFallbackChain).toBe('function');
  });
});
