/**
 * Regression: three-layer memory persistence must actually touch the disk.
 *
 * Before 2026-09-16, `save()` and `load()` called the bare global `require`,
 * which does not exist in this ES-module package. The resulting
 * `ReferenceError: require is not defined` was caught by their own
 * `try`/`catch` and logged as "Save failed"/"Load failed", so:
 *
 *   - `save()` returned 0 and wrote no file, while `hasPersistence()` — which
 *     only checks that a path was configured — returned `true`;
 *   - `load()` returned 0 for a file that was never written.
 *
 * The pre-existing suite only asserted the *absence* of a `persistPath`
 * ("stays file/disk inert"), so a broken persist path was never exercised.
 * These tests assert the round trip, which fails loudly if the file is not
 * written or not read back.
 *
 * Scope caveat (measured 2026-09-16): vitest supplies its own `require`
 * binding, so these tests **pass against the buggy code too** and therefore do
 * NOT reproduce the original mechanism. They are a behavioural guard on the
 * save/load contract only. The mechanism is covered by
 * `tests/architecture/noBareRequire.test.ts` (static, runner-independent) and
 * `tests/architecture/esmRequire.test.ts` (`node:test`, which has no such shim).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ThreeLayerMemory } from '../../src/threeLayerMemory';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-persist-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('ThreeLayerMemory persistence', () => {
  it('save() writes the configured persist file', () => {
    const persistPath = join(tempDir(), 'memory.json');
    const mem = new ThreeLayerMemory({ persistPath });

    expect(mem.hasPersistence()).toBe(true);
    const written = mem.save();

    // A missing file is the exact symptom of the require() failing silently.
    expect(existsSync(persistPath)).toBe(true);
    expect(typeof written).toBe('number');

    const parsed = JSON.parse(readFileSync(persistPath, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBe(written);
  });

  it('load() restores entries written by a previous instance', () => {
    const persistPath = join(tempDir(), 'memory.json');

    const first = new ThreeLayerMemory({ persistPath });
    const entry = first.add('persist round-trip marker', 'longterm', 'regression', 0.9);
    expect(entry).toBeTruthy();

    const written = first.save();
    expect(written).toBeGreaterThan(0);

    const second = new ThreeLayerMemory({ persistPath });
    expect(second.load()).toBe(written);
    expect(readFileSync(persistPath, 'utf8')).toContain('persist round-trip marker');
  });

  it('save() with no persistPath is inert and reports 0', () => {
    const mem = new ThreeLayerMemory();
    expect(mem.hasPersistence()).toBe(false);
    expect(mem.save()).toBe(0);
    expect(mem.load()).toBe(0);
  });
});
