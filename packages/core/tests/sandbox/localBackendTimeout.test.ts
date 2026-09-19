/**
 * LocalBackend must propagate the per-call deadline into the sandbox profile.
 *
 * ExecutionRouter passes `timeout` in seconds; `SandboxProfile.timeout` is in
 * milliseconds and is the policy maximum. The backend used to call
 * `sandbox.execute(command, 'workspace-write', workdir, undefined, context)`,
 * dropping the requested deadline entirely, so `execSandboxed`'s timeoutSec did
 * not bound sandboxed local execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeSpy, profileSpy } = vi.hoisted(() => ({
  executeSpy: vi.fn(),
  profileSpy: vi.fn(),
}));

vi.mock('../../src/sandbox/manager', () => ({
  getSandboxManager: () => ({
    hasSandbox: () => true,
    getProfile: profileSpy,
    execute: executeSpy,
  }),
}));

import { LocalBackend } from '../../src/sandbox/backends/localBackend';

function baseProfile(timeout?: number) {
  return {
    mode: 'workspace-write' as const,
    network: 'none' as const,
    filesystem: {
      readablePaths: [],
      writablePaths: [],
      protectedPaths: [],
      useStagingDir: false,
    },
    ...(timeout === undefined ? {} : { timeout }),
  };
}

describe('LocalBackend per-call sandbox deadline', () => {
  beforeEach(() => {
    executeSpy.mockReset();
    profileSpy.mockReset();
    profileSpy.mockReturnValue(baseProfile(30_000));
    executeSpy.mockImplementation(async (_cmd: string, profile: { timeout?: number }) => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      sandboxMechanism: 'sandbox-exec' as const,
      _seenTimeout: profile.timeout,
    }));
  });

  async function seenTimeout(timeout?: number): Promise<number | undefined> {
    const backend = new LocalBackend();
    await backend.execute('echo hello', undefined, timeout);
    expect(executeSpy).toHaveBeenCalled();
    const passedProfile = executeSpy.mock.calls.at(-1)?.[1] as { timeout?: number };
    return passedProfile.timeout;
  }

  it('converts the requested seconds into milliseconds', async () => {
    expect(await seenTimeout(5)).toBe(5000);
  });

  it('caps a request above the profile policy maximum', async () => {
    expect(await seenTimeout(600)).toBe(30_000);
  });

  it('falls back to the profile deadline for missing/invalid requests', async () => {
    expect(await seenTimeout(undefined)).toBe(30_000);
    expect(await seenTimeout(Number.NaN)).toBe(30_000);
    expect(await seenTimeout(0)).toBe(30_000);
    expect(await seenTimeout(-5)).toBe(30_000);
  });

  it('uses the request when the profile declares no deadline', async () => {
    profileSpy.mockReturnValue(baseProfile(undefined));
    expect(await seenTimeout(2)).toBe(2000);
  });

  it('does not mutate the shared profile object', async () => {
    const shared = baseProfile(30_000);
    profileSpy.mockReturnValue(shared);
    await seenTimeout(5);
    expect(shared.timeout).toBe(30_000);
  });
});
