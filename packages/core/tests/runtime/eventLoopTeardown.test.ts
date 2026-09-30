/**
 * Regression: a background interval started by the `AgentRuntime` constructor
 * must not hold the event loop open.
 *
 * Found 2026-09-17. The constructor starts `MemoryCurator` and
 * `SLOMonitoringEngine`; each created a `setInterval` and never `unref()`'d it.
 * Nothing retained those timers except their own `stop()`, which no caller runs
 * for a runtime that was merely constructed, so the process could never exit:
 *
 *   - `node --test` blocked forever. `scripts/run-node-tests.mjs` spawns ONE
 *     `node --test` for the whole 196-file suite and passes no
 *     `--test-force-exit`, so this single leaked handle hung the entire run.
 *     Because it hung on the first file alphabetically, every downstream failure
 *     stayed invisible — the suite reported one stalled file, not the real state.
 *   - a CLI that builds a runtime hangs after its work is finished.
 *
 * `OpenTelemetryExporter.start()` already had the right pattern
 * (`this.flushTimer.unref()`); the other two timers simply did not follow it.
 *
 * This asserts the invariant directly rather than by watching a child process
 * exit. A child-process probe was tried first and abandoned: the runtime takes
 * ~7s to construct and ~16s to drain on a loaded machine (it loads a persisted
 * event log and runs a recovery scan), so "did it exit?" cannot distinguish a
 * leaked handle from a slow teardown without a guard long enough to be useless.
 * `hasRef()` answers the actual question in milliseconds.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentRuntime } from '../../src/runtime/agentRuntime';

/** The subset of Node's `Timeout` this test inspects. */
interface TimerHandle {
  hasRef?: () => boolean;
}

/** The first frame inside this package's source, for an actionable message. */
function firstSourceFrame(stack: string | undefined): string {
  return (
    (stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.includes('/packages/core/src/')) ?? '(unknown call site)'
  );
}

/**
 * Constructs a runtime with `setInterval` trapped, and returns the call sites of
 * every interval that still holds a reference once construction returns.
 */
function referencedIntervalsFromConstruction(): string[] {
  const created: Array<{ handle: TimerHandle; stack: string | undefined }> = [];
  const original = globalThis.setInterval;

  globalThis.setInterval = function trappedSetInterval(
    this: unknown,
    ...args: unknown[]
  ): ReturnType<typeof setInterval> {
    const handle = (original as (...a: unknown[]) => TimerHandle).apply(this, args);
    created.push({ handle, stack: new Error().stack });
    return handle as ReturnType<typeof setInterval>;
  } as typeof setInterval;

  try {
    new AgentRuntime();
  } finally {
    globalThis.setInterval = original;
  }

  return created
    .filter(({ handle }) => typeof handle.hasRef === 'function' && handle.hasRef())
    .map(({ stack }) => firstSourceFrame(stack));
}

test('constructing an AgentRuntime leaves no referenced interval behind', () => {
  const holders = referencedIntervalsFromConstruction();

  assert.deepEqual(
    holders,
    [],
    `${holders.length} interval(s) started by the AgentRuntime constructor still hold a ` +
      'reference, so any process that builds a runtime can never exit on its own:\n' +
      holders.map((site) => `  ${site}`).join('\n') +
      "\n\nA periodic background timer must be unref()'d (see " +
      'OpenTelemetryExporter.start(), which does `this.flushTimer.unref()`).',
  );
});
