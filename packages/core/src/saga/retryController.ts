import type { RetryPolicy } from './types';

/**
 * Cooldown before a tripped circuit breaker transitions to the half-open
 * state. Once this elapses, the next request is allowed through as a probe:
 *   - probe success  → circuit fully closes
 *   - probe failure  → circuit re-opens and the cooldown restarts
 */
const CIRCUIT_RECOVERY_COOLDOWN_MS = 60_000;

export class RetryController {
  private consecutiveFailures = 0;
  private circuitOpen = false;
  /**
   * Half-open flag: the circuit has cooled down and a single probe request
   * has been allowed through. While true, isCircuitOpen() reports false so
   * the probe can execute; the probe's outcome (recordSuccess/recordFailure)
   * resolves the state back to closed or open.
   */
  private halfOpen = false;
  /** Epoch ms when the circuit was last opened. null when closed/half-open. */
  private circuitOpenedAt: number | null = null;

  constructor(private readonly policy: RetryPolicy) {
    if (policy.maxAttempts < 1) {
      throw new RetryControllerError('maxAttempts must be >= 1');
    }
    if (policy.initialDelayMs < 0 || policy.maxDelayMs < 0) {
      throw new RetryControllerError('delay values must be non-negative');
    }
    if (policy.initialDelayMs > policy.maxDelayMs) {
      throw new RetryControllerError('initialDelayMs must be <= maxDelayMs');
    }
  }

  get policy_(): RetryPolicy {
    return this.policy;
  }

  computeDelay(attempt: number): number {
    if (attempt < 1) return 0;
    const base = this.baseDelay(attempt);
    const capped = Math.min(base, this.policy.maxDelayMs);
    return this.applyJitter(capped);
  }

  shouldRetry(err: Error, attempt: number): boolean {
    if (this.circuitOpen) return false;
    if (attempt >= this.policy.maxAttempts) return false;
    if (this.policy.retryOn) return this.policy.retryOn(err);
    return true;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    // A failed half-open probe re-opens the circuit immediately and
    // restarts the cooldown timer.
    if (this.halfOpen) {
      this.circuitOpen = true;
      this.halfOpen = false;
      this.circuitOpenedAt = Date.now();
      return;
    }
    if (
      this.policy.circuitBreakerAfter !== undefined &&
      this.consecutiveFailures >= this.policy.circuitBreakerAfter
    ) {
      this.circuitOpen = true;
      this.halfOpen = false;
      this.circuitOpenedAt = Date.now();
    }
  }

  recordSuccess(): void {
    // A successful half-open probe fully closes the circuit.
    this.consecutiveFailures = 0;
    this.halfOpen = false;
  }

  resetCircuit(): void {
    this.circuitOpen = false;
    this.halfOpen = false;
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = null;
  }

  isCircuitOpen(): boolean {
    if (!this.circuitOpen) return false;
    // A half-open probe is already in flight — let it through.
    if (this.halfOpen) return false;
    // Cooldown elapsed → transition to half-open and allow the next request
    // to act as a probe. If the probe succeeds the circuit closes; if it
    // fails, recordFailure() re-opens it.
    if (
      this.circuitOpenedAt !== null &&
      Date.now() - this.circuitOpenedAt >= CIRCUIT_RECOVERY_COOLDOWN_MS
    ) {
      this.circuitOpen = false;
      this.halfOpen = true;
      return false;
    }
    return true;
  }

  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  private baseDelay(attempt: number): number {
    switch (this.policy.backoff) {
      case 'fixed':
        return this.policy.initialDelayMs;
      case 'linear':
        return this.policy.initialDelayMs * attempt;
      case 'exponential':
        return this.policy.initialDelayMs * Math.pow(2, attempt - 1);
    }
  }

  private applyJitter(delay: number): number {
    switch (this.policy.jitter) {
      case 'none':
        return delay;
      case 'full':
        return Math.floor(Math.random() * delay);
      case 'equal':
        return Math.floor(delay / 2 + Math.random() * (delay / 2));
    }
  }
}

export class RetryControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryControllerError';
  }
}

export function createRetryController(policy: RetryPolicy): RetryController {
  return new RetryController(policy);
}

export function mergeRetryPolicy(base: RetryPolicy, override: Partial<RetryPolicy>): RetryPolicy {
  return {
    maxAttempts: override.maxAttempts ?? base.maxAttempts,
    backoff: override.backoff ?? base.backoff,
    initialDelayMs: override.initialDelayMs ?? base.initialDelayMs,
    maxDelayMs: override.maxDelayMs ?? base.maxDelayMs,
    jitter: override.jitter ?? base.jitter,
    retryOn: override.retryOn ?? base.retryOn,
    circuitBreakerAfter: override.circuitBreakerAfter ?? base.circuitBreakerAfter,
  };
}
