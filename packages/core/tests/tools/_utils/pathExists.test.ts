/**
 * Unit tests for the async `{@link pathExists}` util.
 *
 * Regression-guard for the event-loop-friendly boolean contract:
 *   (a) returns a Promise (never blocks on a sync fs.existsSync);
 *   (b) returns `false` (never throws) for missing paths;
 *   (c) surfaces non-ENOENT errors through `reportSilentFailure` so
 *       observability sees them;
 *   (d) works for both files and directories;
 *   (e) uses `fs.promises.access` under `F_OK` (cheaper than stat and
 *       definitely not existsSync).
 *
 * IMPLEMENTATION NOTES:
 *
 * (1) **Dual `vi.mock` of `node:fs` AND `node:fs/promises`.** Source code
 *     does `import * as fs from 'node:fs'; fs.promises.X`. A naive
 *     `vi.mock('node:fs/promises')` does NOT intercept — `fs.promises`
 *     is resolved through the parent module capture (Node ESM / CJS
 *     interop quirk) and bypasses the submodule-level mock. We have to
 *     additionally mock `node:fs` and override its `promises` to point
 *     back to the same spy-mocked submodule so both `fs.promises.X`
 *     (source) and `fsp.X` (test) resolve to ONE spy instance. This is
 *     the canonical pattern documented in vitest docs.
 *
 * (2) **`vi.hoisted` for shared state between factory and tests.** Vitest
 *     hoists `vi.mock` above imports AND forbids top-level vars from
 *     inside the factory body. `vi.hoisted` runs BEFORE imports + BEFORE
 *     the factory body and is the only safe way to share state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const silentFailureSpy = vi.fn();

const realRefs = vi.hoisted(() => ({
  access: null as typeof fsp.access | null,
}));

// (1a) Mock the submodule. Spy `access` and capture the real impl so
//      per-test `mockImplementation(...)` can fall through for unrelated
//      probes (e.g. mkdtemp, writeFile, rm) without recursion.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  realRefs.access = actual.access.bind(actual);
  return { ...actual, access: vi.fn(actual.access) };
});

// (1b) Mock the parent module — swap `promises` so `fs.promises.X` in
//      source code resolves to the SAME spy instance the test file sees
//      via `import * as fsp from 'node:fs/promises'`. Both views share
//      one function reference so `vi.mocked(fsp.access).mock.calls`
//      counts source calls too.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mockedPromises = await import('node:fs/promises');
  return {
    ...actual,
    promises: mockedPromises,
    // Some CJS-interop import patterns read `.default.promises`. Mirror
    // it for robustness.
    default: { ...actual, promises: mockedPromises },
  };
});

vi.mock('../../../src/silentFailureReporter', () => ({
  reportSilentFailure: (...args: unknown[]) => silentFailureSpy(...args),
}));

// Dynamic import inside test body ensures the mocked `node:fs/promises`
// (and the swapped `node:fs.promises`) is the version source code sees.
async function pathExistsMocked(p: string): Promise<boolean> {
  const mod = await import('../../../src/tools/_utils/pathExists');
  return mod.pathExists(p);
}

describe('pathExists', () => {
  let tmp: string;

  beforeEach(async () => {
    silentFailureSpy.mockReset();
    vi.mocked(fsp.access).mockReset();
    // Default passthrough via refs — the real impl captured during
    // vi.mock factory execution BEFORE vitest wrapped the export.
    // Using `realRefs.access` (not `fsp.access`) avoids the recursion
    // bug from calling a live spy from inside its own mock impl.
    vi.mocked(fsp.access).mockImplementation(
      realRefs.access as typeof fsp.access,
    );
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pathExists-'));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('returns true for an existing regular file', async () => {
    const file = path.join(tmp, 'real-file.txt');
    await fsp.writeFile(file, 'hello', 'utf-8');
    await expect(pathExistsMocked(file)).resolves.toBe(true);
  });

  it('returns true for an existing directory', async () => {
    await expect(pathExistsMocked(tmp)).resolves.toBe(true);
  });

  it('returns false for a missing file path (no throw)', async () => {
    const missing = path.join(tmp, 'definitely-not-here');
    await expect(pathExistsMocked(missing)).resolves.toBe(false);
  });

  it('returns false for a path inside a missing directory', async () => {
    const phantom = path.join(tmp, 'no-such-dir', 'no-such-file');
    await expect(pathExistsMocked(phantom)).resolves.toBe(false);
  });

  it('returns a Promise (never blocks synchronously)', async () => {
    const ret = pathExistsMocked(path.join(tmp, 'anything'));
    expect(ret).toBeInstanceOf(Promise);
    await ret;
  });

  it('reports non-ENOENT errors via reportSilentFailure and still returns false', async () => {
    const target = path.join(tmp, 'perm-denied');
    await fsp.writeFile(target, '', 'utf-8');
    vi.mocked(fsp.access).mockImplementation(
      ((p: unknown, _mode?: number) => {
        if (p === target) {
          const err = new Error(
            `EACCES: permission denied, access '${String(p)}'`,
          ) as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        // Unrelated probes fall through to the real impl via refs.
        return (realRefs.access as typeof fsp.access)(
          p as Parameters<typeof fsp.access>[0],
          _mode,
        );
      }) as typeof fsp.access,
    );

    await expect(pathExistsMocked(target)).resolves.toBe(false);
    // Wrong-reason guard: the access call must actually have been issued
    // against the target path with F_OK. Without this assertion a
    // regression that drops the access call entirely would still pass.
    expect(vi.mocked(fsp.access)).toHaveBeenCalledWith(target, fs.constants.F_OK);
    expect(silentFailureSpy).toHaveBeenCalledTimes(1);
    const [errArg, tagArg] = silentFailureSpy.mock.calls[0]!;
    expect((errArg as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(String(tagArg)).toBe('pathExists');
  });

  it('uses fs.promises.access under F_OK (regression: must not switch to existsSync)', async () => {
    await pathExistsMocked(path.join(tmp, 'whatever'));
    const calls = vi.mocked(fsp.access).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastMode = calls[calls.length - 1]?.[1];
    expect(lastMode).toBe(fs.constants.F_OK);
  });
});
