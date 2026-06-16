export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  threshold: number;
  recoveryTimeMs: number;
  openCount: number;
  semanticFailureCount: number;
  securityEventCount: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private threshold: number;
  private recoveryTimeMs: number;
  private halfOpenMaxTests: number;
  private halfOpenTests = 0;
  private halfOpenInFlight = 0;
  private openCount = 0;
  private onStateChange?: (from: CircuitState, to: CircuitState) => void;
  private observability?: { onTransition?: (from: CircuitState, to: CircuitState, provider?: string) => void };
  private providerName?: string;
  /** Sliding window of failure timestamps for windowed failure counting */
  private failureTimestamps: number[] = [];
  /** Sliding window of all request timestamps for volume threshold (Hystrix pattern) */
  private requestTimestamps: number[] = [];
  /** Minimum requests in window before circuit can trip (Hystrix: circuitBreakerRequestVolumeThreshold) */
  private volumeThreshold: number;
  /** Error rate threshold (0-1) to trip circuit (Hystrix: circuitBreakerErrorThresholdPercentage) */
  private errorRateThreshold: number;
  // Semantic drift tracking (P1: semantic circuit breaker)
  private consecutiveSemanticFailures = 0;
  private semanticFailureThreshold = 3;
  private lastSemanticFailureTime = 0;
  private onSemanticTrip?: (consecutiveFailures: number, reason: string) => void;
  // Aggregated counters for semantic drift and security events
  private semanticFailureCount = 0;
  private securityEventCount = 0;
  private semanticThreshold: number;
  private securityThreshold: number;

  constructor(threshold = 5, recoveryTimeMs = 30000, halfOpenMaxTests = 1, onStateChange?: (from: CircuitState, to: CircuitState) => void, options?: { volumeThreshold?: number; errorRateThreshold?: number; semanticThreshold?: number; securityThreshold?: number }) {
    this.threshold = threshold;
    this.recoveryTimeMs = recoveryTimeMs;
    this.halfOpenMaxTests = halfOpenMaxTests;
    this.onStateChange = onStateChange;
    this.volumeThreshold = options?.volumeThreshold ?? 0;
    this.errorRateThreshold = options?.errorRateThreshold ?? 0.5;
    this.semanticThreshold = options?.semanticThreshold ?? 3;
    this.securityThreshold = options?.securityThreshold ?? 2;
  }

  setProviderName(name: string): void {
    this.providerName = name;
  }

  setObservability(obs: { onTransition?: (from: CircuitState, to: CircuitState, provider?: string) => void }): void {
    this.observability = obs;
  }

  getState(): CircuitState { return this.state; }

  getStats(): CircuitStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      threshold: this.threshold,
      recoveryTimeMs: this.recoveryTimeMs,
      openCount: this.openCount,
      semanticFailureCount: this.semanticFailureCount,
      securityEventCount: this.securityEventCount,
    };
  }

  isAvailable(): boolean {
    // Trip the circuit if semantic failures or security events exceed their thresholds,
    // even when conventional operational failures have not reached the volume/error rate gate.
    if (this.semanticFailureCount >= this.semanticThreshold || this.securityEventCount >= this.securityThreshold) {
      if (this.state !== 'OPEN') {
        this.transitionTo('OPEN');
        this.openCount++;
      }
      return false;
    }

    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.transitionTo('HALF_OPEN');
        this.halfOpenTests = 0;
        this.halfOpenInFlight = 1;
        return true;
      }
      return false;
    }
    if (this.halfOpenInFlight < this.halfOpenMaxTests) {
      this.halfOpenInFlight++;
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.successCount++;
    this.failureCount = 0;
    this.requestTimestamps.push(Date.now());
    if (this.state === 'HALF_OPEN') {
      this.halfOpenTests++;
      // Only close circuit after enough consecutive successes (multi-probe recovery)
      if (this.halfOpenTests >= this.halfOpenMaxTests) {
        this.transitionTo('CLOSED');
        this.halfOpenTests = 0;
        this.halfOpenInFlight = 0;
      }
    }
  }

  /** Decrement halfOpenInFlight without recording success/failure (for callers that throw before reporting). */
  release(): void {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
  }

  onFailure(): void {
    const now = Date.now();
    this.failureCount++;
    this.lastFailureTime = now;
    // Track failure in sliding window (prune entries older than recoveryTimeMs)
    this.failureTimestamps.push(now);
    this.requestTimestamps.push(now);
    const windowStart = now - this.recoveryTimeMs;
    this.failureTimestamps = this.failureTimestamps.filter(t => t > windowStart);
    this.requestTimestamps = this.requestTimestamps.filter(t => t > windowStart);
    if (this.state === 'HALF_OPEN') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
    // Hystrix pattern: trip when BOTH volume threshold AND error rate are met
    const windowedFailures = this.failureTimestamps.length;
    const windowedRequests = this.requestTimestamps.length;
    const volumeMet = windowedRequests >= this.volumeThreshold;
    const errorRate = windowedRequests > 0 ? windowedFailures / windowedRequests : 0;
    const errorRateMet = errorRate >= this.errorRateThreshold;
    if (this.state === 'HALF_OPEN' || (volumeMet && errorRateMet && windowedFailures >= this.threshold)) {
      if (this.state !== 'OPEN') {
        this.transitionTo('OPEN');
        this.openCount++;
      }
    }
  }

  /**
   * Record a semantic/quality failure (e.g., verification failed, hallucination detected).
   * Tracks consecutive failures as a proxy for semantic drift.
   * When threshold is reached, fires onSemanticTrip callback.
   * This is separate from operational failures (network errors, timeouts).
   */
  recordSemanticFailure(reason: string): void {
    this.consecutiveSemanticFailures++;
    this.lastSemanticFailureTime = Date.now();
    if (this.consecutiveSemanticFailures >= this.semanticFailureThreshold) {
      this.onSemanticTrip?.(this.consecutiveSemanticFailures, reason);
    }
  }

  /** Reset semantic failure counter after a successful recovery. */
  recordSemanticSuccess(): void {
    this.consecutiveSemanticFailures = 0;
  }

  /** Get current semantic health status. */
  getSemanticHealth(): { consecutiveFailures: number; tripped: boolean; lastFailureTime: number } {
    return {
      consecutiveFailures: this.consecutiveSemanticFailures,
      tripped: this.consecutiveSemanticFailures >= this.semanticFailureThreshold,
      lastFailureTime: this.lastSemanticFailureTime,
    };
  }

  /** Set callback for semantic trip events. */
  setSemanticTripHandler(handler: (consecutiveFailures: number, reason: string) => void): void {
    this.onSemanticTrip = handler;
  }

  /**
   * Record a semantic drift event with a severity score (0-1).
   * Increments the aggregated semantic failure counter; when the configured
   * threshold is reached, subsequent isAvailable() calls will keep the circuit open.
   */
  onSemanticDrift(score: number): void {
    if (score > 0) {
      this.semanticFailureCount++;
      this.lastSemanticFailureTime = Date.now();
    }
  }

  /**
   * Record a security event (e.g., HIGH/CRITICAL content threat detected).
   * Critical events count for 2, others for 1. When the security threshold is
   * reached, the circuit stays open until reset.
   */
  onSecurityEvent(severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): void {
    const weight = severity === 'CRITICAL' ? 2 : severity === 'HIGH' ? 1 : 0;
    if (weight > 0) {
      this.securityEventCount += weight;
      this.lastSemanticFailureTime = Date.now();
    }
  }

  reset(): void {
    const was = this.state;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenTests = 0;
    this.halfOpenInFlight = 0;
    this.failureTimestamps = [];
    this.requestTimestamps = [];
    this.consecutiveSemanticFailures = 0;
    this.semanticFailureCount = 0;
    this.securityEventCount = 0;
    if (was !== 'CLOSED') this.onStateChange?.(was, 'CLOSED');
  }

  private transitionTo(newState: CircuitState): void {
    const old = this.state;
    if (old !== newState) {
      this.state = newState;
      this.onStateChange?.(old, newState);
      try { this.observability?.onTransition?.(old, newState, this.providerName); } catch { /* best-effort */ }
    }
  }
}
