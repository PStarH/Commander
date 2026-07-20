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
   * cooperative=true only for abort-linked reject inside the abort coop window
   * (honored cancel before next macrotask); false after grace hard-cancel, late
   * success, or late reject (including late throw of signal.reason after side effects).
   */
  timeoutError: (cooperative: boolean) => Error;
  /** Same cooperative semantics as timeoutError for parent-abort outcomes. */
  abortError: (cooperative: boolean) => Error;
}

/**
 * 仅当 rejection 与 signal.reason 为同一引用时视为 abort-linked。
 *
 * 本仓库 abort 路径始终写入 reason（timeout→Error('timeout')；
 * parent→parent.reason ?? Error('aborted')；stop→Error('Worker stopped')），
 * 合作 handler 应在 abort 监听器内 reject(signal.reason)。
 *
 * 伪造 AbortError / 文案相同的新 Error('aborted') → 非 linked（正确）。
 * linked  alone 不够：ignore 后副作用再 throw signal.reason 仍同引用；
 * 须叠加 abort 协作窗口（abortLocal：先 setTimeout(0) 关窗再 abort，finally 快照）
 * 才标 cooperative/retryable。
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
  /**
   * abort 后的协作窗口：覆盖 abort 同步监听器（真 coop reject）。
   * abortLocal 先 setTimeout(0) 关窗再 abort，保证监听器内 setTimeout(0) reject
   * 不会排在关窗之前误入窗；同步 reject 仍在窗内。
   */
  let abortCoopWindow = false;
  let settledInCoopWindow = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let coopWindowTimer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;

  const run = work(local.signal).finally(() => {
    settled = true;
    if (abortCoopWindow) settledInCoopWindow = true;
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
        if (coopWindowTimer !== undefined) clearTimeout(coopWindowTimer);
        fn();
      };

      const rejectTimeout = (cooperative: boolean): void => {
        close(() => reject(options.timeoutError(cooperative)));
      };

      const rejectAbort = (cooperative: boolean): void => {
        close(() => reject(options.abortError(cooperative)));
      };

      /**
       * Soft-abort local signal；协作窗口覆盖 abort 同步监听器（真 coop）。
       *
       * 关窗 setTimeout(0) 必须先于 local.abort 入队：若先 abort，监听器内
       *「副作用 + setTimeout(0, reject(signal.reason))」会把 settle 定时器排在
       * 关窗之前 → settle 仍落在 coop 窗 → 误标 retryable（dual-dispatch）。
       * 先关窗再 abort：监听器的 setTimeout(0) 晚于关窗 → fail-closed；
       * 同步 reject(signal.reason) 仍在窗内 → coop/retryable。
       * （#74 toolOrchestrator 同源 abortLocal 须保持同一顺序。）
       */
      const abortLocal = (reason: unknown): void => {
        if (local.signal.aborted) return;
        abortCoopWindow = true;
        if (coopWindowTimer !== undefined) clearTimeout(coopWindowTimer);
        coopWindowTimer = setTimeout(() => {
          abortCoopWindow = false;
          coopWindowTimer = undefined;
        }, 0);
        local.abort(reason);
      };

      /** Soft-abort already fired; after grace, hard-reject if work ignored it. */
      const scheduleHardExit = (hardReject: () => void): void => {
        if (graceTimer !== undefined || closed) return;
        graceTimer = setTimeout(() => {
          if (closed || settled) return;
          hardReject();
        }, abortGraceMs);
      };

      /**
       * abort/timeout 已开火后的 settle：仅窗口内 abort-linked 仍可 coop/retryable；
       * 晚抛 signal.reason（副作用后再抛）与 late-success 一样 fail-closed。
       */
      const coopAfterCancel = (error: unknown): boolean =>
        settledInCoopWindow && isAbortLinkedRejection(error, local.signal);

      onParentAbort = () => {
        abortLocal(parentSignal.reason ?? new Error('aborted'));
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
        abortLocal(new Error('timeout'));
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
          if (parentSignal.aborted) {
            rejectAbort(coopAfterCancel(error));
            return;
          }
          if (timedOut) {
            rejectTimeout(coopAfterCancel(error));
            return;
          }
          if (local.signal.aborted) {
            rejectAbort(coopAfterCancel(error));
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
    if (coopWindowTimer !== undefined) clearTimeout(coopWindowTimer);
  }
}
