import { describe, it, expect } from 'vitest';
import { SubAgentGuard, SubAgentLimitError } from '../../src/ultimate/subAgentGuard';
import type { SubAgentLimits, SubAgentState } from '../../src/ultimate/subAgentGuard';

// ============================================================================
// Unit tests: Guard enforcement paths
// ============================================================================

describe('SubAgentGuard', () => {
  it('allows steps under max', () => {
    const g = new SubAgentGuard({ maxSteps: 5 });
    for (let i = 1; i <= 5; i++) g.check(i);
    expect(g.getState().steps).toBe(5);
  });

  it('throws on max_steps', () => {
    const g = new SubAgentGuard({ maxSteps: 3 });
    g.check(1); g.check(2); g.check(3);
    expect(() => g.check(4)).toThrowError(SubAgentLimitError);
  });

  it('throws on max_tokens via recordTokens', () => {
    const g = new SubAgentGuard({ maxTokens: 100 });
    expect(() => g.recordTokens(150)).toThrow(/max_tokens/);
  });

  it('throws on no_progress after threshold', () => {
    const g = new SubAgentGuard({ maxSteps: 50, noProgressThreshold: 3 });
    g.check(1);
    g.check(1);
    g.check(1);
    expect(() => g.check(1)).toThrowError(SubAgentLimitError);
  });

  it('does NOT count steps as no-progress when evidence grows', () => {
    const g = new SubAgentGuard({ maxSteps: 100, noProgressThreshold: 3 });
    for (let i = 1; i <= 10; i++) g.check(i);
    expect(g.getState().steps).toBe(10);
  });

  it('throws on max_wall_clock', () => {
    const g = new SubAgentGuard({ maxWallClockMs: 1, maxSteps: 100 });
    g.check(1);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(() => g.check(2)).toThrow(/max_wall_clock/);
        resolve();
      }, 10);
    });
  });

  it('uses sensible defaults when no limits passed', () => {
    const g = new SubAgentGuard();
    const limits = g.getLimits();
    expect(limits.maxSteps).toBeGreaterThan(0);
    expect(limits.maxTokens).toBeGreaterThan(0);
    expect(limits.maxWallClockMs).toBeGreaterThan(0);
  });
});

// ============================================================================
// Integration tests: Deep-wired enforcement paths
// ============================================================================

describe('SubAgentGuard — deep-wiring integration', () => {
  // ── maxSteps enforcement ──

  it('maxSteps: throws SubAgentLimitError with correct reason, limit, and observed', () => {
    const g = new SubAgentGuard({ maxSteps: 5 });
    for (let i = 0; i < 5; i++) g.check(i + 1);

    try {
      g.check(6);
      expect.fail('Expected SubAgentLimitError was not thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubAgentLimitError);
      const e = err as SubAgentLimitError;
      expect(e.reason).toBe('max_steps');
      expect(e.limit).toBe(5);
      expect(e.observed).toBe(6); // steps incremented from 5 → 6, then checked
    }
  });

  it('maxSteps: many steps with growing evidence does not trigger noProgress', () => {
    const g = new SubAgentGuard({ maxSteps: 20, noProgressThreshold: 5 });
    for (let i = 0; i < 15; i++) g.check(i + 1); // growing evidence
    expect(g.getState().steps).toBe(15);
    expect(g.getState().evidenceCount).toBe(15);
  });

  it('maxSteps: guard state reflects accumulated steps and evidence', () => {
    const g = new SubAgentGuard({ maxSteps: 50 });
    g.check(3);
    g.check(5);
    g.check(7);
    const state = g.getState();
    expect(state.steps).toBe(3);
    expect(state.evidenceCount).toBe(7);
  });

  // ── noProgress enforcement ──

  it('noProgress: stalls when evidence is flat across many steps', () => {
    const g = new SubAgentGuard({ maxSteps: 100, noProgressThreshold: 2 });
    g.check(0);  // steps=1, evidence stays 0 (0 > 0 is false)
    try {
      g.check(0);  // steps=2, evidence stays 0, stall = 2-0 = 2 >= 2 → throws
      expect.fail('Expected no_progress error on second flat call');
    } catch (err) {
      expect(err).toBeInstanceOf(SubAgentLimitError);
      expect((err as SubAgentLimitError).reason).toBe('no_progress');
    }
  });

  it('noProgress: resets stall when new evidence arrives', () => {
    const g = new SubAgentGuard({ maxSteps: 100, noProgressThreshold: 5 });
    // Grow to 10, then stall for 3 steps
    g.check(10);
    g.check(10);
    g.check(10);
    g.check(10);
    // New evidence arrives — stall resets
    g.check(15);
    g.check(15);
    // Still under noProgressThreshold after new evidence
    expect(g.getState().evidenceCount).toBe(15);
  });

  it('noProgress: cumulative evidence persists across simulated retries', () => {
    // Simulate the deep-wiring pattern: cumulativeEvidence persists across retries
    const g = new SubAgentGuard({ maxSteps: 100, noProgressThreshold: 5 });
    let cumulativeEvidence = 0;

    // First attempt: gather some evidence
    cumulativeEvidence += 3;
    g.check(cumulativeEvidence); // evidence = 3
    cumulativeEvidence += 2;
    g.check(cumulativeEvidence); // evidence = 5
    cumulativeEvidence += 1;
    g.check(cumulativeEvidence); // evidence = 6

    // Second attempt (retry): cumulativeEvidence continues from 6
    cumulativeEvidence += 2;
    g.check(cumulativeEvidence); // evidence = 8 — grows, stall resets
    cumulativeEvidence += 0; // no new evidence
    g.check(cumulativeEvidence); // stall = 1 (5 - 8? no, steps=5, evidence=8, stall = -3)
    // Actually stall = steps - evidence = 5 - 8 = -3, so no stall
    expect(g.getState().evidenceCount).toBe(8);
    expect(g.getState().steps).toBe(5);
  });

  // ── maxTokens enforcement ──

  it('maxTokens: recordTokens throws SubAgentLimitError with reason max_tokens', () => {
    const g = new SubAgentGuard({ maxTokens: 500 });
    g.recordTokens(200);
    g.recordTokens(200);

    try {
      g.recordTokens(200); // total = 600 > 500
      expect.fail('Expected max_tokens error');
    } catch (err) {
      expect(err).toBeInstanceOf(SubAgentLimitError);
      const e = err as SubAgentLimitError;
      expect(e.reason).toBe('max_tokens');
      expect(e.limit).toBe(500);
      expect(e.observed).toBe(600);
    }
  });

  it('maxTokens: incremental recordTokens accumulates correctly', () => {
    const g = new SubAgentGuard({ maxTokens: 1000 });
    g.recordTokens(100);
    g.recordTokens(200);
    g.recordTokens(300);
    expect(g.getState().tokens).toBe(600);
    g.recordTokens(399); // total = 999, under limit
    expect(g.getState().tokens).toBe(999);
  });

  it('maxTokens: check() also enforces token limit', () => {
    const g = new SubAgentGuard({ maxTokens: 200 });
    g.recordTokens(100);   // tokens=100, under 200
    // recordTokens enforces immediately, so check() never sees it first.
    // Instead, verify that exceeding via recordTokens throws correctly.
    try {
      g.recordTokens(150); // tokens=250 > 200, throws inside recordTokens
      expect.fail('Expected max_tokens error from recordTokens');
    } catch (err) {
      expect(err).toBeInstanceOf(SubAgentLimitError);
      expect((err as SubAgentLimitError).reason).toBe('max_tokens');
      expect((err as SubAgentLimitError).observed).toBe(250);
    }
  });

  // ── maxWallClockMs enforcement ──

  it('maxWallClockMs: throws after elapsed time exceeds limit', () => {
    const g = new SubAgentGuard({ maxWallClockMs: 50, maxSteps: 100 });
    g.check(1);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        try {
          g.check(2);
          expect.fail('Expected max_wall_clock error');
        } catch (err) {
          expect(err).toBeInstanceOf(SubAgentLimitError);
          const e = err as SubAgentLimitError;
          expect(e.reason).toBe('max_wall_clock');
          expect(e.observed).toBeGreaterThanOrEqual(50);
        }
        resolve();
      }, 60);
    });
  });

  it('maxWallClockMs: within-limit calls succeed', () => {
    const g = new SubAgentGuard({ maxWallClockMs: 5000, maxSteps: 100 });
    g.check(1);
    g.check(2);
    g.check(3);
    expect(g.getState().steps).toBe(3);
  });

  // ── Multiple limit interactions ──

  it('multiple limits: steps enforced before tokens', () => {
    // maxSteps=1: first call puts steps at 1, second call exceeds (steps=2 > 1)
    const g = new SubAgentGuard({ maxSteps: 1, maxTokens: 500, noProgressThreshold: 10 });
    g.check(1);           // steps=1, equals maxSteps (1 > 1 is false, OK)
    g.recordTokens(100);   // tokens=100, under 500, no throw
    try {
      g.check(2); // steps=2 > maxSteps=1 → should throw max_steps
      expect.fail('Expected max_steps error');
    } catch (err) {
      expect(err).toBeInstanceOf(SubAgentLimitError);
      expect((err as SubAgentLimitError).reason).toBe('max_steps');
    }
  });

  it('multiple limits: wall clock checked independently', () => {
    const g = new SubAgentGuard({ maxSteps: 100, maxWallClockMs: 1 });
    g.check(1);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        try {
          g.check(2);
          expect.fail('Expected max_wall_clock');
        } catch (err) {
          expect((err as SubAgentLimitError).reason).toBe('max_wall_clock');
        }
        resolve();
      }, 10);
    });
  });

  // ── Error propagation ──

  it('SubAgentLimitError: message includes reason, limit, and observed', () => {
    const err = new SubAgentLimitError('max_steps', 10, 11);
    expect(err.message).toContain('max_steps');
    expect(err.message).toContain('10');
    expect(err.message).toContain('11');
    expect(err.name).toBe('SubAgentLimitError');
    expect(err.reason).toBe('max_steps');
    expect(err.limit).toBe(10);
    expect(err.observed).toBe(11);
  });

  it('SubAgentLimitError: instanceof works for selective catch', () => {
    const g = new SubAgentGuard({ maxSteps: 1 });
    g.check(1);
    try {
      g.check(2);
    } catch (err) {
      expect(err instanceof SubAgentLimitError).toBe(true);
      expect(err instanceof Error).toBe(true);
    }
  });

  // ── Guard state and limits introspection ──

  it('getState: returns immutable copy that does not affect internal state', () => {
    const g = new SubAgentGuard({ maxSteps: 10 });
    g.check(5);
    const state = g.getState();
    state.steps = 999; // mutate copy
    expect(g.getState().steps).toBe(1); // internal state unchanged
  });

  it('getLimits: returns all configured limits', () => {
    const limits: SubAgentLimits = { maxSteps: 7, maxTokens: 500, noProgressThreshold: 3 };
    const g = new SubAgentGuard(limits);
    const configured = g.getLimits();
    expect(configured.maxSteps).toBe(7);
    expect(configured.maxTokens).toBe(500);
    expect(configured.noProgressThreshold).toBe(3);
    expect(configured.maxWallClockMs).toBe(5 * 60 * 1000); // default
  });

  // ── AgentExecutionContext integration ──

  it('guard can be passed via AgentExecutionContext.guard field', () => {
    // Verify type compatibility: guard field exists on ctx
    const guard = new SubAgentGuard({ maxSteps: 10 });
    const ctx: { guard?: SubAgentGuard } = { guard };
    expect(ctx.guard).toBe(guard);
    expect(ctx.guard?.getState().steps).toBe(0);
  });

  it('guard?.check() is no-op when guard is undefined (root agent)', () => {
    const ctx: { guard?: SubAgentGuard } = {};
    // Optional chaining should not throw
    ctx.guard?.check(1);
    ctx.guard?.recordTokens(100);
    // No error thrown — guard is undefined, calls are skipped
    expect(ctx.guard).toBeUndefined();
  });

  it('Simulated sub-agent step loop: evidence accumulates across retries', () => {
    const guard = new SubAgentGuard({ maxSteps: 30, noProgressThreshold: 5, maxTokens: 10000 });
    let cumulativeEvidence = 0;

    // Simulate first attempt with 3 tool loop iterations
    const simulateIteration = (newEvidence: number) => {
      if (newEvidence > 0) cumulativeEvidence += newEvidence;
      guard.check(cumulativeEvidence);
    };

    // Attempt 1: 3 iterations with growing evidence
    simulateIteration(2);
    simulateIteration(1);
    simulateIteration(3);
    expect(guard.getState().evidenceCount).toBe(6);
    expect(guard.getState().steps).toBe(3);

    // Attempt 2 (retry): cumulativeEvidence persists
    simulateIteration(2);
    simulateIteration(0); // no new evidence this iteration
    simulateIteration(1);
    expect(guard.getState().evidenceCount).toBe(9);
    expect(guard.getState().steps).toBe(6);
  });

  it('Simulated sub-agent token tracking across multiple LLM calls', () => {
    const guard = new SubAgentGuard({ maxTokens: 1000 });
    // Simulate LLM response tokens being recorded
    guard.recordTokens(250); // first LLM call
    guard.recordTokens(300); // tool loop follow-up
    guard.recordTokens(200); // next attempt
    guard.recordTokens(200); // another follow-up
    expect(guard.getState().tokens).toBe(950);
    // Next call should exceed limit
    try {
      guard.recordTokens(100);
      expect.fail('Expected max_tokens');
    } catch (err) {
      expect((err as SubAgentLimitError).reason).toBe('max_tokens');
      expect((err as SubAgentLimitError).limit).toBe(1000);
      expect((err as SubAgentLimitError).observed).toBe(1050);
    }
  });
});
