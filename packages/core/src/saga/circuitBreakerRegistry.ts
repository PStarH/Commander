/**
 * Global Circuit Breaker Registry.
 *
 * Aggregates circuit breaker state by SERVICE BOUNDARY (e.g. "stripe",
 * "github", "slack"), NOT by individual Saga node id.  This ensures
 * that when Stripe API is down, ALL concurrent Saga instances see the
 * open breaker and fail fast — instead of each creating its own
 * transient breaker and collectively hammering the downstream.
 *
 * Architecture:
 *   Registry (singleton)
 *     └── Map<breakerKey, RetryController>
 *           └── 3-state (CLOSED / OPEN / HALF-OPEN via RetryController)
 *           └── persisted optionally via CircuitBreakerStore
 *
 * Breaker key resolution:
 *   toolName = "stripe_charge_create"  →  key = "stripe"
 *   toolName = "github_pr_merge"       →  key = "github"
 *   toolName = "slack_chat_postMessage" →  key = "slack"
 *
 * This is intentionally coarser than per-tool (one breaker per service
 * boundary) because if Stripe is degraded, ALL Stripe operations are
 * affected — not just one specific endpoint.
 */

import { RetryController } from './retryController';
import type { RetryPolicy } from './types';

export const DEFAULT_BREAKER_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoff: 'exponential',
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  jitter: 'equal',
  circuitBreakerAfter: 5,
};

export class CircuitBreakerRegistry {
  private static instance: CircuitBreakerRegistry;
  private readonly breakers = new Map<string, RetryController>();
  private readonly policies = new Map<string, RetryPolicy>();

  static getInstance(): CircuitBreakerRegistry {
    if (!CircuitBreakerRegistry.instance) {
      CircuitBreakerRegistry.instance = new CircuitBreakerRegistry();
    }
    return CircuitBreakerRegistry.instance;
  }

  /**
   * Derive a breaker key from a tool name (first segment before '_').
   * Examples:
   *   "stripe_charge_create" → "stripe"
   *   "github_pr_merge"      → "github"
   *   "file_write"           → "file"
   */
  static resolveBreakerKey(toolName: string): string {
    const idx = toolName.indexOf('_');
    return idx > 0 ? toolName.slice(0, idx) : toolName;
  }

  /**
   * Register a per-key policy.  Call once at startup or when configuring
   * a tool plugin.  If not set, `DEFAULT_BREAKER_POLICY` is used.
   */
  setPolicy(key: string, policy: RetryPolicy): void {
    this.policies.set(key, policy);
  }

  /**
   * Get or create a RetryController for the given breaker key.
   * Returns the SAME instance for the same key across all callers,
   * guaranteeing cross-Saga-instance circuit breaker state.
   */
  getOrCreate(key: string): RetryController {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      const policy = this.policies.get(key) ?? DEFAULT_BREAKER_POLICY;
      breaker = new RetryController(policy);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  /** Convenience: resolve key + get/create in one call. */
  breakerFor(toolName: string): RetryController {
    return this.getOrCreate(CircuitBreakerRegistry.resolveBreakerKey(toolName));
  }

  /** Reset a single breaker (e.g. after half-open success). */
  resetBreaker(key: string): void {
    this.breakers.delete(key);
  }

  /** Reset ALL breakers (e.g. on system recovery). */
  resetAll(): void {
    this.breakers.clear();
  }

  /** Snapshot of all breaker states (for health checks). */
  snapshot(): Array<{ key: string; open: boolean; failures: number }> {
    const entries: Array<{ key: string; open: boolean; failures: number }> = [];
    for (const [key, breaker] of this.breakers) {
      entries.push({
        key,
        open: breaker.isCircuitOpen(),
        failures: breaker.consecutiveFailureCount,
      });
    }
    return entries;
  }

  /** Testing hook: replace the singleton. */
  static resetInstance(): void {
    CircuitBreakerRegistry.instance = new CircuitBreakerRegistry();
  }
}
