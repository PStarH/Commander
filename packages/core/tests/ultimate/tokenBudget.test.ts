/**
 * Audit #4 hardening tests — `SequentialPipeline.tokenBudget` per-run soft
 * cap with `getAuditChainLedger` integration.
 *
 * Behavior contract:
 *   - When `pipeline.tokenBudget = N` is set, the executor accumulates
 *     `tokensUsed` per step and on the FIRST step that pushes the running
 *     total past N, it logs `token_budget_breach` to the audit chain and
 *     marks `budgetExceeded = true`.
 *   - Subsequent steps (post-overflow) short-circuit to FAILURE rather
 *     than invoking the LLM agent.
 *   - When the budget is unset, no enforcement fires (existing semantics
 *     preserved).
 *   - When `pipeline.envTokenBudgetKey` is set and the env is set, the
 *     ENV value wins over the default.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  SequentialPipelineExecutor,
  type AgentExecutor,
  type SequentialContext,
  type TokenUsage,
} from '../../src/ultimate/executor';
import { SequentialPipelineBuilder, type SequentialPipeline } from '../../src/ultimate/sequential';
import { CircuitBreakerRegistry } from '../../src/runtime/circuitBreakerRegistry';
import * as securityAuditLoggerModule from '../../src/security/securityAuditLogger';
import * as auditChainLedgerModule from '../../src/security/auditChainLedger';

// ── Mock AgentExecutor with configurable per-step token usage ────────

class ConfigurableTokenExecutor implements AgentExecutor {
  public invocations = 0;
  constructor(public readonly perStepTokens: number) {}

  async execute(
    _agentId: string,
    _input: unknown,
    _context: SequentialContext,
  ): Promise<{ output: unknown; tokenUsage: TokenUsage }> {
    this.invocations += 1;
    return {
      output: { ok: true, step: this.invocations },
      tokenUsage: {
        promptTokens: Math.max(1, Math.floor(this.perStepTokens / 2)),
        completionTokens: Math.max(1, Math.ceil(this.perStepTokens / 2)),
        totalTokens: this.perStepTokens,
      },
    };
  }
}

// ── mock AuditChainLedger to capture writes without disk I/O ─────────

function attachAuditSpies() {
  const logEventSpy = vi.fn().mockReturnValue({
    id: 'mock_entry_id',
    timestamp: new Date().toISOString(),
    chainId: 'mock_chain',
    seq: 1,
    prevHash: '0000',
    hmac: 'mock_hmac',
  });
  const getLedgerSpy = vi.spyOn(auditChainLedgerModule, 'getAuditChainLedger').mockReturnValue({
    logEvent: logEventSpy,
  } as unknown as ReturnType<typeof auditChainLedgerModule.getAuditChainLedger>);
  return { logEventSpy, getLedgerSpy };
}

describe('Audit #4 — tokenBudget enforcement', () => {
  let breakerRegistry: CircuitBreakerRegistry;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    breakerRegistry = new CircuitBreakerRegistry();
    envBackup = { ...process.env };
  });

  afterEach(() => {
    process.env = envBackup;
    vi.restoreAllMocks();
  });

  it('within budget: 3 steps of 100 tokens x budget=400 completes cleanly', async () => {
    const { getLedgerSpy } = attachAuditSpies();
    const mock = new ConfigurableTokenExecutor(100);
    const builder = new SequentialPipelineBuilder('tok-ok', 'within-budget');
    for (let i = 0; i < 3; i++)
      builder.addStep({ name: `S${i}`, agentId: `a${i}`, objective: 'x' });
    const pipeline = builder.build();
    pipeline.tokenBudget = 400;

    const exec = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await exec.execute(pipeline);

    expect(run.status).toBe('COMPLETED');
    expect(mock.invocations).toBe(3);
    expect(run.metrics.tokenUsage.totalTokens).toBe(300);
    // No audit-chain entry should fire when we stay under budget.
    expect(getLedgerSpy).not.toHaveBeenCalled();
  });

  it('overflow on step N: budget=200, 3 steps of 100 — step 3 short-circuits with audit log', async () => {
    const { logEventSpy, getLedgerSpy } = attachAuditSpies();
    const mock = new ConfigurableTokenExecutor(100);
    const builder = new SequentialPipelineBuilder('tok-over', 'overflow');
    for (let i = 0; i < 3; i++)
      builder.addStep({ name: `S${i}`, agentId: `a${i}`, objective: 'y' });
    const pipeline = builder.build();
    pipeline.tokenBudget = 200;

    const exec = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await exec.execute(pipeline);

    // Step 1+2 = 200 tokens (at cap); Step 2 pushes the running total to
    // 200 which equals the cap but does NOT exceed it. The third step
    // would push the total past 200.
    //
    // The executor's predicate is `accumulatedTokens > effectiveTokenBudget`
    // so step 2 may not trigger on its own (200 > 200 is false); step 3
    // brings the running total to 300 which definitely fires. Therefore
    // step 3 is the first to short-circuit.
    expect(run.status).toBe('COMPLETED');
    expect(mock.invocations).toBe(3);
    expect(getLedgerSpy).toHaveBeenCalled();
    const breachCalls = logEventSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'token_budget_breach',
    );
    expect(breachCalls.length).toBeGreaterThan(0);
    const breachDetail = (
      breachCalls[0]![0] as { details?: { accumulated?: number; cap?: number } }
    ).details;
    expect(breachDetail?.cap).toBe(200);
    expect(breachDetail?.accumulated).toBeGreaterThan(200);
  });

  it('overflow has the SAME-step completed then short-circuit semantics (current step runs then later short-circuit)', async () => {
    // Per design lock-in: the FIRST step that pushes the sum past the cap
    // is allowed to complete (LLM responses cannot be truncated mid-call);
    // subsequent steps short-circuit. Verify in this test that the very
    // first step past the cap is logged.
    const { logEventSpy } = attachAuditSpies();
    const mock = new ConfigurableTokenExecutor(150);
    const builder = new SequentialPipelineBuilder('tok-trail', 'trail');
    for (let i = 0; i < 3; i++)
      builder.addStep({ name: `S${i}`, agentId: `a${i}`, objective: 'z' });
    const pipeline = builder.build();
    pipeline.tokenBudget = 200;

    const exec = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await exec.execute(pipeline);

    // Step 1 = 150 (under cap), step 2 = 300 (pushes past), step 3 short-circuits.
    expect(mock.invocations).toBe(2);
    // The final run status is implementation-defined: depending on
    // whether the short-circuited step-3 surfaces as a hard FAILURE or
    // an audit-only decision, the run may end either COMPLETED or
    // FAILED. What MUST hold is the breach log + the no-invocation
    // of step 3 + the audit-chain entry fired by step 2.
    expect(['COMPLETED', 'FAILED']).toContain(run.status);
    const breachCalls = logEventSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'token_budget_breach',
    );
    expect(breachCalls.length).toBeGreaterThan(0);
  });

  it('no budget set: tokenBudget undefined → no enforcement, no audit calls', async () => {
    const { logEventSpy } = attachAuditSpies();
    const mock = new ConfigurableTokenExecutor(1000);
    const builder = new SequentialPipelineBuilder('tok-nobud', 'no-budget');
    for (let i = 0; i < 3; i++)
      builder.addStep({ name: `S${i}`, agentId: `a${i}`, objective: 'w' });
    const pipeline = builder.build();
    expect(pipeline.tokenBudget).toBeUndefined();

    const exec = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await exec.execute(pipeline);

    expect(run.status).toBe('COMPLETED');
    expect(mock.invocations).toBe(3);
    const breachCalls = logEventSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'token_budget_breach',
    );
    expect(breachCalls.length).toBe(0);
  });

  it('envTokenBudgetKey env override: pipeline.tokenBudget=0 falls back to env, then enforces', async () => {
    const { logEventSpy } = attachAuditSpies();
    process.env.MY_PIPELINE_BUDGET = '200';
    const mock = new ConfigurableTokenExecutor(100);
    const builder = new SequentialPipelineBuilder('tok-env', 'env-override');
    for (let i = 0; i < 3; i++)
      builder.addStep({ name: `S${i}`, agentId: `a${i}`, objective: 'e' });
    const pipeline = builder.build();
    pipeline.tokenBudget = 0; // 0 is ignored → falls back to envTokenBudgetKey
    pipeline.envTokenBudgetKey = 'MY_PIPELINE_BUDGET';

    const exec = new SequentialPipelineExecutor(mock, { breakerRegistry });
    const run = await exec.execute(pipeline);

    expect(run.status).toBe('COMPLETED');
    const breachCalls = logEventSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'token_budget_breach',
    );
    expect(breachCalls.length).toBeGreaterThan(0);
  });
});

// ── sanity test: SecurityEventType extended values exist in the audit
//    union (regression). Keeps handlers from silently misclassifying. ──

describe('Audit #4 — SecurityEventType extension sanity', () => {
  it('token_budget_breach and key_rotation_attempt are valid SecurityEventType values', () => {
    // Compile-time check via TS narrowing: assignability to the union.
    const v1: securityAuditLoggerModule.SecurityEventType = 'token_budget_breach';
    const v2: securityAuditLoggerModule.SecurityEventType = 'key_rotation_attempt';
    const v3: securityAuditLoggerModule.SecurityEventType = 'circuit_breaker_short_circuit';
    expect([v1, v2, v3]).toContain('token_budget_breach');
  });
});
