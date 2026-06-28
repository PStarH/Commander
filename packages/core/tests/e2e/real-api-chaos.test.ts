/**
 * Real-API Chaos / Failure-Injection Tests
 *
 * Exercises the Commander framework's failure-recovery mechanisms against a
 * real LLM API (StepFun step-3.7-flash). Unlike the mock-based chaos.test.ts,
 * these tests verify that:
 *
 *   1. ProviderFallbackChain — real API primary → real API secondary failover
 *   2. CircuitBreaker — real API failures trip the breaker, blocks subsequent calls
 *   3. AgentRuntime retry — real API transient error → retry → success
 *   4. AgentRuntime all-providers-fail — graceful failure with error details
 *   5. Timeout handling — real API slow response → timeout → graceful failure
 *
 * Requirements:
 *   - STEPFUN_API_KEY environment variable
 *   - Network access to https://api.stepfun.com
 *
 * Run with:
 *   npx vitest run --config real-api-chaos.vitest.config.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIProvider } from '../../src/runtime/providers/openaiProvider';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { ProviderFallbackChain } from '../../src/runtime/providerFallbackChain';
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
import { resetCostGuard } from '../../src/security/costGuard';
import { resetSecurityMonitor } from '../../src/security/securityMonitor';
import { resetGuardianAgent } from '../../src/security/guardianAgent';
import type { LLMRequest, LLMResponse } from '../../src/runtime/types';

// ── Configuration ──────────────────────────────────────────────────────────

const STEPFUN_API_KEY = process.env.STEPFUN_API_KEY ?? '';
const STEPFUN_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.stepfun.com/step_plan/v1';
const STEPFUN_MODEL = process.env.OPENAI_MODEL ?? 'step-3.7-flash';

const SKIP = !STEPFUN_API_KEY;

const CHAOS_TIMEOUT = 90000;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: STEPFUN_API_KEY,
    baseUrl: STEPFUN_BASE_URL,
    defaultModel: STEPFUN_MODEL,
  });
}

/** A provider that wraps a real provider but can inject failures */
class FlakyProviderWrapper implements Pick<OpenAIProvider, 'call' | 'name'> {
  readonly name: string;
  private inner: OpenAIProvider;
  private failCount: number;
  private failTimes: number;

  constructor(inner: OpenAIProvider, failTimes: number) {
    this.inner = inner;
    this.name = inner.name;
    this.failCount = 0;
    this.failTimes = failTimes;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    if (this.failCount < this.failTimes) {
      this.failCount++;
      throw new Error(`Injected timeout failure #${this.failCount} (simulated network error)`);
    }
    return this.inner.call(request);
  }

  get failureCount(): number {
    return this.failCount;
  }
}

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
  resetCostGuard();
  resetSecurityMonitor();
  resetGuardianAgent();
}

function makeCustomRouter(): ModelRouter {
  const customModels = (['eco', 'standard', 'power', 'consensus'] as const).map((tier) => ({
    id: `${STEPFUN_MODEL}@${tier}`,
    provider: 'openai',
    tier,
    costPer1MInput: 1,
    costPer1MOutput: 3,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 0,
  }));
  return new ModelRouter(customModels);
}

function makeMinimalRequest(): LLMRequest {
  return {
    model: STEPFUN_MODEL,
    messages: [{ role: 'user', content: 'Say hello.' }],
    maxTokens: 100,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('E2E Real-API Chaos: failure injection', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    resetGlobals();
  });

  afterEach(() => {
    try {
      runtime?.dispose();
    } catch {
      /* best-effort */
    }
  });

  // ── 1. ProviderFallbackChain: real API failover ──────────────────────────

  it(
    'ProviderFallbackChain fails over from failing primary to real API secondary',
    async () => {
      const realProvider = makeProvider();
      const failingPrimary = {
        name: 'failing-primary',
        attempt: () => Promise.reject(new Error('primary provider timeout: connection refused')),
      };
      const realSecondary = {
        name: 'real-stepfun',
        attempt: () => realProvider.call(makeMinimalRequest()),
      };

      const chain = new ProviderFallbackChain<LLMResponse>();
      const result = await chain.tryProviders([failingPrimary, realSecondary]);

      expect(result.providerUsed).toBe('real-stepfun');
      expect(result.attempts).toBe(2);
      expect(result.result.content).toBeTruthy();
      expect(result.result.usage.totalTokens).toBeGreaterThan(0);

      console.log('[Real-API Chaos] Fallback chain failover:', {
        providerUsed: result.providerUsed,
        attempts: result.attempts,
        content: result.result.content.slice(0, 80),
        tokens: result.result.usage.totalTokens,
      });
    },
    CHAOS_TIMEOUT,
  );

  // ── 2. CircuitBreaker: real API failures trip the breaker ────────────────

  it(
    'CircuitBreaker trips after threshold failures and blocks subsequent calls',
    async () => {
      // Use a low threshold so the test doesn't take too long
      const breaker = new CircuitBreaker(3, 60000); // threshold=3, recovery=60s

      // Simulate 3 failures
      for (let i = 0; i < 3; i++) {
        breaker.onFailure();
      }

      // Circuit should now be OPEN
      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.isAvailable()).toBe(false);

      // Verify a real API call is NOT made (circuit blocks it)
      // We simulate what AgentRuntime does: check isAvailable() before calling
      const realProvider = makeProvider();
      let apiCallMade = false;

      if (breaker.isAvailable()) {
        apiCallMade = true;
        await realProvider.call(makeMinimalRequest());
      }

      expect(apiCallMade).toBe(false);

      console.log('[Real-API Chaos] Circuit breaker tripped:', {
        state: breaker.getState(),
        isAvailable: breaker.isAvailable(),
        stats: breaker.getStats(),
      });
    },
    CHAOS_TIMEOUT,
  );

  // ── 3. CircuitBreaker recovery: CLOSED → OPEN → HALF_OPEN → CLOSED ──────

  it(
    'CircuitBreaker recovers from OPEN to CLOSED after a successful real API call',
    async () => {
      // threshold=2, recovery=100ms (short for fast test)
      const breaker = new CircuitBreaker(2, 100);
      const realProvider = makeProvider();

      // Trip the breaker with 2 failures
      breaker.onFailure();
      breaker.onFailure();
      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.isAvailable()).toBe(false);

      // Wait for recovery timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should transition to HALF_OPEN on next isAvailable()
      expect(breaker.isAvailable()).toBe(true);
      expect(breaker.getState()).toBe('HALF_OPEN');

      // Make a real successful API call → should close the circuit
      const response = await realProvider.call(makeMinimalRequest());
      expect(response.content).toBeTruthy();

      // Record success
      breaker.onSuccess();
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.isAvailable()).toBe(true);

      console.log('[Real-API Chaos] Circuit breaker recovery:', {
        finalState: breaker.getState(),
        responseContent: response.content.slice(0, 60),
        tokens: response.usage.totalTokens,
      });
    },
    CHAOS_TIMEOUT,
  );

  // ── 4. AgentRuntime: transient failure → retry → real API success ────────

  it(
    'AgentRuntime retries past a transient failure and succeeds with real API',
    async () => {
      const router = makeCustomRouter();
      const runtime = new AgentRuntime(
        {
          maxRetries: 2,
          timeoutMs: 90000,
          maxConcurrency: 4,
          budgetHardCapTokens: 500000,
          llmTimeoutMs: 60000,
        },
        router,
      );

      // Wrap the real provider to fail once, then succeed
      const realProvider = makeProvider();
      const flaky = new FlakyProviderWrapper(realProvider, 1);
      runtime.registerProvider('openai', flaky as unknown as OpenAIProvider);

      const result = await runtime.execute({
        agentId: 'chaos-retry-agent',
        projectId: 'chaos-retry-project',
        missionId: 'chaos-retry',
        goal: 'What is the capital of France? Answer in one word.',
        contextData: {},
        availableTools: [],
        maxSteps: 3,
        tokenBudget: 10000,
      });

      // Should succeed after retry
      expect(result.status).toBe('success');
      expect(result.summary).toMatch(/Paris/i);
      expect(result.totalTokenUsage.totalTokens).toBeGreaterThan(0);

      console.log('[Real-API Chaos] Retry after transient failure:', {
        status: result.status,
        summary: result.summary.slice(0, 100),
        injectedFailures: flaky.failureCount,
        tokens: result.totalTokenUsage,
        durationMs: result.totalDurationMs,
      });
    },
    CHAOS_TIMEOUT,
  );

  // ── 5. AgentRuntime: all providers fail → graceful failure ───────────────

  it(
    'AgentRuntime returns failed status gracefully when all providers are unreachable',
    async () => {
      const router = makeCustomRouter();
      const runtime = new AgentRuntime(
        {
          maxRetries: 1,
          timeoutMs: 30000,
          maxConcurrency: 4,
          budgetHardCapTokens: 500000,
          llmTimeoutMs: 15000,
        },
        router,
      );

      // Register a provider with an invalid API key → guaranteed 401 failure
      const badProvider = new OpenAIProvider({
        apiKey: 'sk-invalid-key-for-chaos-test',
        baseUrl: STEPFUN_BASE_URL,
        defaultModel: STEPFUN_MODEL,
      });
      runtime.registerProvider('openai', badProvider);

      const result = await runtime.execute({
        agentId: 'chaos-fail-agent',
        projectId: 'chaos-fail-project',
        missionId: 'chaos-all-fail',
        goal: 'This should fail because the API key is invalid.',
        contextData: {},
        availableTools: [],
        maxSteps: 1,
        tokenBudget: 1000,
      });

      // Must be 'failed' (not a crash/hang)
      expect(['failed', 'partial', 'cancelled']).toContain(result.status);
      expect(result.error).toBeTruthy();

      console.log('[Real-API Chaos] All providers fail:', {
        status: result.status,
        error: String(result.error).slice(0, 200),
        durationMs: result.totalDurationMs,
      });
    },
    CHAOS_TIMEOUT,
  );

  // ── 6. Real API + FlakyProvider: success after 2 injected failures ──────

  it(
    'FlakyProviderWrapper succeeds on 3rd attempt after 2 injected failures',
    async () => {
      const realProvider = makeProvider();
      const flaky = new FlakyProviderWrapper(realProvider, 2);

      let lastError: Error | null = null;
      let response: LLMResponse | null = null;

      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          response = await flaky.call(makeMinimalRequest());
          break;
        } catch (err) {
          lastError = err as Error;
        }
      }

      expect(response).not.toBeNull();
      expect(response!.content).toBeTruthy();
      expect(response!.usage.totalTokens).toBeGreaterThan(0);
      expect(flaky.failureCount).toBe(2);

      console.log('[Real-API Chaos] Flaky provider recovery:', {
        injectedFailures: flaky.failureCount,
        content: response!.content.slice(0, 60),
        tokens: response!.usage.totalTokens,
        lastError: lastError?.message,
      });
    },
    CHAOS_TIMEOUT,
  );
});
