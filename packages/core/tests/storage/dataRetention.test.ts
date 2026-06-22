import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataRetentionJanitor } from '../../src/storage/dataRetention';

describe('DataRetentionJanitor schedule() boolean-return dedup contract', () => {
  // Initialized to empty strings so `if (otherRoot)` and the
  // afterEach rmSync branches are guarded at every boundary; beforeEach
  // and the cross-rootDir it() reassign them to fresh mkdtemp paths.
  let tmpRoot = '';
  let otherRoot = '';
  let janitorA: DataRetentionJanitor;
  let janitorB: DataRetentionJanitor;
  // janitorC is hoisted so afterEach can guarantee teardown even if
  // a test body throws BEFORE its in-test janitorC.stopSchedule() call.
  let janitorC: DataRetentionJanitor | null = null;
  // janitorX is hoisted for the same reason: the 3-janitor Promise.all
  // race-test constructs it locally; if it's the FIFO-claim winner
  // (in some future scheduler swap) afterEach must stop it or it leaks
  // tmpRoot into the next test's scheduledRootDirs Set.
  let janitorX: DataRetentionJanitor | null = null;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-janitor-dedup-'));
    janitorA = new DataRetentionJanitor({ rootDir: tmpRoot });
    janitorB = new DataRetentionJanitor({ rootDir: tmpRoot });
  });

  afterEach(() => {
    // Dedup-aware teardown: stop C first if it was opened (dedup-catch),
    // then the claimed pair, so the module-level `scheduledRootDirs`
    // Set is empty for the next test.
    if (janitorC) {
      janitorC.stopSchedule();
      janitorC = null;
    }
    if (janitorX) {
      janitorX.stopSchedule();
      janitorX = null;
    }
    janitorB.stopSchedule();
    janitorA.stopSchedule();
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([]);
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    if (otherRoot) {
      try {
        fs.rmSync(otherRoot, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      otherRoot = '';
    }
  });

  it('first instance claims (true), second dedup-catches (false); scheduledRootDirs has exactly one entry', () => {
    // Initial state is empty
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([]);

    // First instance claims the tick on this rootDir
    const claimedA = janitorA.schedule(60 * 60 * 1000, false);
    expect(claimedA).toBe(true);
    expect(janitorA.isScheduled()).toBe(true);
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);

    // Second instance dedup-catches: returns false, never sets its own intervalRef
    const claimedB = janitorB.schedule(60 * 60 * 1000, false);
    expect(claimedB).toBe(false);
    expect(janitorB.isScheduled()).toBe(false);
    // The set is unchanged: still exactly the one rootDir
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);
  });

  it('releasing via stopSchedule() unblocks the same rootDir for the next claimer', () => {
    janitorA.schedule(60 * 60 * 1000, false);
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);

    // A steps down \u2014 release the rootDir
    janitorA.stopSchedule();
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([]);

    // B can now claim the same rootDir
    const claimedB = janitorB.schedule(60 * 60 * 1000, false);
    expect(claimedB).toBe(true);
    expect(janitorB.isScheduled()).toBe(true);
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);
  });

  it('different rootDirs are independent keyed slots', () => {
    otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-janitor-other-'));
    janitorC = new DataRetentionJanitor({ rootDir: otherRoot });

    const aClaimed = janitorA.schedule(60 * 60 * 1000, false);
    const cClaimed = janitorC.schedule(60 * 60 * 1000, false);

    expect(aClaimed).toBe(true);
    expect(cClaimed).toBe(true);
    expect(DataRetentionJanitor.getScheduledRootDirs().sort()).toEqual(
      [tmpRoot, otherRoot].sort(),
    );

    // Releasing one doesn't affect the other
    janitorC.stopSchedule();
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);
    expect(janitorA.isScheduled()).toBe(true);
  });

  it('Promise.all race: exactly one claims, the other dedup-catches under async wrapping', async () => {
    // schedule() is internally synchronous (no awaits between the Set
    // dedup read and the setInterval write), so unawaited sequential
    // calls would be deterministic. Promise.all + Promise.resolve
    // wrapping schedules both schedule() calls on the microtask queue
    // in FIFO order — the first to fire claims the tick, the second
    // dedup-catches. The boolean return makes the winner visible.
    const [claimedA, claimedB] = await Promise.all([
      Promise.resolve(janitorA.schedule(60 * 60 * 1000, false)),
      Promise.resolve(janitorB.schedule(60 * 60 * 1000, false)),
    ]);

    // Exactly one claims (true); the other dedup-catches (false).
    // `.toContain` over `.sort().toEqual([false, true])` reads more
    // naturally without depending on `false < true` lexicographic ordering.
    expect([claimedA, claimedB]).toContain(true);
    expect([claimedA, claimedB]).toContain(false);

    // The module-level scheduledRootDirs Set still has exactly one entry.
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);

    // Cross-check via the public isScheduled() test hook: the claimer
    // has a live setInterval on its intervalRef; the dedup-catcher
    // never created one. Exactly one isScheduled === true.
    const liveCount = [janitorA.isScheduled(), janitorB.isScheduled()]
      .filter((b) => b === true).length;
    expect(liveCount).toBe(1);
  });

  it('Promise.all race over 3 janitors on the same rootDir: exactly one claims, two dedup-catch under N-way fan-out', async () => {
    // Extend the 2-way race to N=3 to confirm the dedup invariant is
    // not a coincidence of the 2-element case. The first microtask
    // wins; the other two dedup-catch.
    janitorX = new DataRetentionJanitor({ rootDir: tmpRoot });

    const [claimedA, claimedB, claimedX] = await Promise.all([
      Promise.resolve(janitorA.schedule(60 * 60 * 1000, false)),
      Promise.resolve(janitorB.schedule(60 * 60 * 1000, false)),
      Promise.resolve(janitorX.schedule(60 * 60 * 1000, false)),
    ]);

    // Strength assertions: not just "contains both" but exact counts.
    expect([claimedA, claimedB, claimedX].filter((b) => b === true)).toHaveLength(1);
    expect([claimedA, claimedB, claimedX].filter((b) => b === false)).toHaveLength(2);

    // Module-level dedup invariant: still exactly one entry, not three.
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);

    // Cross-check via isScheduled(): exactly one tick live.
    const liveCount = [
      janitorA.isScheduled(),
      janitorB.isScheduled(),
      janitorX.isScheduled(),
    ].filter((b) => b === true).length;
    expect(liveCount).toBe(1);
  });

  it('isScheduled() flips true → false → true across stop+re-schedule on the same instance', () => {
    // Lifecycle round-trip on a SINGLE instance. The existing cases
    // only verify claim-or-dedup at schedule-time; this asserts the
    // `isScheduled()` cross-invariant across the full lifecycle:
    //   claim   → isScheduled === true   (intervalRef set, rootDir pending)
    //   stop    → isScheduled === false  (interval cleared, rootDir released)
    //   resched → isScheduled === true   (this instance reclaims its own slot)
    expect(janitorA.isScheduled()).toBe(false);

    // 1. claim
    const claimed1 = janitorA.schedule(60 * 60 * 1000, false);
    expect(claimed1).toBe(true);
    expect(janitorA.isScheduled()).toBe(true);
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);

    // 2. stop releases the tick
    janitorA.stopSchedule();
    expect(janitorA.isScheduled()).toBe(false);
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([]);

    // 3. re-schedule on the SAME instance claims again (slot freed by step 2)
    const claimed2 = janitorA.schedule(60 * 60 * 1000, false);
    expect(claimed2).toBe(true);
    expect(janitorA.isScheduled()).toBe(true);
    expect(DataRetentionJanitor.getScheduledRootDirs()).toEqual([tmpRoot]);
  });
});
