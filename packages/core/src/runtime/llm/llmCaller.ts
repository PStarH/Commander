/**
 * LLMCaller — extracted from `packages/core/src/runtime/agentRuntime.ts`
 * (Phase 1 of god-object decomposition).
 *
 * Owns the per-attempt LLM provider invocation chain — previously the three
 * private methods `callWithTimeout` + `callProviderOrThrow` + `callProvider`
 * on the AgentRuntime god object. Also absorbs `estimateRequestTokens`, which
 * only `callProvider` consumes from inside the pre-LLM gateway check.
 *
 * Behavioural contract — preserved byte-for-byte from the source:
 *   1. `fireBeforeBackendSelect` may return a provider-name override (string)
 *      or `null` (no hook match) or throw — `.catch(() => null)` keeps the
 *      call alive when a hook throws.
 *      `resolvedProvider = override ?? routing.provider`.
 *   2. `ProviderEntry[]` is built: resolved provider first (if registered),
 *      then remaining providers EXCEPT `routing.provider`. NOTE: original code
 *      skips by `name === routing.provider` (not `resolvedProvider`) — preserved
 *      deliberately to keep byte-for-byte semantics.
 *   3. `fallbackChain.tryProviders(entries)` runs sequentially. On success:
 *      `fireAfterBackendSelect` fires (silently swallowed via `.catch`).
 *      On `FallbackChainExhaustedError`: samplesStore.recordLLMCall +
 *      logger.warn → return null.
 *   4. `callProviderOrThrow` converts a `null` from `callProvider` into a throw
 *      so the fallback chain can route retry decisions. It does NOT clear
 *      `lastProviderError` on the throw path — only on success — so the retry
 *      loop in `AgentRuntime.execute()` can classify the original error before
 *      the next attempt writes a fresh one.
 *   5. `callProvider` semantics:
 *        * Semantic cache lookup short-circuits and returns the cached response
 *          with a 'hit' metric recorded; 'miss' metric recorded otherwise.
 *        * Google Gemini cachedContent wiring when
 *          `providerName === 'google' && request.cacheConfig` — attaches the
 *          server-side cache name on success and records 'create' / 'hit' /
 *          'error' metrics. Failures fall through (cost optimisation, not
 *          correctness).
 *        * EnterpriseSecurityGateway.preLLMCheck — throws on block.
 *        * singleFlight dedup → stepTimeout.wrap(provider.call) →
 *          'hit'/'miss'/'eviction' metrics → storeSemantic + 'store' metric.
 *        * EnterpriseSecurityGateway.postLLMCheck — throws on block.
 *        * samplesStore.recordLLMCall on the success path.
 *        * Catch: setLastProviderError(err) + samplesStore.recordLLMCall
 *          (failure shape) + logger.error + return null.
 *
 * The class is wired in `AgentRuntime`'s constructor with callback dependencies
 * for the few mutable fields (`getProviders / getLastProviderError /
 * setLastProviderError`) so the runtime can swap them per run. Stable
 * subsystems are passed by direct ref. The shape mirrors `LLMRequestBuilder`.
 */
import {
  ProviderFallbackChain,
  FallbackChainExhaustedError,
  type ProviderEntry,
} from '../providerFallbackChain';
import { DEFAULT_LLM_TIMEOUT_MS } from '../runtimeConstants';
import { getEnterpriseSecurityGateway } from '../../security/enterpriseSecurityGateway';
import { reportSilentFailure } from '../../silentFailureReporter';
import { getHookManager } from '../../pluginManager';
import { getMetricsCollector } from '../metricsCollector';
import { getGlobalLogger } from '../../logging';
import { getGlobalTenantProvider } from '../tenantProvider';
import { SingleFlightRequestCache } from '../singleFlightRequestCache';
import type { LLMProvider, LLMRequest, LLMResponse, RoutingDecision } from '../types';
import type { CacheManager } from '../cacheManager';
import type { StepTimeoutManager } from '../stepTimeoutManager';
import type { SamplesStore } from '../samplesStore';

export interface LLMCallerDeps {
  /** Return the live providers map. Callback so `registerProvider()` mutations after construction are visible. */
  getProviders(): Map<string, LLMProvider>;
  /** Read the last error from a provider call. Consumed by AgentRuntime's retry loop for `classifyLLMError`. */
  getLastProviderError(): Error | null;
  /** Write the last error. Cleared on success by `callProviderOrThrow`, set on failure by `callProvider`. */
  setLastProviderError(err: Error | null): void;
  /** Constructed once per runtime in `serviceInitializer.ts`. */
  samplesStore: SamplesStore;
  cacheManager: CacheManager;
  stepTimeout: StepTimeoutManager;
  fallbackChain: ProviderFallbackChain<LLMResponse>;
  /** Config override; falls back to `DEFAULT_LLM_TIMEOUT_MS` when undefined. */
  llmTimeoutMs: number | undefined;
}

export interface LLMCallerCallInput {
  request: LLMRequest;
  routing: RoutingDecision;
  /**
   * Reflects the OUTER retry-attempt number — call sites MUST pass the outer
   * attempt (e.g. the reflexion inner loop passes the outer `attempt` value,
   * not a sub-counter). Preserved verbatim into samplesStore and stepId.
   */
  attemptNumber?: number;
  taskId?: string;
}

export class LlmCaller {
  constructor(private readonly deps: LLMCallerDeps) {}

  /**
   * AgentRuntime-compatible signature. Delegates to the canonical `call`
   * implementation so both the legacy `call(input)` shape and the runtime's
   * `callWithTimeout(request, routing, ...)` shape are satisfied.
   */
  async callWithTimeout(
    request: LLMRequest,
    routing: RoutingDecision,
    attemptNumber: number = 0,
    taskId?: string,
  ): Promise<LLMResponse | null> {
    return this.call({ request, routing, attemptNumber, taskId });
  }

  async call(input: LLMCallerCallInput): Promise<LLMResponse | null> {
    const { request, routing, attemptNumber = 0, taskId } = input;

    // Plugin hook: beforeBackendSelect — can override the selected provider.
    // .catch(() => null) — a throwing hook must not stop the call.
    const hookSelected = await getHookManager()
      .fireBeforeBackendSelect({
        toolName: routing.provider,
        args: request as unknown as Record<string, unknown>,
        agentId: taskId ?? 'unknown',
        runId: taskId ?? 'unknown',
      })
      .catch(() => null);
    const resolvedProvider = hookSelected ?? routing.provider;

    const providers = this.deps.getProviders();
    const primaryProvider = providers.get(resolvedProvider);
    const entries: ProviderEntry<LLMResponse>[] = [];

    if (primaryProvider) {
      entries.push({
        name: resolvedProvider,
        attempt: () =>
          this.callProviderOrThrow(
            primaryProvider,
            resolvedProvider,
            request,
            attemptNumber,
            taskId,
          ),
      });
    }

    // Iterate remaining providers as fallback.
    // NOTE: the original code checks `name === routing.provider` (not
    // `name === resolvedProvider`). Preserved deliberately to keep byte-for-byte
    // semantics — if the hook overrode routing.provider, the override may also
    // appear in the entries list (duplicate). The fallback chain handles dedup
    // by virtue of `ProviderEntry.name`, but the original duplicate-visit
    // behavior is preserved here.
    for (const [name, provider] of providers) {
      if (name === routing.provider) continue;
      entries.push({
        name,
        attempt: () => this.callProviderOrThrow(provider, name, request, attemptNumber, taskId),
      });
    }

    if (entries.length === 0) {
      this.deps.samplesStore.recordLLMCall(request, null, {
        provider: 'none',
        durationMs: 0,
        attemptNumber,
        error: 'No provider available',
      });
      return null;
    }

    try {
      const { result } = await this.deps.fallbackChain.tryProviders(entries);
      getHookManager()
        .fireAfterBackendSelect({
          toolName: routing.provider,
          args: request as unknown as Record<string, unknown>,
          selectedBackend: resolvedProvider,
          agentId: taskId ?? 'unknown',
          runId: taskId ?? 'unknown',
        })
        .catch(() => {});
      return result;
    } catch (err) {
      if (err instanceof FallbackChainExhaustedError) {
        this.deps.samplesStore.recordLLMCall(request, null, {
          provider: 'fallback_exhausted',
          durationMs: 0,
          attemptNumber,
          error: err.message,
        });
      }
      getGlobalLogger().warn('AgentRuntime', 'All providers exhausted in fallback chain', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Thin forwarder that adapts `callProvider`'s nullable return for
   * `ProviderFallbackChain`. The chain treats non-throwing returns as success,
   * so we throw on null. Preserves the last provider error so the retry loop
   * can classify it (429 → retryable, 400 → permanent).
   */
  private async callProviderOrThrow(
    provider: LLMProvider,
    providerName: string,
    request: LLMRequest,
    attemptNumber: number,
    taskId?: string,
  ): Promise<LLMResponse> {
    const result = await this.callProvider(provider, providerName, request, attemptNumber, taskId);
    if (!result) {
      // The original error is preserved in lastProviderError by callProvider.
      // Throw it directly so ProviderFallbackChain and the retry loop can
      // classify it properly (e.g., 429 = retryable, 400 = permanent).
      // Do NOT clear lastProviderError here — the retry loop reads it later.
      const lastErr = this.deps.getLastProviderError();
      if (lastErr) {
        throw lastErr;
      }
      throw new Error(`Provider "${providerName}" returned null (likely timeout or unavailable)`);
    }
    // Clear on success — no error to preserve.
    this.deps.setLastProviderError(null);
    return result;
  }

  private async callProvider(
    provider: LLMProvider,
    providerName: string,
    request: LLMRequest,
    attemptNumber: number,
    taskId?: string,
  ): Promise<LLMResponse | null> {
    const startMs = Date.now();
    try {
      const cached = await this.deps.cacheManager.lookupSemantic(request);
      if (cached) {
        try {
          getMetricsCollector().recordSemanticCacheEvent(
            'hit',
            0,
            getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
          );
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:llmCaller:lookupSemantic:hit');
          /* best-effort */
        }
        return cached;
      }
      try {
        getMetricsCollector().recordSemanticCacheEvent(
          'miss',
          0,
          getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        );
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:llmCaller:lookupSemantic:miss');
        /* best-effort */
      }

      // Google Gemini cachedContent wiring: when the provider is Google and the
      // request carries a cacheConfig, try to attach a server-side cached
      // content name. Failures fall through (cached content is a cost
      // optimisation, not a correctness requirement).
      if (providerName === 'google' && request.cacheConfig) {
        const systemMsg = request.messages.find((m) => m.role === 'system');
        const tenantForGemini = getGlobalTenantProvider().getCurrentTenantId() ?? undefined;
        try {
          const lookup = await this.deps.cacheManager.getGeminiCachedContent({
            systemInstruction: systemMsg?.content,
            tools: request.tools,
            model: request.model,
            apiKey: process.env.GOOGLE_API_KEY ?? '',
            baseUrl: process.env.GOOGLE_BASE_URL,
            tenantId: tenantForGemini,
          });
          if (lookup.cachedContentName) {
            request.cacheConfig.geminiCachedContentName = lookup.cachedContentName;
            try {
              getMetricsCollector().recordGeminiCacheEvent(
                lookup.createdNow ? 'create' : 'hit',
                tenantForGemini,
              );
            } catch (err) {
              reportSilentFailure(err, 'agentRuntime:llmCaller:geminiCache:hitOrCreate');
              /* best-effort */
            }
          }
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:llmCaller:geminiCache:lookup');
          try {
            getMetricsCollector().recordGeminiCacheEvent('error', tenantForGemini);
          } catch (err) {
            reportSilentFailure(err, 'agentRuntime:llmCaller:geminiCache:errorMetric');
            /* best-effort */
          }
        }
      }

      const tenantIdForFlight = getGlobalTenantProvider().getCurrentTenantId() ?? undefined;
      const flightKey = SingleFlightRequestCache.computeKey(request, tenantIdForFlight);
      const evictionsBefore = this.deps.cacheManager.getSingleFlightStats().evictions;
      const inflightBefore = this.deps.cacheManager.getSingleFlightInflightCount();
      const llmTimeoutMs = this.deps.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

      // EnterpriseSecurityGateway: pre-LLM cost + input-scan gate.
      const estimatedTokens = this.estimateRequestTokens(request);
      const gateway = getEnterpriseSecurityGateway();
      const preCheck = gateway.preLLMCheck({
        tenantId: tenantIdForFlight,
        sessionId: taskId,
        runId: taskId ?? 'unknown',
        model: request.model,
        estimatedTokens,
        source: taskId ?? 'unknown',
        input: request.messages
          .map((m) => m.content)
          .join('\n')
          .slice(0, 10000),
      });
      if (!preCheck.allowed) {
        throw new Error(`Security gateway blocked LLM call: ${preCheck.reason ?? 'policy'}`);
      }

      const result: LLMResponse = await this.deps.cacheManager.dedupeSingleFlight(
        flightKey,
        async () => {
          return this.deps.stepTimeout.wrap(provider.call(request), {
            timeoutMs: llmTimeoutMs,
            stepId: `llm-${providerName}-${attemptNumber}-${taskId ?? 'main'}`,
          });
        },
        tenantIdForFlight,
      );
      const recentEvictionDelta =
        this.deps.cacheManager.getSingleFlightStats().evictions - evictionsBefore;
      const wasHit = this.deps.cacheManager.getSingleFlightInflightCount() === inflightBefore;
      try {
        getMetricsCollector().recordSingleFlightEvent(wasHit ? 'hit' : 'miss', tenantIdForFlight);
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:llmCaller:singleFlight:hitMiss');
        /* best-effort */
      }
      if (recentEvictionDelta > 0) {
        try {
          getMetricsCollector().recordSingleFlightEvent('eviction', tenantIdForFlight);
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:llmCaller:singleFlight:eviction');
          /* best-effort */
        }
      }
      this.deps.cacheManager.storeSemantic(request, result);
      try {
        getMetricsCollector().recordSemanticCacheEvent(
          'store',
          0,
          getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        );
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:llmCaller:storeSemantic');
        /* best-effort */
      }

      // EnterpriseSecurityGateway: post-LLM cost accounting + DLP scan.
      const postCheck = gateway.postLLMCheck({
        tenantId: tenantIdForFlight,
        sessionId: taskId,
        runId: taskId ?? 'unknown',
        model: request.model,
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        agentId: taskId,
        output: result.content,
      });
      if (!postCheck.allowed) {
        throw new Error(`Security gateway blocked LLM output: ${postCheck.reason ?? 'DLP policy'}`);
      }

      this.deps.samplesStore.recordLLMCall(request, result, {
        provider: providerName,
        durationMs: Date.now() - startMs,
        attemptNumber,
        taskId,
      });
      return result;
    } catch (err) {
      this.deps.setLastProviderError(err instanceof Error ? err : new Error(String(err)));
      this.deps.samplesStore.recordLLMCall(request, null, {
        provider: providerName,
        durationMs: Date.now() - startMs,
        attemptNumber,
        error: String(err),
        taskId,
      });
      getGlobalLogger().error('AgentRuntime', 'Provider call failed', err as Error);
      return null;
    }
  }

  /**
   * Rough token estimator for the enterprise security gateway pre-LLM check.
   * ~4 chars per token, including tool definitions (name + description +
   * JSON-schema). Returns the upper bound — gateway uses this for pre-cost
   * enforcement before dispatching the actual call.
   */
  private estimateRequestTokens(request: LLMRequest): number {
    const text = request.messages.map((m) => m.content).join('\n');
    const toolText = request.tools
      ? request.tools
          .map((t) => `${t.name}\n${t.description ?? ''}\n${JSON.stringify(t.inputSchema ?? {})}`)
          .join('\n')
      : '';
    return Math.ceil((text.length + toolText.length) / 4);
  }
}
