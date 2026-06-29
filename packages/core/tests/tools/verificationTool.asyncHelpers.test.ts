/**
 * Regression tests for `VerificationTool`'s async `hasTool` / `hasFile`
 * helpers.
 *
 * Original sync implementation called `fs.existsSync` inside a try/catch
 * that swallowed errors with a single generic warn. Async conversion
 * tightens the contract:
 *   - `ENOENT` / `ENOTDIR` are SILENT misses — return `false` and do NOT
 *     call `globalLogger.warn`.
 *   - Any other error (`EACCES`, `EMFILE`, …) is a REAL config issue —
 *     return `false` AND emit a warn via `globalLogger.warn`.
 *
 * Without these tests the warn path could regress silently and CI would
 * skip linting/typechecking whenever a permission glitch occurred.
 *
 * IMPLEMENTATION NOTES:
 *
 * (1) **Dual `vi.mock` of `node:fs` AND `node:fs/promises`.** Source does
 *     `import * as fs from 'node:fs'; fs.promises.access(...)`. A naive
 *     `vi.mock('node:fs/promises')` does NOT intercept — `fs.promises`
 *     resolves through the parent module capture (Node ESM / CJS interop
 *     quirk). We mock `node:fs` to swap its `promises` to the same
 *     spy-mocked submodule so source and test share one spy instance.
 *
 * (2) **`vi.hoisted` for shared state.** Vitest hoists `vi.mock` above
 *     imports AND forbids top-level vars from inside the factory body.
 *     `vi.hoisted` runs BEFORE imports + BEFORE the factory and is the
 *     only safe way to share state between factory and tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerWarnSpy = vi.fn();

const realRefs = vi.hoisted(() => ({
  access: null as typeof fsp.access | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  realRefs.access = actual.access.bind(actual);
  return { ...actual, access: vi.fn(actual.access) };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mockedPromises = await import('node:fs/promises');
  return {
    ...actual,
    promises: mockedPromises,
    default: { ...actual, promises: mockedPromises },
  };
});

vi.mock('../../src/logging', () => ({
  getGlobalLogger: () => ({
    warn: (...args: unknown[]) => loggerWarnSpy(...args),
    debug: () => undefined,
    info: () => undefined,
    error: () => undefined,
  }),
}));

async function makeTool(): Promise<import('../../src/tools/verificationTool').VerificationTool> {
  const mod = await import('../../src/tools/verificationTool');
  return new mod.VerificationTool();
}

type PredFn = (cwd: string, name: string) => Promise<boolean>;
function invoke(
  tool: { hasTool?: PredFn; hasFile?: PredFn },
  which: 'hasTool' | 'hasFile',
  cwd: string,
  name: string,
): Promise<boolean> {
  const fn = tool[which];
  if (!fn) throw new Error(`method renamed: ${which}`);
  // hasTool / hasFile do NOT reference `this` (they only touch
  // `fs.promises.access` and the global logger), so binding isn't
  // strictly required here — but we keep `.call(tool, ...)` for
  // consistency with fileSystemTool.asyncHelpers.test.ts and as a
  // future-proofing guard in case `this` becomes referenced.
  return fn.call(tool, cwd, name);
}

describe('VerificationTool hasTool / hasFile async helpers', () => {
  let tmp: string;
  let tool: Awaited<ReturnType<typeof makeTool>>;

  beforeEach(async () => {
    loggerWarnSpy.mockReset();
    vi.mocked(fsp.access).mockReset();
    vi.mocked(fsp.access).mockImplementation(
      realRefs.access as typeof fsp.access,
    );
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'verifyTool-'));
    tool = await makeTool();
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  describe('happy path', () => {
    it('hasTool returns true when the relative path exists', async () => {
      await fsp.writeFile(path.join(tmp, 'present.txt'), 'x', 'utf-8');
      await expect(invoke(tool, 'hasTool', tmp, 'present.txt')).resolves.toBe(true);
    });

    it('hasFile returns true when the relative file exists', async () => {
      await fsp.writeFile(path.join(tmp, 'tsconfig.json'), '{}', 'utf-8');
      await expect(invoke(tool, 'hasFile', tmp, 'tsconfig.json')).resolves.toBe(true);
    });
  });

  describe('silent-miss path (ENOENT / ENOTDIR — no warn)', () => {
    it('hasTool: missing relPath → false, NO warn', async () => {
      await expect(invoke(tool, 'hasTool', tmp, 'not-here')).resolves.toBe(false);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('hasFile: missing file → false, NO warn', async () => {
      await expect(invoke(tool, 'hasFile', tmp, 'tsconfig.json')).resolves.toBe(false);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('hasTool: relative path used against a file (ENOTDIR) → false, NO warn', async () => {
      const file = path.join(tmp, 'i-am-file.txt');
      await fsp.writeFile(file, '', 'utf-8');
      await expect(invoke(tool, 'hasTool', file, 'sub/whatever.txt')).resolves.toBe(false);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('real-error path (EACCES / EMFILE — MUST warn)', () => {
    it('hasTool: simulated EACCES → false AND warns via getGlobalLogger', async () => {
      vi.mocked(fsp.access).mockImplementation(
        ((p: unknown) => {
          const err = new Error(
            `EACCES: permission denied, access '${String(p)}'`,
          ) as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }) as typeof fsp.access,
      );
      await expect(invoke(tool, 'hasTool', tmp, 'whatever')).resolves.toBe(false);
      // Wrong-reason guard: access MUST have been called on the joined
      // path with F_OK. A regression that drops the access call entirely
      // would also return false (just via a different error path) — this
      // assertion pins the contract.
      expect(vi.mocked(fsp.access)).toHaveBeenCalledWith(
        path.join(tmp, 'whatever'),
        fs.constants.F_OK,
      );
      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      const args = loggerWarnSpy.mock.calls[0]!;
      expect(args[0]).toBe('VerificationTool');
      expect(args[1]).toBe('Tool check failed');
      const ctx = args[2] as { error?: string; relPath?: string };
      expect(ctx.error).toMatch(/EACCES/);
      expect(ctx.relPath).toBe('whatever');
    });

    it('hasFile: simulated EMFILE → false AND warns via getGlobalLogger', async () => {
      vi.mocked(fsp.access).mockImplementation(
        ((p: unknown) => {
          const err = new Error(
            `EMFILE: too many open files, access '${String(p)}'`,
          ) as NodeJS.ErrnoException;
          err.code = 'EMFILE';
          throw err;
        }) as typeof fsp.access,
      );
      await expect(invoke(tool, 'hasFile', tmp, 'package.json')).resolves.toBe(false);
      expect(vi.mocked(fsp.access)).toHaveBeenCalledWith(
        path.join(tmp, 'package.json'),
        fs.constants.F_OK,
      );
      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      const args = loggerWarnSpy.mock.calls[0]!;
      expect(args[0]).toBe('VerificationTool');
      expect(args[1]).toBe('File check failed');
      const ctx = args[2] as { error?: string; name?: string };
      expect(ctx.error).toMatch(/EMFILE/);
      expect(ctx.name).toBe('package.json');
    });
  });

  it('uses fs.promises.access under F_OK (regression: must not use existsSync)', async () => {
    await invoke(tool, 'hasFile', tmp, 'whatever');
    const calls = vi.mocked(fsp.access).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastMode = calls[calls.length - 1]?.[1];
    expect(lastMode).toBe(fs.constants.F_OK);
  });
});
