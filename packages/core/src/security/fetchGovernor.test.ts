import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGlobalFetchGovernor, resetGlobalFetchGovernor } from './securityPrimitives';
describe('fetch governor lifecycle', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    resetGlobalFetchGovernor();
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    resetGlobalFetchGovernor();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  for (const fails of [false, true]) {
    it(
      'cleans up timeout and caller listener after fetch ' + (fails ? 'failure' : 'success'),
      async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, 'removeEventListener');
        globalThis.fetch = async () => {
          if (fails) throw new Error('network down');
          return new Response('ok');
        };
        installGlobalFetchGovernor({ timeoutMs: 1000 });
        const request = globalThis.fetch('https://example.com', { signal: caller.signal });
        if (fails) await expect(request).rejects.toThrow('network down');
        else await expect(request).resolves.toBeInstanceOf(Response);
        expect(vi.getTimerCount()).toBe(0);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      },
    );
  }

  it('preserves an already aborted caller signal', async () => {
    const caller = new AbortController();
    caller.abort(new Error('cancelled'));
    globalThis.fetch = async (_input, init) => {
      init?.signal?.throwIfAborted();
      return new Response('unexpected');
    };
    installGlobalFetchGovernor();
    await expect(
      globalThis.fetch('https://example.com', { signal: caller.signal }),
    ).rejects.toThrow('cancelled');
  });

  it('still aborts requests at the configured deadline', async () => {
    vi.useFakeTimers();
    globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    installGlobalFetchGovernor({ timeoutMs: 1000 });
    const assertion = expect(globalThis.fetch('https://example.com')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates caller cancellation and releases its listener', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    installGlobalFetchGovernor({ timeoutMs: 1000 });
    const assertion = expect(
      globalThis.fetch('https://example.com', { signal: caller.signal }),
    ).rejects.toThrow('cancelled');
    caller.abort(new Error('cancelled'));
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
