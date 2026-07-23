import type {
  AdmitEffectRequest,
  AdmitEffectResult,
  AnswerInteractionRequest,
  ClaimStepRequest,
  CompleteStepRequest,
  CreateInteractionRequest,
  CreateKernelRun,
  CreateTimerRequest,
  FailStepRequest,
  KernelDlqEntry,
  KernelEffect,
  KernelEvent,
  KernelInteraction,
  KernelLease,
  KernelOutboxMessage,
  KernelRun,
  KernelStep,
  KernelTimer,
  MarkEffectCompletionUnknownRequest,
  ReconcileEffectRequest,
  RequestReconcileInput,
  ClaimReconcileEffectsInput,
  ClaimedReconcileEffect,
  RescheduleReconcileInput,
  EscalateReconcileInput,
  FailEffectRequest,
  RequestCompensationInput,
  RequestCompensationResult,
  TenantExecutionControl,
  KillSwitch,
  KillSwitchMatchDims,
  PutKillSwitchInput,
  RemoveKillSwitchInput,
} from './types.js';

export type { KillSwitchMatchDims } from './types.js';

/**
 * The only persistence boundary used by the execution kernel.
 *
 * Production implementations must offer a shared transactional store. The
 * in-memory implementation is intentionally test-only and is never selected
 * by a production factory.
 */
export interface KernelRepository {
  initialize(): Promise<void>;
  createRun(command: CreateKernelRun, actor: string): Promise<KernelRun>;
  /** Control-plane configured maximum simultaneously running steps for a tenant. */
  setTenantConcurrencyLimit(tenantId: string, maxConcurrentSteps: number): Promise<void>;
  getRun(runId: string, tenantId: string): Promise<KernelRun | null>;
  /** List runs for a tenant, newest updatedAt first. */
  listRuns(tenantId: string, options?: { limit?: number }): Promise<KernelRun[]>;
  getStep(stepId: string, tenantId: string): Promise<KernelStep | null>;
  /**
   * Claim the next eligible step. Worker/Postgres (non-scheduler) path uses
   * DB-atomic `claim_next_step` — `request.tenantIds` / `tenantId` are ignored;
   * authz is durable `commander_workers.tenant_ids` for the worker generation.
   */
  claimNextStep(request: ClaimStepRequest): Promise<KernelStep | null>;
  heartbeatStep(
    stepId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    leaseTtlMs: number,
  ): Promise<KernelStep | null>;
  /** Requeue or terminally fail steps whose worker lease is no longer live. */
  reclaimExpiredLeases(now?: Date, limit?: number): Promise<KernelStep[]>;
  completeStep(request: CompleteStepRequest): Promise<KernelStep | null>;
  failStep(request: FailStepRequest): Promise<KernelStep | null>;
  /** Wake a step that is waiting for retry so it becomes claimable again. */
  wakeRetryStep(stepId: string, tenantId: string, actor: string): Promise<KernelStep | null>;
  /** Fail a step from a timer/deadline without a worker lease. */
  failStepByTimer(stepId: string, tenantId: string, error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }, actor: string): Promise<KernelStep | null>;
  /** Pause a run, releasing any active worker leases but keeping scheduled work. */
  pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
  /** Resume a paused run so that pending steps become claimable again. */
  resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
  /** Cancel a run and mark all non-terminal steps CANCELLED. */
  cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
  /** Pause every active Agent execution owned by exactly one tenant. */
  pauseTenant(tenantId: string, actor: string, reason?: string): Promise<TenantExecutionControl>;
  /** Remove the tenant execution gate without resuming individually paused runs. */
  resumeTenant(tenantId: string, actor: string): Promise<TenantExecutionControl>;
  getTenantExecutionControl(tenantId: string): Promise<TenantExecutionControl>;
  admitEffect(request: AdmitEffectRequest): Promise<AdmitEffectResult>;
  completeEffect(
    effectId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    response: Record<string, unknown>,
    actor: string,
  ): Promise<KernelEffect | null>;
  markEffectCompletionUnknown(request: MarkEffectCompletionUnknownRequest): Promise<KernelEffect | null>;
  /** L3-08a: load a single effect for UNKNOWN reconcile. */
  getEffect(effectId: string, tenantId: string): Promise<KernelEffect | null>;
  /**
   * L3-08a: COMPLETION_UNKNOWN → COMPLETED|FAILED after remote queryOutcome.
   * Ops/reconciler path — no worker lease; never re-executes the write.
   */
  reconcileEffect(request: ReconcileEffectRequest): Promise<KernelEffect | null>;
  requestReconcile(input: RequestReconcileInput): Promise<KernelEffect | null>;
  claimReconcileEffects(input: ClaimReconcileEffectsInput): Promise<ClaimedReconcileEffect[]>;
  rescheduleReconcile(input: RescheduleReconcileInput): Promise<boolean>;
  escalateReconcile(input: EscalateReconcileInput): Promise<boolean>;
  releaseReconcileClaim(effectId: string, tenantId: string, claimToken: string): Promise<boolean>;
  failEffect(request: FailEffectRequest): Promise<KernelEffect | null>;
  requestCompensation(input: RequestCompensationInput): Promise<RequestCompensationResult | null>;
  claimOutbox(limit: number, now?: Date): Promise<KernelOutboxMessage[]>;
  /** Worker LOGIN requires tenantId so RLS can scope the UPDATE. */
  markOutboxPublished(messageId: string, claimToken: string, tenantId?: string): Promise<boolean>;
  /** Worker LOGIN requires tenantId so RLS can scope the UPDATE. */
  retryOutbox(
    messageId: string,
    claimToken: string,
    error: { code: string; message: string },
    now?: Date,
    tenantId?: string,
  ): Promise<boolean>;
  listEvents(runId: string, tenantId: string): Promise<KernelEvent[]>;
  /** Effect ledger rows for a run (commander_effects). */
  listEffectsForRun(runId: string, tenantId: string): Promise<KernelEffect[]>;

  // ── Durable Timers ──────────────────────────────────────────────────────

  /** Schedule a durable timer. When it fires, the wakeup worker will
   *  transition the associated step. */
  createTimer(request: CreateTimerRequest, actor: string): Promise<KernelTimer>;
  /** Cancel a timer before it fires. */
  cancelTimer(timerId: string, tenantId: string): Promise<boolean>;
  /** Scan for expired timers and mark them FIRED. Returns fired timers
   *  so the caller can take action (e.g., transition steps). */
  claimExpiredTimers(now?: Date, limit?: number): Promise<KernelTimer[]>;
  acknowledgeTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean>;
  retryTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean>;

  // ── Interactions ────────────────────────────────────────────────────────

  /** Create a human-agent interaction. The associated step should be in
   *  WAITING_FOR_HUMAN state. */
  createInteraction(request: CreateInteractionRequest, actor: string): Promise<KernelInteraction>;
  /** Answer a pending interaction. Transitions status → 'answered' and
   *  wakes the associated step. */
  answerInteraction(request: AnswerInteractionRequest): Promise<KernelInteraction>;
  /** Get an interaction by ID. */
  getInteraction(interactionId: string, tenantId: string): Promise<KernelInteraction | null>;
  /** List interactions for a run. */
  listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]>;
  /** Expire stale interactions that have passed their expires_at. */
  expireStaleInteractions(now?: Date, limit?: number): Promise<KernelInteraction[]>;

  // ── Outbox DLQ ──────────────────────────────────────────────────────────

  /** Move outbox messages that exceeded max_attempts to the DLQ.
   *  Applies exponential backoff to messages below the threshold. */
  sweepOutboxDlq(now?: Date, limit?: number): Promise<{ movedToDlq: number; backoffApplied: number }>;
  /** List DLQ entries for inspection and replay. */
  listDlqEntries(limit?: number, topic?: string): Promise<KernelDlqEntry[]>;
  /** Replay a DLQ entry back into the outbox for re-publishing. */
  replayDlqEntry(dlqId: string): Promise<boolean>;

  // ── WS2 EffectBroker monopoly: capability, allowlist, quota, compensation ──

  /** Claim outbox messages filtered by topic. Used by the compensation
   *  consumer to claim only `commander.compensation` messages.
   *  Worker LOGIN (`schedulerMode: false`) requires durable claim authz
   *  (workerId + generation + claimSecret); tenants come from the worker row. */
  claimOutboxByTopic(
    topic: string,
    limit: number,
    now?: Date,
    authz?: {
      workerId: string;
      workerGeneration: number;
      claimSecret: string;
    },
  ): Promise<KernelOutboxMessage[]>;

  /**
   * Returns true iff the capability token (by jti) has been revoked under
   * the given tenant. Callers must supply tenantId so worker repos
   * (`schedulerMode: false`) can set `app.tenant_scope` under RLS.
   */
  isCapabilityRevoked(jti: string, tenantId: string): Promise<boolean>;

  /** Revoke a capability token by jti. Idempotent. Tenant-scoped write. */
  revokeCapability(input: { jti: string; tenantId: string; expiresAt: string; reason?: string }): Promise<void>;

  /**
   * Atomically consume a capability (jti, nonce) under tenant scope.
   * Returns true when the row already existed (replay); false on first insert.
   */
  consumeCapabilityReplay(input: {
    tenantId: string;
    jti: string;
    nonce: string;
    expiresAt: string;
  }): Promise<boolean>;

  /** Check whether an action is allowed for a tenant per the allowlist.
   *  Supports wildcard patterns (e.g. `http.*`, `compensate.*`). An empty
   *  allowlist for the tenant means "deny all" (fail-closed). */
  isActionAllowed(tenantId: string, action: string): Promise<boolean>;

  /** Add or update an allowlist entry for a tenant. */
  setAllowlistEntry(tenantId: string, actionPattern: string, allowed: boolean): Promise<void>;

  /**
   * Insert a default allowlist row only when absent (never overwrites).
   * Used by worker bootstrap to seed `llm.*` without clobbering explicit denies.
   */
  ensureAllowlistDefault(tenantId: string, actionPattern: string, allowed: boolean): Promise<void>;

  /** Increment the daily quota counter for a tenant/action_class. Returns the
   *  updated row so the broker can compare against the configured ceiling. */
  incrementQuota(input: { tenantId: string; actionClass: string; tokensUsed?: number; now?: Date }): Promise<{ countUsed: number; tokensUsed: number }>;

  /** Read the current daily quota row (or zeros if none yet). */
  getQuota(tenantId: string, actionClass: string, now?: Date): Promise<{ countUsed: number; tokensUsed: number }>;

  // ── L4-04 Kill switches ───────────────────────────────────────────────────

  putKillSwitch(input: PutKillSwitchInput): Promise<KillSwitch>;
  removeKillSwitch(input: RemoveKillSwitchInput): Promise<void>;
  listKillSwitches(tenantId: string): Promise<KillSwitch[]>;
  findMatchingKillSwitch(tenantId: string, dims: KillSwitchMatchDims): Promise<KillSwitch | null>;
}
