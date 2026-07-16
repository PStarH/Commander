/**
 * ExecutionContext — per-run mutable state container for AgentRuntime.
 *
 * Extracted from the 4,806-line `agentRuntime.ts` god object (Task Package 3,
 * subtask 3.2). Prior to this extraction, `AgentRuntime` reassigned instance
 * fields like `this.slidingWindow = new SlidingWindowOrchestrator()` on every
 * `execute()` call. That pattern created data races under concurrent runs (two
 * requests in flight could each rebuild the other run's sliding window between
 * tool loop iterations) and made per-run isolation impossible to test.
 *
 * Scope of this extraction:
 *   - Per-run mutable fields ONLY. Construction-time singletons
 *     (`circuitBreaker`, `verificationPipeline`, `orchestrator`, ...) stay on
 *     `AgentRuntime`.
 *   - Locks in the pattern that `enter(ctx)` resets state and `exit()` clears
 *     run-handle / ledger context. The runtime's `execute()` body becomes:
 *       `const ctx = this.executionContext.enter(agentCtx); try { ... }
 *        finally { this.executionContext.exit(); }`
 *   - Keeps `governor` AND `slidingWindow` mutable per-run so concurrent
 *     `execute()` calls do not stomp each other. The lifecycle is symmetric:
 *     every comparator downstream of these objects (e.g. `CacheManager`,
 *     `VerificationPipeline`) reads them off the context, not the runtime.
 *   - `executedMutations`, `promotedTools`, `runHandle`, `ledgerCtx` are
 *     scratchpad state for the tool loop. Moved here so the loop can be
 *     extracted later as a separate Task 3.4 (ToolRegistry) concern.
 *
 * Lifecycle contract (intentionally asymmetric):
 *   - `enter()` resets all scratch state and rebuilds per-run governor +
 *     sliding window. Builds a NEW sliding window because the existing
 *     `resetSession()` only touches counters and skipping reconstruction
 *     would leak prior-turn dashboard counters between runs.
 *   - `exit()` clears run-handle + ledger-ctx (run-handle ownership belongs
 *     to the ExecutionScheduler and must be released per-run) but keeps
 *     the governor and sliding window alive — they act as a fallback for
 *     diagnostic readers hit between runs. Don't add a docstring claim
 *     about "only construction-time state remains."
 *
 * Out of scope (deliberately):
 *   - `messages` array — already lives inside the `LLMRequest.messages` field;
 *     extraction would mean inventing a parallel shadow state.
 *   - `tools: Map<string, Tool>` — tool registration happens globally, not
 *     per-run; that side of the ledger moves to Task 3.4 (ToolRegistry).
 *     The one per-run write — `this.tools.set('request_tool', requestTool)`
 *     in `execute()` — is documented as a follow-up; the migration PR will
 *     route it via `ExecutionContext`'s pre-run hook list, not here.
 *   - Construction-time singletons — see scope above.
 *
 * Backward compat: this file initially co-exists with the in-place fields on
 * AgentRuntime. During the staged migration, `AgentRuntime.execute()` will
 * delegate mutable-state reads to `this.executionContext.slidingWindow` etc.
 * Old field assignments are kept as proxy getters until every call site in
 * `execute()` (~150 references) is migrated in a follow-up PR.
 *
 * Tests: see `tests/runtime/executionContext.test.ts` (added in follow-up).
 */

import { SlidingWindowOrchestrator } from './slidingWindowOrchestrator';
import { TokenGovernor, type TaskCategory } from './tokenGovernor';
import type { RunHandle } from '../atr/scheduler';
import type { PlannedToolCall } from '../compensation/rollbackPlanner';

// ============================================================================
// Configuration
// ============================================================================

export interface ExecutionContextConfig {
  /** Hard cap used to seed the per-run TokenGovernor when no ctx budget is supplied. */
  defaultBudgetHardCap?: number;
  /** Defaults for the SlidingWindowOrchestrator when ctx does not supply one. */
  slidingWindowConfig?: ConstructorParameters<typeof SlidingWindowOrchestrator>[0];
}

const DEFAULT_CONFIG: Required<ExecutionContextConfig> = {
  defaultBudgetHardCap: 200_000,
  slidingWindowConfig: {},
};

/** Thrown when a second `execute()` begins while a run is already active. */
export class ExecuteConcurrencyError extends Error {
  constructor(message = 'CONCURRENT_EXECUTE_REJECTED: AgentRuntime already executing') {
    super(message);
    this.name = 'ExecuteConcurrencyError';
  }
}

/** Map `detectTaskType()` output to TokenGovernor task categories. */
export function taskTypeToCategory(taskType: string): TaskCategory {
  switch (taskType) {
    case 'code':
      return 'code';
    case 'search':
      return 'search';
    case 'analysis':
      return 'analysis';
    case 'structured':
      return 'structured';
    default:
      return 'general';
  }
}

// Fallback constant removed (round 3, reviewer accept). DEFAULT_CONFIG is the
// single source of truth; the constructor merges it before any read.

// ============================================================================
// ExecutionContext
// ============================================================================

/**
 * Per-run mutable scratch state. One instance per `Runtime.execute()`. After
 * `enter()` runs, all scratch state is zeroed and re-derived from the input
 * `AgentExecutionContext`. After `exit()` runs, only construction-time state
 * remains on the host object — preventing leak between concurrent runs.
 */
export class ExecutionContext {
  private readonly config: ExecutionContextConfig;

  /** Per-run sliding window — created fresh on each `enter()` to isolate concurrent runs. */
  private _slidingWindow: SlidingWindowOrchestrator | null = null;

  /** Per-run token governor — created fresh on each `enter()` from ctx.tokenBudget. */
  private _governor: TokenGovernor | null = null;

  /** Tools promoted to Tier 1 (full schema) in the current turn — for hallucination rejection gate. */
  private _promotedTools: Set<string> = new Set();

  /** Tracks successful mutation tool calls per retry attempt for rollback planning. */
  private _executedMutations: PlannedToolCall[] = [];

  /** ExecutionScheduler handle for the currently executing run. */
  private _runHandle: RunHandle | null = null;

  /** RunLedger transaction context (runId, leaseToken, fencingEpoch). */
  private _ledgerCtx: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
  } | null = null;

  /** KV-cache prefix key from the prior LLM call — used to detect cache reuse. */
  private _lastPrefixCacheKey?: string;

  /** True between enter() and exit(). Read by hooks / shutdown to detect mid-run state. */
  private _active = false;

  constructor(config?: Partial<ExecutionContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._slidingWindow = new SlidingWindowOrchestrator(this.config.slidingWindowConfig);
    // Pre-populated governor — will be replaced per `enter()` call when
    // ctx.tokenBudget is known. Default ensures external readers never see
    // null after construction.
    this._governor = new TokenGovernor({
      totalBudget: this.config.defaultBudgetHardCap,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Bind mutable state for a single run. Rebuilds per-run `SlidingWindow` and
   * `TokenGovernor`; zeros scratch state; returns `this` so `AgentRuntime`
   * can chain.
   *
   * MUST be paired with `exit()` in a `try/finally` to release RunHandle
   * lifecycle and prevent memory leaks between concurrent `execute()` calls.
   *
   * @param tokenBudget - per-run budget that seeds the TokenGovernor
   * @param taskCategory - derived from `detectTaskType(goal)` for governor heuristics
   */
  enter(tokenBudget: number, taskCategory: TaskCategory = 'general'): ExecutionContext {
    // Concurrency guard: a second enter() while the previous run is still
    // active (between enter() and exit()) corrupts per-run scratch state
    // (sliding window, governor, executedMutations). Reject it explicitly so
    // AgentRuntime.execute() can surface a CONCURRENT_EXECUTE_REJECTED failure
    // instead of silently stomping the in-flight run's state.
    if (this._active) {
      throw new ExecuteConcurrencyError();
    }
    this._slidingWindow = new SlidingWindowOrchestrator(this.config.slidingWindowConfig);
    this._slidingWindow.resetSession();

    this._governor = new TokenGovernor({
      totalBudget: tokenBudget || this.config.defaultBudgetHardCap,
    });
    this._governor.setTaskCategory(taskCategory);

    this._promotedTools = new Set();
    this._executedMutations = [];
    this._runHandle = null;
    this._ledgerCtx = null;
    this._lastPrefixCacheKey = undefined;
    this._active = true;
    return this;
  }

  /**
   * Release run-scoped state. After exit():
   * - per-run governor and sliding window are dropped (instantiated fresh on next enter())
   * - runHandle / ledgerCtx are nulled (the underlying ExecutionScheduler owns them;
   *   the caller MUST call endRun() before here if recovery semantics require it)
   * - executedMutations and promotedTools are zeroed
   */
  exit(): void {
    this._runHandle = null;
    this._ledgerCtx = null;
    this._active = false;
    // The governor / slidingWindow stay alive but will be replaced on next
    // enter(); we deliberately do not null them so any hook reading
    // getGovernor() between runs can still get a valid fallback.
  }

  // ── State accessors ────────────────────────────────────────────────────────

  /** Per-run SlidingWindowOrchestrator. Fresh on each enter(). */
  get slidingWindow(): SlidingWindowOrchestrator {
    if (!this._slidingWindow) {
      // Fallback for readers hit between exit() and next enter().
      this._slidingWindow = new SlidingWindowOrchestrator(this.config.slidingWindowConfig);
    }
    return this._slidingWindow;
  }

  /** Per-run TokenGovernor. Fresh on each enter(). */
  get governor(): TokenGovernor {
    if (!this._governor) {
      this._governor = new TokenGovernor({
        totalBudget: this.config.defaultBudgetHardCap,
      });
    }
    return this._governor;
  }

  /** Read the active governor's budget phase — most common downstream query. */
  get governorPhase(): 'relaxed' | 'moderate' | 'tight' | 'critical' {
    return this.governor.getState().phase;
  }

  /** Read-only view of promoted tools. Use `markPromoted()` to mutate. */
  get promotedTools(): ReadonlySet<string> {
    return this._promotedTools;
  }

  /** Mutable scratch list for the active tool loop (same reference as recordMutation). */
  get mutableExecutedMutations(): PlannedToolCall[] {
    return this._executedMutations;
  }

  /** Read-only view of executed mutations. Use `recordMutation()` to append. */
  get executedMutations(): readonly PlannedToolCall[] {
    return this._executedMutations;
  }

  get runHandle(): RunHandle | null {
    return this._runHandle;
  }

  get ledgerCtx(): {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
  } | null {
    return this._ledgerCtx;
  }

  get lastPrefixCacheKey(): string | undefined {
    return this._lastPrefixCacheKey;
  }

  get isActive(): boolean {
    return this._active;
  }

  // ── State mutators (the only sanctioned write paths) ──────────────────────

  /** Replace the executed-mutations scratch list (tool loop reset per attempt). */
  replaceExecutedMutations(calls: PlannedToolCall[]): void {
    this._executedMutations = calls;
  }

  /** Append a successful mutation call so rollback planning can use it later. */
  recordMutation(call: PlannedToolCall): void {
    this._executedMutations.push(call);
  }

  /** Mark a tool as promoted to Tier 1 for the hallucination rejection gate. */
  markPromoted(toolName: string): void {
    this._promotedTools.add(toolName);
  }

  /** Replace the promoted-tools set in one call (e.g. after twoTier rebuild). */
  setPromotedTools(names: Iterable<string>): void {
    this._promotedTools = new Set(names);
  }

  /** Bookkeeping for the ExecutionScheduler — call after `getExecutionScheduler().beginRun()`. */
  setRunHandle(handle: RunHandle | null): void {
    this._runHandle = handle;
  }

  /** Bookkeeping for the RunLedger — set in same code path as runHandle. */
  setLedgerCtx(
    ctx: { runId: string; leaseToken: string; fencingEpoch: number; tenantId?: string } | null,
  ): void {
    this._ledgerCtx = ctx;
  }

  /** Update KV-cache prefix reuse tracker. */
  setLastPrefixCacheKey(key: string | undefined): void {
    this._lastPrefixCacheKey = key;
  }

  /**
   * Override the governor instance — used by TenantManager.restoreTenantOverrides()
   * which swaps a tenant-scoped governor in mid-run. The runtime MUST update
   * downstream consumers (cacheManager, outputManager) after calling this.
   */
  setGovernor(governor: TokenGovernor): void {
    this._governor = governor;
  }

  /** Override the per-run sliding window (legacy preLoopSetup hook). */
  setSlidingWindow(sw: SlidingWindowOrchestrator): void {
    this._slidingWindow = sw;
  }
}

// ============================================================================
// Companion exports (re-export surface for callers)
// ============================================================================

export type { TaskCategory };
