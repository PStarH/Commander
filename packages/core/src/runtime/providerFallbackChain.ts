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

/**
 * An attempt may observe the chain's remaining deadline. The signal argument is
 * optional, so existing zero-argument callers are unaffected, but an attempt that
 * accepts it can abort its own transport when the chain runs out of time.
 */
export type ProviderAttempt<T> = (signal?: AbortSignal) => Promise<T>;

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
  /** Called when a provider fails and the chain moves to the next one. */
  onProviderSkipped?: (from: string, to: string | null) => void;
}

const DEFAULT_RETRYABLE = (err: unknown): boolean => {
  if (!(err instanceof Error)) return true;
  const msg = err.message.toLowerCase();
  // Node's fetch layer surfaces connection failures as opaque `fetch failed`
  // (the cause carries ECONNREFUSED etc.), so they must be treated as
  // retryable or the chain gives up without ever trying the fallback.
  return /timeout|econn|enotfound|etimedout|eai_again|epipe|socket hang up|fetch failed|5\d\d|429|rate|unavailable|network/.test(
    msg,
  );
};

export class FallbackChainExhaustedError extends Error {
  readonly attempts: Array<{ provider: string; error: string }>;
  constructor(attempts: Array<{ provider: string; error: string }>) {
    super(
      `All ${attempts.length} providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join('; ')}`,
    );
    this.name = 'FallbackChainExhaustedError';
    this.attempts = attempts;
  }
}

export class ProviderFallbackChain<T> {
  private options: Required<Omit<FallbackChainOptions, 'onProviderSkipped'>> &
    Pick<FallbackChainOptions, 'onProviderSkipped'>;

  constructor(options: FallbackChainOptions = {}) {
    this.options = {
      maxProviders: options.maxProviders ?? 5,
      totalTimeoutMs: options.totalTimeoutMs ?? 60_000,
      isRetryable: options.isRetryable ?? DEFAULT_RETRYABLE,
      onProviderSkipped: options.onProviderSkipped,
    };
  }

  async tryProviders(
    providers: ProviderEntry<T>[],
  ): Promise<{ result: T; providerUsed: string; attempts: number }> {
    const startedAt = Date.now();
    const attempts: Array<{ provider: string; error: string }> = [];

    const chain = providers.slice(0, this.options.maxProviders);
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
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

      // RUN-01: the deadline used to be checked only at the top of the loop, so a
      // single attempt that never settles outlived `totalTimeoutMs` — the chain
      // awaited it forever and the budget was decorative. Bound the attempt by the
      // remaining budget, abort the signal the attempt receives, and ignore any
      // late result instead of waiting for it.
      const remainingMs = this.options.totalTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new FallbackChainExhaustedError([
          ...attempts,
          { provider: entry.name, error: 'total_timeout_exceeded' },
        ]);
      }

      const controller = new AbortController();
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineHit = false;
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          deadlineHit = true;
          controller.abort();
          reject(new Error('total_timeout_exceeded'));
        }, remainingMs);
        // A pending attempt must not be the only thing keeping the process alive.
        deadlineTimer.unref?.();
      });

      try {
        const result = await Promise.race([entry.attempt(controller.signal), deadline]);
        if (entry.breaker) entry.breaker.onSuccess();
        return { result, providerUsed: entry.name, attempts: attempts.length + 1 };
      } catch (err) {
        if (deadlineHit) {
          // The attempt is still running; its result is discarded. Report the
          // timeout rather than the synthetic rejection, and stop the chain.
          attempts.push({ provider: entry.name, error: 'total_timeout_exceeded' });
          throw new FallbackChainExhaustedError(attempts);
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (entry.breaker) entry.breaker.onFailure();
        attempts.push({ provider: entry.name, error: msg });
        if (!this.options.isRetryable(err)) {
          throw err;
        }
        const next = providers[i + 1];
        this.options.onProviderSkipped?.(entry.name, next ? next.name : null);
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }
    }

    throw new FallbackChainExhaustedError(attempts);
  }
}
