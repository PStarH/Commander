/**
 * Abort-aware await with hard timeout exit.
 *
 * Linked AbortSignal covers cooperative handlers. Promise.race alone left
 * orphaned work running; abort-only left non-cooperative handlers stuck under
 * lease heartbeat. This helper aborts on timeout, waits a short grace for
 * cooperative settle, then force-rejects so the step await always terminates.
 */

export interface AwaitWithAbortTimeoutOptions {
  parentSignal: AbortSignal;
  timeoutMs: number;
  /** Grace after abort before hard-failing non-cooperative work (default 50ms). */
  abortGraceMs?: number;
  /** cooperative=true when handler settled after abort; false after grace hard-cancel. */
  timeoutError: (cooperative: boolean) => Error;
  abortError: () => Error;
}

export async function awaitWithAbortTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: AwaitWithAbortTimeoutOptions,
): Promise<T> {
  const { parentSignal, timeoutMs, abortGraceMs = 50 } = options;
  const local = new AbortController();
  const onParentAbort = () => {
    if (!local.signal.aborted) local.abort(parentSignal.reason ?? new Error('aborted'));
  };
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener('abort', onParentAbort, { once: true });

  let timedOut = false;
  let settled = false;
  let closed = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const run = work(local.signal).finally(() => {
    settled = true;
  });
  // Abandoned non-cooperative work must not surface as unhandledRejection.
  void run.catch(() => {});

  try {
    return await new Promise<T>((resolve, reject) => {
      const close = (fn: () => void): void => {
        if (closed) return;
        closed = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        fn();
      };

      const rejectTimeout = (cooperative: boolean): void => {
        close(() => reject(options.timeoutError(cooperative)));
      };

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (!local.signal.aborted) local.abort(new Error('timeout'));
        graceTimer = setTimeout(() => {
          if (!settled) rejectTimeout(false);
        }, abortGraceMs);
      }, timeoutMs);

      void run.then(
        (value) => {
          if (closed) return;
          if (timedOut) {
            // Late resolve after timeout: completion unknown — not cooperative cancel.
            rejectTimeout(false);
            return;
          }
          if (parentSignal.aborted || local.signal.aborted) {
            close(() => reject(options.abortError()));
            return;
          }
          close(() => resolve(value));
        },
        (error) => {
          if (closed) return;
          if (timedOut) {
            rejectTimeout(true);
            return;
          }
          if (parentSignal.aborted || local.signal.aborted) {
            close(() => reject(options.abortError()));
            return;
          }
          close(() => reject(error));
        },
      );
    });
  } finally {
    parentSignal.removeEventListener('abort', onParentAbort);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}
