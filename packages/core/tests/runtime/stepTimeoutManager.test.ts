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
});
