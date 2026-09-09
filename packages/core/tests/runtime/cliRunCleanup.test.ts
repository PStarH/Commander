import { afterEach, expect, it, vi } from 'vitest';
import { cmdRun } from '../../src/cli/commands/core';

const state = vi.hoisted(() => ({ dispose: vi.fn(async () => {}), execute: vi.fn() }));
vi.mock('../../src/cli/commands/_shared', async (original) => ({
  ...(await original<object>()),
  createRuntime: () => ({ dispose: state.dispose }),
  loadTools: () => [],
}));
vi.mock('../../src/config/commanderConfig', async (original) => ({
  ...(await original<object>()),
  detectProvider: () => ({ type: 'mock' }),
}));
vi.mock('../../src/telos/telosOrchestrator', () => ({ TELOSOrchestrator: class {} }));
vi.mock('../../src/ultimate/orchestrator', () => ({
  UltimateOrchestrator: class {
    execute = state.execute;
  },
}));
const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalExitCode = process.exitCode;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalTTY) Object.defineProperty(process.stdin, 'isTTY', originalTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  state.dispose.mockReset();
  state.execute.mockReset();
  process.exitCode = originalExitCode;
});

it('sets a failure exit status without forcing process termination', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  state.execute.mockResolvedValue({
    status: 'FAILED',
    errors: [{ message: 'policy denied' }],
    metrics: { totalTokens: 0, totalCostUsd: 0 },
  });
  process.exitCode = undefined;
  await cmdRun('test task');
  expect(process.exitCode).toBe(1);
  expect(state.dispose).toHaveBeenCalled();
});

it('awaits disposal when execution rejects without replacing its error', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const failure = new Error('execution rejected');
  state.execute.mockRejectedValue(failure);
  let finish!: () => void;
  state.dispose.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let settled = false;
  const run = cmdRun('test task');
  const checked = expect(run)
    .rejects.toBe(failure)
    .then(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(state.dispose).toHaveBeenCalled());
  expect(settled).toBe(false);
  finish();
  await checked;
});

it('releases stdin and the data listener when interactive feedback times out', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const resume = vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  const pause = vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  state.execute.mockResolvedValue({
    status: 'SUCCESS',
    errors: [],
    metrics: { totalTokens: 0, totalCostUsd: 0 },
  });
  const listeners = process.stdin.listenerCount('data');
  const run = cmdRun('test task');
  await vi.advanceTimersByTimeAsync(15000);
  await run;
  expect(resume).toHaveBeenCalled();
  expect(pause).toHaveBeenCalled();
  expect(process.stdin.listenerCount('data')).toBe(listeners);
  expect(state.dispose).toHaveBeenCalled();
});
