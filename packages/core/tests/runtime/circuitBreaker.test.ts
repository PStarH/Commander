import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker } from '../../src/runtime/circuitBreaker';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in CLOSED state and allows calls', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.isAvailable()).toBe(true);
  });

  it('tracks stats correctly initially', () => {
    const cb = new CircuitBreaker();
    const stats = cb.getStats();
    expect(stats.state).toBe('CLOSED');
    expect(stats.failureCount).toBe(0);
    expect(stats.successCount).toBe(0);
    expect(stats.openCount).toBe(0);
    expect(stats.threshold).toBe(5);
    expect(stats.recoveryTimeMs).toBe(30000);
  });

  it('allows custom threshold and recovery time', () => {
    const cb = new CircuitBreaker(3, 10000, 2);
    const stats = cb.getStats();
    expect(stats.threshold).toBe(3);
    expect(stats.recoveryTimeMs).toBe(10000);
  });

  it('transitions to OPEN after threshold failures', () => {
    const cb = new CircuitBreaker(3, 30000);
    expect(cb.getState()).toBe('CLOSED');
    cb.onFailure();
    expect(cb.getState()).toBe('CLOSED');
    cb.onFailure();
    expect(cb.getState()).toBe('CLOSED');
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
  });

  it('rejects calls when OPEN', () => {
    const cb = new CircuitBreaker(2, 30000);
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
    expect(cb.isAvailable()).toBe(false);
  });

  it('transitions to HALF_OPEN after recovery time', () => {
    const cb = new CircuitBreaker(2, 10000);
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
    expect(cb.isAvailable()).toBe(false);

    vi.advanceTimersByTime(10000);
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('resets success count and closes on HALF_OPEN success', () => {
    const cb = new CircuitBreaker(2, 10000);
    cb.onFailure();
    cb.onFailure();
    vi.advanceTimersByTime(10000);
    cb.isAvailable(); // triggers OPEN -> HALF_OPEN
    expect(cb.getState()).toBe('HALF_OPEN');

    cb.onSuccess();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getStats().failureCount).toBe(0);
    expect(cb.getStats().successCount).toBe(1);
  });

  it('re-opens on HALF_OPEN failure', () => {
    const cb = new CircuitBreaker(3, 10000);
    // Trigger OPEN
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');

    // Wait for recovery
    vi.advanceTimersByTime(10000);
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');

    // Fail in HALF_OPEN -> back to OPEN
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
  });

  it('limits concurrent test requests in HALF_OPEN', () => {
    const cb = new CircuitBreaker(2, 10000, 2);
    cb.onFailure();
    cb.onFailure();
    vi.advanceTimersByTime(10000);

    // First isAvailable() transitions OPEN -> HALF_OPEN and consumes 1 in-flight slot
    expect(cb.isAvailable()).toBe(true);
    // 2nd call uses the remaining slot
    expect(cb.isAvailable()).toBe(true);
    // 3rd should be blocked (2 in flight)
    expect(cb.isAvailable()).toBe(false);
  });

  it('tracks openCount', () => {
    const cb = new CircuitBreaker(2, 1000);
    cb.onFailure();
    cb.onFailure();
    expect(cb.getStats().openCount).toBe(1);

    vi.advanceTimersByTime(1000);
    cb.isAvailable(); // transitions to HALF_OPEN
    cb.onFailure(); // re-opens
    expect(cb.getStats().openCount).toBe(2);
  });

  it('reset forces back to CLOSED from any state', () => {
    const cb = new CircuitBreaker(2, 30000);
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');

    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getStats().failureCount).toBe(0);
    expect(cb.getStats().successCount).toBe(0);
    expect(cb.isAvailable()).toBe(true);
  });

  it('reset from HALF_OPEN goes to CLOSED', () => {
    const cb = new CircuitBreaker(1, 10000);
    cb.onFailure();
    vi.advanceTimersByTime(10000);
    cb.isAvailable(); // -> HALF_OPEN
    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('fires onStateChange callback on transitions', () => {
    const changes: Array<{ from: string; to: string }> = [];
    const cb = new CircuitBreaker(2, 10000, 1, (from, to) => {
      changes.push({ from, to });
    });

    cb.onFailure();
    cb.onFailure();
    expect(changes).toContainEqual({ from: 'CLOSED', to: 'OPEN' });

    vi.advanceTimersByTime(10000);
    cb.isAvailable();
    expect(changes).toContainEqual({ from: 'OPEN', to: 'HALF_OPEN' });

    cb.onSuccess();
    expect(changes).toContainEqual({ from: 'HALF_OPEN', to: 'CLOSED' });
  });

  it('increments successCount on successful calls', () => {
    const cb = new CircuitBreaker(5, 30000);
    cb.onSuccess();
    cb.onSuccess();
    expect(cb.getStats().successCount).toBe(2);
  });

  it('maintains CLOSED state when failures are below threshold', () => {
    const cb = new CircuitBreaker(5, 30000);
    for (let i = 0; i < 4; i++) cb.onFailure();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.isAvailable()).toBe(true);
  });

  it('handles threshold of 1', () => {
    const cb = new CircuitBreaker(1, 30000);
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
  });

  it('success resets failure count in CLOSED state', () => {
    const cb = new CircuitBreaker(5, 30000);
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    cb.onSuccess();
    expect(cb.getStats().failureCount).toBe(0);
    cb.onFailure(); // now only 1 failure
    expect(cb.getState()).toBe('CLOSED');
  });

  it('handles rapid success/failure cycling', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.onFailure();
    cb.onSuccess();
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');

    vi.advanceTimersByTime(1000);
    cb.isAvailable(); // HALF_OPEN
    cb.onSuccess(); // back to CLOSED
    expect(cb.getState()).toBe('CLOSED');
  });
});

describe('CircuitBreaker — configuration & metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns current config', () => {
    const cb = new CircuitBreaker(3, 10000, 2, undefined, {
      volumeThreshold: 5,
      errorRateThreshold: 0.6,
      semanticThreshold: 4,
      securityThreshold: 3,
    });
    expect(cb.getConfig()).toEqual({
      threshold: 3,
      recoveryTimeMs: 10000,
      halfOpenMaxTests: 2,
      volumeThreshold: 5,
      errorRateThreshold: 0.6,
      semanticThreshold: 4,
      securityThreshold: 3,
      // REL-8: defaults to recoveryTimeMs when not explicitly configured.
      securityDecayMs: 10000,
    });
  });

  it('REL-8: recovers from a security trip via elapsed quiet time (no success needed)', () => {
    // securityThreshold 2, decay window 10s.
    const cb = new CircuitBreaker(5, 10000, 1, undefined, {
      securityThreshold: 2,
      securityDecayMs: 10000,
    });
    // Two HIGH security events trip the breaker.
    cb.onSecurityEvent('HIGH');
    cb.onSecurityEvent('HIGH');
    expect(cb.isAvailable()).toBe(false);
    // Still tripped before a full decay window elapses.
    vi.advanceTimersByTime(9000);
    expect(cb.isAvailable()).toBe(false);
    // After enough quiet time the counter decays below threshold and traffic
    // is allowed again — without any success call, which was impossible while
    // the breaker rejected everything.
    vi.advanceTimersByTime(11000); // 20s total → 2 decay steps
    expect(cb.isAvailable()).toBe(true);
  });

  it('REL-8: a sustained event stream keeps the breaker tripped', () => {
    const cb = new CircuitBreaker(5, 10000, 1, undefined, {
      securityThreshold: 2,
      securityDecayMs: 10000,
    });
    cb.onSecurityEvent('CRITICAL'); // weight 2 → tripped
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(9000); // never a full window between events
      cb.onSecurityEvent('HIGH'); // resets the decay anchor
    }
    expect(cb.isAvailable()).toBe(false);
  });

  it('reconfigures thresholds at runtime', () => {
    const cb = new CircuitBreaker();
    cb.configure({ threshold: 2, recoveryTimeMs: 5000, halfOpenMaxTests: 3 });
    const config = cb.getConfig();
    expect(config.threshold).toBe(2);
    expect(config.recoveryTimeMs).toBe(5000);
    expect(config.halfOpenMaxTests).toBe(3);
  });

  it('sets and exposes provider name', () => {
    const cb = new CircuitBreaker();
    cb.setProviderName('openai');
    // setProviderName is a setter; no public getter, but we can exercise it
    expect(cb.getStats().state).toBe('CLOSED');
  });

  it('emits observability transition callbacks', () => {
    const transitions: Array<{ from: string; to: string; provider?: string }> = [];
    const cb = new CircuitBreaker(1, 1000);
    cb.setProviderName('anthropic');
    cb.setObservability({
      onTransition: (from, to, provider) => transitions.push({ from, to, provider }),
    });

    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
    expect(transitions).toContainEqual({ from: 'CLOSED', to: 'OPEN', provider: 'anthropic' });
  });
});

describe('CircuitBreaker — semantic & security trip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires semantic trip callback when threshold reached', () => {
    const trips: Array<{
      count: number;
      reason: string;
      ctx?: { runId?: string; toolName?: string };
    }> = [];
    const cb = new CircuitBreaker();
    cb.setSemanticTripHandler((count, reason, ctx) => trips.push({ count, reason, ctx }));

    cb.recordSemanticFailure('hallucination', { runId: 'run-1', toolName: 'verify' });
    cb.recordSemanticFailure('hallucination', { runId: 'run-1', toolName: 'verify' });
    expect(trips.length).toBe(0);
    cb.recordSemanticFailure('hallucination', { runId: 'run-1', toolName: 'verify' });
    expect(trips.length).toBe(1);
    expect(trips[0].count).toBe(3);
    expect(trips[0].ctx).toEqual({ runId: 'run-1', toolName: 'verify' });
  });

  it('records semantic success and resets consecutive failures', () => {
    const cb = new CircuitBreaker();
    cb.recordSemanticFailure('bad');
    cb.recordSemanticFailure('bad');
    cb.recordSemanticSuccess();
    expect(cb.getSemanticHealth().consecutiveFailures).toBe(0);
    expect(cb.getSemanticHealth().tripped).toBe(false);
  });

  it('trips circuit when semantic failure count exceeds threshold', () => {
    const cb = new CircuitBreaker(undefined, undefined, undefined, undefined, {
      semanticThreshold: 2,
    });
    cb.onSemanticDrift(0.8);
    cb.onSemanticDrift(0.8);
    expect(cb.isAvailable()).toBe(false);
    expect(cb.getState()).toBe('OPEN');
    expect(cb.getStats().semanticFailureCount).toBe(2);
  });

  it('trips circuit when security events exceed threshold', () => {
    const cb = new CircuitBreaker(undefined, undefined, undefined, undefined, {
      securityThreshold: 2,
    });
    cb.onSecurityEvent('HIGH');
    cb.onSecurityEvent('HIGH');
    expect(cb.isAvailable()).toBe(false);
    expect(cb.getState()).toBe('OPEN');
    expect(cb.getStats().securityEventCount).toBe(2);
  });

  it('counts CRITICAL security events as double weight', () => {
    const cb = new CircuitBreaker(undefined, undefined, undefined, undefined, {
      securityThreshold: 3,
    });
    cb.onSecurityEvent('CRITICAL');
    cb.onSecurityEvent('CRITICAL');
    expect(cb.getStats().securityEventCount).toBe(4);
    expect(cb.isAvailable()).toBe(false);
  });

  it('ignores LOW/MEDIUM security events', () => {
    const cb = new CircuitBreaker();
    cb.onSecurityEvent('LOW');
    cb.onSecurityEvent('MEDIUM');
    expect(cb.getStats().securityEventCount).toBe(0);
    expect(cb.isAvailable()).toBe(true);
  });

  it('decays semantic/security counters on recovery', () => {
    const cb = new CircuitBreaker(1, 1000, 1, undefined, {
      semanticThreshold: 2,
      securityThreshold: 2,
    });
    cb.onSemanticDrift(0.8);
    cb.onSecurityEvent('HIGH');
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');

    vi.advanceTimersByTime(1000);
    cb.isAvailable();
    cb.onSuccess();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getStats().semanticFailureCount).toBe(0);
    expect(cb.getStats().securityEventCount).toBe(0);
  });

  it('decays semantic/security counters every 10 successes in CLOSED state', () => {
    const cb = new CircuitBreaker(undefined, undefined, undefined, undefined, {
      semanticThreshold: 5,
      securityThreshold: 5,
    });
    cb.onSemanticDrift(0.8);
    cb.onSecurityEvent('HIGH');
    for (let i = 0; i < 10; i++) cb.onSuccess();
    expect(cb.getStats().semanticFailureCount).toBe(0);
    expect(cb.getStats().securityEventCount).toBe(0);
  });
});

describe('CircuitBreaker — force open & release', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('force opens the circuit', () => {
    const cb = new CircuitBreaker();
    cb.open();
    expect(cb.getState()).toBe('OPEN');
    expect(cb.isAvailable()).toBe(false);
    expect(cb.getStats().openCount).toBe(1);
  });

  it('release decrements half-open in-flight count', () => {
    const cb = new CircuitBreaker(1, 1000, 2);
    cb.onFailure();
    vi.advanceTimersByTime(1000);
    cb.isAvailable();
    expect(cb.getState()).toBe('HALF_OPEN');

    cb.release();
    // release should allow another request to pass
    expect(cb.isAvailable()).toBe(true);
  });

  it('release is no-op when not HALF_OPEN', () => {
    const cb = new CircuitBreaker();
    cb.release();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.isAvailable()).toBe(true);
  });
});

describe('CircuitBreaker — Hystrix error-rate window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('trips based on volume and error rate thresholds', () => {
    const cb = new CircuitBreaker(3, 5000, 1, undefined, {
      volumeThreshold: 4,
      errorRateThreshold: 0.5,
    });
    // 3 failures out of 4 requests = 75% error rate
    cb.onFailure();
    cb.onSuccess();
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
  });

  it('does not trip when volume threshold is not met', () => {
    const cb = new CircuitBreaker(100, 5000, 1, undefined, {
      volumeThreshold: 10,
      errorRateThreshold: 0.5,
    });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('prunes old request timestamps outside recovery window', () => {
    const cb = new CircuitBreaker(100, 2000, 1, undefined, {
      volumeThreshold: 2,
      errorRateThreshold: 0.5,
    });
    cb.onFailure();
    vi.advanceTimersByTime(3000);
    cb.onSuccess();
    cb.onSuccess();
    // Old failure should be pruned; current window has only successes
    expect(cb.getState()).toBe('CLOSED');
  });
});
