/**
 * Circuit Breaker Registry — Named circuit breaker management for per-tool/per-provider fault isolation.
 *
 * Wraps individual CircuitBreaker instances with a registry that provides
 * named access, lazy initialization, aggregated stats, and bulk reset.
 * Each tool or provider gets its own breaker so a failure in one doesn't
 * cascade to others.
 *
 * Used by ToolOrchestrator and AgentRuntime to track per-call reliability.
 */
import { CircuitBreaker, type CircuitState, type CircuitStats } from './circuitBreaker';
import { getGlobalLogger } from '../logging';

export interface BreakerConfig {
  threshold: number;
  recoveryTimeMs: number;
  halfOpenMaxTests: number;
}

const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  threshold: 5,
  recoveryTimeMs: 60000,
  halfOpenMaxTests: 1,
};

export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private configs = new Map<string, BreakerConfig>();

  register(name: string, config?: Partial<BreakerConfig>): CircuitBreaker {
    if (this.breakers.has(name)) {
      return this.breakers.get(name)!;
    }
    const merged: BreakerConfig = { ...DEFAULT_BREAKER_CONFIG, ...config };
    this.configs.set(name, merged);
    const breaker = new CircuitBreaker(
      merged.threshold,
      merged.recoveryTimeMs,
      merged.halfOpenMaxTests,
      (from, to) => {
        if (to === 'OPEN') {
          getGlobalLogger().warn('CircuitBreakerRegistry', `"${name}" opened (${from}→OPEN, ${this.getStats(name).failureCount} failures)`);
        }
        if (to === 'CLOSED') {
          getGlobalLogger().info('CircuitBreakerRegistry', `"${name}" closed (${from}→CLOSED)`);
        }
      },
    );
    this.breakers.set(name, breaker);
    return breaker;
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  isAvailable(name: string): boolean {
    return this.breakers.get(name)?.isAvailable() ?? true;
  }

  onSuccess(name: string): void {
    this.breakers.get(name)?.onSuccess();
  }

  onFailure(name: string): void {
    this.breakers.get(name)?.onFailure();
  }

  getStats(name: string): CircuitStats {
    const breaker = this.breakers.get(name);
    if (!breaker) {
      return { state: 'CLOSED', failureCount: 0, successCount: 0, lastFailureTime: 0, threshold: 0, recoveryTimeMs: 0, openCount: 0 };
    }
    return breaker.getStats();
  }

  getOpenBreakers(): string[] {
    const open: string[] = [];
    for (const [name, breaker] of this.breakers) {
      if (breaker.getState() === 'OPEN') open.push(name);
    }
    return open;
  }

  reset(name: string): void {
    this.breakers.get(name)?.reset();
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  listBreakers(): string[] {
    return Array.from(this.breakers.keys());
  }
}
