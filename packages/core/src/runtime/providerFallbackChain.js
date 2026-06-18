"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderFallbackChain = exports.FallbackChainExhaustedError = void 0;
const DEFAULT_RETRYABLE = (err) => {
    if (!(err instanceof Error))
        return true;
    const msg = err.message.toLowerCase();
    return /timeout|econn|5\d\d|429|rate|unavailable|network/.test(msg);
};
class FallbackChainExhaustedError extends Error {
    constructor(attempts) {
        super(`All ${attempts.length} providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join('; ')}`);
        this.name = 'FallbackChainExhaustedError';
        this.attempts = attempts;
    }
}
exports.FallbackChainExhaustedError = FallbackChainExhaustedError;
class ProviderFallbackChain {
    constructor(options = {}) {
        var _a, _b, _c;
        this.options = {
            maxProviders: (_a = options.maxProviders) !== null && _a !== void 0 ? _a : 5,
            totalTimeoutMs: (_b = options.totalTimeoutMs) !== null && _b !== void 0 ? _b : 60000,
            isRetryable: (_c = options.isRetryable) !== null && _c !== void 0 ? _c : DEFAULT_RETRYABLE,
        };
    }
    async tryProviders(providers) {
        const startedAt = Date.now();
        const attempts = [];
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
                if (entry.breaker)
                    entry.breaker.onSuccess();
                return { result, providerUsed: entry.name, attempts: attempts.length + 1 };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (entry.breaker)
                    entry.breaker.onFailure();
                attempts.push({ provider: entry.name, error: msg });
                if (!this.options.isRetryable(err)) {
                    throw err;
                }
            }
        }
        throw new FallbackChainExhaustedError(attempts);
    }
}
exports.ProviderFallbackChain = ProviderFallbackChain;
