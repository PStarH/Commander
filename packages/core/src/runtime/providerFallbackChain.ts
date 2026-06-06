/**
 * ProviderFallbackChain — sequential failover across LLM providers.
 *
 * Closes the "single-provider outage" gap from the reversibility audit. If
 * OpenAI is down, the run should fall back to Anthropic, then Google, then
 * local Ollama. Without a fallback chain, an outage of the primary provider
 * fails the entire run.
 *
 * Behavior:
 *   - tryProviders() iterates in order, attempting each one
 *   - On retryable error: skip to next provider
 *   - On permanent error: throw immediately (don't waste budget)
 *   - Per-provider CircuitBreaker integration: skip open circuits
 *   - Total timeout bounds the whole chain
 */

import { CircuitBreaker } from './circuitBreaker';

export type ProviderAttempt<T> = () => Promise<T>;

export interface ProviderEntry<T> {
  name: string;
  attempt: ProviderAttempt<T>;
  /** Circuit breaker for this provider; skipped when open. */
  breaker?: CircuitBreaker;
}

export interface FallbackChainOptions {
  maxProviders?: number;
  totalTimeoutMs?: number;
  isRetryable?: (err: unknown) => boolean;
}

const DEFAULT_RETRYABLE = (err: unknown): boolean => {
  if (!(err instanceof Error)) return true;
  const msg = err.message.toLowerCase();
  return /timeout|econn|5\d\d|429|rate|unavailable|network/.test(msg);
};

export class FallbackChainExhaustedError extends Error {
  readonly attempts: Array<{ provider: string; error: string }>;
  constructor(attempts: Array<{ provider: string; error: string }>) {
    super(`All ${attempts.length} providers failed: ${attempts.map(a => `${a.provider}: ${a.error}`).join('; ')}`);
    this.name = 'FallbackChainExhaustedError';
    this.attempts = attempts;
  }
}

export class ProviderFallbackChain<T> {
  private options: Required<FallbackChainOptions>;

  constructor(options: FallbackChainOptions = {}) {
    this.options = {
      maxProviders: options.maxProviders ?? 5,
      totalTimeoutMs: options.totalTimeoutMs ?? 60_000,
      isRetryable: options.isRetryable ?? DEFAULT_RETRYABLE,
    };
  }

  async tryProviders(providers: ProviderEntry<T>[]): Promise<{ result: T; providerUsed: string; attempts: number }> {
    const startedAt = Date.now();
    const attempts: Array<{ provider: string; error: string }> = [];

    for (const entry of providers.slice(0, this.options.maxProviders)) {
      if (Date.now() - startedAt > this.options.totalTimeoutMs) {
        throw new FallbackChainExhaustedError([
          ...attempts,
          { provider: entry.name, error: 'total_timeout_exceeded' },
        ]);
      }
      if (entry.breaker && !entry.breaker.isAvailable()) {
        attempts.push({ provider: entry.name, error: 'circuit_open' });
        continue;
      }

      try {
        const result = await entry.attempt();
        if (entry.breaker) entry.breaker.onSuccess();
        return { result, providerUsed: entry.name, attempts: attempts.length + 1 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (entry.breaker) entry.breaker.onFailure();
        attempts.push({ provider: entry.name, error: msg });
        if (!this.options.isRetryable(err)) {
          throw err;
        }
      }
    }

    throw new FallbackChainExhaustedError(attempts);
  }
}
