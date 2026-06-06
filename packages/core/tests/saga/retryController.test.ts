import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RetryController, RetryControllerError, mergeRetryPolicy } from '../../src/saga/retryController';
import type { RetryPolicy } from '../../src/saga/types';

const expPolicy: RetryPolicy = {
  maxAttempts: 5,
  backoff: 'exponential',
  initialDelayMs: 100,
  maxDelayMs: 10000,
  jitter: 'none',
};

describe('RetryController', () => {
  it('throws on invalid policy', () => {
    assert.throws(() => new RetryController({ ...expPolicy, maxAttempts: 0 }), RetryControllerError);
    assert.throws(() => new RetryController({ ...expPolicy, initialDelayMs: -1 }), RetryControllerError);
    assert.throws(
      () => new RetryController({ ...expPolicy, initialDelayMs: 100, maxDelayMs: 50 }),
      RetryControllerError
    );
  });

  it('computes exponential backoff without jitter', () => {
    const rc = new RetryController(expPolicy);
    assert.strictEqual(rc.computeDelay(1), 100);
    assert.strictEqual(rc.computeDelay(2), 200);
    assert.strictEqual(rc.computeDelay(3), 400);
    assert.strictEqual(rc.computeDelay(4), 800);
  });

  it('caps at maxDelayMs', () => {
    const rc = new RetryController(expPolicy);
    assert.strictEqual(rc.computeDelay(20), 10000);
  });

  it('computes fixed backoff', () => {
    const rc = new RetryController({ ...expPolicy, backoff: 'fixed' });
    assert.strictEqual(rc.computeDelay(1), 100);
    assert.strictEqual(rc.computeDelay(5), 100);
  });

  it('computes linear backoff', () => {
    const rc = new RetryController({ ...expPolicy, backoff: 'linear' });
    assert.strictEqual(rc.computeDelay(1), 100);
    assert.strictEqual(rc.computeDelay(5), 500);
  });

  it('applies none jitter (returns exact delay)', () => {
    const rc = new RetryController({ ...expPolicy, jitter: 'none' });
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(rc.computeDelay(3), 400);
    }
  });

  it('applies full jitter (returns 0 to delay)', () => {
    const rc = new RetryController({ ...expPolicy, jitter: 'full' });
    for (let i = 0; i < 50; i++) {
      const d = rc.computeDelay(3);
      assert.ok(d >= 0 && d <= 400, `delay ${d} out of range`);
    }
  });

  it('applies equal jitter (returns delay/2 to delay)', () => {
    const rc = new RetryController({ ...expPolicy, jitter: 'equal' });
    for (let i = 0; i < 50; i++) {
      const d = rc.computeDelay(3);
      assert.ok(d >= 200 && d <= 400, `delay ${d} out of equal-jitter range`);
    }
  });

  it('returns 0 delay for attempt < 1', () => {
    const rc = new RetryController(expPolicy);
    assert.strictEqual(rc.computeDelay(0), 0);
    assert.strictEqual(rc.computeDelay(-1), 0);
  });

  it('retries by default for all errors', () => {
    const rc = new RetryController(expPolicy);
    assert.strictEqual(rc.shouldRetry(new Error('any'), 1), true);
    assert.strictEqual(rc.shouldRetry(new Error('any'), 4), true);
  });

  it('does not retry when maxAttempts reached', () => {
    const rc = new RetryController(expPolicy);
    assert.strictEqual(rc.shouldRetry(new Error('any'), 5), false);
    assert.strictEqual(rc.shouldRetry(new Error('any'), 10), false);
  });

  it('uses retryOn predicate to decide', () => {
    const policy: RetryPolicy = {
      ...expPolicy,
      retryOn: (err) => err.message.includes('transient'),
    };
    const rc = new RetryController(policy);
    assert.strictEqual(rc.shouldRetry(new Error('transient failure'), 1), true);
    assert.strictEqual(rc.shouldRetry(new Error('permanent failure'), 1), false);
  });

  it('opens circuit after N consecutive failures', () => {
    const policy: RetryPolicy = { ...expPolicy, circuitBreakerAfter: 3 };
    const rc = new RetryController(policy);
    assert.strictEqual(rc.isCircuitOpen(), false);
    rc.recordFailure();
    rc.recordFailure();
    assert.strictEqual(rc.isCircuitOpen(), false);
    rc.recordFailure();
    assert.strictEqual(rc.isCircuitOpen(), true);
    assert.strictEqual(rc.shouldRetry(new Error('any'), 1), false);
  });

  it('resets failure count on success', () => {
    const policy: RetryPolicy = { ...expPolicy, circuitBreakerAfter: 3 };
    const rc = new RetryController(policy);
    rc.recordFailure();
    rc.recordFailure();
    rc.recordSuccess();
    assert.strictEqual(rc.consecutiveFailureCount, 0);
    rc.recordFailure();
    assert.strictEqual(rc.isCircuitOpen(), false);
  });

  it('manually resets circuit', () => {
    const policy: RetryPolicy = { ...expPolicy, circuitBreakerAfter: 1 };
    const rc = new RetryController(policy);
    rc.recordFailure();
    assert.strictEqual(rc.isCircuitOpen(), true);
    rc.resetCircuit();
    assert.strictEqual(rc.isCircuitOpen(), false);
    assert.strictEqual(rc.consecutiveFailureCount, 0);
  });
});

describe('mergeRetryPolicy', () => {
  it('uses override values when present', () => {
    const base: RetryPolicy = { ...expPolicy };
    const override: Partial<RetryPolicy> = { maxAttempts: 10, backoff: 'fixed' };
    const merged = mergeRetryPolicy(base, override);
    assert.strictEqual(merged.maxAttempts, 10);
    assert.strictEqual(merged.backoff, 'fixed');
    assert.strictEqual(merged.initialDelayMs, base.initialDelayMs);
  });

  it('uses base values when override is empty', () => {
    const base: RetryPolicy = { ...expPolicy };
    const merged = mergeRetryPolicy(base, {});
    assert.strictEqual(merged.maxAttempts, base.maxAttempts);
    assert.strictEqual(merged.backoff, base.backoff);
    assert.strictEqual(merged.initialDelayMs, base.initialDelayMs);
    assert.strictEqual(merged.maxDelayMs, base.maxDelayMs);
    assert.strictEqual(merged.jitter, base.jitter);
  });
});
