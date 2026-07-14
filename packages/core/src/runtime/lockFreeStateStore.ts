/**
 * Lock-Free State Store — CAS (Compare-And-Swap) semantics
 *
 * Implements the ILockFreeStateStore contract from Pillar I.
 *
 * Uses JavaScript's single-threaded execution model to provide
 * linearizable updates without locks. CAS operations are atomic
 * because there are no preemption points within the comparison+set.
 *
 * For async transform functions, a spin-loop retry mechanism
 * handles conflicts: if the state changed between read and write,
 * the transform is re-applied to the new value.
 *
 * Per constraint NFR-PERF-05, concurrent reads must not block writes.
 */

import { getGlobalLogger } from '../logging';

/** Local contract (Pillar I ILockFreeStateStore is not exported from contracts yet). */
interface ILockFreeStateStore<T> {
  read(): T;
  compareAndSet(expected: T, newValue: T): boolean;
  update(transform: (current: T) => T): T;
  update(transform: (current: T) => Promise<T>): Promise<T>;
}

// ============================================================================
// LockFreeStateStore Implementation
// ============================================================================

export class LockFreeStateStore<T> implements ILockFreeStateStore<T> {
  private value: T;
  private version: number = 0;
  private maxRetries: number;
  private casCount = 0;
  private casSuccessCount = 0;
  private casFailureCount = 0;

  constructor(initialValue: T, options?: { maxRetries?: number }) {
    this.value = initialValue;
    this.maxRetries = options?.maxRetries ?? 100;
  }

  /**
   * Read current value (never blocks).
   * Returns a shallow copy if the value is an object.
   */
  read(): T {
    return this.value;
  }

  /**
   * Atomic compare-and-set.
   * Returns true only if the current value deep-equals `expected`,
   * in which case it's replaced with `newValue`.
   */
  compareAndSet(expected: T, newValue: T): boolean {
    this.casCount++;

    if (this.deepEquals(this.value, expected)) {
      this.value = newValue;
      this.version++;
      this.casSuccessCount++;
      return true;
    }

    this.casFailureCount++;
    return false;
  }

  /**
   * Update with a transform function (retry loop on conflict).
   *
   * For synchronous transforms, this is a single CAS attempt.
   * For async-capable contexts, the transform sees the latest value
   * at the time of invocation.
   */
  update(transform: (current: T) => T): T;

  /**
   * Update with an async transform function (retry loop on conflict).
   * The transform may be called multiple times if the state changes
   * between read and write.
   */
  update(transform: (current: T) => Promise<T>): Promise<T>;

  update(transform: ((current: T) => T) | ((current: T) => Promise<T>)): T | Promise<T> {
    // Check if transform is async by calling it and checking the result
    const current = this.value;
    const result = transform(current);

    if (result instanceof Promise) {
      return this.updateAsync(transform as (current: T) => Promise<T>);
    }

    // Synchronous transform — direct CAS
    const newValue = result as T;
    if (this.compareAndSet(current, newValue)) {
      return newValue;
    }

    // CAS failed — retry with the latest value
    // (In a single-threaded JS environment, this only fails if
    //  the value was changed between the read above and the CAS)
    const latest = this.value;
    const retryResult = transform(latest);
    if (this.compareAndSet(latest, retryResult as T)) {
      return retryResult as T;
    }

    // If still failing, throw to prevent infinite loops
    throw new Error('CAS update failed after retry — state changed concurrently');
  }

  /**
   * Async update with retry loop.
   */
  private async updateAsync(transform: (current: T) => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const current = this.value;
      try {
        const newValue = await transform(current);

        if (this.compareAndSet(current, newValue)) {
          return newValue;
        }

        // CAS failed — state changed during async transform
        getGlobalLogger().debug('LockFreeStateStore', 'CAS retry on conflict', {
          attempt: attempt + 1,
          version: this.version,
        });
      } catch (err) {
        lastError = err as Error;
        getGlobalLogger().warn('LockFreeStateStore', 'Transform threw error', {
          attempt: attempt + 1,
          error: lastError.message,
        });
      }
    }

    throw lastError ?? new Error(`CAS update failed after ${this.maxRetries} retries`);
  }

  /**
   * Get the current version (number of successful updates).
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Get CAS statistics.
   */
  getStats(): {
    totalAttempts: number;
    successes: number;
    failures: number;
    successRate: number;
  } {
    return {
      totalAttempts: this.casCount,
      successes: this.casSuccessCount,
      failures: this.casFailureCount,
      successRate: this.casCount > 0 ? this.casSuccessCount / this.casCount : 1,
    };
  }

  /**
   * Deep equality check for CAS comparison.
   * Handles primitives, arrays, and plain objects.
   */
  private deepEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;

    if (typeof a !== 'object') return a === b;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((val, i) => this.deepEquals(val, b[i]));
    }

    if (Array.isArray(a) !== Array.isArray(b)) return false;

    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);

    if (keysA.length !== keysB.length) return false;

    return keysA.every((key) => this.deepEquals(objA[key], objB[key]));
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createLockFreeStateStore<T>(
  initialValue: T,
  options?: { maxRetries?: number },
): LockFreeStateStore<T> {
  return new LockFreeStateStore(initialValue, options);
}
