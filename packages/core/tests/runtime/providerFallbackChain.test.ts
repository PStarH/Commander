import { describe, it, expect, vi } from 'vitest';
import { ProviderFallbackChain, FallbackChainExhaustedError, type ProviderEntry } from '../../src/runtime/providerFallbackChain';
import { CircuitBreaker } from '../../src/runtime/circuitBreaker';

describe('ProviderFallbackChain', () => {
  it('returns first successful provider', async () => {
    const chain = new ProviderFallbackChain<string>();
    const providers: ProviderEntry<string>[] = [
      { name: 'primary', attempt: () => Promise.resolve('from-primary') },
      { name: 'secondary', attempt: () => Promise.resolve('from-secondary') },
    ];
    const result = await chain.tryProviders(providers);
    expect(result.result).toBe('from-primary');
    expect(result.providerUsed).toBe('primary');
    expect(result.attempts).toBe(1);
  });

  it('falls back on retryable error', async () => {
    const chain = new ProviderFallbackChain<string>();
    const providers: ProviderEntry<string>[] = [
      { name: 'primary', attempt: () => Promise.reject(new Error('timeout connecting')) },
      { name: 'secondary', attempt: () => Promise.resolve('from-secondary') },
    ];
    const result = await chain.tryProviders(providers);
    expect(result.result).toBe('from-secondary');
    expect(result.attempts).toBe(2);
  });

  it('throws immediately on permanent (non-retryable) error', async () => {
    const chain = new ProviderFallbackChain<string>({
      isRetryable: err => /retryable/.test((err as Error).message),
    });
    const providers: ProviderEntry<string>[] = [
      { name: 'primary', attempt: () => Promise.reject(new Error('permanent auth error')) },
      { name: 'secondary', attempt: vi.fn(() => Promise.resolve('unused')) },
    ];
    await expect(chain.tryProviders(providers)).rejects.toThrow('permanent auth error');
  });

  it('throws FallbackChainExhaustedError when all providers fail', async () => {
    const chain = new ProviderFallbackChain<string>();
    const providers: ProviderEntry<string>[] = [
      { name: 'a', attempt: () => Promise.reject(new Error('timeout on a')) },
      { name: 'b', attempt: () => Promise.reject(new Error('503 on b')) },
    ];
    try {
      await chain.tryProviders(providers);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FallbackChainExhaustedError);
      const e = err as FallbackChainExhaustedError;
      expect(e.attempts).toHaveLength(2);
      expect(e.attempts[0].provider).toBe('a');
      expect(e.attempts[1].provider).toBe('b');
    }
  });

  it('skips providers with open circuit breakers', async () => {
    const chain = new ProviderFallbackChain<string>();
    const openBreaker = new CircuitBreaker(1, 30000);
    openBreaker.onFailure();
    openBreaker.onFailure();

    const providers: ProviderEntry<string>[] = [
      { name: 'a', attempt: vi.fn(() => Promise.resolve('a')), breaker: openBreaker },
      { name: 'b', attempt: () => Promise.resolve('b') },
    ];
    const result = await chain.tryProviders(providers);
    expect(result.providerUsed).toBe('b');
    expect(providers[0].attempt).not.toHaveBeenCalled();
  });

  it('records success/failure on circuit breaker', async () => {
    const chain = new ProviderFallbackChain<string>();
    const breaker = new CircuitBreaker(5, 30000);
    const providers: ProviderEntry<string>[] = [
      { name: 'a', attempt: () => Promise.resolve('ok'), breaker },
    ];
    await chain.tryProviders(providers);
    expect(breaker.getState().toLowerCase()).toBe('closed');
  });

  it('respects maxProviders cap', async () => {
    const chain = new ProviderFallbackChain<string>({ maxProviders: 2 });
    const providers: ProviderEntry<string>[] = [
      { name: 'a', attempt: () => Promise.reject(new Error('timeout a')) },
      { name: 'b', attempt: () => Promise.reject(new Error('timeout b')) },
      { name: 'c', attempt: vi.fn(() => Promise.resolve('c')) },
    ];
    let thrown: FallbackChainExhaustedError | null = null;
    try {
      await chain.tryProviders(providers);
    } catch (err) {
      thrown = err as FallbackChainExhaustedError;
    }
    expect(thrown).toBeInstanceOf(FallbackChainExhaustedError);
    expect(thrown?.attempts).toHaveLength(2);
    expect(providers[2].attempt).not.toHaveBeenCalled();
  });
});
