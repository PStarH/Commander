/**
 * Abort-aware await with hard timeout / parent-abort exit.
 *
 * Linked AbortSignal covers cooperative handlers. Promise.race alone left
 * orphaned work running; abort-only left non-cooperative handlers stuck under
 * lease heartbeat. This helper aborts on timeout or parent abort, waits a short
 * grace for cooperative settle, then force-rejects so the step await always
 * terminates.
 */

export interface AwaitWithAbortTimeoutOptions {
  parentSignal: AbortSignal;
  timeoutMs: number;
  /** Grace after abort before hard-failing non-cooperative work (default 50ms). */
  abortGraceMs?: number;
  /**
   * cooperative=true only for abort-linked reject after cancel (honored cancel);
   * false after grace hard-cancel, late success resolve, or late non-abort reject.
   */
  timeoutError: (cooperative: boolean) => Error;
  /** Same cooperative semantics as timeoutError for parent-abort outcomes. */
  abortError: (cooperative: boolean) => Error;
}

/**
 * 仅当 rejection 与 signal.reason 为同一引用时视为合作取消。
 *
 * 本仓库 abort 路径始终写入 reason（timeout→Error('timeout')；
 * parent→parent.reason ?? Error('aborted')；stop→Error('Worker stopped')），
 * 合作 handler 应 reject(signal.reason)，与 identity 对齐。
 *
 * 置信度缺口（刻意 fail-closed，无法仅凭 identity 消除）：
 * - ignore 信号做完副作用后仍 throw signal.reason（同一对象）→ 仍会判 coop
 * - 文案相同的新 Error('aborted') / 伪造 AbortError → 一律非 coop（正确）
 */
export function isAbortLinkedRejection(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error === signal.reason;
}

export async function awaitWithAbortTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: AwaitWithAbortTimeoutOptions,
): Promise<T> {
  const { parentSignal, timeoutMs, abortGraceMs = 50 } = options;
  const local = new AbortController();

  let timedOut = false;
  let settled = false;
  let closed = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;

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

      const rejectAbort = (cooperative: boolean): void => {
        close(() => reject(options.abortError(cooperative)));
      };

      /** Soft-abort already fired; after grace, hard-reject if work ignored it. */
      const scheduleHardExit = (hardReject: () => void): void => {
        if (graceTimer !== undefined || closed) return;
        graceTimer = setTimeout(() => {
          if (closed || settled) return;
          hardReject();
        }, abortGraceMs);
      };

      onParentAbort = () => {
        if (!local.signal.aborted) {
          local.abort(parentSignal.reason ?? new Error('aborted'));
        }
        // Parent abort must hard-exit non-cooperative work (same as timeout path).
        scheduleHardExit(() => rejectAbort(false));
      };

      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });

      timeoutTimer = setTimeout(() => {
        if (closed) return;
        // Parent owns ABORTED mapping; still ensure a hard-exit is armed.
        if (parentSignal.aborted) {
          scheduleHardExit(() => rejectAbort(false));
          return;
        }
        timedOut = true;
        if (!local.signal.aborted) local.abort(new Error('timeout'));
        scheduleHardExit(() => {
          if (parentSignal.aborted) {
            rejectAbort(false);
            return;
          }
          rejectTimeout(false);
        });
      }, timeoutMs);

      void run.then(
        (value) => {
          if (closed) return;
          // Parent abort takes priority over a racing timeout flag.
          if (parentSignal.aborted) {
            // Late success after parent abort: same as timeout late-resolve —
            // handler ignored cancel intent; do not claim cooperative/retryable.
            rejectAbort(false);
            return;
          }
          if (timedOut) {
            // Late resolve after timeout: completion unknown — not cooperative cancel.
            rejectTimeout(false);
            return;
          }
          if (local.signal.aborted) {
            rejectAbort(true);
            return;
          }
          close(() => resolve(value));
        },
        (error) => {
          if (closed) return;
          // Fail-closed: after cancel, only abort-linked reject is cooperative.
          // Ignore-signal + late throw must not claim retryable (dual-dispatch).
          const cooperative = isAbortLinkedRejection(error, local.signal);
          if (parentSignal.aborted) {
            rejectAbort(cooperative);
            return;
          }
          if (timedOut) {
            rejectTimeout(cooperative);
            return;
          }
          if (local.signal.aborted) {
            rejectAbort(cooperative);
            return;
          }
          close(() => reject(error));
        },
      );
    });
  } finally {
    if (onParentAbort) parentSignal.removeEventListener('abort', onParentAbort);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}
