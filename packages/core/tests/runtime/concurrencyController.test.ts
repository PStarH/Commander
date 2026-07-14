import { describe, it, expect } from 'vitest';
import {
  ConcurrencyController,
  ConcurrencyQueueFullError,
  ConcurrencyAcquireTimeoutError,
} from '../../src/runtime/concurrencyController';

describe('ConcurrencyController (REL-10)', () => {
  it('caps concurrency and admits a queued waiter on release', async () => {
    const c = new ConcurrencyController(1);
    const release1 = await c.acquire('t');
    expect(c.getRunningCount('t')).toBe(1);

    let acquired2 = false;
    const p2 = c.acquire('t').then((r) => {
      acquired2 = true;
      return r;
    });
    // Second acquire is queued, not granted, while the first slot is held.
    await Promise.resolve();
    expect(acquired2).toBe(false);
    expect(c.getQueueDepth('t')).toBe(1);

    release1();
    const release2 = await p2;
    expect(acquired2).toBe(true);
    release2();
  });

  it('release is idempotent and never drives the count negative (over-admission guard)', async () => {
    const c = new ConcurrencyController(2);
    const rel = await c.acquire('t');
    rel();
    rel(); // double-release must be a no-op
    expect(c.getRunningCount('t')).toBe(0);
    // A brand-new acquire still works and the ceiling is intact.
    const r1 = await c.acquire('t');
    const r2 = await c.acquire('t');
    expect(c.getRunningCount('t')).toBe(2);
    r1();
    r2();
  });

  it('rejects with ConcurrencyQueueFullError past the queue bound', async () => {
    const c = new ConcurrencyController(1, { maxQueueDepth: 1 });
    const held = await c.acquire('t'); // occupies the single slot
    const queued = c.acquire('t'); // fills the single queue slot
    await Promise.resolve();
    await expect(c.acquire('t')).rejects.toBeInstanceOf(ConcurrencyQueueFullError);
    held();
    await queued.then((r) => r());
  });

  it('times out a waiter without leaking it', async () => {
    const c = new ConcurrencyController(1, { acquireTimeoutMs: 20 });
    const held = await c.acquire('t');
    await expect(c.acquire('t')).rejects.toBeInstanceOf(ConcurrencyAcquireTimeoutError);
    // The timed-out waiter was removed from the queue.
    expect(c.getQueueDepth('t')).toBe(0);
    held();
  });

  it('evicts idle non-global tenant semaphores (no unbounded growth)', async () => {
    const c = new ConcurrencyController(1);
    const rel = await c.acquire('tenant-a');
    expect(c.getRunningCount('tenant-a')).toBe(1);
    rel();
    // After the tenant goes idle its semaphore is dropped; a fresh read reports 0.
    expect(c.getRunningCount('tenant-a')).toBe(0);
    expect(c.getQueueDepth('tenant-a')).toBe(0);
  });
});
