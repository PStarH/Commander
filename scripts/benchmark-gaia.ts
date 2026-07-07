#!/usr/bin/env tsx
/**
 * scripts/benchmark-gaia.ts — Phase 1 ATR/ExecutionScheduler-pinned GAIA benchmark.
 *
 * Background:
 *   CHANGELOG.md line 87 documents the historical regression:
 *     "Previous 69.7% result was invalidated by a scoring bug (empty
 *      `expected` field marked responses as correct)."
 *   Root cause: EvalScorer (`packages/core/src/observability/evalScorer.ts`)
 *   passes `{{expected}}` through `safeJson(undefined)` → renders the JSON
 *   literal `null` into the judge prompt. The judge LLM reasonably
 *   interprets "EXPECTED: null" as "no ground truth, anything goes" and
 *   marks every response correct.
 *
 * Phase 1 Goal:
 *   1. Replace the historical binary verdict (CORRECT/INCORRECT) with a
 *      3-way verdict (CORRECT / INCORRECT / UNGRADED) that returns
 *      `UNGRADED` whenever the expected answer is missing OR reduces to
 *      empty after normalization (e.g. all-punctuation "...").
 *   2. Pin the run lifecycle to ATR's ExecutionScheduler so the lease /
 *      idempotency / RunLedger invariants are exercised on every task.
 *      UltimateOrchestrator is class-loaded and constructor-tested, but
 *      NOT invoked end-to-end in this script — that requires a real
 *      AgentRuntime + mock LLM provider layer which Phase 2 will add.
 *   3. Provide a `--quick` offline 10-task dry-run that proves (a) the
 *      scoring regression is gone (b) the spine is healthy (c) the
 *      script does NOT need API keys to run (d) the script is
 *      re-runnable without manual cleanup.
 *
 * Usage:
 *   pnpm benchmark:gaia          # 165-task GAIA fixture (Phase 2, NOT YET IMPLEMENTED)
 *   pnpm benchmark:gaia:quick    # 10-task offline dry-run (Phase 1)
 *
 * Exit codes:
 *   0  spine healthy + scoring correct (UNGRADED for empty expected)
 *   1  spine failure (run not COMMITTED in ledger)
 *   2  scoring regression (empty expected graded as anything other than UNGRADED)
 *   3  orchestrator wiring failure (UltimateOrchestrator constructor throws)
 *   4  invoked without `--quick` flag — full mode (165-task fixture) is
 *      Phase 2 work and not yet implemented. Split from code 2 so CI
 *      dashboards can distinguish a scoring bug from a missing-fixture bug.
 *
 * Cron-gate contract: When invoked with `--output=<path>`, the script writes
 *   a canonical baseline JSON BEFORE returning the exit code above, so the
 *   cron workflow's day-over-day drift gate (`.github/workflows/gaia-bench.yml`)
 *   still has a baseline artifact to diff against when the run fails. The
 *   shape mirrors the other bench-* scripts (slo, tenant-isolation, cost,
 *   memory-poisoning) so the cron baseline writer/plotter tooling does not
 *   need a per-bench special case.
 *
 * Re-runnability: process.env.COMMANDER_ATR_MEMORY=1 is set at module-load
 *   time so the file-backed RunLedger at .commander/atr_ledger.db is bypassed
 *   in favor of an in-memory SQLite DB. Without this, the dry-run would only
 *   succeed once — the second invocation would replay the same idempotency
 *   keys and trip the spine's `replayed !== false` assertion. The switch is
 *   read inside createLedgerSingleton() in packages/core/src/atr/runLedger.ts
 *   at singleton-creation time, so any value set before the first
 *   `getExecutionScheduler()` call wins. Setter is placed BEFORE imports to
 *   be unambiguous even though ESM/CJS doesn't strictly require it.
 */

// MUST be set BEFORE first `getExecutionScheduler()` call AND BEFORE any
// new module-load-time singleton that reads COMMANDER_ATR_MEMORY. Placed
// before imports so the execution order is unambiguous even if a future
// TypeScript emit target reorders top-level statements.
//
// Future-maintainer invariant: when adding NEW imports above (or
// transitively reachable types), verify that NONE of the imported
// modules initialize a singleton that reads
// `process.env.COMMANDER_ATR_MEMORY` at module-load time. A side-effecting
// import + a re-runnability-ordering bug = silent break of the second
// `tsc scripts/benchmark-gaia.ts --quick` invocation (the file-backed
// ledger would collide on idempotency keys on the second run). See
// `packages/core/src/atr/runLedger.ts` for the env var's read site — any
// new transitive importer MUST be ordered after this `process.env` setter.
process.env.COMMANDER_ATR_MEMORY = '1';

import { UltimateOrchestrator } from '../packages/core/src/ultimate/orchestrator';
import { TELOSOrchestrator } from '../packages/core/src/telos/telosOrchestrator';
import { getExecutionScheduler } from '../packages/core/src/atr/scheduler';
import type { AgentRuntimeInterface } from '../packages/core/src/runtime/agentRuntimeInterface';
import { score, type Verdict, type ScoreResult } from '../packages/core/src/observability/score';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Scoring — 3-way verdict (CORRECT / INCORRECT / UNGRADED)
//
// The historical verdict was binary. We upgrade to 3-way so missing ground
// truth cannot be silently swallowed as "correct".
//
// `score`, `Verdict`, and `ScoreResult` are imported from the shared
// `packages/core/src/observability/score.ts` module — the SINGLE source of
// truth. The vitest runtime tests in
// `packages/core/tests/observability/evalScorer.test.ts` import from the
// same module, so the asymmetric-parameter-types invariant is locked at
// one site.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Self-test for `score()` — runs BEFORE the dry-run and exits 2 if any
 * regression-safety case misbehaves. Catches both:
 *   - empty-expected path (the original CHANGELOG regression)
 *   - all-punctuation post-normalize-empty path (the harder-to-spot variant)
 */
function runScoringSelfTest(): void {
  const cases: Array<{
    label: string;
    expectedVerdict: Verdict;
    run: () => ScoreResult;
  }> = [
    {
      label: 'undefined expected → UNGRADED',
      expectedVerdict: 'UNGRADED',
      run: () => score(undefined, 'anything'),
    },
    {
      label: 'null expected → UNGRADED',
      expectedVerdict: 'UNGRADED',
      run: () => score(null, 'anything'),
    },
    {
      label: '"" expected → UNGRADED',
      expectedVerdict: 'UNGRADED',
      run: () => score('', 'anything'),
    },
    {
      label: '" " (whitespace) expected → UNGRADED',
      expectedVerdict: 'UNGRADED',
      run: () => score(' ', 'anything'),
    },
    {
      label: '"..." (all-punctuation) expected → UNGRADED [regression-safety]',
      expectedVerdict: 'UNGRADED',
      run: () => score('...', "this would have been CORRECT via String.includes('')"),
    },
    {
      label: 'matching substring → CORRECT',
      expectedVerdict: 'CORRECT',
      run: () => score('Tim Cook', 'Tim Cook is the CEO.'),
    },
    {
      label: 'mismatch → INCORRECT',
      expectedVerdict: 'INCORRECT',
      run: () => score('14', '15'),
    },
    {
      label: 'non-string object expected → UNGRADED [non_string_expected_not_substring_matchable]',
      // No cast needed — score() now accepts `unknown` for `expected` to
      // defend against runtime non-string inputs (e.g. parsed from JSON).
      // The shared classifyExpectedForSubstringMatch refuses rather than
      // silently emitting INCORRECT.
      expectedVerdict: 'UNGRADED',
      run: () => score({ outputContains: ['y'] }, 'y'),
    },
  ];

  const failures: string[] = [];
  for (const c of cases) {
    const r = c.run();
    if (r.verdict !== c.expectedVerdict) {
      failures.push(
        `  [FAIL] ${c.label}  expected=${c.expectedVerdict}  got=${r.verdict}  reason=${r.reason}`,
      );
    } else {
      console.log(`  [PASS] ${c.label}  → ${r.verdict}`);
    }
  }
  if (failures.length > 0) {
    console.error('Scoring self-test FAILED:');
    for (const f of failures) console.error(f);
    throw new Error('scoring self-test failed — historical regression has resurfaced');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spine cycle — drive ExecutionScheduler directly so we never bypass ATR.
//
// Mirrors what UltimateOrchestrator.execute() does internally:
//   beginRun → scheduleAction → recordResult → commitRun
// Crucially, EVERY state-mutating call requires the lease token + fencing
// epoch that beginRun returned. We pass those back through the cycle so a
// stale caller would be rejected at the ledger boundary.
// ─────────────────────────────────────────────────────────────────────────────

interface SpineHandle {
  runId: string;
  leaseToken: string;
  fencingEpoch: number;
  intentHash: string;
}

interface SyntheticTask {
  id: string;
  agentId: string;
  projectId: string;
  /** What the (mock) agent would receive as input. */
  input: string;
  /** What the (mock) agent should have output. */
  mockOutput: string;
  /** Ground truth from the dataset (may be empty to test the ungraded path). */
  expected: string;
}

const SPINE_TENANT = 'spine-dry-run';

function spineBegin(task: SyntheticTask): SpineHandle {
  const handle = getExecutionScheduler().beginRun({
    runId: `gaia_dry_${task.id}`,
    goal: task.input,
    intent: task.input,
    tenantId: SPINE_TENANT,
    metadata: {
      phase: 'gaia-dry-run',
      taskId: task.id,
      agentId: task.agentId,
      projectId: task.projectId,
    },
    ttlSeconds: 60,
    holder: `gaia-dry-run-${task.id}`,
  });
  return {
    runId: handle.runId,
    leaseToken: handle.leaseToken,
    fencingEpoch: handle.fencingEpoch,
    intentHash: handle.intentHash,
  };
}

function spineSchedule(handle: SpineHandle, task: SyntheticTask): string {
  const scheduleResult = getExecutionScheduler().scheduleAction({
    runId: handle.runId,
    leaseToken: handle.leaseToken,
    fencingEpoch: handle.fencingEpoch,
    tenantId: SPINE_TENANT,
    toolName: 'agent.run',
    externalSystem: 'llm',
    args: {
      synthetic: true,
      input: task.input,
      agentId: task.agentId,
      projectId: task.projectId,
    },
    idempotencyKey: `idempotency_${task.id}_${handle.intentHash.slice(0, 16)}`,
    compensable: false,
    description: `Synthetic GAIA dry-run task ${task.id}`,
  });
  if (!scheduleResult) {
    throw new Error(`Spine failure: scheduleAction returned null for ${task.id}`);
  }
  if (scheduleResult.replayed) {
    // We don't expect replays for fresh task ids; surface this so we know
    // if the idempotency layer is replaying across invocations (which would
    // indicate a re-runnability bug — fixes like COMMANDER_ATR_MEMORY=1
    // should prevent this).
    throw new Error(
      `Spine failure: scheduleAction replayed (cached) for ${task.id} — idempotency bug`,
    );
  }
  return scheduleResult.actionId;
}

function spineRecord(handle: SpineHandle, actionId: string, output: string): void {
  getExecutionScheduler().recordResult({
    runId: handle.runId,
    leaseToken: handle.leaseToken,
    fencingEpoch: handle.fencingEpoch,
    tenantId: SPINE_TENANT,
    actionId,
    result: output,
  });
}

function spineCommit(handle: SpineHandle): void {
  const commitResult = getExecutionScheduler().commitRun({
    runId: handle.runId,
    leaseToken: handle.leaseToken,
    fencingEpoch: handle.fencingEpoch,
    tenantId: SPINE_TENANT,
  });
  if (!commitResult.committed) {
    throw new Error(
      `Spine failure: commitRun did not commit run ${handle.runId} — reason=${commitResult.reason ?? 'unknown'}`,
    );
  }
}

function assertSpineCommitted(handle: SpineHandle, expectedTaskId: string): void {
  const tx = getExecutionScheduler().getRun({
    runId: handle.runId,
    tenantId: SPINE_TENANT,
  });
  if (!tx) {
    throw new Error(
      `Spine failure: run ${handle.runId} not found in ledger after commit (taskId=${expectedTaskId})`,
    );
  }
  if (tx.state !== 'COMMITTED') {
    throw new Error(
      `Spine failure: run ${handle.runId} state=${tx.state}, expected COMMITTED (taskId=${expectedTaskId})`,
    );
  }
  if (tx.actions.length === 0) {
    throw new Error(
      `Spine failure: run ${handle.runId} has zero actions (taskId=${expectedTaskId})`,
    );
  }
  if (tx.metadata?.taskId !== expectedTaskId) {
    throw new Error(
      `Spine failure: run ${handle.runId} metadata.taskId=${String(tx.metadata?.taskId)}, expected ${expectedTaskId}`,
    );
  }
  if (tx.leaseToken !== handle.leaseToken || tx.fencingEpoch !== handle.fencingEpoch) {
    throw new Error(
      `Spine failure: run ${handle.runId} ledger credentials mismatch — possible fence attack (taskId=${expectedTaskId})`,
    );
  }
}

async function runSpine(task: SyntheticTask): Promise<SpineHandle> {
  const handle = spineBegin(task);
  const actionId = spineSchedule(handle, task);
  spineRecord(handle, actionId, task.mockOutput);
  spineCommit(handle);
  assertSpineCommitted(handle, task.id);
  return handle;
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic tasks — 10 offline cases that mirror GAIA's task shape.
//
// Three of these (Task 1, Task 9, Task 10) intentionally have empty `expected`
// fields to exercise the UNGRADED branch. The all-punctuation regression is
// covered by the scoring self-test above (a synthetic task with `expected='...'`
// isn't added to the dry-run list because it would skew the documented
// 30%-ungraded rate; the self-test exercises the same code path deterministically).
// ─────────────────────────────────────────────────────────────────────────────

const SYNTHETIC_TASKS: readonly SyntheticTask[] = [
  {
    // 1 — REGRESSION CHECK (placed FIRST so a regression fails fast)
    id: 'gaia_synth_01',
    agentId: 'agent_ungraded_1',
    projectId: 'project_ungraded_1',
    input: '[SYNTHETIC] What is the meaning of the universe?',
    mockOutput: '42 is a joke.',
    expected: '',
  },
  {
    // 2 — SIMPLE factual lookup
    id: 'gaia_synth_02',
    agentId: 'agent_lookup_apple_ceo',
    projectId: 'project_lookup_apple_ceo',
    input: '[SYNTHETIC] Who is the CEO of Apple?',
    mockOutput: 'Tim Cook',
    expected: 'Tim Cook',
  },
  {
    // 3 — MODERATE reasoning (arithmetic)
    id: 'gaia_synth_03',
    agentId: 'agent_arith_apples',
    projectId: 'project_arith_apples',
    input: '[SYNTHETIC] If I have 3 apples and eat 1, how many are left?',
    mockOutput: '2',
    expected: '2',
  },
  {
    // 4 — COMPLEX inference (long-form)
    id: 'gaia_synth_04',
    agentId: 'agent_complex_mars',
    projectId: 'project_complex_mars',
    input: '[SYNTHETIC] Analyze the geopolitical impact of Mars colonies on Earth.',
    mockOutput: 'The impact would be a significant paradigm shift in human history.',
    expected: 'significant paradigm shift',
  },
  {
    // 5 — ARITHMETIC (mirrors real GAIA math problems)
    id: 'gaia_synth_05',
    agentId: 'agent_math_q1',
    projectId: 'project_math_q1',
    input: '[SYNTHETIC] MATH:Q Evaluate 7 * 2',
    mockOutput: '14',
    expected: '14',
  },
  {
    // 6 — STRING transformation
    id: 'gaia_synth_06',
    agentId: 'agent_reverse_cat',
    projectId: 'project_reverse_cat',
    input: "[SYNTHETIC] Reverse the word 'cat'",
    mockOutput: 'tac',
    expected: 'tac',
  },
  {
    // 7 — SORTING (mirrors real GAIA structured-data questions)
    id: 'gaia_synth_07',
    agentId: 'agent_sort_312',
    projectId: 'project_sort_312',
    input: '[SYNTHETIC] SORT:Q Sort these numbers: 3, 1, 2',
    mockOutput: '1, 2, 3',
    expected: '1, 2, 3',
  },
  {
    // 8 — CLASSIFICATION (multi-class)
    id: 'gaia_synth_08',
    agentId: 'agent_classify_dog',
    projectId: 'project_classify_dog',
    input: '[SYNTHETIC] Classify a dog as mammal, bird, or reptile.',
    mockOutput: 'mammal',
    expected: 'mammal',
  },
  {
    // 9 — TOOL-REQUIRING with empty expected (regression check #2)
    id: 'gaia_synth_09',
    agentId: 'agent_tool_weather_paris',
    projectId: 'project_tool_weather_paris',
    input: '[SYNTHETIC] Fetch weather in Paris and write to /tmp/weather.md',
    mockOutput: 'Wrote Sunny to /tmp/weather.md',
    expected: '',
  },
  {
    // 10 — Empty-edge GENERATIVE with empty expected (regression check #3)
    id: 'gaia_synth_10',
    agentId: 'agent_open_ended_poem',
    projectId: 'project_open_ended_poem',
    input: '[SYNTHETIC] Generate a generic poem.',
    mockOutput: 'Roses are red.',
    expected: '',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator wiring sanity check
//
// We do NOT call UltimateOrchestrator.execute() in this dry-run — its runtime
// dependencies (a full AgentRuntime + mock LLM providers) are heavyweight and
// would require extensive stubs for offline use. Instead we instantiate the
// class with stub inputs to catch constructor-shape regressions the type
// system can't see (e.g. accidentally requiring a 4th positional argument).
//
// NOTE: This relies on UltimateOrchestrator's constructor chain being
// eager-stub-safe — i.e. it may pass `runtime` into `new SubAgentExecutor(...)`
// but must NOT call any method on `runtime` during construction. If a
// future change makes SubAgentExecutor or any peer constructor eager-method,
// the `Object.freeze({})` stub below will throw a TypeError and surface as
// exit code 3 with the stack trace pointing at the offending call site.
// ─────────────────────────────────────────────────────────────────────────────

function assertOrchestratorClassLoadable(): void {
  try {
    // Stub the AgentRuntime with Object.freeze({}) so any property ACCESS
    // (not construction) surfaces immediately as TypeError. This catches
    // eager method calls in UltimateOrchestrator's constructor chain.
    const stubRuntime = Object.freeze({});
    const telos = new TELOSOrchestrator();
    // `as unknown` is required because AgentRuntimeInterface has ~30
    // methods we don't need to stub for construction-only validation.
    const _instance = new UltimateOrchestrator(
      telos,
      stubRuntime as unknown as AgentRuntimeInterface,
    );
    if (!_instance || typeof _instance.execute !== 'function') {
      throw new Error('UltimateOrchestrator instance missing .execute() method');
    }
  } catch (err) {
    throw new Error(
      `Orchestrator wiring failure: UltimateOrchestrator constructor threw: ${
        (err as Error).message
      }`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');

  // Phase 2 explicitly NOT-YET-IMPLEMENTED guard.
  // Running without `--quick` without the 165-task fixture would silently
  // re-run the 10-task list while printing "full" — exactly the misleading
  // UX the code-reviewer flagged. Exit code 4 (not 2) so CI distinguishes
  // this signal from a real scoring regression.
  if (!quick) {
    console.error('========================================================');
    console.error('Commander GAIA: --full mode requires the 165-task GAIA');
    console.error('fixture which is Phase 2 work and NOT YET IMPLEMENTED.');
    console.error('');
    console.error('For now, run:');
    console.error('  pnpm benchmark:gaia:quick   # 10-task offline dry-run');
    console.error('========================================================');
    return 4;
  }

  const tasks = SYNTHETIC_TASKS;

  console.log('=== Commander GAIA spine-restricted benchmark ===');
  console.log(`Mode:                quick (10 tasks, offline — Phase 1)`);
  console.log(`Spine pinning:       getExecutionScheduler() from packages/core/src/atr/scheduler`);
  console.log(
    `Orchestrator pin:    UltimateOrchestrator class loadable + constructable from packages/core/src/ultimate/orchestrator`,
  );
  console.log(`Ledger backing:      in-memory SQLite (COMMANDER_ATR_MEMORY=1) for re-runnability`);
  console.log(
    `Scoring contract:    3-way verdict (CORRECT | INCORRECT | UNGRADED) — empty expected = UNGRADED`,
  );
  console.log(`Started:             ${new Date().toISOString()}`);
  console.log('');

  // Phase 0 — scoring self-test (catches both historical regressions fast)
  console.log('[Phase 0] Scoring self-test ...');
  try {
    runScoringSelfTest();
  } catch (err) {
    console.error('[Phase 0] FAILED:', (err as Error).message);
    return 2;
  }
  console.log('');

  // Phase A — orchestrator class load check
  try {
    assertOrchestratorClassLoadable();
    console.log('[Phase A] UltimateOrchestrator class loadable: OK');
  } catch (err) {
    console.error('[Phase A] FAILED:', (err as Error).message);
    return 3;
  }
  console.log('');

  // Phase B — 10-task dry-run + scoring
  const summary = { correct: 0, incorrect: 0, ungraded: 0, spineErrors: 0, scoringRegressions: 0 };
  const startMs = Date.now();

  console.log(`[Phase B] Running ${tasks.length} synthetic tasks through ExecutionScheduler ...`);
  console.log('');
  for (const task of tasks) {
    try {
      await runSpine(task);
      const verdict = score(task.expected, task.mockOutput);

      // Hard regression check: empty `expected` MUST grade UNGRADED.
      if ((task.expected === '' || task.expected === undefined) && verdict.verdict !== 'UNGRADED') {
        summary.scoringRegressions++;
        console.error(
          `  [REGRESSION] ${task.id}: empty expected graded ${verdict.verdict} — historical bug has resurfaced`,
        );
        continue;
      }

      switch (verdict.verdict) {
        case 'CORRECT':
          summary.correct++;
          break;
        case 'INCORRECT':
          summary.incorrect++;
          break;
        case 'UNGRADED':
          summary.ungraded++;
          break;
      }
      console.log(
        `  [${verdict.verdict.padEnd(8)}] ${task.id}  ${verdict.reason}  expected="${task.expected || '<empty>'}" actual="${task.mockOutput.slice(0, 64)}"`,
      );
    } catch (err) {
      summary.spineErrors++;
      console.error(`  [SPINE ERR] ${task.id}: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  const total = tasks.length;
  const graded = summary.correct + summary.incorrect;
  const ungradedRate = (summary.ungraded / total) * 100;
  // Computed-grade score: divide correct by graded (excluding ungraded).
  // 0/(graded==0) → 0. UNGRADED is reported separately. This recovers the
  // "effective GAIA score" while never inflating with missing ground truth.
  const effectiveScore = graded === 0 ? 0 : (summary.correct / graded) * 100;
  const durationMs = Date.now() - startMs;

  console.log('');
  console.log('=== Summary ===');
  console.log(`Tasks total:        ${total}`);
  console.log(`Correct:            ${summary.correct}`);
  console.log(`Incorrect:          ${summary.incorrect}`);
  console.log(`Ungraded:           ${summary.ungraded} (${ungradedRate.toFixed(1)}%)`);
  console.log(
    `Effective GAIA:    ${effectiveScore.toFixed(1)}% (correct/graded, ungraded excluded)`,
  );
  console.log(`Spine errors:       ${summary.spineErrors}`);
  console.log(
    `Scoring regressions: ${summary.scoringRegressions} (empty expected must grade UNGRADED)`,
  );
  console.log(`Duration:           ${(durationMs / 1000).toFixed(2)}s`);
  console.log('');

  // Phase C — exit code mapping. Captured into a variable (instead of
  // direct `return N`) so the JSON emit phase (Phase D) can run BEFORE
  // process.exit() and surface the full baseline JSON artifact even when
  // the bench fails. This matches the cron-gate contract documented at the
  // top of .github/workflows/gaia-bench.yml.
  let exitCode = 0;
  let failedReason: string | null = null;
  if (summary.spineErrors > 0) {
    failedReason = `spine health check tripped (${summary.spineErrors} task(s))`;
    console.error(`FAILED: ${failedReason}`);
    exitCode = 1;
  } else if (summary.scoringRegressions > 0) {
    failedReason =
      'scoring regression: empty-expected tasks graded as something other than UNGRADED';
    console.error(`FAILED: ${failedReason}`);
    exitCode = 2;
  } else if (ungradedRate < 25 || ungradedRate > 35) {
    // We expect 3/10 = 30% ungraded. Outside this band means either we
    // accidentally removed the regression tasks or something else is wrong.
    failedReason = `ungraded rate ${ungradedRate.toFixed(
      1,
    )}% outside expected 25-35% band (should be 30%=3/10)`;
    console.error(`FAILED: ${failedReason}`);
    exitCode = 2;
  } else {
    console.log(
      'PASSED: spine healthy + scoring correct (UNGRADED preserved for empty expected).',
    );
  }

  // Phase D — JSON result emit (optional, cron-gate contract).
  // When invoked as `benchmark-gaia.ts --quick --output=<path>`, write the
  // canonical baseline JSON so the cron workflow's day-over-day drift gate
  // can read it without parsing stdout. Shape matches the other bench-*
  // scripts (slo / tenant-isolation / cost / memory-poisoning).
  const outputArg = argv.find((a) => a.startsWith('--output='));
  const outputPath = outputArg ? outputArg.slice('--output='.length) : null;
  if (outputPath) {
    try {
      const result = {
        runAt: new Date().toISOString(),
        mode: quick ? 'quick' : 'full',
        passed: exitCode === 0,
        exitCode,
        failedReason,
        summary: {
          total,
          correct: summary.correct,
          incorrect: summary.incorrect,
          ungraded: summary.ungraded,
          ungradedRate,
          effectiveScore,
          spineErrors: summary.spineErrors,
          scoringRegressions: summary.scoringRegressions,
        },
        durationMs,
      };
      const dir = dirname(outputPath);
      if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
      writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`Result JSON written: ${outputPath}`);
    } catch (err) {
      console.error(`Failed to write result JSON: ${(err as Error).message}`);
    }
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Unhandled error in benchmark-gaia:', err);
    process.exit(99);
  },
);
