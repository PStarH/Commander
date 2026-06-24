/**
 * checkpointAdapters — Day 2 wire-through helpers.
 *
 * Each executor builds a `CheckpointState` envelope around its own native
 * state. WAL's `state_json` column persists the envelope as JSON; recovery
 * code reshapes back into executor-native state by reading
 * `executorState.kind + executorState.payload`.
 *
 * Serialization contract (the 3 anti-pitfalls from Day 2 thinker plan):
 *   1. stepNumber is monotonically increasing — each call here uses an
 *      externally-supplied integer; callers MUST pass next=current+1.
 *   2. JSON-safe subset only — strip Promises, AbortControllers,
 *      Map<Promise<...>>, and any other runtime object that does not
 *      survive JSON.stringify. The strip* helpers below are explicit so
 *      the contract is auditable in code review.
 *   3. Single source of truth — callers MUST NOT also write a parallel
 *      fs/tmp/rename path. If `safeCheckpointAtomically` is called, the
 *      ATR backend is the canonical recovery point.
 */

import { ReliabilityEngine } from '../runtime/reliabilityEngine';
import type { CheckpointState, CheckpointPhase } from '../runtime/stateCheckpointer';
import type { LLMMessage, TokenUsage } from '../runtime/types';
import type {
  SequentialPipelineRun,
  SequentialStepResult,
  OrchestrationMetrics,
} from './sequential';
import type { PoolResult } from './taskPool';
import type { GoalNode, RoundLedger, CritiqueResult } from '../goal/types';
import type { SwarmNode, SwarmManager, SwarmResult, FusionReport } from '../swarm/types';

// ============================================================================
// Phase labels
// ============================================================================

export const EXECUTOR_PHASES = {
  SEQUENTIAL_STEP: 'sequential-step',
  TASK_POOL_BATCH: 'task-pool-batch',
  GOAL_ROUND: 'goal-round',
  SWARM_ROUND: 'swarm-round',
} as const satisfies Record<string, CheckpointPhase>;

// ============================================================================
// Test-only phase guard (Day 6 hardening)
// ============================================================================

/**
 * Module-load assertion: the production EXECUTOR_PHASES const must
 * contain ONLY the four phases runtime executors emit. If a future
 * contributor accidentally adds a test-only phase value (e.g.
 * `'test-anchor'`) to this const, the CheckpointPhase union grows
 * silently and production-side emissions become possible. This
 * guard catches the addition at module-load time so the regression
 * surfaces immediately at test entry, before any WAL row is written.
 *
 * Implementation note: we use `Object.hasOwn` instead of a typed
 * index access like `EXECUTOR_PHASES['TEST_ANCHOR']` because the
 * outer `as const satisfies Record<string, CheckpointPhase>`
 * narrows the const's keys to the literal labels it carries. Only
 * `Object.hasOwn` accepts an arbitrary string key without forcing a
 * widening cast (`as Record<string, string>`) that would lose the
 * relationship between the const and `CheckpointPhase`.
 */
if (Object.hasOwn(EXECUTOR_PHASES, 'TEST_ANCHOR')) {
  throw new Error(
    '@test-only phase leaked to runtime: EXECUTOR_PHASES.TEST_ANCHOR must remain undefined. ' +
      'test-only phases belong in test-fixture local consts (as `as CheckpointPhase`), never in the ' +
      'production EXECUTOR_PHASES const whose `satisfies Record<string, CheckpointPhase>` would ' +
      'silently expand the production phase union.',
  );
}

/**
 * Internal canonical name for the test-only phase used by
 * `tests/stress/resume.hammer.test.ts`. Declared here (NOT in
 * EXECUTOR_PHASES const) so the production phase union stays clean
 * and the read-time guard can flag any leaked emission.
 */
const TEST_ANCHOR_PHASE_VALUE = 'test-anchor';

/**
 * Module-private toggle for the read-time test-only-phase guard.
 *
 * Default: `false` — production callers cannot acquire any state
 * with phase `'test-anchor'` through `tryResumeFromATR`; a tweet
 * attempt throws `'@test-only phase leaked to runtime'` visibly.
 *
 * Opt-in: test fixtures (specifically `resume.hammer.test.ts`)
 * call `setTestOnlyPhasesAllowed(true)` from `beforeAll` so the
 * 5-distinct-phase hammer can write + read stress-fixture rows
 * whose phase is `'test-anchor'`. Cleanup via
 * `setTestOnlyPhasesAllowed(false)` in `afterAll` prevents
 * leakage to other vitest workers running in parallel.
 */
let testOnlyPhasesAllowed = false;

export function setTestOnlyPhasesAllowed(allowed: boolean): void {
  testOnlyPhasesAllowed = allowed;
}

/**
 * Higher-order helper for the toggle-dance bracket.
 *
 * Sets `testOnlyPhasesAllowed = allowed` for the duration of `fn`, then
 * restores the previous value in `finally` regardless of `fn`'s outcome.
 * Composes with `assertNoTestOnlyPhase` for fixtures that need to plant
 * a `test-anchor` row in test mode and then immediately verify the
 * production-mode guard fires on a subsequent read/write:
 *
 *   setTestOnlyPhasesAllowed(false);  // baseline: production mode
 *   withTestOnlyPhasesAllowed(true, () => {
 *     // planting happens here — opt-in lets the guard return state
 *   });
 *   // helper restored prev=false; subsequent reads/writes run in
 *   // production mode and the guard fires.
 *
 * The `prev`-restore semantics matter: a hard-set-to-prev helper
 * composes cleanly with nested opt-in blocks. Tests should still
 * declare their baseline at the top of `it` so they're robust to
 * test-ordering drift.
 */
export function withTestOnlyPhasesAllowed<T>(allowed: boolean, fn: () => T): T {
  const prev = testOnlyPhasesAllowed;
  testOnlyPhasesAllowed = allowed;
  try {
    return fn();
  } finally {
    testOnlyPhasesAllowed = prev;
  }
}

// ============================================================================
// Envelope contract
// ============================================================================

export type ExecutorCheckpointKind = 'sequential' | 'task-pool' | 'goal-round' | 'swarm-round';

export interface ExecutorCheckpointEnvelope {
  kind: ExecutorCheckpointKind;
  payload: Record<string, unknown>;
}

// ============================================================================
// Shared primitives
// ============================================================================

const TOKEN_USAGE_ZERO = (): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

const EMPTY_MESSAGES: LLMMessage[] = [];

// ============================================================================
// JSON-safe sanitizer — protects strip helpers from non-serializable inputs
// ============================================================================

/**
 * Recursively walk a value and produce a JSON-safe equivalent.
 *
 * Coercion rules (Day 3 strip-helper hardening):
 *   - Promise / AbortController / Function / Symbol  → null
 *   - Map  → object with stringified keys
 *   - Set  → array
 *   - Date → ISO string
 *   - Error → { name, message }
 *   - Recursion depth > 10 → null (cycle / runaway safety)
 *
 * Used inside stripGoalNode / stripSwarmNode so a hostile metadata field
 * (e.g. a Promise accidentally captured before async cleanup) never
 * produces a TypeError out of `JSON.stringify` at WAL commit time. The
 * kill9 SIGKILL contract requires the row to land even when the caller
 * passed garbage.
 */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 10) return null;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return null;
  if (typeof Promise !== 'undefined' && value instanceof Promise) return null;
  if (typeof AbortController !== 'undefined' && value instanceof AbortController) return null;
  if (typeof Map !== 'undefined' && value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value) obj[String(k)] = jsonSafe(v, depth + 1);
    return obj;
  }
  if (typeof Set !== 'undefined' && value instanceof Set) {
    return [...value].map((v) => jsonSafe(v, depth + 1));
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1));
  if (t === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sv = jsonSafe(v, depth + 1);
      if (sv !== undefined) result[k] = sv;
    }
    return result;
  }
  return null;
}

/** Strip a CritiqueResult to JSON-safe subset (no Symbol, no class refs). */
export function stripCritique(c: CritiqueResult | undefined): Record<string, unknown> | null {
  if (!c) return null;
  return {
    passed: c.passed,
    findings: c.findings.map((f) => ({ ...f })),
    summary: c.summary,
  };
}

/** Strip a GoalNode to JSON-safe subset — recursive on subGoals. */
export function stripGoalNode(node: GoalNode): Record<string, unknown> {
  return {
    id: node.id,
    goal: node.goal,
    parentId: node.parentId,
    status: node.status,
    workerOutput: node.workerOutput ?? null,
    critique: stripCritique(node.critique),
    subGoals: node.subGoals.map(stripGoalNode),
    dependencies: [...node.dependencies],
    roundAssigned: node.roundAssigned ?? null,
    roundCompleted: node.roundCompleted ?? null,
    metadata: jsonSafe(node.metadata) ?? null,
  };
}

/** Strip a SwarmNode to JSON-safe subset.
 *
 *  Children carry `SwarmManager.result` which has a recursive `rootNodes`.
 *  We preserve the top-level manager summary for frontier recovery but
 *  explicitly do NOT recursively strip the full tree (avoid exponential
 *  retention). Callers wanting to resume a child manager can read the
 *  descendant rows by their own runIds.
 */
export function stripSwarmNode(node: SwarmNode): Record<string, unknown> {
  return {
    id: node.id,
    goal: node.goal,
    parentId: node.parentId,
    status: node.status,
    workerOutput: node.workerOutput ?? null,
    critique: stripCritique(node.critique),
    subNodes: node.subNodes.map(stripSwarmNode),
    children: node.children.map(stripSwarmManager),
    dependencies: [...node.dependencies],
    metadata: jsonSafe(node.metadata) ?? null,
  };
}

export function stripSwarmManager(m: SwarmManager): Record<string, unknown> {
  return {
    id: m.id,
    goal: m.goal,
    depth: m.depth,
    topology: { ...m.topology, levelBreaths: [...m.topology.levelBreaths] },
    result: m.result ? stripSwarmResult(m.result) : null,
  };
}

export function stripSwarmResult(r: SwarmResult): Record<string, unknown> {
  return {
    goal: r.goal,
    status: r.status,
    totalRounds: r.totalRounds,
    totalTokensUsed: r.totalTokensUsed,
    totalDurationMs: r.totalDurationMs,
    summary: r.summary,
  };
}

// ============================================================================
// Sequential adapter
// ============================================================================

export function serializeMetrics(m: OrchestrationMetrics): Record<string, unknown> {
  return {
    totalDuration: m.totalDuration,
    stepDurationSum: m.stepDurationSum,
    overheadDuration: m.overheadDuration,
    successCount: m.successCount,
    failureCount: m.failureCount,
    skippedCount: m.skippedCount,
    timeoutCount: m.timeoutCount,
    retryCount: m.retryCount,
    tokenUsage: { ...m.tokenUsage },
    averageStepDuration: m.averageStepDuration,
    stepDurationVariance: m.stepDurationVariance,
  };
}

/**
 * Strip a SequentialStepResult.  `output` is intentionally excluded from
 * the durable payload — its `unknown` shape is at risk of carrying
 * non-serializable runtime objects. Recovery re-queries the executor at
 * the resumption frontier and re-runs downstream steps; the durable
 * payload only needs to show that a step reached SUCCESS / FAILURE and
 * to plumb its error message for diagnostics.
 */
export function stripSequentialStepResult(r: SequentialStepResult): Record<string, unknown> {
  return {
    stepId: r.stepId,
    agentId: r.agentId,
    status: r.status,
    duration: r.duration,
    timestamp: r.timestamp,
    error: r.error ?? null,
    hasOutput: r.output !== undefined,
  };
}

export function serializeSequentialRun(run: SequentialPipelineRun): Record<string, unknown> {
  return {
    pipelineId: run.pipelineId,
    executionId: run.executionId,
    status: run.status,
    startTime: run.startTime,
    endTime: run.endTime ?? null,
    completedAt: run.completedAt ?? null,
    error: run.error ?? null,
    stepResults: run.stepResults.map(stripSequentialStepResult),
    metrics: serializeMetrics(run.metrics),
  };
}

export function toSequentialCheckpoint(
  runId: string,
  stepNumber: number,
  run: SequentialPipelineRun,
): CheckpointState {
  return {
    runId,
    agentId: 'sequential-pipeline',
    timestamp: new Date().toISOString(),
    phase: EXECUTOR_PHASES.SEQUENTIAL_STEP,
    stepNumber,
    attemptNumber: 0,
    messages: EMPTY_MESSAGES,
    tokenUsage: run.metrics?.tokenUsage ?? TOKEN_USAGE_ZERO(),
    stepDurations: run.stepResults.map((r) => r.duration),
    context: {
      agentId: 'sequential-pipeline',
      projectId: 'sequential',
      goal: run.pipelineId,
      availableTools: [],
      maxSteps: run.stepResults.length,
      tokenBudget: run.metrics?.tokenUsage?.totalTokens ?? 0,
    },
    totalDurationMs: run.metrics?.totalDuration ?? 0,
    executorState: {
      kind: 'sequential',
      payload: serializeSequentialRun(run),
    },
  };
}

// ============================================================================
// TaskPool adapter
// ============================================================================

export function toTaskPoolCheckpoint(
  runId: string,
  stepNumber: number,
  results: PoolResult[],
  totalTokensUsed: number,
): CheckpointState {
  return {
    runId,
    agentId: 'task-pool',
    timestamp: new Date().toISOString(),
    phase: EXECUTOR_PHASES.TASK_POOL_BATCH,
    stepNumber,
    attemptNumber: 0,
    messages: EMPTY_MESSAGES,
    tokenUsage: TOKEN_USAGE_ZERO(),
    stepDurations: [],
    context: {
      agentId: 'task-pool',
      projectId: 'taskpool',
      goal: runId,
      availableTools: [],
      maxSteps: results.length,
      tokenBudget: totalTokensUsed,
    },
    totalDurationMs: 0,
    executorState: {
      kind: 'task-pool',
      payload: {
        totalTokensUsed,
        results: results.map((r) => ({ ...r })),
      },
    },
  };
}

// ============================================================================
// Goal adapter
// ============================================================================

export function stripLedgerEntry(l: RoundLedger): Record<string, unknown> {
  return {
    round: l.round,
    goalSnapshot: l.goalSnapshot.map(stripGoalNode),
    findingsTotal: l.findingsTotal,
    findingsResolved: l.findingsResolved,
    findingsNew: l.findingsNew,
    improvementRate: l.improvementRate,
    tokensUsed: l.tokensUsed,
    totalTokensUsed: l.totalTokensUsed,
    decision: l.decision,
    decisionReason: l.decisionReason,
    summary: l.summary,
    timestamp: l.timestamp,
  };
}

export function toGoalRoundCheckpoint(
  runId: string,
  stepNumber: number,
  goal: string,
  goalTree: GoalNode[],
  ledger: RoundLedger[],
  totalTokensUsed: number,
  plateauRounds: number,
): CheckpointState {
  return {
    runId,
    agentId: 'goal-orchestrator',
    timestamp: new Date().toISOString(),
    phase: EXECUTOR_PHASES.GOAL_ROUND,
    stepNumber,
    attemptNumber: 0,
    messages: EMPTY_MESSAGES,
    tokenUsage: TOKEN_USAGE_ZERO(),
    stepDurations: [],
    context: {
      agentId: 'goal-orchestrator',
      projectId: 'goal',
      goal,
      availableTools: [],
      maxSteps: ledger.length,
      tokenBudget: totalTokensUsed,
    },
    totalDurationMs: ledger.reduce((s, r) => s + r.tokensUsed, 0),
    executorState: {
      kind: 'goal-round',
      payload: {
        round: stepNumber,
        goal,
        rootNodes: goalTree.map(stripGoalNode),
        ledger: ledger.map(stripLedgerEntry),
        totalTokensUsed,
        plateauRounds,
      },
    },
  };
}

// ============================================================================
// Swarm adapter
// ============================================================================

export function stripFusionReport(fr: FusionReport): Record<string, unknown> {
  return {
    round: fr.round,
    conflicts: fr.conflicts.map((c) => ({ ...c, nodeIds: [...c.nodeIds] })),
    resolvedCount: fr.resolvedCount,
    summary: fr.summary,
  };
}

export function toSwarmRoundCheckpoint(
  runId: string,
  stepNumber: number,
  goal: string,
  rootNodes: SwarmNode[],
  fusionReports: FusionReport[],
  totalTokensUsed: number,
): CheckpointState {
  return {
    runId,
    agentId: 'swarm-orchestrator',
    timestamp: new Date().toISOString(),
    phase: EXECUTOR_PHASES.SWARM_ROUND,
    stepNumber,
    attemptNumber: 0,
    messages: EMPTY_MESSAGES,
    tokenUsage: TOKEN_USAGE_ZERO(),
    stepDurations: [],
    context: {
      agentId: 'swarm-orchestrator',
      projectId: 'swarm',
      goal,
      availableTools: [],
      maxSteps: rootNodes.length,
      tokenBudget: totalTokensUsed,
    },
    totalDurationMs: 0,
    executorState: {
      kind: 'swarm-round',
      payload: {
        round: stepNumber,
        goal,
        rootNodes: rootNodes.map(stripSwarmNode),
        fusionReports: fusionReports.map(stripFusionReport),
        totalTokensUsed,
      },
    },
  };
}

// ============================================================================
// Soft-fail helper
// ============================================================================

/**
 * Run an ATR checkpoint through the engine, soft-failing on error.
 *
 * Callers MUST catch failures silently — checkpoint failures must not
 * crash the executor's main loop. The fallback observation is a single
 * `console.warn`; richer metric/observability hops land in Day 3+.
 *
 * If `engine` is undefined, this is a no-op (legacy test paths and
 * pre-Day-2 callers fall through cleanly).
 */
/**
 * Assert `state.phase !== 'test-anchor'` (or that test-only phases
 * were opted-in via `setTestOnlyPhasesAllowed(true)` via the
 * `withTestOnlyPhasesAllowed` helper). Single canonical guard —
 * callers MUST invoke this BEFORE any path that commits `state` to
 * the WAL. Returns `state` so it composes as an inline argument:
 *
 *   engine.checkpointAtomically(assertNoTestOnlyPhase(state));
 *
 * Exported (not inlined) so direct `engine.checkpointAtomically` test
 * fixtures re-use the same guard; this closes the spec-fidelity gap
 * the Day 6+2 reviewer flagged.
 *
 * The `state.phase as string` cast is required because `state.phase`
 * is typed `CheckpointPhase` (which excludes `'test-anchor'` — the
 * invariant we enforce); TS2367 narrowing would otherwise block the
 * comparison. Throws `@test-only phase 'test-anchor' write-side guard:…`
 * matched by regex in regression tests.
 */
export function assertNoTestOnlyPhase(state: CheckpointState): CheckpointState {
  const phaseStr = state.phase as string;
  if (phaseStr === TEST_ANCHOR_PHASE_VALUE && !testOnlyPhasesAllowed) {
    throw new Error(
      `@test-only phase '${TEST_ANCHOR_PHASE_VALUE}' write-side guard: ` +
        `Production callers MUST NOT emit checkpoints with phase 'test-anchor'. ` +
        `Only test fixtures — after calling setTestOnlyPhasesAllowed(true) — may pass. ` +
        `runId: ${state.runId}, stepNumber: ${state.stepNumber}.`,
    );
  }
  return state;
}

export function safeCheckpointAtomically(
  engine: ReliabilityEngine | undefined,
  state: CheckpointState,
): void {
  if (!engine) return;

  // Day 6+2: write-side guard via `assertNoTestOnlyPhase` BEFORE the
  // try-catch so the soft-fail DB fallback loop can't mask the
  // violation. The hard-throw gives ops a clean signal; the soft-fail
  // try/catch below stays for legitimate DB transients (busy /
  // locked) which Executor main loops must survive.
  assertNoTestOnlyPhase(state);

  try {
    engine.checkpointAtomically(state);
  } catch (err) {
    const kind = String(
      (state.executorState as ExecutorCheckpointEnvelope | undefined)?.kind ?? 'unknown',
    );
    // eslint-disable-next-line no-console
    console.warn(
      `[checkpoint] soft-fail kind=${kind} step=${state.stepNumber} err=${(err as Error)?.message}`,
    );
  }
}

// ============================================================================
// Recovery handler — Day 3 followup
// ============================================================================

/**
 * Filter options for `tryResumeFromATR`. Both fields are optional and
 * combine as a logical AND. When omitted, every phase matches and the
 * helper returns the latest checkpoint for `runId` regardless of kind.
 */
export interface ResumeFilter {
  /** Exact phase match — narrow the search to a single phase label. */
  phase?: CheckpointPhase;
  /** Set match — accept any phase in this list. */
  kinds?: readonly CheckpointPhase[];
}

/**
 * Discriminated union returned by `tryResumeFromATR`.
 *
 *   - `not-found`: no durable checkpoint exists for this runId (after
 *                  any filter is applied). Caller treats this as a
 *                  fresh-start signal.
 *   - `seed`:      stepNumber === 0. The run COMMENCED but did not
 *                  finish decomposition / first batch. Only the goal
 *                  string (goal/swarm executors) survives in the
 *                  payload. Caller must re-run decomposition before
 *                  resuming normal execution.
 *   - `resume`:    stepNumber >= 1. The executor-native payload is
 *                  fully populated. Caller rebuilds the in-memory
 *                  tree/state from `payload` and resumes forward.
 *
 * The 4 executors (Sequential / TaskPool / Goal / Swarm) each define a
 * payload schema; downstream `resumePointedAt(runId)` ABI entry-points
 * (planned for Day 4+) will branch on `executorKind`/phase to rehydrate
 * the correct shape.
 *
 * CALLER DISCIPLINE: the seed/resume split assumes writers obey the
 * Day 2 contract — every start commit uses stepNumber === 0 BEFORE
 * any decomposition or first batch runs. A future writer (migration
 * import, manual row insert, replay tooling) that emits stepNumber === 0
 * with a populated payload will be misclassified as seed and re-run
 * decomposition. If you need to inject synthetic rows, set stepNumber
 * >= 1 or bypass this helper and read the WAL directly.
 */
export type ResumePoint =
  | { kind: 'not-found'; runId: string; reason?: string }
  | {
      kind: 'seed';
      runId: string;
      phase: CheckpointPhase;
      executorKind: string;
      goal: string | null;
      payload: Record<string, unknown>;
    }
  | {
      kind: 'resume';
      runId: string;
      phase: CheckpointPhase;
      stepNumber: number;
      executorKind: string;
      payload: Record<string, unknown>;
    };

type EngineAction<T> = (engine: ReliabilityEngine) => T;
type EngineOpenResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * engineOpens — open an engine (transient if `dbPath` is supplied,
 * inherit existing instance otherwise) and run `action` against it.
 * All engine-construction errors are caught and collapsed into
 * `{ ok: false, reason }` so callers never see an exception escape.
 *
 * Reason format `<head>: <detail>` lets callers grep uniformly on
 * `^engine-`:
 *   - `engine-source-required: <typeof>:<value>`  source was neither
 *     a string nor a ReliabilityEngine instance
 *   - `engine-open-failed: <message>`  constructor threw (e.g. SQLite
 *     open failure that bypassed the in-memory fallback)
 *
 * Action-side throws are NOT caught here — the helper assumes the
 * caller wants uncaught exceptions to bubble unless explicitly wrapped.
 *
 * For path inputs, the helper runs `engine.shutdown()` in `finally`
 * before returning; for instance inputs, the caller retains ownership.
 */
function engineOpens<T>(
  source: ReliabilityEngine | string | null | undefined,
  action: EngineAction<T>,
): EngineOpenResult<T> {
  // Day 5: honor the type union instead of truthy duck-typing. A
  // number/string/object/etc. that isn't a ReliabilityEngine is
  // refused at the source-shape boundary rather than silently coerced
  // through `else if (source)`.
  if (typeof source !== 'string' && !(source instanceof ReliabilityEngine)) {
    return {
      ok: false,
      reason: `engine-source-required: ${describeRejectedSource(source)}`,
    };
  }
  let engine: ReliabilityEngine;
  let ownsEngine: boolean;
  if (typeof source === 'string') {
    try {
      engine = new ReliabilityEngine({ atrCheckpointPath: source });
    } catch (err) {
      return {
        ok: false,
        reason: `engine-open-failed: ${(err as Error)?.message ?? String(err)}`,
      };
    }
    ownsEngine = true;
  } else {
    engine = source;
    ownsEngine = false;
  }
  try {
    return { ok: true, value: action(engine) };
  } finally {
    if (ownsEngine) {
      try {
        engine.shutdown();
      } catch (err) {
        console.warn('[Catch]', err);
        /* best-effort — transient engine */
      }
    }
  }
}

/**
 * Render a rejected `source` argument as the `<typeof>:<value>` tail
 * of an `engine-source-required` reason.
 *
 * Discriminator rules:
 *   - null/undefined: explicit literals (typeof null would mislead)
 *   - symbol: `local` vs `registered` via `Symbol.keyFor` so
 *     `Symbol.for(x)` never collides with `Symbol(x)` even when their
 *     `.description` strings match
 *   - object: ctor name only (never recurse — PII / circular-ref risk)
 *   - other primitives: type-tagged fall-through
 *
 * Examples:
 *   Symbol()            → 'symbol:local:<unnamed>'
 *   Symbol('rank')      → 'symbol:local:rank'
 *   Symbol.for('rank')  → 'symbol:registered:rank'
 *   Symbol.iterator     → 'symbol:local:Symbol.iterator' (well-known)
 */
function describeRejectedSource(source: unknown): string {
  if (source === null) return 'null:null';
  if (source === undefined) return 'undefined:undefined';
  const t = typeof source;
  if (t === 'symbol') {
    // String(symbol) throws TypeError — handle explicitly so callers
    // passing accidental Symbol values get a clean reason string
    // rather than a crash out of engineOpens. Symbol.keyFor returns
    // the registration key for registered symbols, undefined otherwise.
    const sym = source as symbol;
    const key = Symbol.keyFor(sym);
    if (key !== undefined) return `symbol:registered:${key}`;
    const desc = sym.description;
    return `symbol:local:${desc ?? '<unnamed>'}`;
  }
  if (t === 'object') {
    const ctor = (source as { constructor?: { name?: string } })?.constructor?.name ?? 'Object';
    return `object:${ctor}`;
  }
  if (t === 'string') return `string:${JSON.stringify(source)}`;
  return `${t}:${String(source)}`;
}

/**
 * Look up the LATEST durable ATR row for `runId` and discriminate the
 * "started but not yet decomposed" case (stepNumber===0) from a real
 * resume candidate (stepNumber>=1).
 *
 * Source overloads:
 *   - `ReliabilityEngine` instance: caller retains the engine and
 *     can use it for follow-up writes (e.g. the resumed executor's
 *     next checkpoint).
 *   - `string` dbPath: helper opens a transient engine, runs the
 *     lookup, and shuts the engine down before returning. Useful
 *     for one-shot recovery flows that don't need a persistent
 *     handle.
 *   - `null` / `undefined`: collapses to `not-found` with reason
 *     starting `engine-source-required:` — caller passed garbage.
 *
 * Filter options narrow the phase allowlist. A phase mismatch behaves
 * like no row exists (returns `not-found`) so callers can branch on
 * `.kind` without separate filter bookkeeping.
 *
 * All failure modes are collapsed into the `{kind: 'not-found', reason}`
 * arm — the helper never throws. When the row exists but is
 * unreadable, the discriminator tags the reason with either
 * `corrupt-state-json` (JSON.parse fails) or `no-executor-state`
 * (state present but lacks `executorState`). A forensic caller can
 * route the row differently from a real missing-row case; the rest
 * of the codebase just treats it as a clean fresh-start signal.
 */
export function tryResumeFromATR(
  engineOrPath: ReliabilityEngine | string | null | undefined,
  runId: string,
  options?: ResumeFilter,
): ResumePoint {
  const opened = engineOpens(engineOrPath, (engine) => readResumePoint(engine, runId, options));
  if (opened.ok) return opened.value;
  return { kind: 'not-found', runId, reason: opened.reason };
}

/**
 * Inner worker for `tryResumeFromATR`. Split out so `engineOpens` can
 * own the engine-construction try/catch; this function only deals
 * with the read + classify phase and trusts that the engine it
 * receives is already open and SHAPE-valid.
 */
function readResumePoint(
  engine: ReliabilityEngine,
  runId: string,
  options?: ResumeFilter,
): ResumePoint {
  const latest = engine.getLatestCheckpoint(runId);
  if (!latest) return { kind: 'not-found', runId };

  // Day 6: read-time guard against `@test-only` phase emission. The
  // production EXECUTOR_PHASES const excludes 'test-anchor', so any
  // WAL row with that phase reaching `tryResumeFromATR` is either
  // (a) a test fixture that opted in via
  //     `setTestOnlyPhasesAllowed(true)` — allowed, OR
  // (b) a production-side leak — throw visibly so ops can spot it
  //     and route the row to forensic recovery instead of silently
  //     re-running normal classification.
  //
  // Implementation note: we capture the raw `phaseStr` BEFORE the
  // `as CheckpointPhase` narrowing so the comparison can run against
  // the literal phase string from the WAL — which the production
  // `CheckpointPhase` union intentionally excludes. After the
  // guard, narrowing `phaseStr` to `phase` produces a `CheckpointPhase`
  // for the downstream filter/classify logic. No cast needed at the
  // comparison site: `phaseStr` is structurally a string (whatever
  // shape `latest.phase` returns), and `TEST_ANCHOR_PHASE_VALUE` is
  // a string literal — the comparison is honest and honest-checking
  // is exactly what we want.
  const phaseStr = latest.phase;
  if (phaseStr === TEST_ANCHOR_PHASE_VALUE && !testOnlyPhasesAllowed) {
    throw new Error(
      `@test-only phase '${TEST_ANCHOR_PHASE_VALUE}' leaked to runtime. ` +
        `Production code MUST NOT emit checkpoints with this phase; only test ` +
        `fixtures (e.g. resume.hammer.test.ts) are permitted to, after calling ` +
        `setTestOnlyPhasesAllowed(true). Engine: ${engine.constructor?.name ?? '<unknown>'}, runId: ${runId}.`,
    );
  }
  const phase = phaseStr as CheckpointPhase;

  if (options?.phase && phase !== options.phase) {
    return { kind: 'not-found', runId };
  }
  if (options?.kinds && !options.kinds.includes(phase)) {
    return { kind: 'not-found', runId };
  }

  let state: CheckpointState;
  try {
    state = JSON.parse(latest.stateJson) as CheckpointState;
  } catch (err) {
    console.warn('[Catch]', err);
    // Corrupt stateJson → collapse to not-found with a forensic
    // reason tag, and log first so ops can spot partial WAL rows
    // that would otherwise be silently overwritten by a fresh
    // start. Forensic recovery goes through the raw backend, not
    // this convenience layer.
    // eslint-disable-next-line no-console
    console.warn(`[resume] corrupt stateJson for runId=${runId}`);
    return { kind: 'not-found', runId, reason: 'corrupt-state-json' };
  }
  if (!state.executorState) {
    return { kind: 'not-found', runId, reason: 'no-executor-state' };
  }

  const envelope = state.executorState as unknown as ExecutorCheckpointEnvelope;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const executorKind = envelope.kind ?? 'unknown';

  if (latest.stepNumber === 0) {
    const goalRaw = (payload as { goal?: unknown }).goal;
    const goal = typeof goalRaw === 'string' ? goalRaw : null;
    return {
      kind: 'seed',
      runId,
      phase,
      executorKind,
      goal,
      payload,
    };
  }

  return {
    kind: 'resume',
    runId,
    phase,
    stepNumber: latest.stepNumber,
    executorKind,
    payload,
  };
}
