/**
 * Provider defects — regression tests for two audited P1 findings.
 *
 * Defect 1 (PC-SEMCACHE-DLP): the semantic cache used to short-circuit BEFORE
 * either security gate, the raw provider result was stored BEFORE
 * `postLLMCheck`, and a sanitized-allowed response was returned raw. The fix
 * requires: (a) store only AFTER the output policy approves, (b) re-run the
 * current policy on a cache hit, (c) never store or return a blocked output.
 * Cost accounting must not change (a hit is not new inference).
 *
 * Defect 2 (PC-ANTHROPIC-TOOL): `AnthropicProvider.buildMessages` preserved the
 * OpenAI `tool` role (Anthropic rejects it) and ignored assistant `tool_calls`,
 * so the second turn of any tool cycle was malformed. Also PC-USAGE-DELTA:
 * `message_delta` replaced accumulated usage instead of merging it.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LlmCaller, type LLMCallerDeps } from '../../src/runtime/llm/llmCaller';
import { ProviderFallbackChain } from '../../src/runtime/providerFallbackChain';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  RoutingDecision,
} from '../../src/runtime/types';
import { getEnterpriseSecurityGateway } from '../../src/security/enterpriseSecurityGateway';
import { getHookManager } from '../../src/pluginManager';
import { getMetricsCollector } from '../../src/runtime/metricsCollector';
import { getGlobalTenantProvider } from '../../src/runtime/tenantProvider';
import { getGlobalLogger } from '../../src/logging';
import { AnthropicProvider } from '../../src/runtime/providers/anthropicProvider';

// ── singleton monkey-patching (node:test has no module mocking) ──────────────
// The implementation resolves these singletons at call time via `getX()`, so we
// overwrite the returned instance's methods and restore them afterwards.

const restores: Array<() => void> = [];

function patchMethod(target: object, key: string, value: unknown): void {
  const bag = target as unknown as Record<string, unknown>;
  const original = bag[key];
  bag[key] = value;
  restores.push(() => {
    bag[key] = original;
  });
}

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

// ── Defect 1 harness ─────────────────────────────────────────────────────────

function makeResponse(content = 'hello'): LLMResponse {
  return {
    content,
    model: 'm',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
  };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return { model: 'm', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

function makeRouting(provider = 'openai'): RoutingDecision {
  return {
    provider,
    modelId: 'm',
    tier: 'standard',
    reasoning: ['test'],
    estimatedCost: 0,
    maxTokens: 4096,
  };
}

/** A provider that fails the test if it is ever invoked. */
function forbiddenProvider(): LLMProvider {
  return {
    name: 'forbidden',
    async call(): Promise<LLMResponse> {
      throw new Error('provider.call must not run for a semantic-cache hit');
    },
  };
}

function providerReturning(response: LLMResponse): LLMProvider {
  return {
    name: 'mock',
    async call() {
      return response;
    },
  };
}

interface Harness {
  deps: LLMCallerDeps;
  setProvider(name: string, p: LLMProvider): void;
  setCached(r: LLMResponse | null): void;
  lastErr(): Error | null;
  samples: Array<{ resp: LLMResponse | null; meta: Record<string, unknown> }>;
  storeCalls: Array<{ request: LLMRequest; response: LLMResponse }>;
  dedupeCalls(): number;
}

function makeHarness(): Harness {
  const providers = new Map<string, LLMProvider>();
  let lastErr: Error | null = null;
  let cachedResult: LLMResponse | null = null;
  let dedupeCalls = 0;
  const samples: Array<{ resp: LLMResponse | null; meta: Record<string, unknown> }> = [];
  const storeCalls: Array<{ request: LLMRequest; response: LLMResponse }> = [];

  const cache = {
    lookupSemantic: async () => cachedResult,
    getGeminiCachedContent: async () => ({ cachedContentName: undefined, createdNow: false }),
    dedupeSingleFlight: async (_key: string, fn: () => Promise<LLMResponse>) => {
      dedupeCalls += 1;
      return fn();
    },
    storeSemantic: (request: LLMRequest, response: LLMResponse) => {
      storeCalls.push({ request, response });
    },
    getSingleFlightStats: () => ({ hits: 0, misses: 0, inflight: 0, evictions: 0 }),
    getSingleFlightInflightCount: () => 0,
  };

  const samplesStore = {
    recordLLMCall: (_req: LLMRequest, resp: LLMResponse | null, meta: Record<string, unknown>) => {
      samples.push({ resp, meta });
    },
  } as unknown as LLMCallerDeps['samplesStore'];

  const stepTimeout = {
    wrap: async (p: Promise<LLMResponse>) => p,
  } as unknown as LLMCallerDeps['stepTimeout'];

  const deps: LLMCallerDeps = {
    getProviders: () => providers,
    getLastProviderError: () => lastErr,
    setLastProviderError: (err) => {
      lastErr = err;
    },
    samplesStore,
    cacheManager: cache as unknown as LLMCallerDeps['cacheManager'],
    stepTimeout,
    // Non-retryable: a blocked output is a permanent decision, not a failover.
    fallbackChain: new ProviderFallbackChain<LLMResponse>({ isRetryable: () => false }),
    llmTimeoutMs: 5000,
  };

  return {
    deps,
    setProvider: (name, p) => providers.set(name, p),
    setCached: (r) => {
      cachedResult = r;
    },
    lastErr: () => lastErr,
    samples,
    storeCalls,
    dedupeCalls: () => dedupeCalls,
  };
}

interface PostCheckResult {
  allowed: boolean;
  sanitizedOutput?: string;
  reason?: string;
  durationMs: number;
}

let postCheckImpl: () => PostCheckResult = () => ({ allowed: true, durationMs: 0 });
let postCheckCalls = 0;

beforeEach(() => {
  postCheckCalls = 0;
  postCheckImpl = () => ({ allowed: true, durationMs: 0 });

  const gateway = getEnterpriseSecurityGateway();
  patchMethod(gateway, 'preLLMCheck', () => ({ allowed: true, durationMs: 0 }));
  patchMethod(gateway, 'postLLMCheck', () => {
    postCheckCalls += 1;
    return postCheckImpl();
  });

  patchMethod(getHookManager(), 'fireBeforeBackendSelect', async () => null);
  patchMethod(getHookManager(), 'fireAfterBackendSelect', async () => undefined);
  patchMethod(getGlobalTenantProvider(), 'getCurrentTenantId', () => 'tenant-test');

  const collector = getMetricsCollector();
  patchMethod(collector, 'recordSemanticCacheEvent', () => {});
  patchMethod(collector, 'recordGeminiCacheEvent', () => {});
  patchMethod(collector, 'recordSingleFlightEvent', () => {});

  const logger = getGlobalLogger();
  patchMethod(logger, 'warn', () => {});
  patchMethod(logger, 'error', () => {});
});

describe('LlmCaller — semantic cache is gated by the current output policy', () => {
  it('does not return a cached response that the current output policy rejects', async () => {
    const h = makeHarness();
    h.setProvider('openai', forbiddenProvider());
    h.setCached(makeResponse('cached-secret'));
    postCheckImpl = () => ({ allowed: false, reason: 'policy tightened', durationMs: 0 });

    const result = await new LlmCaller(h.deps).call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'cache-block',
      attemptNumber: 0,
    });

    assert.equal(result, null, 'a policy-rejected cache entry must not be returned');
    assert.equal(h.dedupeCalls(), 0, 'the provider must not be consulted for a cache hit');
    assert.equal(postCheckCalls, 1, 'the current output policy must run on the cache hit');
    assert.ok(h.lastErr() instanceof Error);
    assert.match(h.lastErr()!.message, /blocked cached LLM output/i);
  });

  it('re-checks a cache entry stored before a policy change and applies the current sanitized form', async () => {
    const h = makeHarness();
    h.setProvider('openai', forbiddenProvider());
    h.setCached(makeResponse('raw-cached-pii'));
    postCheckImpl = () => ({
      allowed: true,
      sanitizedOutput: '[REDACTED-CACHED]',
      durationMs: 0,
    });

    const result = await new LlmCaller(h.deps).call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'cache-resanitize',
      attemptNumber: 0,
    });

    assert.equal(result?.content, '[REDACTED-CACHED]');
    assert.notEqual(result?.content, 'raw-cached-pii');
    assert.equal(postCheckCalls, 1);
    assert.equal(h.dedupeCalls(), 0);
  });

  it('returns and caches the sanitized output, never the raw provider content', async () => {
    const h = makeHarness();
    h.setProvider('openai', providerReturning(makeResponse('sk-live-RAW-SECRET')));
    postCheckImpl = () => ({ allowed: true, sanitizedOutput: '[REDACTED-OUT]', durationMs: 0 });

    const result = await new LlmCaller(h.deps).call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'store-sanitized',
      attemptNumber: 0,
    });

    assert.equal(result?.content, '[REDACTED-OUT]');
    assert.equal(h.samples[0]?.resp?.content, '[REDACTED-OUT]');
    assert.equal(h.storeCalls.length, 1, 'an approved response must be cached');
    assert.equal(h.storeCalls[0].response.content, '[REDACTED-OUT]');
    assert.ok(
      !JSON.stringify(h.storeCalls).includes('RAW-SECRET'),
      'raw pre-redaction content must never enter the semantic cache',
    );
  });

  it('never caches an output the current policy blocks', async () => {
    const h = makeHarness();
    h.setProvider('openai', providerReturning(makeResponse('blocked-payload')));
    postCheckImpl = () => ({ allowed: false, reason: 'critical DLP hit', durationMs: 0 });

    const result = await new LlmCaller(h.deps).call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'blocked-not-stored',
      attemptNumber: 0,
    });

    assert.equal(result, null);
    assert.equal(h.storeCalls.length, 0, 'a blocked output must never be cached');
    assert.ok(h.lastErr() instanceof Error);
    assert.match(h.lastErr()!.message, /blocked LLM output/i);
  });

  it('still caches and returns an allowed response when the policy supplies no sanitized form', async () => {
    const h = makeHarness();
    h.setProvider('openai', providerReturning(makeResponse('plain')));
    postCheckImpl = () => ({ allowed: true, durationMs: 0 });

    const result = await new LlmCaller(h.deps).call({
      request: makeRequest(),
      routing: makeRouting('openai'),
      taskId: 'allowed-store',
      attemptNumber: 0,
    });

    assert.equal(result?.content, 'plain');
    assert.equal(h.storeCalls.length, 1);
    assert.equal(h.storeCalls[0].response.content, 'plain');
  });
});

// ── Defect 2 harness ─────────────────────────────────────────────────────────

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: string;
  content: AnthropicBlock[];
}

interface AnthropicInternals {
  buildMessages(request: LLMRequest): AnthropicMessage[];
  handleStreamingResponse(response: Response, model: string): Promise<LLMResponse>;
}

function internalsOf(provider: AnthropicProvider): AnthropicInternals {
  return provider as unknown as AnthropicInternals;
}

function twoTurnToolCycle(): LLMRequest {
  return {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'weather in SF and the time?' },
      {
        role: 'assistant',
        content: 'Checking both.',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"SF"}' },
          },
          {
            id: 'toolu_2',
            type: 'function',
            function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
          },
        ],
      },
      { role: 'tool', content: '18C', tool_call_id: 'toolu_1' },
      { role: 'tool', content: '12:00', tool_call_id: 'toolu_2' },
    ],
  };
}

describe('AnthropicProvider.buildMessages — OpenAI tool cycle on the Anthropic wire', () => {
  it('maps assistant tool_calls to tool_use and tool results to a user tool_result turn', () => {
    const msgs = internalsOf(new AnthropicProvider({ apiKey: 'test-key' })).buildMessages(
      twoTurnToolCycle(),
    );

    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant', 'user'],
      'tool results must be emitted under a user role, and the system message dropped',
    );
    assert.ok(!msgs.some((m) => m.role === 'tool'), 'Anthropic rejects the tool role');

    assert.deepEqual(msgs[0].content, [{ type: 'text', text: 'weather in SF and the time?' }]);

    const assistant = msgs[1];
    assert.equal(assistant.content[0].type, 'text');
    assert.equal(assistant.content[0].text, 'Checking both.');
    assert.deepEqual(assistant.content.slice(1), [
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
      { type: 'tool_use', id: 'toolu_2', name: 'get_time', input: { tz: 'UTC' } },
    ]);

    assert.deepEqual(msgs[2].content, [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '18C' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: '12:00' },
    ]);
  });

  it('degrades malformed tool arguments to {} and coalesces same-wire-role turns', () => {
    const request: LLMRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'toolu_bad',
              type: 'function',
              function: { name: 'do_thing', arguments: '{not valid json' },
            },
          ],
        },
        { role: 'tool', content: 'done', tool_call_id: 'toolu_bad' },
        { role: 'user', content: 'and again' },
      ],
    };

    const msgs = internalsOf(new AnthropicProvider({ apiKey: 'test-key' })).buildMessages(request);

    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
    assert.deepEqual(msgs[1].content, [
      { type: 'tool_use', id: 'toolu_bad', name: 'do_thing', input: {} },
    ]);
    // The trailing `user` text coalesces into the tool_result turn rather than
    // creating an adjacent duplicate user turn.
    assert.deepEqual(msgs[2].content, [
      { type: 'tool_result', tool_use_id: 'toolu_bad', content: 'done' },
      { type: 'text', text: 'and again' },
    ]);
  });

  it('sends tool_use / tool_result blocks in the real request body', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const request = twoTurnToolCycle();
      request.cacheConfig = { cacheSystemPrompt: false, cacheTools: false, useCacheControl: false };
      const response = await new AnthropicProvider({ apiKey: 'test-key' }).call(request);
      assert.equal(response.content, 'ok');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }

    assert.equal(sent.length, 1);
    const wire = sent[0].messages as AnthropicMessage[];
    assert.deepEqual(
      wire.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
    assert.equal(wire[1].content[1].type, 'tool_use');
    assert.equal(wire[2].content[0].type, 'tool_result');
    assert.equal(wire[2].content[0].tool_use_id, 'toolu_1');
  });
});

describe('AnthropicProvider streaming usage', () => {
  it('merges message_delta usage into the counters captured from message_start', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":40,"cache_creation_input_tokens":7}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":25},"delta":{"stop_reason":"end_turn"}}\n\n';

    const response = await internalsOf(
      new AnthropicProvider({ apiKey: 'test-key' }),
    ).handleStreamingResponse(new Response(sse), 'claude-sonnet-4-6');

    assert.equal(response.content, 'Hi');
    assert.equal(response.usage.promptTokens, 120, 'message_start input_tokens must survive');
    assert.equal(response.usage.completionTokens, 25, 'message_delta output_tokens must apply');
    assert.equal(response.usage.totalTokens, 145);
    assert.equal(response.usage.cacheReadTokens, 40, 'cache read counters must survive');
    assert.equal(response.usage.cacheWriteTokens, 7, 'cache write counters must survive');
    assert.equal(response.finishReason, 'stop');
  });
});
