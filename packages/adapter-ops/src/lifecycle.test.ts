import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startAdapterOpsRuntime } from './lifecycle.js';

function daemon(events: string[], name: string, stopError?: Error) {
  return {
    start: () => events.push(`${name}:start`),
    stop: async () => {
      events.push(`${name}:stop`);
      if (stopError) throw stopError;
    },
  };
}

describe('adapter-ops lifecycle', () => {
  it('cleans up both daemon intervals and wiring when health bind fails', async () => {
    const events: string[] = [];
    await assert.rejects(
      () => startAdapterOpsRuntime({
        wiring: {
          reconciliation: daemon(events, 'reconciliation'),
          compensation: daemon(events, 'compensation'),
          safeStop: async (reason) => { events.push(`safe-stop:${reason}`); },
          close: async () => { events.push('wiring:close'); },
        },
        startHealth: async () => { throw new Error('EADDRINUSE'); },
      }),
      /EADDRINUSE/,
    );
    assert.deepEqual(events, [
      'reconciliation:start',
      'compensation:start',
      'safe-stop:health_start_failed',
      'wiring:close',
    ]);
  });

  it('closes health and wiring even when one daemon drain rejects', async () => {
    const events: string[] = [];
    const runtime = await startAdapterOpsRuntime({
      wiring: {
        reconciliation: daemon(events, 'reconciliation', new Error('drain failed')),
        compensation: daemon(events, 'compensation'),
        safeStop: async (reason) => {
          events.push(`safe-stop:${reason}`);
          throw new Error('drain failed');
        },
        close: async () => { events.push('wiring:close'); },
      },
      startHealth: async () => ({
        close: async () => { events.push('health:close'); },
      }),
    });
    await assert.rejects(() => runtime.shutdown(), /drain failed/);
    assert.deepEqual(events.slice(-3), [
      'safe-stop:shutdown',
      'health:close',
      'wiring:close',
    ]);
  });
});
