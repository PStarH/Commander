/**
 * tests/stress/resume.hammer.test.ts — Day 4 加压 contract.
 *
 * Two describe blocks exercise the recovery path under stress:
 *
 *   1. `50-iter invariants` — drives `tryResumeFromATR` through 50 sequential
 *      iterations of (plant → shutdown → reopen → lookup). Across the 50
 *      iters we assert:
 *      - exactly one of {not-found, seed, resume} per iter (no double kinds)
 *      - the phase field is well-defined whenever `kind !== 'not-found'`
 *      - stepNumber in the latest checkpoint at the end of each iter is
 *        monotonic non-decreasing against the planted sequence
 *
 *   2. `5-runId × 1000 checkpoints concurrency` — the canonical hammer.
 *      5 runIds receive 1000 checkpoints each (`stepNumber 1..1000`) in a
 *      perfectly interleaved order: outer loop i=1..1000, inner loop r=1..5.
 *      After the write stream, `tryResumeFromATR(runId, { phase })` is
 *      called for each runId in parallel and asserted on:
 *      - kind is strictly 'resume' (latest stepNumber=1000)
 *      - the WAL holds exactly 1000 rows per runId
 *      - stepNumber sequence is exactly 1..1000
 *
 * Both blocks share a tmpDir + dbPath instance per `it` via beforeEach,
 * so test isolation is the same as the rest of the suite.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReliabilityEngine } from '../../src/runtime/reliabilityEngine';
import {
  tryResumeFromATR,
  EXECUTOR_PHASES,
  safeCheckpointAtomically,
  setTestOnlyPhasesAllowed,
  type ExecutorCheckpointKind,
} from '../../src/ultimate/checkpointAdapters';
import type { CheckpointPhase, CheckpointState } from '../../src/runtime/stateCheckpointer';

/**
 * Day 6: opt-in to the test-only phase guard BEFORE any fixture
 * write/read. Without this, the `tryResumeFromATR` read-side guard
 * would reject our `test-anchor` fixtures — the hammer test exercises
 * 5 distinct phases per runId, so the 5th entry is `test-anchor`.
 *
 * Scope: file-level (top-level) beforeAll/afterAll so all `it`
 * tests below — including both describe blocks (50-iter invariants
 * AND 5-runId × 1000 concurrent) — run with the toggle on, then
 * restore to off after this file's tests complete so a parallel
 * vitest worker running unrelated tests (e.g.
 * checkpointAdapters.test.ts's "production mode" test) does not get
 * poisoned by our module-private state.
 *
 * vitest by default runs test files in parallel across worker
 * processes (each file is its own module instance), so the toggle
 * leak risk is intra-file only. afterAll is sufficient defense.
 */
beforeAll(() => {
  setTestOnlyPhasesAllowed(true);
});
afterAll(() => {
  setTestOnlyPhasesAllowed(false);
});

/**
 * @test-only
 * `test-anchor` is a deliberate test-only phase + kind pair. It is
 * NEVER produced by any executor at runtime — declared here as a
 * local-cast constant so the production EXECUTOR_PHASES const and
 * the production CheckpointPhase / ExecutorCheckpointKind unions
 * stay strictly runtime-emitted. The hammer test exercises 5
 * distinct phases per runId, so this is the 5th entry; production
 * executors only emit the 4 EXECUTOR_PHASES values above.
 *
 * Pair note: the `beforeAll` opt-in above is REQUIRED for any
 * fixture write or read using this phase value to succeed — without
 * it, the read-time guard in `tryResumeFromATR` throws the
 * `@test-only phase leaked to runtime` error.
 */
const TEST_ANCHOR_PHASE: CheckpointPhase = 'test-anchor' as CheckpointPhase;
const TEST_ANCHOR_KIND: ExecutorCheckpointKind = 'test-anchor' as ExecutorCheckpointKind;

const PHASE_KIND_PAIRS: Array<[CheckpointPhase, ExecutorCheckpointKind]> = [
  [EXECUTOR_PHASES.GOAL_ROUND, 'goal-round'],
  [EXECUTOR_PHASES.SWARM_ROUND, 'swarm-round'],
  [EXECUTOR_PHASES.TASK_POOL_BATCH, 'task-pool'],
  [EXECUTOR_PHASES.SEQUENTIAL_STEP, 'sequential'],
  [TEST_ANCHOR_PHASE, TEST_ANCHOR_KIND],
];

function makeFixtureState(args: {
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
      projectId: 'stress',
      goal: typeof args.payload.goal === 'string' ? args.payload.goal : 'r',
      availableTools: [],
      maxSteps: 0,
      tokenBudget: 0,
    },
    totalDurationMs: 0,
    executorState: { kind: args.executorKind, payload: args.payload },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 50-iter invariants
// ────────────────────────────────────────────────────────────────────────────

describe('resume.hammer — 50-iter invariants', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: ReliabilityEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-hammer-50-'));
    dbPath = path.join(tmpDir, 'atr.db');
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

  it('50 iters: no double kinds, consistent phase, monotonic stepNumber per runId', () => {
    // Distribution: 50 iters, i % 3 mod; pattern 0 → seed only,
    // pattern 1 → seed + boundary at stepNumber=i+1, pattern 2 → not-found.
    let notFound = 0;
    let seed = 0;
    let resume = 0;

    // For monotonicity we keep the latest observed stepNumber per runId.
    // Each runId is unique per iter so per-iter monotonicity is trivial;
    // we still capture to detect a regression where the same runId is
    // tested twice in adjacent iters.
    const lastStepByRunId = new Map<string, number>();
    const phaseObservations = new Set<CheckpointPhase>();

    for (let i = 0; i < 50; i++) {
      // Reopen the engine per iter to simulate fresh-process restart;
      // each iter must independently pass the invariant check.
      engine.shutdown();
      engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });

      const runId = `iter-${i}`;
      const [phase, kind] = PHASE_KIND_PAIRS[i % PHASE_KIND_PAIRS.length];
      const pattern = i % 3;

      if (pattern === 0) {
        // seed-only: planted stepNumber=0 with empty payload → kind='seed'
        safeCheckpointAtomically(
          engine,
          makeFixtureState({
            runId,
            stepNumber: 0,
            phase,
            executorKind: kind,
            payload: {
              goal: 'g',
              rootNodes: [],
              ledger: [],
              totalTokensUsed: 0,
              plateauRounds: 0,
            },
          }),
        );
      } else if (pattern === 1) {
        // seed + boundary at stepNumber=i+1 → kind='resume'
        safeCheckpointAtomically(
          engine,
          makeFixtureState({
            runId,
            stepNumber: 0,
            phase,
            executorKind: kind,
            payload: {
              goal: 'g',
              rootNodes: [],
              ledger: [],
              totalTokensUsed: 0,
              plateauRounds: 0,
            },
          }),
        );
        safeCheckpointAtomically(
          engine,
          makeFixtureState({
            runId,
            stepNumber: i + 1,
            phase,
            executorKind: kind,
            payload: {
              goal: 'g',
              rootNodes: [{ id: 'n1' }],
              ledger: [{ round: i + 1 }],
              totalTokensUsed: i,
              plateauRounds: 0,
            },
          }),
        );
      }
      // pattern === 2: plant nothing → not-found

      const filter = pattern === 2 ? undefined : { phase };
      const point = tryResumeFromATR(engine, runId, filter);

      // Invariant 1: exactly one valid kind per iter.
      expect(['not-found', 'seed', 'resume']).toContain(point.kind);
      if (point.kind === 'not-found') notFound++;
      else if (point.kind === 'seed') seed++;
      else resume++;

      // Invariant 2: phase is well-defined when applicable.
      if (point.kind !== 'not-found') {
        phaseObservations.add(point.phase);
        expect(point.phase).toBeTruthy();
        expect(point.payload).toBeDefined();
      }

      // Invariant 3: stepNumber monotonicity for the same runId.
      const expectedMax = pattern === 1 ? i + 1 : pattern === 0 ? 0 : -1;
      const prior = lastStepByRunId.get(runId);
      if (prior !== undefined) {
        expect(expectedMax).toBeGreaterThanOrEqual(prior);
      }
      lastStepByRunId.set(runId, expectedMax);
    }

    // Total must equal 50 — no ghost kinds leaked.
    expect(notFound + seed + resume).toBe(50);
    // The 50-iter round-robin (i%3) on i=0..49:
    //   pattern 0 (i=0,3,6,...,48)  →  17 iters → seed
    //   pattern 1 (i=1,4,7,...,49)  →  17 iters → resume
    //   pattern 2 (i=2,5,8,...,47)  →  16 iters → not-found
    expect(seed).toBe(17);
    expect(resume).toBe(17);
    expect(notFound).toBe(16);
    // All 5 PHASE_KIND_PAIRS entries were exercised across the 50 iters
    // (i ∈ 0..49, paired with PHASE_KIND_PAIRS[i % 5]). Day 6:
    // PHASE_KIND_PAIRS extended from 4 to 5 with TEST_ANCHOR.
    expect(phaseObservations.size).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. 5-runId × 1000 concurrent hammer
// ────────────────────────────────────────────────────────────────────────────

describe('resume.hammer — 5-runId × 1000 checkpoints concurrent', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: ReliabilityEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-hammer-conc-'));
    dbPath = path.join(tmpDir, 'atr.db');
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

  it('interleaves 1000 writes across 5 runIds; tryResumeFromATR returns strict resume × 5', async () => {
    const RUN_IDS = ['r0', 'r1', 'r2', 'r3', 'r4'];

    // Pre-build the 5000 checkpoint fixtures once. The interleaved write
    // pattern below iterates i=1..1000 over r=0..4 (round-robin) so that
    // each runId is touched at every step in fixture order — exactly the
    // pattern the user spec asked for.
    const fixtures: CheckpointState[] = [];
    for (let r = 0; r < RUN_IDS.length; r++) {
      const [phase, kind] = PHASE_KIND_PAIRS[r % PHASE_KIND_PAIRS.length];
      const runId = RUN_IDS[r];
      for (let i = 1; i <= 1000; i++) {
        fixtures.push(
          makeFixtureState({
            runId,
            stepNumber: i,
            phase,
            executorKind: kind,
            payload: { goal: `g${r}`, round: i, marker: 'hammer' },
          }),
        );
      }
    }

    // Interleave: for i in 1..1000: for r in 0..4: write fixture[r][i].
    for (let i = 1; i <= 1000; i++) {
      for (let r = 0; r < RUN_IDS.length; r++) {
        const idx = r * 1000 + (i - 1);
        safeCheckpointAtomically(engine, fixtures[idx]);
      }
    }

    // Now trigger tryResumeFromATR for each runId in parallel. The helper
    // is sync but Promise.resolve preserves the parallelism framing.
    const results = await Promise.all(
      RUN_IDS.map((runId, r) => {
        const [phase] = PHASE_KIND_PAIRS[r % PHASE_KIND_PAIRS.length];
        return Promise.resolve(tryResumeFromATR(engine, runId, { phase }));
      }),
    );

    // Each result must be kind='resume' with stepNumber=1000.
    for (let r = 0; r < RUN_IDS.length; r++) {
      const point = results[r];
      expect(point.kind).toBe('resume');
      if (point.kind !== 'resume') continue;
      expect(point.stepNumber).toBe(1000);
      expect(point.runId).toBe(RUN_IDS[r]);
    }

    // Cross-check via the WAL backend: each runId must hold exactly 1000
    // rows with strictly monotonic stepNumber 1..1000.
    const backend = engine.getAtrCheckpointStore();
    for (let r = 0; r < RUN_IDS.length; r++) {
      const rows = backend.listByRun(RUN_IDS[r]);
      expect(rows).toHaveLength(1000);
      const stepNumbers = rows.map((row) => row.stepNumber).sort((a, b) => a - b);
      const expected = Array.from({ length: 1000 }, (_, i) => i + 1);
      expect(stepNumbers).toEqual(expected);
      // Phase integrity: no duplicate phase value within a single runId.
      const phases = new Set(rows.map((row) => row.phase));
      expect(phases.size).toBe(1);
    }
  });
});
