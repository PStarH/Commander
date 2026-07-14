/**
 * ATR (Agent Transaction Runtime) — shared kernel types.
 *
 * ATR is the runtime that guarantees agent external actions are:
 *   - Idempotent: retries do not duplicate side effects
 *   - Recoverable: failures can be compensated
 *   - Leased: only one process owns a run at a time
 *   - Fenced: zombie processes cannot corrupt in-flight runs
 *
 * This is the kernel for Commander's "Settlement Layer" — it sits between
 * the agent's decision loop and every external system call.
 */

// ============================================================================
// Run Lifecycle
// ============================================================================

/**
 * State machine for a single run (one agent execution end-to-end):
 *
 *   PENDING → EXECUTING → VERIFYING → COMMITTED
 *                  │            │
 *                  │            └──→ ABORTED → COMPENSATED
 *                  └───────────────────→ ABORTED → COMPENSATED
 *
 * COMMITTED is terminal-success. ABORTED + COMPENSATED is terminal-failure-recovered.
 * PAUSED is orthogonal (HITL approval, budget halt) — can resume back to EXECUTING.
 */
export type RunState =
  | 'PENDING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMMITTED'
  | 'ABORTED'
  | 'COMPENSATED'
  | 'PAUSED';

/**
 * State of a single idempotency slot.
 *   in_progress: another process is currently working this key
 *   completed:   finished; result cached for replay
 *   failed:      finished with error; error cached for replay
 */
export type IdempotencyState = 'in_progress' | 'completed' | 'failed';

// ============================================================================
// Idempotency
// ============================================================================

export interface IdempotencyRecord {
  /** SHA-256 hash key */
  key: string;
  state: IdempotencyState;
  /** Serialized tool result (caller is responsible for serialization format) */
  result?: string;
  /** Serialized error message */
  error?: string;
  /** How many times this key has been attempted (including the first) */
  attemptCount: number;
  startedAt: string;
  completedAt?: string;
  /** ISO timestamp; record is logically expired at this time */
  expiresAt: string;
  tenantId?: string;
  runId?: string;
  toolName?: string;
}

export interface IdempotencyOptions {
  /** How long to retain the record after completion (seconds) */
  ttlSeconds: number;
  /** Tenant scope — if set, key is namespaced by tenant */
  tenantId?: string;
  /** Originating run ID for audit */
  runId?: string;
  /** Originating tool name for audit */
  toolName?: string;
}

// ============================================================================
// Run Lease / Fencing
// ============================================================================

/**
 * Opaque lease token. The runtime acquires a token before mutating a run;
 * any resume operation must present the matching token, or be fenced.
 */
export interface RunLease {
  /** UUID v4 */
  token: string;
  /** Monotonically increasing; rejects stale leases from zombie processes */
  fencingEpoch: number;
  acquiredAt: string;
  /** Last heartbeat + lease TTL */
  expiresAt: string;
  runId: string;
  /** Identifier for the process/instance holding the lease (hostname:pid etc.) */
  holder: string;
}

// ============================================================================
// Compensable Action (run-level transaction record)
// ============================================================================

export interface CompensableAction {
  /** UUID for this specific action instance */
  actionId: string;
  /** Parent run */
  runId: string;
  /** Tool that produced the side effect */
  toolName: string;
  /** Tool arguments (canonical JSON form) */
  args: Record<string, unknown>;
  /** External system touched (github, stripe, slack, db, fs, llm, mcp, shell) */
  externalSystem: string;
  /** Idempotency key for this action */
  idempotencyKey: string;
  /** Result (post-execution) */
  result?: string;
  /** Error message if failed */
  error?: string;
  executedAt: string;
  /** Set when compensate() successfully undid this action */
  compensatedAt?: string;
  /** Whether this action can be compensated (false = terminal, no undo) */
  compensable: boolean;
  /** Tags for matching compensation handlers (e.g. ['destructive', 'github:pr']) */
  tags: string[];
  /** Optional inverse action description for human-readable compensation logs */
  description: string;
}

// ============================================================================
// Run Transaction
// ============================================================================

export interface RunTransaction {
  runId: string;
  state: RunState;
  /** SHA-256 of the original goal string (normalized) */
  intentHash: string;
  /** Current lease token */
  leaseToken: string;
  fencingEpoch: number;
  /** All actions executed in this run, in order */
  actions: CompensableAction[];
  createdAt: string;
  committedAt?: string;
  abortedAt?: string;
  error?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  /**
   * ISO timestamp when a PAUSED run becomes eligible to wake.
   * Null/undefined means wake only on explicit resume (e.g. human input).
   */
  resumeAt?: string;
  /** Why the run entered PAUSED (hitl, budget, operator, timer). */
  pauseReason?: string;
}

// ============================================================================
// Verification
// ============================================================================

export type VerificationVerdict = 'pass' | 'fail' | 'skip';

export interface VerificationResult {
  runId: string;
  verdict: VerificationVerdict;
  reason: string;
  /** Evidence backing the verdict (test results, schema check, etc.) */
  evidence?: Record<string, unknown>;
  verifiedAt: string;
}
