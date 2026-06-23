/**
 * checkpointAdapters.test.ts — Day 3 strip-helper hardening + resume contract.
 *
 * Part 1: hostile metadata round-trip. Each `it` proves one of the
 * security-relevant promises from `ultimate/checkpointAdapters.ts`:
 *   1. Hostile metadata (Promise / AbortController / Function / Map /
 *      Symbol / Date / Error) round-trips through JSON.stringify without
 *      throwing — jsonSafe() coerces each non-serializable flavor to its
 *      JSON-equivalent or to `null`.
 *   2. stripSequentialStepResult refuses to persist the `output: unknown`
 *      field — recovery code paths do not need a typed-or-string output
 *      because the executor's in-memory frontier is the source of truth.
 *
 * Part 2: tryResumeFromATR discriminated union. Each `it` proves one
 * recovery-handler promise:
 *   - `not-found` when no durable row exists.
 *   - `seed` when stepNumber===0 (goal-committed but no progress).
 *   - `resume` when stepNumber>=1 (populated payload).
 *   - Filter options collapse to `not-found` on phase mismatch.
 *   - dbPath overload opens a transient engine and shuts it down
 *     cleanly before returning (no leaked file handles).
 *
 * Day 7: every `engine.checkpointAtomically(...)` direct callsite runs
 * through `assertNoTestOnlyPhase(...)` so the test-only-phase contract
 * is enforced uniformly with the production `safeCheckpointAtomically`
 * path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertNoTestOnlyPhase,
  EXECUTOR_PHASES,
  type ExecutorCheckpointKind,
  jsonSafe,
  safeCheckpointAtomically,
  setTestOnlyPhasesAllowed,
  stripGoalNode,
  stripSequentialStepResult,
  stripSwarmNode,
  tryResumeFromATR,
  withTestOnlyPhasesAllowed,
} from '../../src/ultimate/checkpointAdapters';
import { ReliabilityEngine } from '../../src/runtime/reliabilityEngine';
import type { CheckpointPhase, CheckpointState } from '../../src/runtime/stateCheckpointer';

// Build a metadata object full of values that JSON.stringify would refuse
// without our jsonSafe recursion. This is the hostile-input shape the kill9
// contract must survive: real callers leak Promises / AbortControllers
// into tree state when they forget to `.finally()`-clean them.
const HOSTILE_METADATA = {
  fn: () => 'side-effect',
  promise: Promise.resolve(42),
  abortController: new AbortController(),
  map: new Map<string, unknown>([
    ['k', 1],
    ['nested', new Set(['a', 'b'])],
  ]),
  symbol: Symbol('badge'),
  date: new Date('2024-01-01T00:00:00.000Z'),
  err: new Error('boom'),
  nested: {
    promise: Promise.resolve(99),
    date: new Date('2024-02-02T00:00:00.000Z'),
    fn: () => 'should-drop',
  },
};

describe('checkpointAdapters strip helpers', () => {
  it('jsonSafe round-trip survives hostile inputs without throwing', () => {
    const sanitized = jsonSafe(HOSTILE_METADATA);
    // The whole point: this line must not TypeError.
    expect(() => JSON.stringify(sanitized)).not.toThrow();

    const parsed = JSON.parse(JSON.stringify(sanitized));
    // Function / Promise / AbortController / Symbol → null
    expect(parsed.fn).toBeNull();
    expect(parsed.promise).toBeNull();
    expect(parsed.abortController).toBeNull();
    expect(parsed.symbol).toBeNull();
    // Map → object with string keys; nested Set → array
    expect(parsed.map).toMatchObject({ k: 1 });
    expect(parsed.map.nested).toEqual(['a', 'b']);
    // Date → ISO string; Error → { name, message }
    expect(parsed.date).toBe('2024-01-01T00:00:00.000Z');
    expect(parsed.err).toEqual({ name: 'Error', message: 'boom' });
    // Nested fields keep their sanitization
    expect(parsed.nested.promise).toBeNull();
    expect(parsed.nested.date).toBe('2024-02-02T00:00:00.000Z');
    expect(parsed.nested.fn).toBeNull();
  });

  it('stripGoalNode with hostile metadata JSON-roundtrips cleanly', () => {
    const node = {
      id: 'n1',
      goal: 'g',
      parentId: null,
      status: 'pending' as const,
      subGoals: [],
      dependencies: [],
      workerOutput: 'ok',
      critique: undefined,
      metadata: HOSTILE_METADATA,
    };
    const stripped = stripGoalNode(node as any);
    expect(() => JSON.stringify(stripped)).not.toThrow();
    const meta = JSON.parse(JSON.stringify(stripped.metadata));
    expect(meta.promise).toBeNull();
    expect(meta.abortController).toBeNull();
    expect(meta.fn).toBeNull();
    expect(meta.symbol).toBeNull();
  });

  it('stripSwarmNode with hostile metadata JSON-roundtrips cleanly', () => {
    const node = {
      id: 's1',
      goal: 'g',
      parentId: null,
      status: 'pending' as const,
      workerOutput: 'ok',
      critique: undefined,
      subNodes: [],
      children: [],
      dependencies: [],
      metadata: HOSTILE_METADATA,
    };
    const stripped = stripSwarmNode(node as any);
    expect(() => JSON.stringify(stripped)).not.toThrow();
    const meta = JSON.parse(JSON.stringify(stripped.metadata));
    expect(meta.promise).toBeNull();
    expect(meta.abortController).toBeNull();
  });

  it('stripSequentialStepResult drops the unknown `output` field entirely', () => {
    const r = {
      stepId: 's',
      agentId: 'a',
      status: 'SUCCESS' as const,
      duration: 100,
      timestamp: new Date().toISOString(),
      output: {
        promise: Promise.resolve(),
        bigBlob: { recursive: { ref: 'data' } },
      },
      error: 'none',
    };
    const stripped = stripSequentialStepResult(r as any);
    // Strict: no `output` key at all in the durable shape.
    expect(stripped).not.toHaveProperty('output');
    // Bookkeeping fields survive.
    expect(stripped).toMatchObject({
      stepId: 's',
      agentId: 'a',
      status: 'SUCCESS',
      duration: 100,
      error: 'none',
      hasOutput: true,
    });
  });
});

// ============================================================================
// tryResumeFromATR — discriminated union (Day 3 followup)
// ============================================================================

const RESUME_RUN_ID = 'resume-handler-fixture';

// Day 6: local-cast const for the test-only phase used by the
// runtime-emission guard tests. Mirror of the const in
// resume.hammer.test.ts — kept local so the production
// EXECUTOR_PHASES const stays clean.
const TEST_ANCHOR_PHASE_LOCAL: CheckpointPhase = 'test-anchor' as CheckpointPhase;

function makeCheckpointState(args: {
  runId: string;
  stepNumber: number;
  phase: CheckpointPhase;
  executorKind: ExecutorCheckpointKind;
  payload: Record<string, unknown>;
}): CheckpointState {
  return {
    runId: args.runId,
    agentId: args.executorKind,
    timestamp: new Date().toISOString(),
    phase: args.phase,
    stepNumber: args.stepNumber,
    attemptNumber: 0,
    messages: [],
    tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    stepDurations: [],
    context: {
      agentId: args.executorKind,
      projectId: 'resume-test',
      goal: typeof args.payload.goal === 'string' ? args.payload.goal : 'g',
      availableTools: [],
      maxSteps: 0,
      tokenBudget: 0,
    },
    totalDurationMs: 0,
    executorState: { kind: args.executorKind, payload: args.payload },
  };
}

describe('tryResumeFromATR — discriminated union', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: ReliabilityEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-fixture-'));
    dbPath = path.join(tmpDir, 'atr_checkpoints.db');
    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });
  });

  afterEach(() => {
    try {
      engine.shutdown();
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('returns not-found when no row exists for runId', () => {
    const point = tryResumeFromATR(engine, RESUME_RUN_ID);
    expect(point).toEqual({ kind: 'not-found', runId: RESUME_RUN_ID });
  });

  it('returns seed for a single stepNumber === 0 row', () => {
    // Mimics Goal/Swarm start seed: goal committed, rootNodes/ledger empty.
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeCheckpointState({
          runId: RESUME_RUN_ID,
          stepNumber: 0,
          phase: EXECUTOR_PHASES.GOAL_ROUND,
          executorKind: 'goal-round',
          payload: {
            round: 0,
            goal: 'decompose goal',
            rootNodes: [],
            ledger: [],
            totalTokensUsed: 0,
            plateauRounds: 0,
          },
        }),
      ),
    );

    const point = tryResumeFromATR(engine, RESUME_RUN_ID);
    expect(point.kind).toBe('seed');
    if (point.kind !== 'seed') return;
    expect(point.runId).toBe(RESUME_RUN_ID);
    expect(point.phase).toBe(EXECUTOR_PHASES.GOAL_ROUND);
    expect(point.executorKind).toBe('goal-round');
    expect(point.goal).toBe('decompose goal');
    expect(point.payload.ledger).toEqual([]);
    expect(point.payload.rootNodes).toEqual([]);
  });

  it('returns resume for stepNumber === 1 with populated payload', () => {
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeCheckpointState({
          runId: RESUME_RUN_ID,
          stepNumber: 1,
          phase: EXECUTOR_PHASES.GOAL_ROUND,
          executorKind: 'goal-round',
          payload: {
            round: 1,
            goal: 'decompose goal',
            rootNodes: [{ id: 'n1', goal: 'sub' }],
            ledger: [{ round: 1, summary: 'r1' }],
            totalTokensUsed: 100,
            plateauRounds: 0,
          },
        }),
      ),
    );

    const point = tryResumeFromATR(engine, RESUME_RUN_ID);
    expect(point.kind).toBe('resume');
    if (point.kind !== 'resume') return;
    expect(point.runId).toBe(RESUME_RUN_ID);
    expect(point.stepNumber).toBe(1);
    expect(point.phase).toBe(EXECUTOR_PHASES.GOAL_ROUND);
    expect(point.executorKind).toBe('goal-round');
    expect(Array.isArray(point.payload.rootNodes)).toBe(true);
    expect((point.payload.rootNodes as Array<unknown>).length).toBe(1);
    expect((point.payload.ledger as Array<unknown>).length).toBe(1);
  });

  it('returns resume for stepNumber === 2 — latest overrides the seed', () => {
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeCheckpointState({
          runId: RESUME_RUN_ID,
          stepNumber: 0,
          phase: EXECUTOR_PHASES.GOAL_ROUND,
          executorKind: 'goal-round',
          payload: { round: 0, goal: 'g1', rootNodes: [], ledger: [] },
        }),
      ),
    );
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeCheckpointState({
          runId: RESUME_RUN_ID,
          stepNumber: 1,
          phase: EXECUTOR_PHASES.GOAL_ROUND,
          executorKind: 'goal-round',
          payload: { round: 1, goal: 'g1', rootNodes: [{ id: 'n1' }], ledger: [] },
        }),
      ),
    );
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeCheckpointState({
          runId: RESUME_RUN_ID,
          stepNumber: 2,
          phase: EXECUTOR_PHASES.GOAL_ROUND,
          executorKind: 'goal-round',
          payload: {
            round: 2,
            goal: 'g1',
            rootNodes: [{ id: 'n1' }],
            ledger: [{ round: 1 }, { round: 2 }],
          },
        }),
      ),
    );

    const point = tryResumeFromATR(engine, RESUME_RUN_ID);
    expect(point.kind).toBe('resume');
    if (point.kind !== 'resume') return;
    expect(point.stepNumber).toBe(2);
    // seed-only 'goal' field is still extractable from the resume payload
    expect(point.payload.goal).toBe('g1');
  });

  it('filters on phase — mismatched phase collapses to not-found', () => {
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeCheckpointState({
          runId: RESUME_RUN_ID,
          stepNumber: 0,
          phase: EXECUTOR_PHASES.GOAL_ROUND,
          executorKind: 'goal-round',
          payload: { goal: 'g1' },
        }),
      ),
    );
    const point = tryResumeFromATR(engine, RESUME_RUN_ID, {
      phase: EXECUTOR_PHASES.SWARM_ROUND,
    });
    expect(point).toEqual({ kind: 'not-found', runId: RESUME_RUN_ID });
  });

  it('filters on kinds set — matching phase is still found', () => {
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeCheckpointState({
          runId: RESUME_RUN_ID,
          stepNumber: 1,
          phase: EXECUTOR_PHASES.SWARM_ROUND,
          executorKind: 'swarm-round',
          payload: { goal: 'g1', rootNodes: [{ id: 's1' }] },
        }),
      ),
    );
    const point = tryResumeFromATR(engine, RESUME_RUN_ID, {
      kinds: [EXECUTOR_PHASES.GOAL_ROUND, EXECUTOR_PHASES.SWARM_ROUND],
    });
    expect(point.kind).toBe('resume');
    if (point.kind !== 'resume') return;
    expect(point.executorKind).toBe('swarm-round');
  });

  it('dbPath overload returns the same discriminated result as engine overload', () => {
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeCheckpointState({
          runId: RESUME_RUN_ID,
          stepNumber: 0,
          phase: EXECUTOR_PHASES.GOAL_ROUND,
          executorKind: 'goal-round',
          payload: { round: 0, goal: 'g1', rootNodes: [], ledger: [] },
        }),
      ),
    );

    // Shutdown the test's own engine so the only handle is whatever the
    // helper opens from the dbPath. If the dbPath overload leaked
    // SQLite handles, the afterEach rmSync could return EBUSY on
    // rare filesystems, but the helper's finally-block keeps it rare.
    engine.shutdown();

    const point = tryResumeFromATR(dbPath, RESUME_RUN_ID);
    expect(point.kind).toBe('seed');
    if (point.kind !== 'seed') return;
    expect(point.executorKind).toBe('goal-round');
    expect(point.goal).toBe('g1');
  });

  // --- Day 5 format-leveler: engineOpens wrapper collapses bad source ---
  //
  // User contract (greppable reason format):
  //   `tryResumeFromATR` MUST never throw on engine-open or engine-read
  //   failures; every failure mode is folded into the
  //   `{kind: 'not-found', reason}` arm with a colon-detail reason
  //   string of the form `<head>: <detail>`. Callers can grep on
  //   `^engine-` to bucket every infrastructure failure uniformly:
  //     `engine-source-required: <typeof>:<value>` for typed-wrong
  //       inputs (null / undefined / numbers / objects).
  //     `engine-open-failed: <message>` for constructor throws.
  //   These tests are the contract — any future change that breaks
  //   a reason shape MUST also update these assertions.

  it('null source collapses to not-found with reason "engine-source-required: null:null"', () => {
    expect(() => tryResumeFromATR(null as unknown as string, 'r-null')).not.toThrow();
    const point = tryResumeFromATR(null as unknown as string, 'r-null');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.runId).toBe('r-null');
    expect(point.reason).toBe('engine-source-required: null:null');
  });

  it('undefined source collapses to not-found with reason "engine-source-required: undefined:undefined"', () => {
    expect(() => tryResumeFromATR(undefined as unknown as string, 'r-undef')).not.toThrow();
    const point = tryResumeFromATR(undefined as unknown as string, 'r-undef');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: undefined:undefined');
  });

  it('falsy-zero source (0) is refused at the source-shape boundary', () => {
    // typeof check rejects 0 even though truthy-check would have
    // accepted it — protects callers from accidentally passing a
    // numeric token/ID thinking it's a path.
    expect(() => tryResumeFromATR(0 as unknown as string, 'r-zero')).not.toThrow();
    const point = tryResumeFromATR(0 as unknown as string, 'r-zero');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: number:0');
  });

  it('boolean false is refused at the source-shape boundary', () => {
    expect(() => tryResumeFromATR(false as unknown as string, 'r-false')).not.toThrow();
    const point = tryResumeFromATR(false as unknown as string, 'r-false');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: boolean:false');
  });

  it('plain object (not a ReliabilityEngine instance) is refused with ctor tag', () => {
    const fake = { notAnEngine: true };
    expect(() => tryResumeFromATR(fake as unknown as string, 'r-obj')).not.toThrow();
    const point = tryResumeFromATR(fake as unknown as string, 'r-obj');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: object:Object');
  });

  it('Symbol source is refused without crashing (String(symbol) throws)', () => {
    // describeRejectedSource used to call `String(source)` for any
    // non-object/non-string primitive, which throws `Cannot convert a
    // Symbol value to a string`. Symbol is handled explicitly now —
    // round-trip and pin the contract.
    const sym = Symbol('rank');
    expect(() => tryResumeFromATR(sym as unknown as string, 'r-symbol')).not.toThrow();
    const point = tryResumeFromATR(sym as unknown as string, 'r-symbol');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: symbol:local:rank');
  });

  it('unnamed Symbol is refused with reason tag "symbol:local:<unnamed>"', () => {
    const sym = Symbol();
    expect(() => tryResumeFromATR(sym as unknown as string, 'r-symbol-unnamed')).not.toThrow();
    const point = tryResumeFromATR(sym as unknown as string, 'r-symbol-unnamed');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: symbol:local:<unnamed>');
  });

  it('registered Symbol.for(key) is tagged with the registration key, not the description', () => {
    const sym = Symbol.for('rank');
    expect(() => tryResumeFromATR(sym as unknown as string, 'r-symbol-registered')).not.toThrow();
    const point = tryResumeFromATR(sym as unknown as string, 'r-symbol-registered');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: symbol:registered:rank');
  });

  it('well-known Symbol.iterator falls through the registered branch as `local`', () => {
    const sym = Symbol.iterator;
    expect(() => tryResumeFromATR(sym as unknown as string, 'r-symbol-wk')).not.toThrow();
    const point = tryResumeFromATR(sym as unknown as string, 'r-symbol-wk');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: symbol:local:Symbol.iterator');
  });

  it('BigInt source is refused via the string-coerce fall-through path', () => {
    const n = 5n;
    expect(() => tryResumeFromATR(n as unknown as string, 'r-bigint')).not.toThrow();
    const point = tryResumeFromATR(n as unknown as string, 'r-bigint');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: bigint:5');
  });

  it('Function source is refused with a function-tagged reason', () => {
    // The head-shape regex pins the discriminator contract uniformly
    // with other engine-* reasons; the body substring is dropped to
    // avoid pinning cosmetic rendering.
    const fn = () => 'x';
    expect(() => tryResumeFromATR(fn as unknown as string, 'r-fn')).not.toThrow();
    const point = tryResumeFromATR(fn as unknown as string, 'r-fn');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toMatch(/^engine-source-required: function:/);
  });

  it('Array input is tagged with ctor "Array" in the reason', () => {
    const arr: unknown[] = [];
    expect(() => tryResumeFromATR(arr as unknown as string, 'r-arr')).not.toThrow();
    const point = tryResumeFromATR(arr as unknown as string, 'r-arr');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: object:Array');
  });

  it('Date instance is tagged with ctor "Date" in the reason', () => {
    const d = new Date('2026-06-23T00:00:00.000Z');
    expect(() => tryResumeFromATR(d as unknown as string, 'r-date')).not.toThrow();
    const point = tryResumeFromATR(d as unknown as string, 'r-date');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.reason).toBe('engine-source-required: object:Date');
  });

  it('directory path deterministically rejects via engine-open-failed (or silent fallback)', () => {
    // ReliabilityEngine has 2 documented behaviors for directory paths:
    //   (A) Silent :memory: fallback — point.reason is undefined.
    //   (B) Hard rejection — point.reason matches /^engine-open-failed:/
    //       AND /EISDIR|EACCES|directory/i.
    // The branched assertion below PASSES on the current contract AND
    // pins the future hard-rejection contract.
    expect(() => tryResumeFromATR(tmpDir, 'r-bad-path')).not.toThrow();
    const point = tryResumeFromATR(tmpDir, 'r-bad-path');
    expect(point.kind).toBe('not-found');
    if (point.kind !== 'not-found') return;
    expect(point.runId).toBe('r-bad-path');
    if (point.reason === undefined) {
      // (A) Silent :memory: fallback — CURRENT contract.
      console.log('[contract] directory-path: A (silent fallback)');
      return;
    }
    // (B) Hard rejection — TARGETED contract.
    console.log('[contract] directory-path: B (hard rejection)');
    expect(point.reason).toMatch(/^engine-open-failed:/);
    expect(point.reason).toMatch(/EISDIR|EACCES|directory/i);
  });

  it('Symbol("<unnamed>") with explicit description matches Symbol() no-description sentinel', () => {
    // Both `Symbol('<unnamed>').description` and `Symbol().description`
    // are '<unnamed>' — JS cannot distinguish them. The reason string
    // MUST be identical; otherwise desc branches would split them.
    const pointA = tryResumeFromATR(
      Symbol('<unnamed>') as unknown as string,
      'r-sym-explicit-unnamed',
    );
    const pointB = tryResumeFromATR(Symbol() as unknown as string, 'r-sym-implicit-unnamed');
    expect(pointA.kind).toBe('not-found');
    expect(pointB.kind).toBe('not-found');
    if (pointA.kind !== 'not-found' || pointB.kind !== 'not-found') return;
    expect(pointA.reason).toBe(pointB.reason);
    expect(pointA.reason).toBe('engine-source-required: symbol:local:<unnamed>');
  });

  // --- Day 6 hardening: runtime-emission guard for `@test-only` phases ---
  //
  // Contract: `tryResumeFromATR` throws if a WAL row has phase
  // 'test-anchor' AND the module-private toggle is `false` (default).
  // Test fixtures call `setTestOnlyPhasesAllowed(true)` from `beforeAll`
  // so their hammer fixtures aren't blocked. Production callers MUST
  // NOT enable the toggle; any leak through to a production row throws
  // visibly so ops can route the row to forensic recovery.

  it('production mode: read of a planted test-anchor row throws @test-only', () => {
    // Baseline: production mode. Plant via opt-in
    // (assertNoTestOnlyPhase returns state through when toggle=true);
    // the helper restores prev=false so the read below runs in
    // production mode and the read-side guard fires.
    setTestOnlyPhasesAllowed(false);
    withTestOnlyPhasesAllowed(true, () => {
      engine.checkpointAtomically(
        assertNoTestOnlyPhase(
          makeCheckpointState({
            runId: 'r-anchor-prod',
            stepNumber: 1,
            phase: TEST_ANCHOR_PHASE_LOCAL,
            executorKind: 'goal-round',
            payload: { marker: 'anchor' },
          }),
        ),
      );
    });
    expect(() => tryResumeFromATR(engine, 'r-anchor-prod')).toThrow(
      /@test-only phase 'test-anchor' leaked to runtime/,
    );
  });

  it('test mode: read is allowed when opted-in; opt-out restores strictness', () => {
    // Baseline: production mode. Inside the opt-in helper the plant
    // succeeds AND the read returns the row normally. After the helper
    // restores prev=false, a second read of the same row throws —
    // proving the read-side guard really fires when the runtime
    // flips back to production mode.
    setTestOnlyPhasesAllowed(false);
    withTestOnlyPhasesAllowed(true, () => {
      engine.checkpointAtomically(
        assertNoTestOnlyPhase(
          makeCheckpointState({
            runId: 'r-anchor-test',
            stepNumber: 1,
            phase: TEST_ANCHOR_PHASE_LOCAL,
            executorKind: 'goal-round',
            payload: { marker: 'anchor' },
          }),
        ),
      );
      const point = tryResumeFromATR(engine, 'r-anchor-test');
      expect(point.kind).toBe('resume');
      if (point.kind !== 'resume') return;
      expect(point.phase).toBe(TEST_ANCHOR_PHASE_LOCAL);
      expect(point.stepNumber).toBe(1);
      expect(point.runId).toBe('r-anchor-test');
    });
    expect(() => tryResumeFromATR(engine, 'r-anchor-test')).toThrow(
      /@test-only phase 'test-anchor' leaked to runtime/,
    );
  });

  // --- Day 6+2 hardening: write-side guard for `@test-only` phases ---
  //
  // Symmetric to the read-side guard. The wrapper refuses to PLANT a
  // `test-anchor` row when the toggle is off, so neither side can
  // sneak a `test-anchor` value through. Production executors all
  // call `safeCheckpointAtomically` and are covered automatically;
  // tests here use the wrapper so the guard is exercised end-to-end.

  it('production mode: safeCheckpointAtomically write of test-anchor throws @test-only', () => {
    setTestOnlyPhasesAllowed(false);
    expect(() =>
      safeCheckpointAtomically(
        engine,
        makeCheckpointState({
          runId: 'r-anchor-write-prod',
          stepNumber: 0,
          phase: TEST_ANCHOR_PHASE_LOCAL,
          executorKind: 'goal-round',
          payload: { marker: 'anchor-write' },
        }),
      ),
    ).toThrow(/@test-only phase 'test-anchor' write-side guard/);
  });

  it('test mode: safeCheckpointAtomically write of test-anchor is allowed when opted-in; opt-out restores strictness', () => {
    // Baseline: production mode. Inside the opt-in helper, the
    // safeCheckpointAtomically call succeeds AND the row lands in
    // the WAL (verified via tryResumeFromATR with phase filter).
    // After the helper restores prev=false, a subsequent write through
    // the wrapper throws — proving both sides of the toggle move
    // synchronously through restoration.
    setTestOnlyPhasesAllowed(false);
    withTestOnlyPhasesAllowed(true, () => {
      expect(() =>
        safeCheckpointAtomically(
          engine,
          makeCheckpointState({
            runId: 'r-anchor-write-test',
            stepNumber: 1,
            phase: TEST_ANCHOR_PHASE_LOCAL,
            executorKind: 'goal-round',
            payload: { marker: 'anchor-write' },
          }),
        ),
      ).not.toThrow();
      const point = tryResumeFromATR(engine, 'r-anchor-write-test', {
        phase: TEST_ANCHOR_PHASE_LOCAL,
      });
      expect(point.kind).toBe('resume');
      if (point.kind !== 'resume') return;
      expect(point.stepNumber).toBe(1);
      expect(point.runId).toBe('r-anchor-write-test');
    });
    expect(() =>
      safeCheckpointAtomically(
        engine,
        makeCheckpointState({
          runId: 'r-anchor-write-after-disable',
          stepNumber: 1,
          phase: TEST_ANCHOR_PHASE_LOCAL,
          executorKind: 'goal-round',
          payload: { marker: 'anchor-write' },
        }),
      ),
    ).toThrow(/@test-only phase 'test-anchor' write-side guard/);
  });
});
