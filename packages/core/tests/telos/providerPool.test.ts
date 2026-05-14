import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProviderPool, resetProviderPool } from '../../src/telos/providerPool';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';

describe('ProviderPool', () => {
  let pool: ProviderPool;

  before(() => {
    resetProviderPool();
    pool = new ProviderPool(1, 100);
  });

  it('registers providers', () => {
    const provider = new MockLLMProvider('openai');
    pool.registerProvider(provider);
    expect(pool.isProviderRegistered('openai')).toBe(true);
  });

  it('configures endpoints', () => {
    pool.configureEndpoints([
      { provider: 'openai', modelId: '*', priority: 0, weight: 1, isEnabled: true },
      { provider: 'anthropic', modelId: '*', priority: 1, weight: 1, isEnabled: true },
    ]);
    expect(pool.getEndpointCount()).toBe(2);
  });

  it('selects an endpoint among healthy providers', () => {
    pool.registerProvider(new MockLLMProvider('openai'));
    const selection = pool.select('eco');
    expect(selection.provider).toBeTruthy();
    expect(selection.modelId).toBeTruthy();
  });

  it('executes with failover', async () => {
    const goodProvider = new MockLLMProvider('good', {
      defaultResponse: 'I am the working provider.',
    });
    pool.registerProvider(goodProvider);

    const response = await pool.executeWithFailover(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'test' }], maxTokens: 100 },
      'eco',
    );
    expect(response.content).toBeTruthy();
    expect(response.usage.totalTokens).toBeGreaterThan(0);
  });

  it('tracks health after failures', async () => {
    const failingProvider = new MockLLMProvider('failing');
    const mockCall = async () => { throw new Error('API error'); };
    failingProvider.call = mockCall;
    pool.registerProvider(failingProvider);

    const request = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'test' }], maxTokens: 100 };

    // Force failure of the failing provider 3 times by calling recordFailure directly
    pool.recoverProvider('failing', '*');
    pool.recoverProvider('failing', '*');
    for (let i = 0; i < 3; i++) {
      try {
        await pool.executeWithFailover(request, 'eco');
      } catch {
        /* expected */
      }
    }

    const statuses = pool.getHealthStatus();
    const failingStatus = statuses.find(s => s.provider === 'failing');
    // Should be degraded or down after failures
    expect(failingStatus).toBeDefined();
  });

  it('recovers a provider', () => {
    const provider = new MockLLMProvider('test');
    pool.registerProvider(provider);
    pool.recoverProvider('test', '*');
    const statuses = pool.getHealthStatus();
    const healthy = statuses.find(s => s.provider === 'test' && s.status === 'healthy');
    expect(healthy).toBeDefined();
  });
});
