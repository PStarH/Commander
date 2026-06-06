import type { RetryPolicy } from './types';

export class RetryController {
  private consecutiveFailures = 0;
  private circuitOpen = false;

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
    if (
      this.policy.circuitBreakerAfter !== undefined &&
      this.consecutiveFailures >= this.policy.circuitBreakerAfter
    ) {
      this.circuitOpen = true;
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  resetCircuit(): void {
    this.circuitOpen = false;
    this.consecutiveFailures = 0;
  }

  isCircuitOpen(): boolean {
    return this.circuitOpen;
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

export function createRetryController(
  policy: RetryPolicy
): RetryController {
  return new RetryController(policy);
}

export function mergeRetryPolicy(
  base: RetryPolicy,
  override: Partial<RetryPolicy>
): RetryPolicy {
  return {
    maxAttempts: override.maxAttempts ?? base.maxAttempts,
    backoff: override.backoff ?? base.backoff,
    initialDelayMs: override.initialDelayMs ?? base.initialDelayMs,
    maxDelayMs: override.maxDelayMs ?? base.maxDelayMs,
    jitter: override.jitter ?? base.jitter,
    retryOn: override.retryOn ?? base.retryOn,
    circuitBreakerAfter:
      override.circuitBreakerAfter ?? base.circuitBreakerAfter,
  };
}
