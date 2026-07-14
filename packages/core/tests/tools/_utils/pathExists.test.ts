/**
 * Unit tests for the async `{@link pathExists}` util.
 *
 * Vitest 4 + package type:module cannot reliably intercept node:fs/promises
 * or local ESM named bindings. pathExists accepts optional access/report
 * injects so error-path tests do not depend on vi.mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathExists, type PathExistsAccess } from '../../../src/tools/_utils/pathExists';

describe('pathExists', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pathExists-'));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('returns true for an existing regular file', async () => {
    const file = path.join(tmp, 'real-file.txt');
    await fsp.writeFile(file, 'hello', 'utf-8');
    await expect(pathExists(file)).resolves.toBe(true);
  });

  it('returns true for an existing directory', async () => {
    await expect(pathExists(tmp)).resolves.toBe(true);
  });

  it('returns false for a missing file path (no throw)', async () => {
    const missing = path.join(tmp, 'definitely-not-here');
    await expect(pathExists(missing)).resolves.toBe(false);
  });

  it('returns false for a path inside a missing directory', async () => {
    const phantom = path.join(tmp, 'no-such-dir', 'no-such-file');
    await expect(pathExists(phantom)).resolves.toBe(false);
  });

  it('returns a Promise (never blocks synchronously)', async () => {
    const ret = pathExists(path.join(tmp, 'anything'));
    expect(ret).toBeInstanceOf(Promise);
    await ret;
  });

  it('reports non-ENOENT errors via reportSilentFailure and still returns false', async () => {
    const target = path.join(tmp, 'perm-denied');
    const access: PathExistsAccess = vi.fn(async (p: string) => {
      if (p === target) {
        const err = new Error(
          `EACCES: permission denied, access '${String(p)}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
    });
    const report = vi.fn();

    await expect(pathExists(target, access, report)).resolves.toBe(false);
    expect(access).toHaveBeenCalledWith(target, fs.constants.F_OK);
    expect(report).toHaveBeenCalledTimes(1);
    const [errArg, tagArg] = report.mock.calls[0]!;
    expect((errArg as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(String(tagArg)).toBe('pathExists');
  });

  it('uses fs.promises.access under F_OK (regression: must not switch to existsSync)', async () => {
    const access: PathExistsAccess = vi.fn(async () => undefined);
    const target = path.join(tmp, 'whatever');
    await pathExists(target, access);
    expect(access).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledWith(target, fs.constants.F_OK);
  });
});
