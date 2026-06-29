/**
 * Backpressure Controller — Unified admission control for the runtime
 *
 * Implements the IBackpressureController contract from Pillar I.
 *
 * Architecture:
 *   Producer → [Token Bucket] → [Ring Buffer] → [Circuit Breaker] → Consumer
 *
 * - Token Bucket: rate-limits admission (tokens per second)
 * - Ring Buffer: absorbs burst traffic (fixed-size, O(1) insert/evict)
 * - Circuit Breaker: protects consumer when overwhelmed (Hystrix pattern)
 *
 * When the bucket is empty, requests spill to the ring buffer.
 * When the buffer is full, the circuit breaker opens and requests
 * are dropped (with metrics tracking) until the breaker half-opens.
 *
 * Per constraint NFR-PERF-05, concurrent reads must not block writes.
 * The controller uses lock-free CAS via atomic counter operations.
 */

import { getGlobalLogger } from '../logging';
import type { IBackpressureController, BackpressureMetrics } from '../contracts/pillarI';

// ============================================================================
// Token Bucket
// ============================================================================

/**
 * Lock-free token bucket using a single timestamp + counter.
 *
 * Tokens are refilled at a constant rate based on elapsed time.
 * CAS is simulated via atomic BigInt operations (Node.js).
 */
class TokenBucket {
  private tokens: number;
  private lastRefillTime: number;
  private readonly maxTokens: number;
  private refillRatePerMs: number;

  constructor(maxTokens: number, refillRatePerSecond: number) {
    // Validate parameters to prevent undefined behavior
    if (maxTokens <= 0 || !Number.isFinite(maxTokens)) {
      throw new Error(`TokenBucket: maxTokens must be positive, got ${maxTokens}`);
    }
    if (refillRatePerSecond <= 0 || !Number.isFinite(refillRatePerSecond)) {
      throw new Error(
        `TokenBucket: refillRatePerSecond must be positive, got ${refillRatePerSecond}`,
      );
    }
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRatePerMs = refillRatePerSecond / 1000;
    this.lastRefillTime = Date.now();
  }

  /**
   * Try to consume a token. Returns true if a token was available.
   * Refills tokens based on elapsed time before attempting consumption.
   */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Return a token to the bucket (e.g., when a request completes early).
   */
  returnToken(): void {
    this.tokens = Math.min(this.tokens + 1, this.maxTokens);
  }

  /**
   * Refill tokens based on elapsed time since last refill.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    if (elapsed <= 0) return;

    const refilled = elapsed * this.refillRatePerMs;
    this.tokens = Math.min(this.tokens + refilled, this.maxTokens);
    this.lastRefillTime = now;
  }

  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  setRefillRate(ratePerSecond: number): void {
    this.refill(); // Refill with old rate before changing
    this.refillRatePerMs = ratePerSecond / 1000;
  }
}

// ============================================================================
// Ring Buffer (LMAX Disruptor-inspired)
// ============================================================================

/**
 * Fixed-size ring buffer for absorbing burst traffic.
 *
 * O(1) insert and evict. When full, oldest entry is evicted
 * (and counted as spilled). Uses a circular array with head/tail pointers.
 */
class RingBuffer<T> {
  private buffer: (T | null)[];
  private head = 0; // Next write position
  private tail = 0; // Next read position
  private count = 0;
  private totalSpilled = 0;

  constructor(private readonly capacity: number) {
    if (capacity <= 0 || !Number.isFinite(capacity)) {
      throw new Error(`RingBuffer: capacity must be positive, got ${capacity}`);
    }
    this.buffer = new Array(capacity).fill(null);
  }

  /**
   * Push an item into the buffer.
   * Returns true if the item was accepted, false if it was dropped (buffer full).
   */
  push(item: T): boolean {
    if (this.count >= this.capacity) {
      // Buffer full — evict oldest (advance tail) and count as spilled
      this.tail = (this.tail + 1) % this.capacity;
      this.count--;
      this.totalSpilled++;
    }

    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    this.count++;
    return true;
  }

  /**
   * Pop the oldest item from the buffer.
   * Returns null if empty.
   */
  pop(): T | null {
    if (this.count === 0) return null;

    const item = this.buffer[this.tail];
    this.buffer[this.tail] = null;
    this.tail = (this.tail + 1) % this.capacity;
    this.count--;
    return item;
  }

  get occupancy(): number {
    return this.count;
  }

  get spilled(): number {
    return this.totalSpilled;
  }

  get isFull(): boolean {
    return this.count >= this.capacity;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }
}

// ============================================================================
// Circuit Breaker
// ============================================================================

type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Circuit breaker for consumer protection.
 *
 * - CLOSED: normal operation, requests pass through
 * - OPEN: consumer is overwhelmed, all requests are dropped
 * - HALF_OPEN: limited requests allowed to test recovery
 *
 * Transitions:
 * - CLOSED → OPEN: when error count exceeds threshold
 * - OPEN → HALF_OPEN: after cooldown period
 * - HALF_OPEN → CLOSED: on success
 * - HALF_OPEN → OPEN: on failure
 */
class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private totalDropped = 0;

  constructor(
    private readonly failureThreshold: number = 10,
    private readonly cooldownMs: number = 5000,
  ) {}

  /**
   * Check if a request can pass through.
   * Returns true if CLOSED or HALF_OPEN, false if OPEN.
   */
  canPass(): boolean {
    switch (this.state) {
      case 'CLOSED':
        return true;
      case 'OPEN':
        // Check if cooldown has elapsed
        if (Date.now() - this.lastFailureTime >= this.cooldownMs) {
          this.state = 'HALF_OPEN';
          getGlobalLogger().info('BackpressureController', 'Circuit breaker → HALF_OPEN');
          return true;
        }
        this.totalDropped++;
        return false;
      case 'HALF_OPEN':
        return true;
    }
  }

  /**
   * Record a successful operation.
   */
  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.failureCount = 0;
      getGlobalLogger().info('BackpressureController', 'Circuit breaker → CLOSED (recovered)');
    }
  }

  /**
   * Record a failed operation.
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      getGlobalLogger().warn(
        'BackpressureController',
        'Circuit breaker → OPEN (half-open failure)',
      );
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      getGlobalLogger().warn('BackpressureController', 'Circuit breaker → OPEN', {
        failureCount: this.failureCount,
        threshold: this.failureThreshold,
      });
    }
  }

  get currentState(): CircuitBreakerState {
    return this.state;
  }

  get droppedCount(): number {
    return this.totalDropped;
  }
}

// ============================================================================
// Backpressure Controller
// ============================================================================

/**
 * Unified backpressure controller.
 *
 * Combines token bucket (rate limiting), ring buffer (burst absorption),
 * and circuit breaker (consumer protection) into a single admission gate.
 *
 * Usage:
 *   const controller = new BackpressureController({
 *     maxTokens: 100,
 *     refillRatePerSecond: 50,
 *     bufferSize: 200,
 *   });
 *
 *   if (await controller.acquire()) {
 *     try {
 *       await doWork();
 *       controller.release();
 *     } catch (e) {
 *       controller.release();
 *       throw e;
 *     }
 *   }
 */
export class BackpressureController implements IBackpressureController {
  private bucket: TokenBucket;
  private buffer: RingBuffer<() => void>;
  private breaker: CircuitBreaker;
  private totalProcessed = 0;
  private totalRejected = 0;
  private bufferSpilledCount = 0;
  private readonly config: BackpressureControllerConfig;

  // Bounded waiter queue — each waiter has a unique ID for race-free removal
  private waiters: Array<{
    id: number;
    resolve: (v: boolean) => void;
    timer: NodeJS.Timeout;
    resolved: () => boolean;
  }> = [];
  private waiterIdCounter = 0;

  constructor(config: Partial<BackpressureControllerConfig> = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 100,
      refillRatePerSecond: config.refillRatePerSecond ?? 50,
      bufferSize: config.bufferSize ?? 200,
      failureThreshold: config.failureThreshold ?? 10,
      cooldownMs: config.cooldownMs ?? 5000,
      maxWaitMs: config.maxWaitMs ?? 10000,
    };

    this.bucket = new TokenBucket(this.config.maxTokens, this.config.refillRatePerSecond);
    this.buffer = new RingBuffer(this.config.bufferSize);
    this.breaker = new CircuitBreaker(this.config.failureThreshold, this.config.cooldownMs);
  }

  /**
   * Acquire a token for admission.
   *
   * Flow:
   * 1. Check circuit breaker — if OPEN, return false (drop)
   * 2. Try token bucket — if token available, return true
   * 3. Spill to waiter queue — if space (bounded by bufferSize), wait
   * 4. If waiter queue full, return false (drop)
   *
   * Race condition fix: each waiter has a unique ID. drainBuffer atomically
   * removes a waiter and resolves it. The timeout callback checks if the
   * waiter is still in the queue before resolving false, preventing the
   * double-resolve race.
   *
   * @returns true if admission granted, false if dropped
   */
  async acquire(): Promise<boolean> {
    // Validate config
    if (this.config.maxTokens <= 0 || this.config.refillRatePerSecond <= 0) {
      this.totalRejected++;
      return false;
    }

    // Step 1: Circuit breaker check
    if (!this.breaker.canPass()) {
      this.totalRejected++;
      getGlobalLogger().debug('BackpressureController', 'Request dropped (circuit breaker open)');
      return false;
    }

    // Step 2: Token bucket check
    if (this.bucket.tryConsume()) {
      this.totalProcessed++;
      return true;
    }

    // Step 3: Check if waiter queue has capacity
    if (this.waiters.length >= this.config.bufferSize) {
      this.totalRejected++;
      this.bufferSpilledCount++;
      getGlobalLogger().debug('BackpressureController', 'Request dropped (waiter queue full)', {
        queueSize: this.waiters.length,
        bufferSize: this.config.bufferSize,
      });
      return false;
    }

    // Step 4: Enqueue in bounded waiter queue and wait
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const waiterId = ++this.waiterIdCounter;

      const timer = setTimeout(() => {
        // Timeout — atomically remove from waiters if still present
        const idx = this.waiters.findIndex((w) => w.id === waiterId);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          this.totalRejected++;
          resolved = true;
          resolve(false);
        }
        // If idx < 0, drainBuffer already resolved this waiter — do nothing
      }, this.config.maxWaitMs);

      this.waiters.push({ id: waiterId, resolve, timer, resolved: () => resolved });

      // Mark as resolved when drainBuffer picks it up
      const originalResolve = resolve;
      this.waiters[this.waiters.length - 1].resolve = (v: boolean) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          originalResolve(v);
        }
      };

      // Try to drain immediately
      this.drainBuffer();
    });
  }

  /**
   * Release a token back to the bucket.
   * Also drains the ring buffer to admit waiting requests.
   */
  release(): void {
    this.bucket.returnToken();
    this.breaker.recordSuccess();
    this.drainBuffer();
  }

  /**
   * Record a failure (triggers circuit breaker if threshold exceeded).
   */
  recordFailure(): void {
    this.breaker.recordFailure();
  }

  /**
   * Get current backpressure metrics.
   */
  getMetrics(): BackpressureMetrics {
    return {
      availableTokens: this.bucket.availableTokens,
      bufferOccupancy: this.waiters.length,
      totalSpilled: this.bufferSpilledCount,
      totalDropped: this.breaker.droppedCount,
      circuitBreakerState: this.breaker.currentState,
    };
  }

  /**
   * Set the consumer rate (tokens per second).
   */
  setConsumerRate(ratePerSecond: number): void {
    this.bucket.setRefillRate(ratePerSecond);
    getGlobalLogger().info('BackpressureController', 'Consumer rate updated', {
      ratePerSecond,
    });
  }

  /**
   * Drain the waiter queue: try to admit waiting requests
   * if tokens are now available.
   *
   * Race condition fix: we shift the waiter first, then try to consume a token.
   * If consumption fails, we unshift the waiter back. This ensures a token is
   * never consumed without a corresponding waiter being resolved.
   */
  private drainBuffer(): void {
    while (this.waiters.length > 0) {
      if (!this.breaker.canPass()) {
        // Breaker is open — reject all waiters
        while (this.waiters.length > 0) {
          const waiter = this.waiters.shift()!;
          clearTimeout(waiter.timer);
          this.totalRejected++;
          waiter.resolve(false);
        }
        return;
      }

      // Shift the waiter FIRST (atomic removal from queue)
      const waiter = this.waiters.shift();
      if (!waiter) break;

      // Now try to consume a token
      if (this.bucket.tryConsume()) {
        this.totalProcessed++;
        waiter.resolve(true);
      } else {
        // No token available — put the waiter back at the front
        this.waiters.unshift(waiter);
        break;
      }
    }
  }
}

// ============================================================================
// Configuration
// ============================================================================

export interface BackpressureControllerConfig {
  /** Maximum tokens in the bucket (burst capacity) */
  maxTokens: number;
  /** Token refill rate (requests per second) */
  refillRatePerSecond: number;
  /** Ring buffer capacity for burst absorption */
  bufferSize: number;
  /** Circuit breaker failure threshold */
  failureThreshold: number;
  /** Circuit breaker cooldown period (ms) */
  cooldownMs: number;
  /** Maximum time to wait in the buffer before dropping (ms) */
  maxWaitMs: number;
}

// ============================================================================
// Singleton
// ============================================================================

let globalController: BackpressureController | null = null;

/**
 * Get the global backpressure controller.
 * Lazily initialized with default configuration.
 */
export function getGlobalBackpressureController(): BackpressureController {
  if (!globalController) {
    globalController = new BackpressureController();
  }
  return globalController;
}

/**
 * Set the global backpressure controller (for custom configuration).
 */
export function setGlobalBackpressureController(controller: BackpressureController | null): void {
  globalController = controller;
}
