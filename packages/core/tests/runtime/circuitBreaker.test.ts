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
