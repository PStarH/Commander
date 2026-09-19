/**
 * Compensation queue PARITY — one shared scenario table, two implementations.
 *
 * The two compensation-queue suites in this directory were written separately
 * (`inMemoryCompensationQueue.test.ts` covers the in-memory double, then repeats
 * a handful of `describe.skipIf` cases against SQLite). Parity between
 * `CompensationQueue` (better-sqlite3) and `InMemoryCompensationQueue` was
 * therefore *claimed* by two hand-copied files, never *measured*.
 *
 * This file measures it: a single scenario table is executed against BOTH
 * implementations and the observable outcome of each scenario (return value,
 * thrown error, queue status, attempt count, claim generation, visibility) is
 * compared. A divergence fails the test with the full diff of both logs.
 *
 * Two properties are asserted per scenario, in opposite directions, so neither
 * can hide the other:
 *
 *   1. Contract — the scenario body asserts the shared behavioural contract
 *      (AR-03 / compensationQueue.ts doc block) against whichever
 *      implementation it is driving. A bug shared by both implementations
 *      cannot pass as "parity".
 *   2. Equality — the logs produced by the two implementations must be strictly
 *      equal. A divergence on one side fails even when that side satisfies its
 *      own contract assertions.
 *
 * Deliberate non-goals (stated so the green result is not over-read):
 *   - No multi-process contention, durability or crash-recovery claim. SQLite
 *     WAL durability and real cross-process races are not exercised here.
 *   - Error *wording* is compared only where the two implementations already
 *     promise the same message. A duplicate-id conflict is compared by refusal
 *     class (`duplicate-id`), because better-sqlite3 reports its native
 *     `UNIQUE constraint failed` text while the double raises its own.
 *
 * When better-sqlite3 is unavailable for this Node ABI the whole suite skips
 * loudly (`describe.skipIf`) and reports zero executed parity scenarios — a
 * skip, never a pass.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { CompensationQueue, CLAIM_EXPIRED_REASON } from '../compensationQueue';
import type {
  CompensationClaim,
  CompensationQueueConfig,
  CompensationQueueItem,
  CompensationReceipt,
  CompensationStatus,
  CompensationWriteOutcome,
} from '../compensationQueue';
import { InMemoryCompensationQueue } from '../inMemoryCompensationQueue';
import { runWithTenant } from '../../runtime/tenantContext';

const nodeRequire = createRequire(import.meta.url);
let sqliteAvailable = false;
try {
  const Database = nodeRequire('better-sqlite3');
  const probe = new Database(':memory:');
  probe.prepare('SELECT 1').get();
  probe.close();
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

/** Fixed fake-clock origin so both implementations observe identical timestamps. */
const BASE_TIME = '2026-02-01T00:00:00.000Z';

// ─── The two sides of the parity comparison ─────────────────────────────────

interface EnqueueInput {
  id: string;
  runId: string;
  agentId?: string;
  tenantId?: string;
  toolName: string;
  args: unknown;
  compensationHandlerKey: string;
  maxAttempts?: number;
}

/** The common public surface both queue classes are expected to expose. */
interface QueueSurface {
  enqueue(input: EnqueueInput): void;
  claimNext(): CompensationQueueItem | null;
  markCompleted(id: string, claim?: CompensationClaim): boolean;
  markFailed(
    id: string,
    error: string,
    claim?: CompensationClaim | number,
  ): CompensationWriteOutcome;
  markEscalated(id: string, error: string, claim?: CompensationClaim): boolean;
  retry(id: string, tenantId?: string): boolean;
  get(id: string): CompensationQueueItem | null;
  getReceipt(id: string): CompensationReceipt | null;
  list(opts?: { limit?: number; status?: CompensationStatus }): CompensationQueueItem[];
  countByStatus(): Record<CompensationStatus, number>;
  close(): void;
}

type RawQueue = CompensationQueue | InMemoryCompensationQueue;

/**
 * Bridge the overloaded class methods to the single optional-argument surface.
 * `markFailed(…, 0)` deliberately supplies a legacy numeric third argument,
 * which both implementations classify as "not a claim" and refuse — that is the
 * missing-claim case the contract requires.
 */
function toSurface(raw: RawQueue): QueueSurface {
  return {
    enqueue: (input) => raw.enqueue(input),
    claimNext: () => raw.claimNext(),
    markCompleted: (id, claim) => (claim ? raw.markCompleted(id, claim) : raw.markCompleted(id)),
    markFailed: (id, error, claim) =>
      typeof claim === 'number'
        ? raw.markFailed(id, error, claim)
        : claim
          ? raw.markFailed(id, error, claim)
          : raw.markFailed(id, error, 0),
    markEscalated: (id, error, claim) =>
      claim ? raw.markEscalated(id, error, claim) : raw.markEscalated(id, error),
    retry: (id, tenantId) => (tenantId ? raw.retry(id, tenantId) : raw.retry(id)),
    get: (id) => raw.get(id),
    getReceipt: (id) => raw.getReceipt(id),
    list: (opts) => raw.list(opts),
    countByStatus: () => raw.countByStatus(),
    close: () => raw.close(),
  };
}

interface ImplHarness {
  readonly label: string;
  make(config: Partial<CompensationQueueConfig>): { raw: RawQueue; dispose(): void };
  resetGlobalState(): void;
}

const sqliteHarness: ImplHarness = {
  label: 'CompensationQueue(better-sqlite3)',
  make(config) {
    const dir = mkdtempSync(join(tmpdir(), 'commander-compq-parity-'));
    const raw = new CompensationQueue({ filePath: join(dir, 'queue.db'), ...config });
    return { raw, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  },
  resetGlobalState() {
    // SQLite state lives in the per-run temp file; nothing global to reset.
  },
};

let memoryStoreSeq = 0;
const inMemoryHarness: ImplHarness = {
  label: 'InMemoryCompensationQueue',
  make(config) {
    const filePath = join(
      tmpdir(),
      `commander-compq-parity-mem-${process.pid}-${++memoryStoreSeq}.db`,
    );
    return { raw: new InMemoryCompensationQueue({ filePath, ...config }), dispose() {} };
  },
  resetGlobalState() {
    InMemoryCompensationQueue.resetAllStores();
  },
};

// ─── Scenario plumbing ──────────────────────────────────────────────────────

type Captured<T> = { ok: true; value: T } | { ok: false; error: string };
type CapturedRefusal = { ok: true } | { ok: false; kind: string };

interface ScenarioContext {
  q: QueueSurface;
  as<T>(tenantId: string, fn: () => T): T;
  advance(ms: number): void;
  capture<T>(fn: () => T): Captured<T>;
  captureRefusal(fn: () => void): CapturedRefusal;
}

interface ParityScenario {
  name: string;
  config?: Partial<CompensationQueueConfig>;
  /** Must be deterministic under the fake clock and fully sync. */
  run(ctx: ScenarioContext): unknown[];
}

const item = (id: string, overrides: Partial<EnqueueInput> = {}): EnqueueInput => ({
  id,
  runId: `run-${id}`,
  agentId: `agent-${id}`,
  toolName: 'shell_execute',
  args: { command: 'rm -rf /tmp/foo' },
  compensationHandlerKey: 'shell_execute.compensate',
  ...overrides,
});

const claim = (tenantId: string, claimed: CompensationQueueItem): CompensationClaim => ({
  tenantId,
  claimGeneration: claimed.claimGeneration,
});

const ZERO_COUNTS: Record<CompensationStatus, number> = {
  pending: 0,
  in_progress: 0,
  escalated: 0,
};

/** Projection that drops nothing observable but normalises null/undefined. */
function itemView(value: CompensationQueueItem | null): unknown {
  if (!value) return null;
  return {
    id: value.id,
    runId: value.runId,
    agentId: value.agentId ?? null,
    tenantId: value.tenantId ?? null,
    toolName: value.toolName,
    status: value.status,
    attemptCount: value.attemptCount,
    maxAttempts: value.maxAttempts,
    claimGeneration: value.claimGeneration,
    lastError: value.lastError ?? null,
    compensationHandlerKey: value.compensationHandlerKey,
    args: value.args,
    nextAttemptInMs: Date.parse(value.nextAttemptAt) - Date.now(),
    claimExpiresInMs: value.claimExpiresAt ? Date.parse(value.claimExpiresAt) - Date.now() : null,
  };
}

function listView(values: CompensationQueueItem[]): unknown[] {
  return values.map((value) => ({
    id: value.id,
    status: value.status,
    attemptCount: value.attemptCount,
    claimGeneration: value.claimGeneration,
  }));
}

function receiptView(value: CompensationReceipt | null): unknown {
  if (!value) return null;
  return {
    id: value.id,
    tenantId: value.tenantId,
    runId: value.runId,
    claimGeneration: value.claimGeneration,
    completedAt: value.completedAt,
  };
}

/** Collapse driver-specific error wording to the refusal contract it encodes. */
function classifyRefusal(message: string): string {
  if (/no authenticated tenant context/.test(message)) return 'no-tenant-context';
  if (/does not match the authenticated tenant/.test(message)) return 'tenant-mismatch';
  if (/is closed/.test(message)) return 'closed';
  if (/UNIQUE constraint failed|duplicate id/.test(message)) return 'duplicate-id';
  return `unclassified: ${message}`;
}

// ─── The single shared scenario table ───────────────────────────────────────

const SCENARIOS: ParityScenario[] = [
  {
    name: 'enqueue outside any tenant context is refused (thrown) and stores nothing',
    run: ({ q, as, capture }) => {
      const refused = capture(() => q.enqueue(item('no-tenant')));
      expect(refused.ok).toBe(false);
      const counts = as('tenant-A', () => q.countByStatus());
      expect(counts).toEqual(ZERO_COUNTS);
      return [refused, counts];
    },
  },
  {
    name: 'enqueue whose input.tenantId disagrees with the ambient tenant is refused (thrown)',
    run: ({ q, as, capture }) => {
      const aRefusesB = as('tenant-A', () =>
        capture(() => q.enqueue(item('mismatch-ab', { tenantId: 'tenant-B' }))),
      );
      const bRefusesA = as('tenant-B', () =>
        capture(() => q.enqueue(item('mismatch-ba', { tenantId: 'tenant-A' }))),
      );
      const matchingOwner = as('tenant-C', () =>
        capture(() => q.enqueue(item('matching', { tenantId: 'tenant-C' }))),
      );
      expect(aRefusesB.ok).toBe(false);
      expect(bRefusesA.ok).toBe(false);
      expect(matchingOwner.ok).toBe(true);
      const countsA = as('tenant-A', () => q.countByStatus());
      const countsC = as('tenant-C', () => q.countByStatus());
      expect(countsA).toEqual(ZERO_COUNTS);
      expect(countsC).toEqual({ pending: 1, in_progress: 0, escalated: 0 });
      return [aRefusesB, bRefusesA, matchingOwner, countsA, countsC];
    },
  },
  {
    name: 'claim returns the enqueued item; two items enqueued in order are claimed FIFO',
    run: ({ q, as, advance }) =>
      as('tenant-A', () => {
        q.enqueue(item('first'));
        advance(1);
        q.enqueue(item('second'));

        const first = q.claimNext()!;
        expect(first.id).toBe('first');
        expect(first.status).toBe('in_progress');
        expect(first.attemptCount).toBe(1);
        expect(first.claimGeneration).toBe(1);
        expect(first.tenantId).toBe('tenant-A');

        const completed = q.markCompleted('first', claim('tenant-A', first));
        expect(completed).toBe(true);

        const second = q.claimNext()!;
        expect(second.id).toBe('second');
        expect(second.attemptCount).toBe(1);
        expect(second.claimGeneration).toBe(1);

        const counts = q.countByStatus();
        expect(counts).toEqual({ pending: 0, in_progress: 1, escalated: 0 });
        return [itemView(first), completed, itemView(second), counts, listView(q.list())];
      }),
  },
  {
    name: 'a second claim by the same tenant gets nothing while the first claim is live',
    run: ({ q, as, advance }) =>
      as('tenant-A', () => {
        q.enqueue(item('only'));
        const first = q.claimNext()!;
        advance(1_000);
        const second = q.claimNext();
        expect(second).toBeNull();
        const held = q.get('only');
        expect(held?.status).toBe('in_progress');
        expect(held?.attemptCount).toBe(1);
        return [itemView(first), second, itemView(held), q.countByStatus()];
      }),
  },
  {
    name: 'markCompleted refuses a missing/stale/wrong-tenant claim; the correct claim removes the item',
    run: ({ q, as }) =>
      as('tenant-A', () => {
        q.enqueue(item('done'));

        const withoutClaim = q.markCompleted('done');
        expect(withoutClaim).toBe(false);

        const claimed = q.claimNext()!;
        const staleGeneration = q.markCompleted('done', {
          tenantId: 'tenant-A',
          claimGeneration: claimed.claimGeneration + 1,
        });
        const wrongTenant = q.markCompleted('done', {
          tenantId: 'tenant-B',
          claimGeneration: claimed.claimGeneration,
        });
        expect(staleGeneration).toBe(false);
        expect(wrongTenant).toBe(false);
        expect(q.get('done')?.status).toBe('in_progress');

        const correct = q.markCompleted('done', claim('tenant-A', claimed));
        expect(correct).toBe(true);
        const gone = q.get('done');
        expect(gone).toBeNull();
        expect(q.list()).toEqual([]);
        const receipt = receiptView(q.getReceipt('done'));

        const repeated = q.markCompleted('done', claim('tenant-A', claimed));
        expect(repeated).toBe(true);

        return [
          withoutClaim,
          staleGeneration,
          wrongTenant,
          correct,
          gone,
          receipt,
          repeated,
          receiptView(q.getReceipt('done')),
          q.countByStatus(),
        ];
      }),
  },
  {
    name: 'markFailed with the correct claim advances the attempt and reschedules (item is not lost)',
    config: { backoffBaseMs: 1_000, backoffMaxMs: 60_000, defaultMaxAttempts: 5 },
    run: ({ q, as, advance }) =>
      as('tenant-A', () => {
        q.enqueue(item('retry'));
        const claimed = q.claimNext()!;

        // Legacy numeric third argument == no claim: refused.
        const noClaim = q.markFailed('retry', 'no-claim', 0);
        expect(noClaim).toBe('refused');

        const outcome = q.markFailed('retry', 'transient', claim('tenant-A', claimed));
        expect(outcome).toBe('pending');
        const rescheduledItem = q.get('retry');
        expect(rescheduledItem?.status).toBe('pending');
        expect(rescheduledItem?.attemptCount).toBe(1);
        expect(rescheduledItem?.lastError).toBe('transient');
        expect(rescheduledItem?.claimExpiresAt).toBeUndefined();
        const rescheduled = itemView(rescheduledItem);

        const tooEarly = q.claimNext();
        expect(tooEarly).toBeNull();

        advance(1_001);
        const reclaimed = q.claimNext()!;
        expect(reclaimed.id).toBe('retry');
        expect(reclaimed.attemptCount).toBe(2);

        return [noClaim, outcome, rescheduled, tooEarly, itemView(reclaimed)];
      }),
  },
  {
    name: 'an expired in-progress claim is escalated for reconciliation, never replayed',
    config: { claimTtlSeconds: 30 },
    run: ({ q, as, advance }) =>
      as('tenant-A', () => {
        q.enqueue(item('expire'));
        const claimed = q.claimNext()!;
        expect(claimed.status).toBe('in_progress');
        expect(claimed.claimExpiresAt).toBeDefined();

        advance(30_001);
        const afterExpiry = q.claimNext();
        expect(afterExpiry).toBeNull();

        const reaped = q.get('expire')!;
        expect(reaped.status).toBe('escalated');
        expect(reaped.lastError).toBe(CLAIM_EXPIRED_REASON);
        expect(reaped.claimExpiresAt).toBeUndefined();
        expect(reaped.attemptCount).toBe(1);

        const stillNeverReplayed = q.claimNext();
        expect(stillNeverReplayed).toBeNull();

        return [
          itemView(claimed),
          afterExpiry,
          itemView(reaped),
          stillNeverReplayed,
          q.countByStatus(),
          listView(q.list()),
        ];
      }),
  },
  {
    name: 'another tenant cannot see or mutate the owner tenant rows',
    run: ({ q, as }) => {
      const claimedA = as('tenant-A', () => {
        q.enqueue(item('a-1'));
        const claimed = q.claimNext()!;
        q.enqueue(item('a-2'));
        return claimed;
      });

      const stolen = as('tenant-B', () => ({
        list: q.list(),
        get: q.get('a-1'),
        claim: q.claimNext(),
        counts: q.countByStatus(),
        complete: q.markCompleted('a-1', {
          tenantId: 'tenant-B',
          claimGeneration: claimedA.claimGeneration,
        }),
        fail: q.markFailed('a-1', 'stolen', {
          tenantId: 'tenant-B',
          claimGeneration: claimedA.claimGeneration,
        }),
        escalate: q.markEscalated('a-1', 'stolen', {
          tenantId: 'tenant-B',
          claimGeneration: claimedA.claimGeneration,
        }),
        retry: q.retry('a-1', 'tenant-B'),
      }));

      expect(stolen.list).toEqual([]);
      expect(stolen.get).toBeNull();
      expect(stolen.claim).toBeNull();
      expect(stolen.counts).toEqual(ZERO_COUNTS);
      expect(stolen.complete).toBe(false);
      expect(stolen.fail).toBe('refused');
      expect(stolen.escalate).toBe(false);
      expect(stolen.retry).toBe(false);

      const ownerView = as('tenant-A', () => {
        const held = q.get('a-1');
        expect(held?.status).toBe('in_progress');
        expect(held?.attemptCount).toBe(1);
        return {
          held: itemView(held),
          counts: q.countByStatus(),
          queued: listView(q.list()),
        };
      });

      return [stolen, ownerView];
    },
  },
  {
    name: 'reads outside any tenant context fail closed (no implicit admin)',
    run: ({ q, as }) => {
      as('tenant-A', () => {
        q.enqueue(item('a-1'));
        q.enqueue(item('a-2'));
      });
      const outside = {
        list: q.list(),
        get: q.get('a-1'),
        claim: q.claimNext(),
        counts: q.countByStatus(),
        receipt: q.getReceipt('a-1'),
      };
      expect(outside.list).toEqual([]);
      expect(outside.get).toBeNull();
      expect(outside.claim).toBeNull();
      expect(outside.counts).toEqual(ZERO_COUNTS);
      expect(outside.receipt).toBeNull();
      return [outside];
    },
  },
  {
    name: 'a stale claim generation cannot mutate a newer claim',
    config: { backoffBaseMs: 1 },
    run: ({ q, as, advance }) =>
      as('tenant-A', () => {
        q.enqueue(item('cas', { maxAttempts: 5 }));
        const first = q.claimNext()!;
        expect(first.claimGeneration).toBe(1);
        expect(q.markFailed('cas', 'transient', claim('tenant-A', first))).toBe('pending');

        advance(2);
        const second = q.claimNext()!;
        expect(second.claimGeneration).toBe(2);

        const staleComplete = q.markCompleted('cas', {
          tenantId: 'tenant-A',
          claimGeneration: 1,
        });
        const staleEscalate = q.markEscalated('cas', 'stale', {
          tenantId: 'tenant-A',
          claimGeneration: 1,
        });
        const staleFail = q.markFailed('cas', 'stale', {
          tenantId: 'tenant-A',
          claimGeneration: 1,
        });
        expect(staleComplete).toBe(false);
        expect(staleEscalate).toBe(false);
        expect(staleFail).toBe('refused');

        const held = q.get('cas');
        expect(held?.status).toBe('in_progress');
        expect(held?.lastError).toBe('transient');
        const liveComplete = q.markCompleted('cas', claim('tenant-A', second));
        expect(liveComplete).toBe(true);

        return [
          first.claimGeneration,
          second.claimGeneration,
          staleComplete,
          staleEscalate,
          staleFail,
          itemView(held),
          liveComplete,
        ];
      }),
  },
  {
    name: 'markFailed escalates once maxAttempts is reached',
    config: { backoffBaseMs: 1, defaultMaxAttempts: 2 },
    run: ({ q, as, advance }) =>
      as('tenant-A', () => {
        q.enqueue(item('escalate'));
        const first = q.claimNext()!;
        const stillPending = q.markFailed('escalate', 'transient', claim('tenant-A', first));
        expect(stillPending).toBe('pending');

        advance(2);
        const second = q.claimNext()!;
        const escalated = q.markFailed('escalate', 'permanent', claim('tenant-A', second));
        expect(escalated).toBe('escalated');
        expect(q.get('escalate')?.status).toBe('escalated');

        return [stillPending, escalated, itemView(q.get('escalate')), q.countByStatus()];
      }),
  },
  {
    name: 'retry moves an escalated item back to pending with attempts reset (tenant-scoped)',
    config: { defaultMaxAttempts: 1 },
    run: ({ q, as }) =>
      as('tenant-A', () => {
        q.enqueue(item('manual'));
        const claimed = q.claimNext()!;
        expect(q.markFailed('manual', 'permanent', claim('tenant-A', claimed))).toBe('escalated');

        const noTenant = q.retry('manual');
        const wrongTenant = as('tenant-B', () => q.retry('manual', 'tenant-B'));
        expect(noTenant).toBe(false);
        expect(wrongTenant).toBe(false);

        const retried = q.retry('manual', 'tenant-A');
        expect(retried).toBe(true);
        const requeued = q.get('manual');
        expect(requeued?.status).toBe('pending');
        expect(requeued?.attemptCount).toBe(0);

        return [noTenant, wrongTenant, retried, itemView(requeued), q.countByStatus()];
      }),
  },
  {
    name: 'a duplicate id is refused without overwriting the original row',
    run: ({ q, as, captureRefusal }) =>
      as('tenant-A', () => {
        q.enqueue(item('dup'));
        const duplicate = captureRefusal(() => q.enqueue(item('dup')));
        expect(duplicate.ok).toBe(false);
        const kept = q.get('dup');
        expect(kept?.attemptCount).toBe(0);
        return [duplicate, itemView(kept), listView(q.list()), q.countByStatus()];
      }),
  },
  {
    name: 'close() refuses every later operation (explicitly, never silently)',
    run: ({ q, as, capture }) =>
      as('tenant-A', () => {
        q.enqueue(item('pre-close'));
        q.close();

        const refusals = [
          capture(() => q.enqueue(item('post-close'))),
          capture(() => q.claimNext()),
          capture(() => q.list()),
          capture(() => q.get('pre-close')),
          capture(() => q.getReceipt('pre-close')),
          capture(() => q.countByStatus()),
          capture(() => q.retry('pre-close', 'tenant-A')),
          capture(() => q.markCompleted('pre-close', { tenantId: 'tenant-A', claimGeneration: 1 })),
          capture(() =>
            q.markFailed('pre-close', 'e', { tenantId: 'tenant-A', claimGeneration: 1 }),
          ),
          capture(() =>
            q.markEscalated('pre-close', 'e', { tenantId: 'tenant-A', claimGeneration: 1 }),
          ),
        ];
        for (const refusal of refusals) expect(refusal.ok).toBe(false);
        return refusals;
      }),
  },
];

/**
 * Execute one scenario against one implementation and return its observation
 * log. The fake clock is reset to `BASE_TIME` before each run so the two
 * implementations see byte-identical timestamps and the logs are comparable.
 */
function runScenario(harness: ImplHarness, scenario: ParityScenario): unknown[] {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_TIME));
  harness.resetGlobalState();
  const { raw, dispose } = harness.make(scenario.config ?? {});
  const q = toSurface(raw);
  try {
    const ctx: ScenarioContext = {
      q,
      as: (tenantId, fn) => runWithTenant(tenantId, fn),
      advance: (ms) => vi.setSystemTime(new Date(Date.now() + ms)),
      capture: (fn) => {
        try {
          return { ok: true, value: fn() };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      captureRefusal: (fn) => {
        try {
          fn();
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            kind: classifyRefusal(err instanceof Error ? err.message : String(err)),
          };
        }
      },
    };
    return scenario.run(ctx);
  } finally {
    try {
      q.close();
    } catch {
      /* the scenario may already have closed it — close() must be idempotent */
    }
    dispose();
    harness.resetGlobalState();
    vi.useRealTimers();
  }
}

describe.skipIf(!sqliteAvailable)(
  'compensation queue parity — one scenario table, both implementations',
  () => {
    beforeEach(() => {
      InMemoryCompensationQueue.resetAllStores();
    });

    afterEach(() => {
      vi.useRealTimers();
      InMemoryCompensationQueue.resetAllStores();
    });

    for (const scenario of SCENARIOS) {
      it(`[parity] ${scenario.name}`, () => {
        const sqliteOutcome = runScenario(sqliteHarness, scenario);
        const inMemoryOutcome = runScenario(inMemoryHarness, scenario);
        expect(
          inMemoryOutcome,
          `${scenario.name} — received = ${inMemoryHarness.label}, expected = ${sqliteHarness.label}`,
        ).toStrictEqual(sqliteOutcome);
      });
    }
  },
);
