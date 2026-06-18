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
export declare class FallbackChainExhaustedError extends Error {
    readonly attempts: Array<{
        provider: string;
        error: string;
    }>;
    constructor(attempts: Array<{
        provider: string;
        error: string;
    }>);
}
export declare class ProviderFallbackChain<T> {
    private options;
    constructor(options?: FallbackChainOptions);
    tryProviders(providers: ProviderEntry<T>[]): Promise<{
        result: T;
        providerUsed: string;
        attempts: number;
    }>;
}
//# sourceMappingURL=providerFallbackChain.d.ts.map