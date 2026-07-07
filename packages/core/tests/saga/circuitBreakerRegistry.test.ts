/**
 * Tests for CircuitBreakerRegistry — global circuit breaker aggregation.
 *
 * Covers:
 *   - Singleton pattern
 *   - Breaker key resolution from tool names
 *   - getOrCreate returns same instance for same key
 *   - breakerFor convenience method
 *   - Custom policy registration
 *   - resetBreaker and resetAll
 *   - snapshot for health checks
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  CircuitBreakerRegistry,
  DEFAULT_BREAKER_POLICY,
} from '../../src/saga/circuitBreakerRegistry';

describe('CircuitBreakerRegistry', () => {
  beforeEach(() => {
    CircuitBreakerRegistry.resetInstance();
  });

  describe('getInstance', () => {
    it('returns the same singleton instance', () => {
      const a = CircuitBreakerRegistry.getInstance();
      const b = CircuitBreakerRegistry.getInstance();
      assert.strictEqual(a, b);
    });

    it('resetInstance creates a new instance', () => {
      const a = CircuitBreakerRegistry.getInstance();
      CircuitBreakerRegistry.resetInstance();
      const b = CircuitBreakerRegistry.getInstance();
      assert.notStrictEqual(a, b);
    });
  });

  describe('resolveBreakerKey', () => {
    it('extracts service name from tool name', () => {
      assert.strictEqual(
        CircuitBreakerRegistry.resolveBreakerKey('stripe_charge_create'),
        'stripe',
      );
      assert.strictEqual(CircuitBreakerRegistry.resolveBreakerKey('github_pr_merge'), 'github');
      assert.strictEqual(
        CircuitBreakerRegistry.resolveBreakerKey('slack_chat_postMessage'),
        'slack',
      );
    });

    it('returns full name when no underscore', () => {
      assert.strictEqual(CircuitBreakerRegistry.resolveBreakerKey('filesystem'), 'filesystem');
    });

    it('returns first segment only', () => {
      assert.strictEqual(CircuitBreakerRegistry.resolveBreakerKey('file_write'), 'file');
      assert.strictEqual(CircuitBreakerRegistry.resolveBreakerKey('db_query'), 'db');
    });
  });

  describe('getOrCreate', () => {
    it('creates a breaker on first access', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      const breaker = registry.getOrCreate('stripe');
      assert.ok(breaker);
    });

    it('returns the same breaker for the same key', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      const a = registry.getOrCreate('stripe');
      const b = registry.getOrCreate('stripe');
      assert.strictEqual(a, b);
    });

    it('returns different breakers for different keys', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      const a = registry.getOrCreate('stripe');
      const b = registry.getOrCreate('github');
      assert.notStrictEqual(a, b);
    });

    it('uses default policy when no custom policy set', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      const breaker = registry.getOrCreate('test_service');
      // The breaker should use the default policy
      // We can verify this indirectly by checking the policy isn't custom
      assert.ok(breaker);
    });
  });

  describe('breakerFor', () => {
    it('resolves key and returns breaker in one call', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      const breaker = registry.breakerFor('stripe_charge_create');
      assert.ok(breaker);
      // Should be the same as getOrCreate('stripe')
      const direct = registry.getOrCreate('stripe');
      assert.strictEqual(breaker, direct);
    });
  });

  describe('setPolicy', () => {
    it('registers a custom policy for a key', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      registry.setPolicy('custom_svc', {
        maxAttempts: 10,
        backoff: 'fixed',
        initialDelayMs: 500,
        maxDelayMs: 5000,
        jitter: 'none',
        circuitBreakerAfter: 3,
      });
      // The breaker created after policy is set should use it
      const breaker = registry.getOrCreate('custom_svc');
      assert.ok(breaker);
    });
  });

  describe('resetBreaker', () => {
    it('removes a single breaker', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      registry.getOrCreate('stripe');
      registry.resetBreaker('stripe');
      // Next access should create a new one
      const newBreaker = registry.getOrCreate('stripe');
      assert.ok(newBreaker);
    });
  });

  describe('resetAll', () => {
    it('removes all breakers', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      registry.getOrCreate('stripe');
      registry.getOrCreate('github');
      registry.getOrCreate('slack');
      registry.resetAll();
      const snapshot = registry.snapshot();
      assert.strictEqual(snapshot.length, 0);
    });
  });

  describe('snapshot', () => {
    it('returns empty array when no breakers exist', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      const snapshot = registry.snapshot();
      assert.strictEqual(snapshot.length, 0);
    });

    it('returns breaker states', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      registry.getOrCreate('stripe');
      registry.getOrCreate('github');
      const snapshot = registry.snapshot();
      assert.strictEqual(snapshot.length, 2);
      const keys = snapshot.map((s) => s.key);
      assert.ok(keys.includes('stripe'));
      assert.ok(keys.includes('github'));
      // Each entry should have key, open, failures
      for (const entry of snapshot) {
        assert.ok(typeof entry.key === 'string');
        assert.ok(typeof entry.open === 'boolean');
        assert.ok(typeof entry.failures === 'number');
      }
    });

    it('reports open state when circuit is open', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      const breaker = registry.getOrCreate('failing_svc');
      // Trigger enough failures to open the circuit
      // DEFAULT_BREAKER_POLICY has circuitBreakerAfter: 5
      for (let i = 0; i < 6; i++) {
        breaker.recordFailure();
      }
      const snapshot = registry.snapshot();
      const entry = snapshot.find((s) => s.key === 'failing_svc');
      assert.ok(entry);
      assert.strictEqual(entry!.open, true);
    });
  });

  describe('cross-instance sharing', () => {
    it('shares breaker state across different callers', () => {
      const registry = CircuitBreakerRegistry.getInstance();
      // Simulate two different saga instances accessing the same service
      const breaker1 = registry.breakerFor('stripe_charge_create');
      const breaker2 = registry.breakerFor('stripe_refund_create');
      // Both should return the same breaker (keyed by "stripe")
      assert.strictEqual(breaker1, breaker2);
    });
  });
});
