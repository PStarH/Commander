/**
 * Regression tests for `persistenceTool`'s lazy async init contract.
 *
 * Historical bug class: the original persistenceTool ran
 * `if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(...)` at MODULE LOAD time.
 * Imported synchronously at the top of every test in the suite, it blocked
 * the event loop during import and could not be cleaned up per test. The
 * fix moved dir creation into a one-shot `ensureMemoryDir()` helper called
 * on the first `execute()` invocation.
 *
 * What we regression-guard:
 *   1. Module load never calls `fs.promises.mkdir` for MEMORY_DIR — proven
 *      via `vi.resetModules()` + dynamic import WITH the mkdir spy already
 *      in place. A naive beforeEach-installed spy misses module-load calls
 *      because the import happens before the spy exists.
 *   2. First `execute()` creates the dir lazily.
 *   3. Two `execute()` calls share EXACTLY ONE mkdir (the wrapper is what
 *      we test; the underlying mkdir is idempotent under `recursive:true`).
 *   4. A mkdir failure propagates as a REJECTED PROMISE from `execute()`
 *      (the source does NOT wrap ensureMemoryDir in a try/catch) AND the
 *      cached promise resets so the next call retries (self-healing).
 *
 * IMPLEMENTATION NOTES:
 *
 * (a) `vi.mock('node:fs/promises', ...)` + `realRefs = vi.hoisted(...)`:
 *     vitest hoists `vi.mock` above imports AND forbids top-level vars
 *     from inside the factory body. `vi.hoisted` runs BEFORE imports +
 *     BEFORE the factory, so the captured ref is reliably populated with
 *     the unwrapped (real) impl. A naive `const realRefs = {}` would hit
 *     `ReferenceError: Cannot access 'realRefs' before initialization`.
 *
 * (b) `vi.resetModules()` runs in `beforeEach`: each test must get a fresh
 *     `persistenceTool` instance with `ensureMemoryDirOnce = undefined`.
 *     Without this reset the module-level singleton's resolved promise
 *     leaks across tests — the singleton assertion in test 3 would receive
 *     `0` mkdir calls (the mkdir already happened in test 2's cached
 *     instance).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const realRefs = vi.hoisted(() => ({
  mkdir: null as typeof fsp.mkdir | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  realRefs.mkdir = actual.mkdir.bind(actual);
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
  };
});

const EXPECTED_MEMORY_DIR = path.join(process.cwd(), '.commander_memory');

/** Windows CI can hit ENOTEMPTY/EBUSY while AV or node still holds files. */
async function rmMemoryDirRetry(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      await fsp.rm(EXPECTED_MEMORY_DIR, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  await fsp.rm(EXPECTED_MEMORY_DIR, { recursive: true, force: true });
}

describe('persistenceTool lazy async init contract', () => {
  beforeEach(async () => {
    await rmMemoryDirRetry();
    // Reset module cache so each test gets a fresh persistenceTool instance
    // with `ensureMemoryDirOnce = undefined`. Without this, the module-level
    // singleton from a prior test would suppress the mkdir calls that the
    // assertions in tests 2-4 are checking for.
    vi.resetModules();
    vi.mocked(fsp.mkdir).mockReset();
    vi.mocked(fsp.mkdir).mockImplementation(realRefs.mkdir as typeof fsp.mkdir);
  });

  afterEach(async () => {
    await rmMemoryDirRetry();
  });

  it('module load: importing persistenceTool does NOT mkdir for MEMORY_DIR', async () => {
    // beforeEach already called vi.resetModules(); we just install the
    // counting override before re-importing the module under test.
    const mkdirCallsForMemoryDir: Array<unknown[]> = [];
    vi.mocked(fsp.mkdir).mockImplementation(((p: unknown, opts: unknown) => {
      if (p === EXPECTED_MEMORY_DIR) mkdirCallsForMemoryDir.push([p, opts]);
      return (realRefs.mkdir as typeof fsp.mkdir)(
        p as Parameters<typeof fsp.mkdir>[0],
        opts as Parameters<typeof fsp.mkdir>[1],
      );
    }) as typeof fsp.mkdir);

    await import('../../src/tools/persistenceTool');

    expect(mkdirCallsForMemoryDir).toEqual([]);
    expect(await fsp.access(EXPECTED_MEMORY_DIR).catch(() => false)).toBe(false);
  });

  it('first execute() creates the dir lazily', async () => {
    const storeMod = await import('../../src/tools/persistenceTool');
    const storeTool = new storeMod.MemoryStoreTool();

    expect(await fsp.access(EXPECTED_MEMORY_DIR).catch(() => false)).toBe(false);

    const result = await storeTool.execute({
      key: 'k1',
      value: 'v1',
      namespace: 'default',
    });
    expect(result).toMatch(/^Stored "k1" in "default"/);

    const calls = vi.mocked(fsp.mkdir).mock.calls;
    expect(calls.some(([p]) => p === EXPECTED_MEMORY_DIR)).toBe(true);
  });

  it('two execute() calls share one mkdir for MEMORY_DIR (singleton lazy init)', async () => {
    const storeMod = await import('../../src/tools/persistenceTool');
    const storeTool = new storeMod.MemoryStoreTool();
    await storeTool.execute({ key: 'k1', value: 'v1' });
    await storeTool.execute({ key: 'k2', value: 'v2' });

    const calls = vi.mocked(fsp.mkdir).mock.calls;
    const memoryDirMkdirs = calls.filter(([p]) => p === EXPECTED_MEMORY_DIR);
    expect(memoryDirMkdirs.length).toBe(1);
  });

  it('mkdir failure on first call: rejection propagates + cache resets + retry succeeds', async () => {
    let memoryDirCalls = 0;
    vi.mocked(fsp.mkdir).mockImplementation(((p: unknown, opts: unknown) => {
      if (p === EXPECTED_MEMORY_DIR) {
        memoryDirCalls += 1;
        if (memoryDirCalls === 1) {
          const err = new Error(
            'simulated transient EACCES on memory dir',
          ) as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
      }
      return (realRefs.mkdir as typeof fsp.mkdir)(
        p as Parameters<typeof fsp.mkdir>[0],
        opts as Parameters<typeof fsp.mkdir>[1],
      );
    }) as typeof fsp.mkdir);

    const storeMod = await import('../../src/tools/persistenceTool');
    const storeTool = new storeMod.MemoryStoreTool();

    await expect(storeTool.execute({ key: 'k1', value: 'v1' })).rejects.toThrow(/EACCES/);
    expect(memoryDirCalls).toBe(1);

    await expect(storeTool.execute({ key: 'k2', value: 'v2' })).resolves.toMatch(/^Stored "k2"/);
    expect(memoryDirCalls).toBe(2);
  });

  it('store → recall → list round-trip works after lazy init', async () => {
    const storeMod = await import('../../src/tools/persistenceTool');
    const store = new storeMod.MemoryStoreTool();
    await store.execute({ key: 'project/alpha', value: 'ship-it', namespace: 'projects' });
    await store.execute({ key: 'project/beta', value: 'delay-it', namespace: 'projects' });

    const recall = new storeMod.MemoryRecallTool();
    const recalled = await recall.execute({ key: 'project/alpha', namespace: 'projects' });
    expect(recalled).toContain('ship-it');

    const listing = await new storeMod.MemoryListTool().execute();
    expect(listing).toMatch(/projects: \d+ entries/);
  });
});
