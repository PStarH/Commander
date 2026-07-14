import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BackpressureController,
  getGlobalBackpressureController,
  setGlobalBackpressureController,
} from '../../src/runtime/backpressureController';

vi.mock('../../src/logging', () => ({
  getGlobalLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe('BackpressureController', () => {
  beforeEach(() => {
    setGlobalBackpressureController(null);
  });

  describe('singleton', () => {
    it('returns the same global instance', () => {
      const a = getGlobalBackpressureController();
      const b = getGlobalBackpressureController();
      expect(a).toBe(b);
    });

    it('allows replacing the global instance', () => {
      const custom = new BackpressureController();
      setGlobalBackpressureController(custom);
      expect(getGlobalBackpressureController()).toBe(custom);
    });
  });

  describe('constructor', () => {
    it('applies default configuration', () => {
      const c = new BackpressureController();
      const metrics = c.getMetrics();
      expect(metrics.availableTokens).toBeGreaterThanOrEqual(0);
      expect(metrics.bufferOccupancy).toBe(0);
      expect(metrics.circuitBreakerState).toBe('CLOSED');
    });

    it('throws on invalid maxTokens', () => {
      expect(() => new BackpressureController({ maxTokens: -1 })).toThrow(/TokenBucket: maxTokens/);
    });

    it('throws on invalid refill rate', () => {
      expect(() => new BackpressureController({ refillRatePerSecond: 0 })).toThrow(
        /TokenBucket: refillRatePerSecond/,
      );
    });

    it('throws on invalid buffer size', () => {
      expect(() => new BackpressureController({ bufferSize: -1 })).toThrow(/RingBuffer: capacity/);
    });
  });

  describe('token bucket', () => {
    it('admits requests while tokens are available', async () => {
      const c = new BackpressureController({
        maxTokens: 2,
        refillRatePerSecond: 1000,
        bufferSize: 1,
      });
      expect(await c.acquire()).toBe(true);
      expect(await c.acquire()).toBe(true);
    });

    it('refills tokens over time', async () => {
      vi.useFakeTimers();
      const c = new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 1,
        bufferSize: 1,
      });
      expect(await c.acquire()).toBe(true);
      expect((c as any).bucket.availableTokens).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect((c as any).bucket.availableTokens).toBe(1);
      vi.useRealTimers();
    });

    it('updates the consumer rate', () => {
      const c = new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 1,
      });
      c.setConsumerRate(100);
      expect((c as any).bucket.refillRatePerMs).toBe(0.1);
    });
  });

  describe('waiter queue', () => {
    it('resolves queued waiters when a token is released', async () => {
      const c = new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 1,
        bufferSize: 2,
        maxWaitMs: 5000,
      });
      expect(await c.acquire()).toBe(true);
      const pending = c.acquire();
      c.release();
      expect(await pending).toBe(true);
    });

    it('times out waiters that are not served', async () => {
      vi.useFakeTimers();
      const c = new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 1,
        bufferSize: 2,
        maxWaitMs: 100,
      });
      expect(await c.acquire()).toBe(true);
      const pending = c.acquire();
      await vi.advanceTimersByTimeAsync(150);
      expect(await pending).toBe(false);
      vi.useRealTimers();
    });

    it('drops requests when the waiter queue is full', async () => {
      const c = new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 1,
        bufferSize: 1,
        maxWaitMs: 5000,
      });
      expect(await c.acquire()).toBe(true);
      c.acquire();
      expect(await c.acquire()).toBe(false);
      expect(c.getMetrics().totalSpilled).toBeGreaterThan(0);
    });
  });

  describe('circuit breaker', () => {
    it('opens after reaching the failure threshold', async () => {
      const c = new BackpressureController({
        maxTokens: 2,
        refillRatePerSecond: 1000,
        bufferSize: 1,
        failureThreshold: 1,
        cooldownMs: 5000,
      });
      expect(await c.acquire()).toBe(true);
      c.recordFailure();
      expect(c.getMetrics().circuitBreakerState).toBe('OPEN');
      expect(await c.acquire()).toBe(false);
      expect(c.getMetrics().totalDropped).toBeGreaterThan(0);
    });

    it('transitions to half-open after cooldown', async () => {
      vi.useFakeTimers();
      const c = new BackpressureController({
        maxTokens: 2,
        refillRatePerSecond: 1000,
        bufferSize: 1,
        failureThreshold: 1,
        cooldownMs: 100,
      });
      expect(await c.acquire()).toBe(true);
      c.recordFailure();
      await vi.advanceTimersByTimeAsync(100);
      expect(await c.acquire()).toBe(true);
      expect(c.getMetrics().circuitBreakerState).toBe('HALF_OPEN');
      vi.useRealTimers();
    });

    it('closes from half-open on release', async () => {
      vi.useFakeTimers();
      const c = new BackpressureController({
        maxTokens: 2,
        refillRatePerSecond: 1000,
        bufferSize: 1,
        failureThreshold: 1,
        cooldownMs: 100,
      });
      expect(await c.acquire()).toBe(true);
      c.recordFailure();
      await vi.advanceTimersByTimeAsync(100);
      expect(await c.acquire()).toBe(true);
      c.release();
      expect(c.getMetrics().circuitBreakerState).toBe('CLOSED');
      vi.useRealTimers();
    });

    it('reopens from half-open on another failure', async () => {
      vi.useFakeTimers();
      const c = new BackpressureController({
        maxTokens: 2,
        refillRatePerSecond: 1000,
        bufferSize: 1,
        failureThreshold: 1,
        cooldownMs: 100,
      });
      expect(await c.acquire()).toBe(true);
      c.recordFailure();
      await vi.advanceTimersByTimeAsync(100);
      expect(await c.acquire()).toBe(true);
      c.recordFailure();
      expect(c.getMetrics().circuitBreakerState).toBe('OPEN');
      vi.useRealTimers();
    });

    it('rejects waiters when the breaker opens during drain', async () => {
      const c = new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 1,
        bufferSize: 2,
        failureThreshold: 1,
        cooldownMs: 100_000,
      });
      expect(await c.acquire()).toBe(true);
      const p1 = c.acquire();
      const p2 = c.acquire();
      c.recordFailure();
      c.release();
      expect(await p1).toBe(false);
      expect(await p2).toBe(false);
    });
  });

  describe('ring buffer', () => {
    it('absorbs bursts and evicts oldest items when full', () => {
      const c = new BackpressureController({ bufferSize: 2 });
      const rb = (c as any).buffer as {
        push(v: number): boolean;
        pop(): number | null;
        occupancy: number;
        spilled: number;
        isFull: boolean;
        isEmpty(): boolean;
      };
      expect(rb.isEmpty()).toBe(true);
      rb.push(1);
      rb.push(2);
      expect(rb.isFull).toBe(true);
      rb.push(3);
      expect(rb.occupancy).toBe(2);
      expect(rb.spilled).toBe(1);
      expect(rb.pop()).toBe(2);
      expect(rb.pop()).toBe(3);
      expect(rb.pop()).toBeNull();
      expect(rb.isEmpty()).toBe(true);
    });
  });

  describe('metrics', () => {
    it('reflects processed and rejected counts', async () => {
      const c = new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 1,
        bufferSize: 1,
      });
      expect(await c.acquire()).toBe(true);
      expect(c.getMetrics().availableTokens).toBe(0);
      c.release();
      expect(c.getMetrics().availableTokens).toBe(1);
    });
  });
});
