/**
 * Regression tests for the async + TOCTOU-safe glob internals of
 * {@link FileSearchTool}.
 *
 * Public-API tests on `FileSearchTool.execute` cover the happy path, but
 * the `globRecurse` / `globRecurseDeep` helpers have a specific contract
 * that the public API does not exercise: when `fs.promises.readdir`
 * throws `ENOENT` / `ENOTDIR`, the helper must SILENTLY skip (no
 * exception propagates, no warn is logged). When it throws a non-ENOENT
 * error (e.g. `EACCES`), the helper must WARN via the global logger but
 * still continue without throwing.
 *
 * Without these tests someone could "optimize" the helpers back into a
 * `readdirSync + existsSync waltz` and the public API would still pass
 * the happy path. The TOCTOU window is what we're regression-guarding.
 *
 * IMPLEMENTATION NOTES:
 *
 * (1) **Dual `vi.mock` of `node:fs` AND `node:fs/promises`.** Source does
 *     `import * as fs from 'node:fs'; fs.promises.readdir(...)`. A naive
 *     `vi.mock('node:fs/promises')` does NOT intercept — `fs.promises`
 *     resolves through the parent module capture (Node ESM / CJS interop
 *     quirk) and bypasses the submodule-level mock. We mock `node:fs`
 *     too and swap its `promises` to the same spy-mocked submodule so
 *     both views share one spy instance.
 *
 * (2) **`fn.call(tool, ...)` to preserve `this` on prototype methods.**
 *     `globRecurse` calls `this.matchGlob(...)`. Extracting
 *     `tool[which]` into a local const and invoking it (`fn(...)`) loses
 *     the `this` binding under strict mode, so any test that exercises
 *     `matchGlob` (which is EVERY test in this file) needs `.call(tool,
 *     ...)`. `.bind(tool)` is equivalent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerWarnSpy = vi.fn();

const realRefs = vi.hoisted(() => ({
  readdir: null as typeof fsp.readdir | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  realRefs.readdir = actual.readdir.bind(actual);
  return { ...actual, readdir: vi.fn(actual.readdir) };
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

async function makeTool(): Promise<import('../../src/tools/fileSystemTool').FileSearchTool> {
  const mod = await import('../../src/tools/fileSystemTool');
  return new mod.FileSearchTool();
}

// Cast pattern: globRecurse / globRecurseDeep are TypeScript-private but
// reachable at runtime. We intentionally use a cast rather than a
// test-export seam so production code stays small. A method rename
// fails loudly here — that IS the desired signal.
type GlobFn = (dir: string, root: string, pattern: string, results: string[]) => Promise<void>;

// Bound invocation — preserves `this` for the prototype method
// `globRecurse` which references `this.matchGlob(...)` on every match
// check. Without `.call(tool, ...)`, `this` is `undefined` in strict
// mode and `this.matchGlob` throws TypeError.
function invokeGlob(
  tool: { globRecurse?: GlobFn; globRecurseDeep?: GlobFn },
  which: 'globRecurse' | 'globRecurseDeep',
  dir: string,
  root: string,
  pattern: string,
): Promise<string[]> {
  const fn = tool[which];
  if (!fn) throw new Error(`method renamed: ${which}`);
  const out: string[] = [];
  return fn.call(tool, dir, root, pattern, out).then(() => out);
}

describe('FileSearchTool async glob helpers — TOCTOU-safe skip semantics', () => {
  let tmp: string;
  let tool: Awaited<ReturnType<typeof makeTool>>;

  beforeEach(async () => {
    loggerWarnSpy.mockReset();
    vi.mocked(fsp.readdir).mockReset();
    vi.mocked(fsp.readdir).mockImplementation(realRefs.readdir as typeof fsp.readdir);
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'globRecurse-'));
    tool = await makeTool();
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('globRecurse yields no results (no throw) when the target dir is missing', async () => {
    const phantom = path.join(tmp, 'never-existed');
    const out = await invokeGlob(tool, 'globRecurse', phantom, tmp, '*.txt');
    expect(out).toEqual([]);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it('globRecurseDeep yields no results (no throw) when the target dir is missing', async () => {
    const phantom = path.join(tmp, 'never-existed');
    const out = await invokeGlob(tool, 'globRecurseDeep', phantom, tmp, '*.txt');
    expect(out).toEqual([]);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it('globRecurse returns no results when the "dir" path is actually a regular file (ENOTDIR)', async () => {
    const fileAsDir = path.join(tmp, 'i-am-a-file.txt');
    await fsp.writeFile(fileAsDir, 'hello', 'utf-8');
    const out = await invokeGlob(tool, 'globRecurse', fileAsDir, tmp, '*.txt');
    expect(out).toEqual([]);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it('globRecurseDeep returns no results when the "dir" path is actually a regular file (ENOTDIR)', async () => {
    const fileAsDir = path.join(tmp, 'i-am-a-file.txt');
    await fsp.writeFile(fileAsDir, 'hello', 'utf-8');
    const out = await invokeGlob(tool, 'globRecurseDeep', fileAsDir, tmp, '*.txt');
    expect(out).toEqual([]);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it('globRecurse falls back to a warn (and skips) when readdir throws EACCES', async () => {
    vi.mocked(fsp.readdir).mockImplementation(((p: unknown, opts?: unknown) => {
      if (String(p) === tmp) {
        const err = new Error(
          `EACCES: permission denied, scandir '${String(p)}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (realRefs.readdir as typeof fsp.readdir)(
        p as Parameters<typeof fsp.readdir>[0],
        opts as Parameters<typeof fsp.readdir>[1],
      );
    }) as typeof fsp.readdir);
    const out = await invokeGlob(tool, 'globRecurse', tmp, tmp, '*.txt');
    expect(out).toEqual([]);
    // Wrong-reason guard: readdir WAS called on the tmp dir (so the
    // EACCES throw was the implementation under test, not a regression
    // that bypassed the readdir call entirely).
    expect(vi.mocked(fsp.readdir)).toHaveBeenCalled();
    const calls = vi.mocked(fsp.readdir).mock.calls;
    expect(calls.some(([p]) => String(p) === tmp)).toBe(true);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    const call = loggerWarnSpy.mock.calls[0]!;
    expect(call[0]).toBe('FileSystemTool');
    expect(call[1]).toBe('Directory scan failed');
    expect((call[2] as { error?: string }).error).toMatch(/EACCES/);
  });

  it('globRecurse finds matching files in a real directory (happy path)', async () => {
    await fsp.writeFile(path.join(tmp, 'a.txt'), 'a', 'utf-8');
    await fsp.writeFile(path.join(tmp, 'b.txt'), 'b', 'utf-8');
    await fsp.mkdir(path.join(tmp, 'sub'));
    await fsp.writeFile(path.join(tmp, 'sub', 'c.txt'), 'c', 'utf-8');

    const out = await invokeGlob(tool, 'globRecurse', tmp, tmp, '*.txt');
    // globRecurse (the shallow variant) only scans the top level — entries
    // are reported relative to the root (tmp here). The sub/c.txt is
    // intentionally not returned; that's the documented contract.
    expect(out.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('globRecurseDeep recurses and skips node_modules + dotfiles', async () => {
    await fsp.writeFile(path.join(tmp, 'top.txt'), 't', 'utf-8');
    await fsp.mkdir(path.join(tmp, '.hidden'));
    await fsp.writeFile(path.join(tmp, '.hidden', 'inside.txt'), 'hidden', 'utf-8');
    await fsp.mkdir(path.join(tmp, 'node_modules'));
    await fsp.writeFile(path.join(tmp, 'node_modules', 'evil.txt'), 'evil', 'utf-8');
    await fsp.mkdir(path.join(tmp, 'real'));
    await fsp.writeFile(path.join(tmp, 'real', 'deep.txt'), 'd', 'utf-8');

    const out = await invokeGlob(tool, 'globRecurseDeep', tmp, tmp, '*.txt');
    expect(out.sort()).toEqual([path.join('real', 'deep.txt'), 'top.txt']);
  });
});
