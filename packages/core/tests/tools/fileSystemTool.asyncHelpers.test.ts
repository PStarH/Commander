/**
 * Regression tests for async + TOCTOU-safe glob internals of FileSearchTool.
 *
 * Vitest 4 + package type:module cannot reliably rebind node:fs named/namespace
 * imports via vi.mock. These tests use:
 *   - real filesystem for ENOENT/ENOTDIR/happy-path
 *   - live replacement of fs.promises.readdir for EACCES
 *   - vi.spyOn(getGlobalLogger) for warn assertions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as logging from '../../src/logging';

async function makeTool(): Promise<import('../../src/tools/fileSystemTool').FileSearchTool> {
  const mod = await import('../../src/tools/fileSystemTool');
  return new mod.FileSearchTool();
}

type GlobFn = (dir: string, root: string, pattern: string, results: string[]) => Promise<void>;

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
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    warn = vi.fn();
    vi.spyOn(logging, 'getGlobalLogger').mockReturnValue({
      warn,
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as ReturnType<typeof logging.getGlobalLogger>);
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'globRecurse-'));
    tool = await makeTool();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('globRecurse yields no results (no throw) when the target dir is missing', async () => {
    const phantom = path.join(tmp, 'never-existed');
    const out = await invokeGlob(tool, 'globRecurse', phantom, tmp, '*.txt');
    expect(out).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('globRecurseDeep yields no results (no throw) when the target dir is missing', async () => {
    const phantom = path.join(tmp, 'never-existed');
    const out = await invokeGlob(tool, 'globRecurseDeep', phantom, tmp, '*.txt');
    expect(out).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('globRecurse returns no results when the "dir" path is actually a regular file (ENOTDIR)', async () => {
    const fileAsDir = path.join(tmp, 'i-am-a-file.txt');
    await fsp.writeFile(fileAsDir, 'hello', 'utf-8');
    const out = await invokeGlob(tool, 'globRecurse', fileAsDir, tmp, '*.txt');
    expect(out).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('globRecurseDeep returns no results when the "dir" path is actually a regular file (ENOTDIR)', async () => {
    const fileAsDir = path.join(tmp, 'i-am-a-file.txt');
    await fsp.writeFile(fileAsDir, 'hello', 'utf-8');
    const out = await invokeGlob(tool, 'globRecurseDeep', fileAsDir, tmp, '*.txt');
    expect(out).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('globRecurse falls back to a warn (and skips) when readdir throws EACCES', async () => {
    const original = fs.promises.readdir.bind(fs.promises);
    const readdirSpy = vi.fn(async (p: unknown, opts?: unknown) => {
      if (String(p) === tmp) {
        const err = new Error(
          `EACCES: permission denied, scandir '${String(p)}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return original(
        p as Parameters<typeof fsp.readdir>[0],
        opts as Parameters<typeof fsp.readdir>[1],
      );
    });
    (fs.promises as { readdir: typeof fs.promises.readdir }).readdir =
      readdirSpy as unknown as typeof fs.promises.readdir;
    try {
      const out = await invokeGlob(tool, 'globRecurse', tmp, tmp, '*.txt');
      expect(out).toEqual([]);
      expect(readdirSpy).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const call = warn.mock.calls[0]!;
      expect(call[0]).toBe('FileSystemTool');
      expect(call[1]).toBe('Directory scan failed');
      expect((call[2] as { error?: string }).error).toMatch(/EACCES/);
    } finally {
      (fs.promises as { readdir: typeof fs.promises.readdir }).readdir = original;
    }
  });

  it('globRecurse finds matching files in a real directory (happy path)', async () => {
    await fsp.writeFile(path.join(tmp, 'a.txt'), 'a', 'utf-8');
    await fsp.writeFile(path.join(tmp, 'b.txt'), 'b', 'utf-8');
    await fsp.mkdir(path.join(tmp, 'sub'));
    await fsp.writeFile(path.join(tmp, 'sub', 'c.txt'), 'c', 'utf-8');
    const out = await invokeGlob(tool, 'globRecurse', tmp, tmp, '*.txt');
    expect(out.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('globRecurseDeep recurses and skips node_modules + dotfiles', async () => {
    await fsp.writeFile(path.join(tmp, 'a.txt'), 'a', 'utf-8');
    await fsp.mkdir(path.join(tmp, 'sub'));
    await fsp.writeFile(path.join(tmp, 'sub', 'c.txt'), 'c', 'utf-8');
    await fsp.mkdir(path.join(tmp, 'node_modules'));
    await fsp.writeFile(path.join(tmp, 'node_modules', 'skip.txt'), 'x', 'utf-8');
    await fsp.mkdir(path.join(tmp, '.hidden'));
    await fsp.writeFile(path.join(tmp, '.hidden', 'skip.txt'), 'x', 'utf-8');
    const out = await invokeGlob(tool, 'globRecurseDeep', tmp, tmp, '*.txt');
    expect(out.sort()).toEqual(['a.txt', path.join('sub', 'c.txt')].sort());
  });
});
