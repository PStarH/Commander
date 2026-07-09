/**
 * Mock-API End-to-End Tests
 *
 * Replaces the STEPFUN_API_KEY-dependent real-api.test.ts and
 * real-api-chaos.test.ts with mock-based equivalents that exercise the
 * same integration paths without requiring network access or API keys.
 *
 * Test coverage:
 *   1. ProviderFallbackChain — mock primary failover to secondary
 *   2. CircuitBreaker — mock failures trip the breaker, blocks subsequent calls
 *   3. ProviderFallbackChain with CircuitBreaker — breaker open skips provider
 *   4. ProviderFallbackChain exhaustion — all providers fail, throws FallbackChainExhaustedError
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProviderFallbackChain,
  FallbackChainExhaustedError,
} from '../../src/runtime/providerFallbackChain';
import { CircuitBreaker } from '../../src/runtime/circuitBreaker';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { resetMetricsCollector } from '../../src/runtime/metricsCollector';
import { resetArtifactSystem } from '../../src/ultimate/artifactSystem';
import { resetTeamManager } from '../../src/ultimate/agentTeamManager';
import { resetTokenSentinel } from '../../src/telos/tokenSentinel';
import { resetProviderPool } from '../../src/telos/providerPool';
import { resetWorkCoordinator } from '../../src/ultimate/workCoordinator';
import { resetExecutionScheduler } from '../../src/atr/scheduler';
import { resetLaneManager } from '../../src/sandbox/lane';
import { resetTokenBudgetManager } from '../../src/runtime/tokenGovernor';
import { resetCheckpointWriter } from '../../src/runtime/checkpointWriter';
import { resetSLOManager } from '../../src/observability/sloManager';
import { resetEnterpriseSecurityGateway } from '../../src/security/enterpriseSecurityGateway';
import { resetBillExplosionGuard } from '../../src/security/billExplosionGuard';
import { resetUnifiedCostAuthority } from '../../src/security/unifiedCostAuthority';
import { resetSecurityMonitor } from '../../src/security/securityMonitor';
import { resetGuardianAgent } from '../../src/security/guardianAgent';
import { resetModelRouter } from '../../src/runtime/modelRouter';

// ── Helpers ────────────────────────────────────────────────────────────────

function resetGlobals() {
  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();
  resetGlobalThreeLayerMemory();
  resetArtifactSystem();
  resetTeamManager();
  resetTokenSentinel();
  resetProviderPool();
  resetWorkCoordinator();
  resetExecutionScheduler();
  resetLaneManager();
  resetTokenBudgetManager();
  resetCheckpointWriter();
  resetMetricsCollector();
  resetSLOManager();
  resetEnterpriseSecurityGateway();
  resetBillExplosionGuard();
  resetUnifiedCostAuthority();
  resetSecurityMonitor();
  resetGuardianAgent();
}

// ── Tests: ProviderFallbackChain ────────────────────────────────────────────

describe('E2E Mock-API: ProviderFallbackChain', () => {
  beforeEach(() => {
    resetGlobals();
  });

  it('falls over from primary to secondary when primary fails', async () => {
    const chain = new ProviderFallbackChain<string>({ totalTimeoutMs: 5000 });

    const result = await chain.tryProviders([
      {
        name: 'primary',
        attempt: async () => {
          throw new Error('primary timeout');
        },
      },
      {
        name: 'secondary',
        attempt: async () => 'response from secondary',
      },
    ]);

    expect(result.result).toBe('response from secondary');
    expect(result.providerUsed).toBe('secondary');
    expect(result.attempts).toBe(2);
  });

  it('returns result from first provider when it succeeds', async () => {
    const chain = new ProviderFallbackChain<string>();

    const result = await chain.tryProviders([
      { name: 'primary', attempt: async () => 'ok' },
      { name: 'secondary', attempt: async () => 'should not reach' },
    ]);

    expect(result.result).toBe('ok');
    expect(result.providerUsed).toBe('primary');
    expect(result.attempts).toBe(1);
  });

  it('throws FallbackChainExhaustedError when all providers fail', async () => {
    const chain = new ProviderFallbackChain<string>({ totalTimeoutMs: 5000 });

    await expect(
      chain.tryProviders([
        {
          name: 'p1',
          attempt: async () => {
            throw new Error('timeout');
          },
        },
        {
          name: 'p2',
          attempt: async () => {
            throw new Error('econnrefused');
          },
        },
      ]),
    ).rejects.toThrow(FallbackChainExhaustedError);
  });

  it('throws immediately on non-retryable error', async () => {
    const chain = new ProviderFallbackChain<string>({
      isRetryable: (err) => err instanceof Error && /timeout/.test(err.message),
    });

    await expect(
      chain.tryProviders([
        {
          name: 'p1',
          attempt: async () => {
            throw new Error('400 Bad Request');
          },
        },
        { name: 'p2', attempt: async () => 'should not reach' },
      ]),
    ).rejects.toThrow('400 Bad Request');
  });

  it('skips provider with open circuit breaker', async () => {
    const breaker = new CircuitBreaker(1, 60000, 1);
    breaker.onFailure(); // trip the breaker immediately (threshold=1)

    const chain = new ProviderFallbackChain<string>({ totalTimeoutMs: 5000 });

    const result = await chain.tryProviders([
      { name: 'primary', attempt: async () => 'should skip', breaker },
      { name: 'secondary', attempt: async () => 'fallback ok' },
    ]);

    expect(result.providerUsed).toBe('secondary');
    expect(breaker.isAvailable()).toBe(false);
  });
});

// ── Tests: CircuitBreaker ───────────────────────────────────────────────────

describe('E2E Mock-API: CircuitBreaker', () => {
  beforeEach(() => {
    resetGlobals();
  });

  it('trips after threshold failures and blocks subsequent calls', () => {
    const breaker = new CircuitBreaker(3, 60000, 1);

    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.isAvailable()).toBe(true);

    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe('CLOSED');

    breaker.onFailure(); // 3rd failure trips the breaker
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.isAvailable()).toBe(false);

    const stats = breaker.getStats();
    expect(stats.state).toBe('OPEN');
    expect(stats.failureCount).toBe(3);
  });

  it('resets failure count on success', () => {
    const breaker = new CircuitBreaker(3, 60000, 1);

    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getStats().failureCount).toBe(2);

    breaker.onSuccess();
    expect(breaker.getStats().failureCount).toBe(0);
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('tracks success count', () => {
    const breaker = new CircuitBreaker(5, 30000, 1);

    breaker.onSuccess();
    breaker.onSuccess();
    breaker.onSuccess();

    const stats = breaker.getStats();
    expect(stats.successCount).toBe(3);
    expect(stats.state).toBe('CLOSED');
  });

  it('can be reset to closed state', () => {
    const breaker = new CircuitBreaker(2, 60000, 1);

    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getStats().failureCount).toBe(0);
  });
});
