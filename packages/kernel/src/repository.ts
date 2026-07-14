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
} from './types.js';

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
  getStep(stepId: string, tenantId: string): Promise<KernelStep | null>;
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
  admitEffect(request: AdmitEffectRequest): Promise<AdmitEffectResult>;
  completeEffect(
    effectId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    response: Record<string, unknown>,
    actor: string,
  ): Promise<KernelEffect | null>;
  markEffectCompletionUnknown(request: MarkEffectCompletionUnknownRequest): Promise<KernelEffect | null>;
  claimOutbox(limit: number, now?: Date): Promise<KernelOutboxMessage[]>;
  markOutboxPublished(messageId: string, claimToken: string): Promise<boolean>;
  listEvents(runId: string, tenantId: string): Promise<KernelEvent[]>;

  // ── Durable Timers ──────────────────────────────────────────────────────

  /** Schedule a durable timer. When it fires, the wakeup worker will
   *  transition the associated step. */
  createTimer(request: CreateTimerRequest, actor: string): Promise<KernelTimer>;
  /** Cancel a timer before it fires. */
  cancelTimer(timerId: string, tenantId: string): Promise<boolean>;
  /** Scan for expired timers and mark them FIRED. Returns fired timers
   *  so the caller can take action (e.g., transition steps). */
  claimExpiredTimers(now?: Date, limit?: number): Promise<KernelTimer[]>;

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
}
