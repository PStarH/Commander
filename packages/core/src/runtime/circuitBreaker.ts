export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  threshold: number;
  recoveryTimeMs: number;
  openCount: number;
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

  constructor(threshold = 5, recoveryTimeMs = 30000, halfOpenMaxTests = 1, onStateChange?: (from: CircuitState, to: CircuitState) => void) {
    this.threshold = threshold;
    this.recoveryTimeMs = recoveryTimeMs;
    this.halfOpenMaxTests = halfOpenMaxTests;
    this.onStateChange = onStateChange;
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
    };
  }

  isAvailable(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.transitionTo('HALF_OPEN');
        this.halfOpenTests = 0;
        this.halfOpenInFlight = 0;
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
    if (this.state === 'HALF_OPEN') {
      this.transitionTo('CLOSED');
      this.halfOpenTests = 0;
      this.halfOpenInFlight = 0;
    }
  }

  onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === 'HALF_OPEN') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
    if (this.state === 'HALF_OPEN' || this.failureCount >= this.threshold) {
      if (this.state !== 'OPEN') {
        this.transitionTo('OPEN');
        this.openCount++;
      }
    }
  }

  reset(): void {
    const was = this.state;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenTests = 0;
    this.halfOpenInFlight = 0;
    if (was !== 'CLOSED') this.onStateChange?.(was, 'CLOSED');
  }

  private transitionTo(newState: CircuitState): void {
    const old = this.state;
    if (old !== newState) {
      this.state = newState;
      this.onStateChange?.(old, newState);
    }
  }
}
