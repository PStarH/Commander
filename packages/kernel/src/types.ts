/** Canonical, versioned execution-kernel domain types. */

import type {
  KernelErrorDetails,
  KernelEvent,
  RunState,
  StepState,
} from '@commander/contracts';

export type { KernelErrorDetails, KernelEvent } from '@commander/contracts';

export const KERNEL_API_VERSION = 'v2' as const;

/** Re-exported from @commander/contracts; kept for source compatibility. */
export type KernelRunState = RunState;
/** Re-exported from @commander/contracts; kept for source compatibility. */
export type KernelStepState = StepState;

export interface KernelRunHandle {
  runId: string;
  state: KernelRunState;
  leaseToken: string;
  fencingEpoch: number;
  intentHash: string;
  tenantId: string;
  resumed: boolean;
  acquired: boolean;
}

export interface KernelRun {
  id: string;
  tenantId: string;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  state: KernelRunState;
  version: number;
  policySnapshotId: string;
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  terminalAt?: string;
  metadata: Record<string, unknown>;
}

export interface TenantExecutionControl {
  tenantId: string;
  paused: boolean;
  generation: number;
  actor: string;
  reason?: string;
  pausedAt?: string;
  resumedAt?: string;
}

export interface KernelStep {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  state: KernelStepState;
  version: number;
  attempt: number;
  maxAttempts: number;
  priority: number;
  dependencies: string[];
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: KernelErrorDetails;
  scheduledAt: string;
  lease?: KernelLease;
  createdAt: string;
  updatedAt: string;
}

export interface KernelLease {
  workerId: string;
  /** Generation from the durable worker registry; stale processes are fenced. */
  workerGeneration?: number;
  token: string;
  fencingEpoch: number;
  expiresAt: string;
}

export interface KernelOutboxMessage {
  id: string;
  eventId: string;
  tenantId: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  attempts: number;
  availableAt: string;
  publishedAt?: string;
  /** Present only when this message is leased to a publisher. */
  claimToken?: string;
  createdAt: string;
}

export interface KernelEffect {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  type: string;
  idempotencyKey: string;
  requestHash: string;
  policyDecisionId: string;
  /** Immutable policy snapshot pinned at admit. */
  policySnapshotId: string;
  /** Canonical digest of the authorized external action. */
  actionDigest: string;
  /** Worker id from the admit lease (never null after Task 2 backfill). */
  leaseWorkerId: string;
  /** Worker registry generation from the admit lease (required, never nullable). */
  leaseWorkerGeneration: number;
  /** Fencing epoch from the admit lease. */
  leaseFencingEpoch: number;
  state: 'ADMITTED' | 'COMPLETION_UNKNOWN' | 'COMPLETED' | 'FAILED';
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
  reconcileAttempts: number;
  reconcileAfter: string | null;
  reconcileClaimToken: string | null;
  reconcileClaimExpiresAt: string | null;
  reconcileLastError: Record<string, unknown> | null;
  reconcileEscalatedAt: string | null;
}

export interface CreateKernelRun {
  id: string;
  tenantId: string;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  policySnapshotId: string;
  metadata?: Record<string, unknown>;
  steps: Array<NewKernelStep>;
}

export interface NewKernelStep {
  id: string;
  kind: string;
  initialState?: 'PENDING' | 'WAITING_FOR_HUMAN';
  interaction?: {
    id: string;
    prompt: string;
    expiresAt?: string;
  };
  input?: Record<string, unknown>;
  dependencies?: string[];
  priority?: number;
  maxAttempts?: number;
  scheduledAt?: string;
}

export interface ClaimStepRequest {
  workerId: string;
  /** Durable worker-registry generation. Required by production Postgres claims. */
  workerGeneration?: number;
  /**
   * Unforgeable claim secret from register() (process memory only).
   * Required on the worker (non-scheduler) claim path.
   */
  claimSecret?: string;
  leaseTtlMs: number;
  /**
   * @deprecated Ignored on the worker (non-scheduler) claim path. Tenant authorization
   * comes only from durable `commander_workers.tenant_ids` via `claim_next_step`.
   * Scheduler-mode repositories may still use this as an optional filter.
   */
  tenantId?: string;
  /**
   * @deprecated Ignored on the worker (non-scheduler) claim path — callers cannot
   * widen or select tenant scope. Drop from new call sites; durable authz only.
   */
  tenantIds?: string[];
  /** Step kinds this worker is authorized and able to execute. */
  capabilities?: string[];
  now?: Date;
}

export interface CompleteStepRequest {
  stepId: string;
  tenantId: string;
  lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
  output?: Record<string, unknown>;
  expectedVersion: number;
  actor: string;
}

export interface FailStepRequest {
  stepId: string;
  tenantId: string;
  lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
  error: KernelErrorDetails;
  expectedVersion: number;
  actor: string;
  retryAt?: Date;
  /** Return the attempt consumed by claim when a worker stops before execution begins. */
  refundAttempt?: boolean;
}

export interface AdmitEffectRequest {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  type: string;
  idempotencyKey: string;
  policyDecisionId: string;
  /** Immutable policy snapshot that authorized this admit. */
  policySnapshotId: string;
  /** Canonical digest of the authorized external action. */
  actionDigest: string;
  request: Record<string, unknown>;
  lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
  actor: string;
}

export interface MarkEffectCompletionUnknownRequest {
  effectId: string;
  tenantId: string;
  reason: string;
  actor: string;
}

/** L3-08a: advance COMPLETION_UNKNOWN after remote query (no worker lease). */
export interface ReconcileEffectRequest {
  effectId: string;
  tenantId: string;
  state: 'COMPLETED' | 'FAILED';
  response: Record<string, unknown>;
  actor: string;
}

export interface RequestReconcileInput {
  effectId: string;
  tenantId: string;
  actor: string;
  reconcileAfter?: string;
}

export interface ClaimReconcileEffectsInput {
  limit: number;
  now?: Date;
  claimTtlMs?: number;
  /**
   * Required on the worker (non-scheduler) path. Tenant authorization comes only
   * from durable `commander_workers.tenant_ids` via `claim_reconcile_effects`.
   * Scheduler-mode repositories may omit this and scan under BYPASSRLS.
   */
  workerId?: string;
  /** Durable worker-registry generation. Required with workerId on the worker path. */
  workerGeneration?: number;
  /**
   * Unforgeable claim secret from register() (process memory only).
   * Required on the worker (non-scheduler) path with workerId.
   */
  claimSecret?: string;
}

export interface ClaimedReconcileEffect {
  effect: KernelEffect;
  claimToken: string;
}

export interface RescheduleReconcileInput {
  effectId: string;
  tenantId: string;
  claimToken: string;
  reconcileAfter: string;
  lastError?: { code: string; message: string };
}

export interface EscalateReconcileInput {
  effectId: string;
  tenantId: string;
  claimToken: string;
  reason: string;
}

export interface FailEffectRequest {
  effectId: string;
  tenantId: string;
  lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
  error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  actor: string;
}

export interface RequestCompensationInput {
  tenantId: string;
  originalRunId: string;
  originalEffectId?: string;
  actor: string;
  adapterVersion: string;
  compensationEffectType: string;
}

export interface RequestCompensationResult {
  compensationRunId: string;
  originalEffectId: string;
  originalRunId: string;
  outboxMessageId?: string;
}

export type AdmitEffectResult =
  | { admitted: true; replayed: false; effect: KernelEffect }
  | { admitted: true; replayed: true; effect: KernelEffect }
  | {
      admitted: false;
      reason:
        | 'LEASE_LOST'
        | 'STEP_NOT_RUNNING'
        | 'IDEMPOTENCY_CONFLICT'
        | 'POLICY_SNAPSHOT_ID_REQUIRED'
        | 'LEASE_WORKER_ID_REQUIRED';
    };

export class KernelInvariantError extends Error {
  constructor(
    readonly code:
      | 'DUPLICATE_RUN'
      | 'DUPLICATE_STEP'
      | 'DUPLICATE_INTERACTION'
      | 'INVALID_GRAPH'
      | 'LEASE_LOST'
      | 'VERSION_CONFLICT'
      | 'INVALID_TRANSITION'
      | 'PRODUCTION_STORAGE_REQUIRED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'TIMER_NOT_FOUND'
      | 'INTERACTION_NOT_FOUND'
      | 'INTERACTION_ALREADY_ANSWERED'
      | 'STEP_NOT_FOUND'
      | 'KILL_SWITCH_LOOKUP_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'KernelInvariantError';
  }
}

// ── Durable Timers ──────────────────────────────────────────────────────────

export type TimerType = 'INTERACTION_TIMEOUT' | 'RETRY_DELAY' | 'STEP_DEADLINE';
export type TimerState = 'PENDING' | 'PROCESSING' | 'FIRED' | 'CANCELLED';

export interface KernelTimer {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  firesAt: string;
  timerType: TimerType;
  state: TimerState;
  payload: Record<string, unknown>;
  createdAt: string;
  firedAt?: string;
  claimToken?: string;
}

export interface CreateTimerRequest {
  runId: string;
  stepId: string;
  tenantId: string;
  firesAt: Date;
  timerType: TimerType;
  payload?: Record<string, unknown>;
}

// ── Interactions ────────────────────────────────────────────────────────────

export type InteractionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface KernelInteraction {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  status: InteractionStatus;
  prompt: string;
  response?: Record<string, unknown>;
  createdAt: string;
  answeredAt?: string;
  expiresAt?: string;
}

export interface CreateInteractionRequest {
  runId: string;
  stepId: string;
  tenantId: string;
  prompt: string;
  expiresAt?: Date;
}

export interface AnswerInteractionRequest {
  interactionId: string;
  runId: string;
  tenantId: string;
  response: Record<string, unknown>;
  actor: string;
  /** When false, answer only; step stays WAITING_FOR_HUMAN. Default true. */
  releaseStep?: boolean;
}

// ── Kill switches (L4-04) ───────────────────────────────────────────────────

export type KillSwitchScope =
  | 'tenant'
  | 'package'
  | 'model'
  | 'tool'
  | 'destination'
  | 'effect-type';

export interface KillSwitch {
  tenantId: string;
  scope: KillSwitchScope;
  value: string;
  enabled: boolean;
  reason?: string;
  actor: string;
  updatedAt: string;
}

export interface PutKillSwitchInput {
  tenantId: string;
  scope: KillSwitchScope;
  value: string;
  enabled: boolean;
  reason?: string;
  actor: string;
}

export interface RemoveKillSwitchInput {
  tenantId: string;
  scope: KillSwitchScope;
  value: string;
}

export interface KillSwitchMatchDims {
  package?: string;
  model?: string;
  tool?: string;
  destination?: string;
  effectType?: string;
}

// ── Outbox DLQ ──────────────────────────────────────────────────────────────

export interface KernelDlqEntry {
  id: string;
  originalId: string;
  eventId: string;
  tenantId: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  attempts: number;
  dlqReason?: string;
  originalCreatedAt: string;
  movedToDlqAt: string;
}
