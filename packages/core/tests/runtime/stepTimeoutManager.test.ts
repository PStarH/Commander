import { describe, it, expect, vi } from 'vitest';
import { StepTimeoutManager, StepTimeoutError } from '../../src/runtime/stepTimeoutManager';

describe('StepTimeoutManager', () => {
  it('resolves before timeout', async () => {
    const mgr = new StepTimeoutManager();
    const result = await mgr.wrap(Promise.resolve('ok'), { stepId: 's1', timeoutMs: 100 });
    expect(result).toBe('ok');
    expect(mgr.activeCount()).toBe(0);
  });

  it('rejects with StepTimeoutError when promise exceeds timeout', async () => {
    const mgr = new StepTimeoutManager();
    const slow = new Promise((resolve) => setTimeout(() => resolve('too late'), 200));
    await expect(mgr.wrap(slow, { stepId: 's2', timeoutMs: 30 })).rejects.toBeInstanceOf(
      StepTimeoutError,
    );
  });

  it('invokes onTimeout callback with AbortSignal', async () => {
    const mgr = new StepTimeoutManager();
    const onTimeout = vi.fn();
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await mgr.wrap(slow, { stepId: 's3', timeoutMs: 20, onTimeout }).catch(() => undefined);
    expect(onTimeout).toHaveBeenCalledOnce();
    const signal = onTimeout.mock.calls[0][0] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('cancel() rejects an in-flight step', async () => {
    const mgr = new StepTimeoutManager();
    const slow = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 5000));
    const wrapP = mgr.wrap(slow, { stepId: 's4', timeoutMs: 5000 });
    setTimeout(() => mgr.cancel('s4'), 30);
    await expect(wrapP).rejects.toBeInstanceOf(StepTimeoutError);
  });

  it('cancelAll() aborts all tracked steps', async () => {
    const mgr = new StepTimeoutManager();
    const p1 = mgr.wrap(new Promise(() => {}), { stepId: 'p1', timeoutMs: 5000 });
    const p2 = mgr.wrap(new Promise(() => {}), { stepId: 'p2', timeoutMs: 5000 });
    const aborted = mgr.cancelAll();
    expect(aborted).toBe(2);
    expect(mgr.activeCount()).toBe(0);
    await expect(p1).rejects.toBeInstanceOf(StepTimeoutError);
    await expect(p2).rejects.toBeInstanceOf(StepTimeoutError);
  });

  it('preserves original error when promise rejects for non-timeout reason', async () => {
    const mgr = new StepTimeoutManager();
    const failing = Promise.reject(new Error('original failure'));
    await expect(mgr.wrap(failing, { stepId: 's5', timeoutMs: 1000 })).rejects.toThrow(
      'original failure',
    );
  });

  // -------------------------------------------------------------------------
  // RQ-STEPTIMEOUT: cancel() is a terminal path — it must release the deadline
  // timer and run the caller's cleanup contract. The timer used to be scoped
  // inside the timeoutPromise executor, so cancel() left it armed until the
  // wrapped promise eventually settled and never invoked onTimeout.
  // -------------------------------------------------------------------------
  describe('cancel durability (RQ-STEPTIMEOUT)', () => {
    it('cancel() fires onTimeout cleanup and clears the deadline timer', async () => {
      vi.useFakeTimers();
      try {
        const mgr = new StepTimeoutManager();
        const onTimeout = vi.fn();
        const wrapP = mgr.wrap(new Promise<never>(() => {}), {
          stepId: 'cancel-s1',
          timeoutMs: 60_000,
          onTimeout,
        });
        wrapP.catch(() => undefined);

        expect(vi.getTimerCount()).toBe(1);
        expect(mgr.cancel('cancel-s1')).toBe(true);

        await expect(wrapP).rejects.toBeInstanceOf(StepTimeoutError);
        // Cleanup contract fired with an aborted signal, like a real timeout.
        expect(onTimeout).toHaveBeenCalledTimes(1);
        expect((onTimeout.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
        // The deadline timer is gone, not merely unreachable.
        expect(vi.getTimerCount()).toBe(0);

        // Even far past the deadline nothing fires a second time.
        vi.advanceTimersByTime(120_000);
        expect(onTimeout).toHaveBeenCalledTimes(1);
        expect(mgr.activeCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancelAll() fires every cleanup and clears every deadline timer', async () => {
      vi.useFakeTimers();
      try {
        const mgr = new StepTimeoutManager();
        const cleanupA = vi.fn();
        const cleanupB = vi.fn();
        const pA = mgr.wrap(new Promise<never>(() => {}), {
          stepId: 'cancel-all-a',
          timeoutMs: 60_000,
          onTimeout: cleanupA,
        });
        const pB = mgr.wrap(new Promise<never>(() => {}), {
          stepId: 'cancel-all-b',
          timeoutMs: 60_000,
          onTimeout: cleanupB,
        });
        pA.catch(() => undefined);
        pB.catch(() => undefined);

        expect(vi.getTimerCount()).toBe(2);
        expect(mgr.cancelAll()).toBe(2);
        expect(mgr.activeCount()).toBe(0);

        await expect(pA).rejects.toBeInstanceOf(StepTimeoutError);
        await expect(pB).rejects.toBeInstanceOf(StepTimeoutError);

        expect(cleanupA).toHaveBeenCalledTimes(1);
        expect(cleanupB).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        vi.advanceTimersByTime(120_000);
        expect(cleanupA).toHaveBeenCalledTimes(1);
        expect(cleanupB).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('tracks duplicate step IDs independently and cancels all of them', async () => {
      vi.useFakeTimers();
      try {
        const mgr = new StepTimeoutManager();
        const cleanupA = vi.fn();
        const cleanupB = vi.fn();
        const pA = mgr.wrap(new Promise<never>(() => {}), {
          stepId: 'dup',
          timeoutMs: 60_000,
          onTimeout: cleanupA,
        });
        const pB = mgr.wrap(new Promise<never>(() => {}), {
          stepId: 'dup',
          timeoutMs: 60_000,
          onTimeout: cleanupB,
        });
        pA.catch(() => undefined);
        pB.catch(() => undefined);

        // The second wrap must not evict the first from the registry.
        expect(mgr.activeCount()).toBe(2);
        expect(vi.getTimerCount()).toBe(2);

        expect(mgr.cancel('dup')).toBe(true);
        expect(mgr.activeCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);

        await expect(pA).rejects.toBeInstanceOf(StepTimeoutError);
        await expect(pB).rejects.toBeInstanceOf(StepTimeoutError);
        expect(cleanupA).toHaveBeenCalledTimes(1);
        expect(cleanupB).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still times out and cleans up exactly once when the deadline fires', async () => {
      vi.useFakeTimers();
      try {
        const mgr = new StepTimeoutManager();
        const onTimeout = vi.fn();
        const wrapP = mgr.wrap(new Promise<never>(() => {}), {
          stepId: 'deadline-once',
          timeoutMs: 5_000,
          onTimeout,
        });
        wrapP.catch(() => undefined);

        vi.advanceTimersByTime(5_000);
        await expect(wrapP).rejects.toBeInstanceOf(StepTimeoutError);
        expect(onTimeout).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        // Cancelling after the deadline must not re-run the cleanup contract.
        expect(mgr.cancel('deadline-once')).toBe(false);
        expect(onTimeout).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
