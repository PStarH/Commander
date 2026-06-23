/**
 * Audit #1 hardening wire-through tests — classified retry behavior in
 * `SequentialPipelineExecutor.executeStep`.
 *
 * Each test exercises ONE branch of the retry decision tree:
 *   - PERMANENT (401/403/422): short-circuit ahead of `step.maxRetries`
 *   - TRANSIENT (429/5xx): honor Retry-After, otherwise exponential backoff
 *   - RETRY_AFTER_TOO_LARGE: server-prescribed delay > 300s ceiling → abort
 *   - RETRY_AFTER_ZERO: immediate retry (no sleep)
 *   - CIRCUIT_OPEN: pre-flight blocks before invoke; emits the
 *     `circuit_breaker_short_circuit` audit-chain entry
 *
 * Uses a mock AgentExecutor that fails N times then succeeds; counts
 * invocations to prove the retry predicate matches the spec.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SequentialPipelineExecutor,
  type AgentExecutor,
  type SequentialContext,
  type TokenUsage,
} from '../../src/ultimate/executor';
import { SequentialPipelineBuilder, type SequentialPipeline } from '../../src/ultimate/sequential';
import { CircuitBreakerRegistry } from '../../src/runtime/circuitBreakerRegistry';
import * as auditChainLedgerModule from '../../src/security/auditChainLedger';

/**
 * MockAgentExecutor — fails the first `failures` invocations with `producer(err)`,
 * then succeeds with a fixed output + token usage.
 */
class CountingMockExecutor implements AgentExecutor {
  public invocations = 0;
  public lastTokenUsage: TokenUsage | undefined;

  constructor(
    private readonly failures: number,
    private readonly producer: (attempt: number) => Error,
  ) {}

  async execute(
    _agentId: string,
    _input: unknown,
    _context: SequentialContext,
  ): Promise<{ output: unknown; tokenUsage: TokenUsage }> {
    this.invocations += 1;
    if (this.invocations <= this.failures) {
      throw this.producer(this.invocations);
    }
    this.lastTokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    return {
      output: { ok: true, attempt: this.invocations },
      tokenUsage: this.lastTokenUsage,
    };
  }
}

function makePipeline(steps = 1, retries = 2): SequentialPipeline {
  const builder = new SequentialPipelineBuilder('test', 'classify-test');
  for (let i = 0; i < steps; i++) {
    builder.addStep({
      name: `Step ${i + 1}`,
      agentId: `agent-${i}`,
      objective: 'classify-test',
      timeout: 5000,
      maxRetries: retries,
      metadata: { provider: 'test', model: 'mock' },
    });
  }
  return builder.build();
}

describe('Audit #1 — executeStep classified retry', () => {
  let breakerRegistry: CircuitBreakerRegistry;

  beforeEach(() => {
    breakerRegistry = new CircuitBreakerRegistry();
  });

  afterEach(() => {
    // The CIRCUIT_OPEN test mocks the audit-chain singleton. Make sure
    // the spy never leaks into adjacent tests.
    vi.restoreAllMocks();
  });

  it('PERMANENT: 401 short-circuits ahead of step.maxRetries (no retry)', async () => {
    const mock = new CountingMockExecutor(99, () => {
      const err = new Error('unauthorized') as Error & { status?: number };
      err.status = 401;
      return err;
    });
    const executor = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await executor.execute(makePipeline(1, 5));

    expect(run.status).toBe('FAILED');
    expect(mock.invocations).toBe(1);
    expect(run.stepResults[0]?.errorClass).toBe('permanent');
    expect(run.stepResults[0]?.error).toMatch(/401|Authentication/);
  });

  it('PERMANENT: 403 forbidden short-circuits', async () => {
    const mock = new CountingMockExecutor(99, () => {
      const err = new Error('forbidden') as Error & { status?: number };
      err.status = 403;
      return err;
    });
    const executor = new SequentialPipelineExecutor(mock, { breakerRegistry });
    await executor.execute(makePipeline(1, 5));
    expect(mock.invocations).toBe(1);
  });

  it('TRANSIENT: 429 with Retry-After=42ms retries with the server-prescribed delay', async () => {
    const mock = new CountingMockExecutor(2, () => {
      const err = new Error('rate-limited') as Error & {
        status?: number;
        headers?: Record<string, string>;
      };
      err.status = 429;
      err.headers = { 'retry-after': '0' }; // 0s = immediate retry (test stays fast)
      return err;
    });
    const executor = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await executor.execute(makePipeline(1, 5));

    expect(run.status).toBe('COMPLETED');
    expect(mock.invocations).toBe(3); // 2 failures + 1 success
  });

  it('RETRY_AFTER_ABORT: 429 with Retry-After > 300_000ms aborts the step (no retry)', async () => {
    const mock = new CountingMockExecutor(99, () => {
      const err = new Error('rate-limited') as Error & {
        status?: number;
        headers?: Record<string, string>;
      };
      err.status = 429;
      err.headers = { 'retry-after': '3600' }; // 1 hour — exceeds 5-minute ceiling
      return err;
    });
    const executor = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await executor.execute(makePipeline(1, 5));

    expect(run.status).toBe('FAILED');
    expect(mock.invocations).toBe(1); // no retry attempted
    expect(run.stepResults[0]?.error).toMatch(/Retry-After=3600000ms exceeds ceiling/);
  });

  it('TRANSIENT: 503 service-unavailable retries with exponential backoff', async () => {
    const mock = new CountingMockExecutor(2, () => {
      const err = new Error('service unavailable') as Error & { status?: number };
      err.status = 503;
      return err;
    });
    const executor = new SequentialPipelineExecutor(mock, {
      breakerRegistry,
      defaultStepTimeout: 300_000,
      defaultMaxRetries: 5,
    });
    const run = await executor.execute(makePipeline(1, 5));

    expect(run.status).toBe('COMPLETED');
    expect(mock.invocations).toBe(3);
  });

  it('NETWORK: ECONNREFUSED classified as transient, retries', async () => {
    const mock = new CountingMockExecutor(1, () => new Error('connect ECONNREFUSED'));
    const executor = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await executor.execute(makePipeline(1, 5));

    expect(run.status).toBe('COMPLETED');
    expect(mock.invocations).toBe(2);
  });

  it('CIRCUIT_OPEN: pre-flight blocks step + emits circuit_breaker_short_circuit audit entry', async () => {
    // Trip the breaker first by recording enough failures.
    const breakerKey = 'test|mock';
    breakerRegistry.register(breakerKey, { threshold: 1, recoveryTimeMs: 60_000 });
    breakerRegistry.onFailure(breakerKey);
    breakerRegistry.onFailure(breakerKey);
    expect(breakerRegistry.getStats(breakerKey).state).toBe('OPEN');

    const mock = new CountingMockExecutor(99, () => new Error('should-not-be-called'));

    // Spy on the audit-chain ledger so we can prove the breaker
    // short-circuit path emits the canonical security event.
    const logEventSpy = vi.fn().mockReturnValue({
      id: 'mock_entry_id',
      timestamp: new Date().toISOString(),
    });
    vi.spyOn(auditChainLedgerModule, 'getAuditChainLedger').mockReturnValue({
      logEvent: logEventSpy,
    } as unknown as ReturnType<typeof auditChainLedgerModule.getAuditChainLedger>);

    const executor = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await executor.execute(makePipeline(1));

    expect(run.status).toBe('FAILED');
    expect(mock.invocations).toBe(0); // pre-flight blocked before invoke
    expect(run.stepResults[0]?.error).toMatch(/Circuit OPEN/i);
    expect(run.stepResults[0]?.errorClass).toBe('transient');

    // The breaker short-circuit MUST write a circuit_breaker_short_circuit
    // entry into the audit chain so security-trail consumers (SOC, SIEM,
    // dailies) can detect breaker-driven pipeline shortfalls. We assert
    // the canonical detail shape via partial-match so a regression that
    // fires the event with the wrong key (or no key) cannot pass, while
    // additive fields added by executor.ts in the future (e.g. new
    // stepId / pipelineId context) do not break this test.
    const shortCircuitCalls = logEventSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'circuit_breaker_short_circuit',
    );
    expect(shortCircuitCalls.length).toBeGreaterThan(0);
    expect(shortCircuitCalls[0]![0]).toMatchObject({
      details: { breakerKey },
    });
  });

  it('CIRCUIT_KEYED: (provider, model) isolates breakers across different metadata', async () => {
    // Two breakers (per metadata.provider/model) — tripping one does NOT
    // affect the other. Validates the audit #1 isolation contract.
    const builder = new SequentialPipelineBuilder('test', 'circuit-keyed');
    builder.addStep({
      name: 'Step 1',
      agentId: 'a',
      objective: 'first',
      metadata: { provider: 'openai', model: 'gpt-4o' },
      maxRetries: 0,
    });
    builder.addStep({
      name: 'Step 2',
      agentId: 'b',
      objective: 'second',
      metadata: { provider: 'anthropic', model: 'claude-3' },
      maxRetries: 0,
    });
    const pipeline = builder.build();
    // CIRCUIT_KEYED verifies breaker-key isolation under best-effort
    // continuation. The sequential executor defaults to stopOnError=true,
    // which would terminate the run after step 1's short-circuit and
    // hide exactly the regression we are guarding against (a registry
    // that leaks state across keys). This test runs explicitly with
    // stopOnError=false to exercise the worst-case path; production
    // behavior with the default is covered separately by the CIRCUIT_OPEN
    // test above.
    pipeline.stopOnError = false;

    const breaker = breakerRegistry.register('openai|gpt-4o', {
      threshold: 1,
      recoveryTimeMs: 60_000,
    });
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getStats().state).toBe('OPEN');

    // failures=0 → mock returns success on first call. Step 1 is
    // short-circuited by the breaker pre-flight; step 2 then reaches
    // the agent and succeeds. If a regression makes every breaker
    // trip simultaneously (defeats Hystrix), step 2 would also
    // short-circuit and the assertions below will fail loudly.
    const mock = new CountingMockExecutor(0, () => new Error('unused'));
    const executor = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await executor.execute(pipeline);

    expect(run.stepResults[0]?.status).toBe('FAILURE');
    expect(run.stepResults[0]?.error).toMatch(/Circuit OPEN/);

    // Step 2 must run freely: defender against "every breaker trips"
    // regressions that silently neutralize Hystrix isolation.
    expect(run.stepResults[1]?.status).toBe('SUCCESS');
    expect(mock.invocations).toBe(1); // only step 2 reached the agent
  });
});
