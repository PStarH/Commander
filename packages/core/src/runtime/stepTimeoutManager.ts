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

import { reportSilentFailure } from '../silentFailureReporter';
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

/**
 * One in-flight wrapped step. The manager owns the deadline timer (instead of
 * the promise executor) so cancellation can release it immediately rather than
 * leaving it alive until the wrapped promise eventually settles.
 */
interface ActiveStep {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  timeoutError: StepTimeoutError;
  onTimeout?: (signal: AbortSignal) => void;
  settled: boolean;
  cleanupInvoked: boolean;
  cancel: (err: Error) => void;
}

export class StepTimeoutManager {
  /**
   * stepId → every in-flight wrap for that id. Duplicate step IDs are tracked
   * as a set so a finished duplicate cannot evict a still-running sibling and
   * leave it uncancellable.
   */
  private active = new Map<string, Set<ActiveStep>>();

  async wrap<T>(promise: Promise<T>, options: StepTimeoutOptions): Promise<T> {
    const controller = new AbortController();
    let rejectFn: ((err: Error) => void) | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectFn = reject;
    });

    const entry: ActiveStep = {
      controller,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      timeoutError: new StepTimeoutError(options.stepId, options.timeoutMs),
      onTimeout: options.onTimeout,
      settled: false,
      cleanupInvoked: false,
      cancel: (err) => {
        if (entry.settled) return;
        entry.settled = true;
        // Cancellation is a terminal path: release the deadline timer here and
        // fire the caller's cleanup contract, exactly as a timeout would.
        clearTimeout(entry.timer);
        controller.abort(err);
        runCleanup(entry);
        if (rejectFn) rejectFn(err);
      },
    };

    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      controller.abort(entry.timeoutError);
      runCleanup(entry);
      if (rejectFn) rejectFn(entry.timeoutError);
    }, options.timeoutMs);

    const stepId = options.stepId;
    let peers = this.active.get(stepId);
    if (!peers) {
      peers = new Set();
      this.active.set(stepId, peers);
    }
    peers.add(entry);

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      // Every terminal path — timeout, success, original rejection or cancel —
      // releases both the timer and this wrap's registry slot.
      entry.settled = true;
      clearTimeout(entry.timer);
      peers.delete(entry);
      if (peers.size === 0 && this.active.get(stepId) === peers) this.active.delete(stepId);
    }
  }

  cancel(stepId: string): boolean {
    const peers = this.active.get(stepId);
    if (!peers || peers.size === 0) return false;
    for (const entry of Array.from(peers)) {
      entry.cancel(new StepTimeoutError(stepId, 0));
    }
    this.active.delete(stepId);
    return true;
  }

  cancelAll(): number {
    let count = 0;
    const entries: ActiveStep[] = [];
    for (const peers of this.active.values()) {
      for (const entry of peers) entries.push(entry);
    }
    for (const entry of entries) {
      entry.cancel(new StepTimeoutError(entry.timeoutError.stepId, 0));
      count++;
    }
    this.active.clear();
    return count;
  }

  activeCount(): number {
    let count = 0;
    for (const peers of this.active.values()) count += peers.size;
    return count;
  }
}

function runCleanup(entry: ActiveStep): void {
  if (entry.cleanupInvoked) return;
  entry.cleanupInvoked = true;
  if (!entry.onTimeout) return;
  try {
    entry.onTimeout(entry.controller.signal);
  } catch (err) {
    reportSilentFailure(err, 'stepTimeoutManager:47');
    /* best-effort */
  }
}
