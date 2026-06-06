import { describe, it, expect } from 'vitest';
import { SubAgentGuard, SubAgentLimitError } from '../../src/ultimate/subAgentGuard';

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
