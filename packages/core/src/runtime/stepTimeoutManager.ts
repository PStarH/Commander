/**
 * StepTimeoutManager — wrap a step's promise with a deadline.
 *
 * Closes the "hung step" gap from the reversibility audit. Without this, a
 * tool that hangs (infinite loop, network stuck) blocks the agent run forever
 * because AgentRuntime.execute has no step-level deadline.
 *
 * Behavior:
 *   - Per-call AbortController fired after `timeoutMs`
 *   - On timeout: rejects with StepTimeoutError (subclass of Error)
 *   - Caller can pass an `onTimeout` callback for cleanup (e.g. abort the underlying fetch)
 *   - clear() called on success releases resources
 */

export class StepTimeoutError extends Error {
  readonly stepId: string;
  readonly timeoutMs: number;
  constructor(stepId: string, timeoutMs: number) {
    super(`Step "${stepId}" exceeded timeout of ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
    this.stepId = stepId;
    this.timeoutMs = timeoutMs;
  }
}

export interface StepTimeoutOptions {
  timeoutMs: number;
  stepId: string;
  onTimeout?: (signal: AbortSignal) => void;
}

export class StepTimeoutManager {
  private active = new Map<string, { controller: AbortController; reject: (err: Error) => void }>();

  async wrap<T>(promise: Promise<T>, options: StepTimeoutOptions): Promise<T> {
    const controller = new AbortController();
    let rejectFn: ((err: Error) => void) | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectFn = reject;
      const timer = setTimeout(() => {
        controller.abort(new StepTimeoutError(options.stepId, options.timeoutMs));
        if (options.onTimeout) {
          try {
            options.onTimeout(controller.signal);
          } catch (err) {
            console.warn('[Catch]', err);
            /* best-effort */
          }
        }
        reject(new StepTimeoutError(options.stepId, options.timeoutMs));
      }, options.timeoutMs);
      // Use .then() with both handlers instead of .finally() to avoid creating
      // a floating rejected promise that Node.js reports as unhandled.
      // .finally() propagates the rejection, but nothing chains on the result.
      // .then(onFulfilled, onRejected) swallows the error if neither handler throws.
      promise.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
    });

    this.active.set(options.stepId, {
      controller,
      reject: (err) => {
        controller.abort(err);
        if (rejectFn) rejectFn(err);
      },
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      this.active.delete(options.stepId);
    }
  }

  cancel(stepId: string): boolean {
    const entry = this.active.get(stepId);
    if (!entry) return false;
    entry.reject(new StepTimeoutError(stepId, 0));
    return true;
  }

  cancelAll(): number {
    const count = this.active.size;
    for (const [stepId, entry] of this.active.entries()) {
      entry.reject(new StepTimeoutError(stepId, 0));
    }
    this.active.clear();
    return count;
  }

  activeCount(): number {
    return this.active.size;
  }
}
