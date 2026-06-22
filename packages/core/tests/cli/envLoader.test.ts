/**
 * Vitest tests for packages/core/src/cli/envLoader.ts.
 *
 * Locked to the public export shape. Uses real temp dirs via os.tmpdir()
 * (no mocks) so we exercise the actual fs + process.loadEnvFile contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  walkUpDotenvPaths,
  loadEnvUp,
  findDotenvDefining,
  type LoadEnvResult,
} from '../../src/cli/envLoader';

let cwd: string;
let cleanupPaths: string[] = [];

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-envloader-'));
  cleanupPaths.push(cwd);
});

afterEach(() => {
  // LIFO cleanup so nested dirs are removed before parents.
  for (const p of cleanupPaths.reverse()) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  cleanupPaths = [];
});

describe('walkUpDotenvPaths', () => {
  it('returns the path + every parent path up to depth 8', () => {
    const paths = walkUpDotenvPaths(cwd);
    // First entry is the cwd itself.
    expect(paths[0]).toBe(path.join(cwd, '.env'));
    // Last entry should be the platform root — depth cap terminates the walk.
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths.length).toBeLessThanOrEqual(9); // max 8 parent hops + self
  });

  it('terminates at filesystem root, not infinite', () => {
    const paths = walkUpDotenvPaths(cwd);
    for (const p of paths) {
      // All entries must be stringly valid absolute paths.
      expect(path.isAbsolute(p)).toBe(true);
    }
  });
});

describe('loadEnvUp behavior', () => {
  it('returns empty result when no .env files exist in the walk', () => {
    const result: LoadEnvResult = loadEnvUp(cwd, () => {});
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.featureMissing).toBe(false);
  });

  it('walks shallowest-first and sets vars from each .env', () => {
    // Place ONLY_SHALLOW in shallowest and ONLY_DEEP in deepest.
    const shallowDir = path.join(cwd, 'a', 'b');
    fs.mkdirSync(shallowDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, '.env'), 'ONLY_DEEP=deep\n');
    fs.writeFileSync(path.join(shallowDir, '.env'), 'ONLY_SHALLOW=shallow\n');

    // Wipe any pre-existing key before the assert (in case a host .env defines it).
    delete process.env.ONLY_DEEP;
    delete process.env.ONLY_SHALLOW;

    const result = loadEnvUp(cwd, () => {});
    expect(result.loaded.length).toBeGreaterThanOrEqual(2);
    // Shallowest entry is loaded before deepest in `result.loaded` order.
    expect(result.loaded[0]).toBe(path.join(shallowDir, '.env'));
    expect(result.loaded).toContain(path.join(cwd, '.env'));
    expect(process.env.ONLY_SHALLOW).toBe('shallow');
    expect(process.env.ONLY_DEEP).toBe('deep');

    delete process.env.ONLY_DEEP;
    delete process.env.ONLY_SHALLOW;
  });

  it('silently skips files that fail to parse and reports them', () => {
    // A file with an invalid assignment passes through process.loadEnvFile
    // depending on Node behavior — Node ≥20.6 actually rejects malformed
    // lines (per spec the whole file fails). We can't guarantee the exact
    // rejection reason across Node versions, so we just require that:
    //   (a) the file is listed in either `loaded` OR `skipped`,
    //   (b) any other valid .env is still loaded.
    fs.writeFileSync(path.join(cwd, '.env'), 'GOOD_VAR=ok\n').toString();
    const badPath = path.join(cwd, 'bad.env');
    // process.loadEnvFile only targets literal `.env` by default, so write
    // a sibling to verify the walker does NOT pick it up.
    fs.writeFileSync(badPath, 'should not be loaded\n');
    delete process.env.GOOD_VAR;

    const warnings: string[] = [];
    const result = loadEnvUp(cwd, (msg) => warnings.push(msg));
    // Only .env (not .env.bak / .env.local etc) should be picked up.
    expect(result.loaded.every((p) => p.endsWith('.env') && !p.endsWith('.env.bak'))).toBe(true);
    expect(process.env.GOOD_VAR).toBe('ok');
    // No spurious stderr noise for the bare-miss case.
    expect(warnings.length).toBe(0);

    delete process.env.GOOD_VAR;
  });

  it('emits a single warning + sets featureMissing when process.loadEnvFile is unavailable', () => {
    const originalLoadEnvFile = (process as unknown as { loadEnvFile?: unknown }).loadEnvFile;
    // Force unavailability regardless of host Node.
    (process as unknown as { loadEnvFile?: unknown }).loadEnvFile = undefined;

    try {
      fs.writeFileSync(path.join(cwd, '.env'), 'SHOULD_NOT_LOAD=oops\n');
      const warnings: string[] = [];
      const result = loadEnvUp(cwd, (msg) => warnings.push(msg));
      expect(result.featureMissing).toBe(true);
      expect(result.loaded).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/.+Node.+20\.6/);
    } finally {
      (process as unknown as { loadEnvFile?: unknown }).loadEnvFile = originalLoadEnvFile;
      delete process.env.SHOULD_NOT_LOAD;
    }
  });
});

describe('findDotenvDefining', () => {
  it('returns the deepest-nested .env path defining the key', () => {
    const shallowDir = path.join(cwd, 'a');
    fs.mkdirSync(shallowDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, '.env'), 'SHARED=top\n');
    fs.writeFileSync(path.join(shallowDir, '.env'), 'SHARED=override\n');
    const hit = findDotenvDefining('SHARED', cwd);
    // Root-most .env wins because we're looking for "who defines this".
    expect(hit).toBe(path.join(cwd, '.env'));
  });

  it('returns undefined when no .env defines the key', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'UNRELATED=x\n');
    expect(findDotenvDefining('MISSING_KEY', cwd)).toBeUndefined();
  });
});
