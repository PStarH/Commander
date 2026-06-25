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
import { CircuitBreaker, type CircuitStats } from './circuitBreaker';
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
  private lastAccess = new Map<string, number>();
  private readonly MAX_IDLE_MS = (() => {
    // Override `COMMANDER_MAX_IDLE_MS` (ms) to lengthen/shorten the idle-prune interval.
    // Default is 30 minutes; non-finite, non-positive, or zero values fall back to the default
    // (a zero/negative interval would create a tight busy loop via setInterval).
    const parsed = Number(process.env['COMMANDER_MAX_IDLE_MS']);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
  })();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.pruneTimer = setInterval(() => this.pruneIdle(), this.MAX_IDLE_MS);
    if (this.pruneTimer?.unref) this.pruneTimer.unref();
  }

  private pruneIdle(): void {
    const now = Date.now();
    for (const [name, breaker] of this.breakers) {
      const last = this.lastAccess.get(name) ?? 0;
      if (breaker.getState() === 'CLOSED' && now - last > this.MAX_IDLE_MS) {
        this.breakers.delete(name);
        this.configs.delete(name);
        this.lastAccess.delete(name);
      }
    }
  }

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
          getGlobalLogger().warn(
            'CircuitBreakerRegistry',
            `"${name}" opened (${from}→OPEN, ${this.getStats(name).failureCount} failures)`,
          );
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
    const breaker = this.breakers.get(name);
    if (breaker) this.lastAccess.set(name, Date.now());
    return breaker;
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

  /**
   * Force a breaker into the OPEN state. Used when a tool has permanently
   * failed after retries and we want to isolate it immediately, rather than
   * waiting for the LLM to fail the same tool N more times.
   */
  forceOpen(name: string): void {
    const breaker = this.breakers.get(name);
    if (breaker && breaker.getState() !== 'OPEN') {
      breaker.open();
    }
  }

  getStats(name: string): CircuitStats {
    const breaker = this.breakers.get(name);
    if (!breaker) {
      return {
        state: 'CLOSED',
        failureCount: 0,
        successCount: 0,
        lastFailureTime: 0,
        threshold: 0,
        recoveryTimeMs: 0,
        openCount: 0,
        semanticFailureCount: 0,
        securityEventCount: 0,
      };
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

  /** Remove a breaker from the registry */
  deregister(name: string): boolean {
    this.configs.delete(name);
    return this.breakers.delete(name);
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  listBreakers(): string[] {
    return Array.from(this.breakers.keys());
  }

  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}
