/**
 * LLM Caller — Extracted from AgentRuntime
 *
 * Handles LLM provider calls with:
 * - Model routing (eco → standard → power)
 * - Timeout handling
 * - Retry with exponential backoff
 * - Error classification (transient/permanent/unknown)
 * - Circuit breaker integration
 * - Token usage tracking
 *
 * Extracted from agentRuntime.ts for better separation of concerns.
 */

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  RoutingDecision,
  TokenUsage,
  AgentRuntimeConfig,
} from './types';
import { ModelRouter } from './modelRouter';
import { CircuitBreaker } from './circuitBreaker';
import { TokenGovernor } from './tokenGovernor';
import { classifyLLMError, computeBackoff } from './llmRetry';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface LLMCallerConfig {
  timeoutMs: number;
  maxRetries: number;
  enableCircuitBreaker: boolean;
}

export interface LLMCallerDeps {
  providers: Map<string, LLMProvider>;
  router: ModelRouter;
  circuitBreaker: CircuitBreaker;
  governor: TokenGovernor;
  config: AgentRuntimeConfig;
}

export interface LLMCallResult {
  response: LLMResponse;
  routing: RoutingDecision;
  tokenUsage: TokenUsage;
  retries: number;
  durationMs: number;
}

// ============================================================================
// LLM Caller
// ============================================================================

export class LLMCaller {
  private deps: LLMCallerDeps;

  constructor(deps: LLMCallerDeps) {
    this.deps = deps;
  }

  /**
   * Call an LLM provider with retry, timeout, and circuit breaker.
   */
  async call(
    request: LLMRequest,
    agentId: string,
    runId: string,
  ): Promise<LLMCallResult> {
    const { providers, router, circuitBreaker, governor, config } = this.deps;
    const bus = getMessageBus();
    const startTime = Date.now();
    let lastError: string | undefined;
    let retries = 0;

    // Route to the best provider
    const routing = router.route(request, providers);
    const provider = providers.get(routing.providerId);

    if (!provider) {
      throw new Error(`LLM provider "${routing.providerId}" not found`);
    }

    // Check circuit breaker
    if (config.enableCircuitBreaker !== false && !circuitBreaker.isAvailable()) {
      throw new Error('Circuit breaker is open — too many recent failures');
    }

    // Check token budget
    const budgetCheck = governor.checkBudget(request.maxTokens ?? 4000);
    if (!budgetCheck.allowed) {
      throw new Error(`Token budget exceeded: ${budgetCheck.reason}`);
    }

    // Retry loop
    for (let attempt = 0; attempt <= (config.maxRetries ?? 3); attempt++) {
      try {
        // Call with timeout
        const response = await this.callWithTimeout(provider, request, config.timeoutMs ?? 30000);

        // Record success
        circuitBreaker.recordSuccess();
        governor.recordUsage(response.usage?.totalTokens ?? 0);

        const durationMs = Date.now() - startTime;
        const tokenUsage: TokenUsage = {
          promptTokens: response.usage?.promptTokens ?? 0,
          completionTokens: response.usage?.completionTokens ?? 0,
          totalTokens: response.usage?.totalTokens ?? 0,
        };

        // Publish metrics
        bus.publish('llm.call.completed', agentId, {
          runId, providerId: routing.providerId, model: request.model,
          durationMs, tokenUsage, retries,
        });

        return { response, routing, tokenUsage, retries, durationMs };
      } catch (err) {
        lastError = (err as Error).message;
        retries = attempt;

        // Classify error
        const errorClass = classifyLLMError(err as Error);

        // Record failure
        circuitBreaker.recordFailure();

        // Don't retry permanent errors
        if (errorClass.errorClass === 'permanent') {
          throw err;
        }

        // Don't retry on last attempt
        if (attempt >= (config.maxRetries ?? 3)) {
          throw err;
        }

        // Compute backoff
        const backoff = computeBackoff(attempt, errorClass);
        getGlobalLogger().warn('LLMCaller', `Retry ${attempt + 1}/${config.maxRetries} after ${backoff}ms`, {
          error: lastError, providerId: routing.providerId,
        });

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    throw new Error(`LLM call failed after ${retries} retries: ${lastError}`);
  }

  /**
   * Call provider with timeout.
   */
  private async callWithTimeout(
    provider: LLMProvider,
    request: LLMRequest,
    timeoutMs: number,
  ): Promise<LLMResponse> {
    const timeoutPromise = new Promise<LLMResponse>((_, reject) => {
      setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const callPromise = provider.call(request);
    return Promise.race([callPromise, timeoutPromise]);
  }
}
