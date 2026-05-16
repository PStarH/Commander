type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private threshold: number;
  private recoveryTimeMs: number;
  private halfOpenMaxTests: number;
  private halfOpenTests = 0;

  constructor(threshold = 5, recoveryTimeMs = 30000, halfOpenMaxTests = 1) {
    this.threshold = threshold;
    this.recoveryTimeMs = recoveryTimeMs;
    this.halfOpenMaxTests = halfOpenMaxTests;
  }

  getState(): CircuitState { return this.state; }

  isAvailable(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenTests = 0;
        return true;
      }
      return false;
    }
    // HALF_OPEN: allow limited tests
    if (this.halfOpenTests < this.halfOpenMaxTests) {
      this.halfOpenTests++;
      return true;
    }
    return false;
  }

  onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.failureCount = 0;
      this.halfOpenTests = 0;
    }
  }

  onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenTests = 0;
  }
}
