/**
 * ExecutionScheduler — the single ATR entry point.
 *
 * Owns: run lease, idempotency, checkpoint version, saga state machine.
 * Composes: LeaseManager + IdempotencyStore + RunLedger + StateCheckpointer.
 *
 * Every state-mutating call is lease-validated. A zombie process that resumes
 * a run gets its writes rejected at the boundary, not at the side effect.
 *
 * State machine (from RunLedger):
 *   PENDING → EXECUTING → VERIFYING → COMMITTED
 *                         \→ ABORTED → COMPENSATED
 *
 * The scheduler is a stateless facade: the run state lives in the ledger.
 * `beginRun / resumeRun` return a RunHandle — a snapshot of the lease
 * credentials + state at call time. Pass them back to every subsequent
 * schedule/commit/abort call. The scheduler does NOT cache them.
 *
 * Reversibility audit: CompensationBridge is no longer composed here — new
 * code uses RunLedger directly (single source of truth). The bridge is
 * retained only as a @deprecated transitional adapter for legacy callers.
 */

import { canAdmitSchedulerWork } from '../runtime/runtimeAdmission';
import { StateCheckpointer, type CheckpointState } from '../runtime/stateCheckpointer';
import type {
  CompensableAction,
  CompensableAction as _CompensableAction,
} from '../runtime/compensationRegistry';
import type { CompensationHandler } from '../runtime/compensationRegistry';
import type { RunState, RunTransaction } from './types';
import { hashIntent } from './canonicalJson';
import { LeaseManager } from './leaseManager';
import { IdempotencyStore } from './idempotencyStore';
import { RunLedger, getRunLedgerBundle, type CompensationOutcome } from './runLedger';
import { defaultCompensationHandlers } from './defaultCompensation';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { createGitSnapshot, restoreGitSnapshot, clearGitSnapshot } from './gitSnapshot';
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalTenantProvider } from '../runtime/tenantProvider';
import type { TenantConfig } from '../runtime/tenantProvider';

export interface BeginRunInput {
  runId?: string;
  goal: string;
  intent?: string;
  intentHash?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
  holder?: string;
}

export interface RunHandle {
  runId: string;
  state: RunState;
  leaseToken: string;
  fencingEpoch: number;
  intentHash: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  resumed: boolean;
  acquired: boolean;
}

export interface ScheduleActionInput {
  runId: string;
  leaseToken: string;
  fencingEpoch: number;
  toolName: string;
  externalSystem: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  compensable: boolean;
  tags?: string[];
  description?: string;
  tenantId?: string;
}

export interface ScheduleActionResult {
  replayed: boolean;
  actionId: string;
  cachedResult?: string;
  cachedError?: string;
}

export interface CommitResult {
  committed: boolean;
  reason?: 'fenced' | 'not_found';
}

export interface AbortResult {
  aborted: boolean;
  reason?: 'fenced' | 'not_found';
  outcome: CompensationOutcome;
}

export interface KillResult {
  killed: boolean;
  reason?: 'fenced' | 'not_found';
}

export interface SchedulerCheckpointInput {
  state: CheckpointState;
  tenantId?: string;
}

export interface ExecutionSchedulerOptions {
  lease: LeaseManager;
  idempotency: IdempotencyStore;
  ledger: RunLedger;
  checkpointer?: StateCheckpointer;
}

export class ExecutionScheduler {
  private lease: LeaseManager;
  private idempotency: IdempotencyStore;
  private ledger: RunLedger;
  private checkpointer?: StateCheckpointer;

  constructor(opts: ExecutionSchedulerOptions) {
    this.lease = opts.lease;
    this.idempotency = opts.idempotency;
    this.ledger = opts.ledger;
    this.checkpointer = opts.checkpointer;
  }

  beginRun(input: BeginRunInput): RunHandle {
    const intentHash = input.intentHash ?? hashIntent(input.intent ?? input.goal);
    const result = this.ledger.start({
      runId: input.runId,
      intentHash,
      tenantId: input.tenantId,
      metadata: input.metadata,
      ttlSeconds: input.ttlSeconds,
      holder: input.holder,
    });
    this.ledger.beginExecuting(result.tx.runId, result.tx.leaseToken, result.tx.fencingEpoch, {
      tenantId: input.tenantId,
    });

    // Create a git snapshot before the run starts — this provides a full-workspace
    // rollback baseline that complements the per-file .atr-snapshot mechanism.
    // If the process crashes and .atr-snapshot files are lost, the git snapshot
    // can still restore the workspace to its pre-run state.
    try {
      createGitSnapshot(result.tx.runId);
    } catch {
      /* best-effort — don't block run start on snapshot failure */
    }

    return {
      runId: result.tx.runId,
      state: 'EXECUTING',
      leaseToken: result.tx.leaseToken,
      fencingEpoch: result.tx.fencingEpoch,
      intentHash,
      tenantId: input.tenantId,
      metadata: result.tx.metadata,
      createdAt: result.tx.createdAt,
      resumed: result.lease.acquired === false && result.lease.reclaimed !== true,
      acquired: result.lease.acquired,
    };
  }

  /**
   * Claim the next PENDING run to execute.
   *
   * Runs are ordered by tenant tier (`premium` > `standard` > `starter`,
   * defaulting to `standard`) and, within the same tier, by creation time
   * (FIFO). The caller receives a fresh EXECUTING handle with valid lease
   * credentials. Returns `null` when no PENDING runs are available or all
   * candidates fail to transition.
   */
  claimNextRun(options?: { tenantId?: string }): RunHandle | null {
    if (!canAdmitSchedulerWork()) {
      return null;
    }
    const tenantFilter = options?.tenantId;
    const pending = this.ledger.listByState('PENDING', { tenantId: tenantFilter });
    if (pending.length === 0) return null;

    const provider = getGlobalTenantProvider();
    const tierRank: Record<string, number> = {
      premium: 0,
      standard: 1,
      starter: 2,
    };

    const getTierRank = (tx: RunTransaction): number => {
      if (!tx.tenantId) return tierRank.standard;
      const cfg: TenantConfig | undefined = provider.getTenantConfig(tx.tenantId);
      const tier = cfg?.metadata?.tier;
      if (typeof tier === 'string' && tier in tierRank) {
        return tierRank[tier];
      }
      return tierRank.standard;
    };

    const sorted = pending.slice().sort((a, b) => {
      const tierDelta = getTierRank(a) - getTierRank(b);
      if (tierDelta !== 0) return tierDelta;
      return a.createdAt.localeCompare(b.createdAt);
    });

    for (const tx of sorted) {
      let leaseToken = tx.leaseToken;
      let fencingEpoch = tx.fencingEpoch;

      const currentLease = this.lease.get(tx.runId, { tenantId: tx.tenantId });
      if (!currentLease || new Date(currentLease.expiresAt).getTime() <= Date.now()) {
        const leaseResult = this.lease.acquire(tx.runId, { tenantId: tx.tenantId });
        if (!leaseResult.acquired) continue;
        leaseToken = leaseResult.lease.token;
        fencingEpoch = leaseResult.lease.fencingEpoch;
        // SAGA-5: persist the rotated lease credentials to the run row before
        // beginExecuting, whose guarded UPDATE matches WHERE lease_token/fencing_epoch.
        // Without this the row keeps the stale credentials, beginExecuting matches
        // zero rows, and the run becomes permanently unclaimable.
        this.ledger.syncLeaseCredentials(tx.runId, leaseToken, fencingEpoch, {
          tenantId: tx.tenantId,
        });
      }

      const ok = this.ledger.beginExecuting(tx.runId, leaseToken, fencingEpoch, {
        tenantId: tx.tenantId,
      });
      if (!ok) continue;

      return {
        runId: tx.runId,
        state: 'EXECUTING',
        leaseToken,
        fencingEpoch,
        intentHash: tx.intentHash,
        tenantId: tx.tenantId,
        metadata: tx.metadata,
        createdAt: tx.createdAt,
        resumed: false,
        acquired: true,
      };
    }

    return null;
  }

  scheduleAction(input: ScheduleActionInput): ScheduleActionResult | null {
    const beginResult = this.idempotency.begin(input.idempotencyKey, {
      tenantId: input.tenantId,
      runId: input.runId,
      toolName: input.toolName,
    });

    if (!beginResult.acquired && beginResult.record.state === 'completed') {
      return {
        replayed: true,
        actionId: `replay:${beginResult.record.key}`,
        cachedResult: beginResult.record.result,
      };
    }
    if (!beginResult.acquired && beginResult.record.state === 'failed') {
      return {
        replayed: true,
        actionId: `replay:${beginResult.record.key}`,
        cachedError: beginResult.record.error,
      };
    }

    const action = this.ledger.recordAction({
      runId: input.runId,
      leaseToken: input.leaseToken,
      fencingEpoch: input.fencingEpoch,
      tenantId: input.tenantId,
      toolName: input.toolName,
      externalSystem: input.externalSystem,
      args: input.args,
      idempotencyKey: input.idempotencyKey,
      compensable: input.compensable,
      tags: input.tags,
      description: input.description,
    });
    if (!action) {
      this.idempotency.fail(input.idempotencyKey, 'ledger_rejected', { tenantId: input.tenantId });
      return null;
    }
    return { replayed: false, actionId: action.actionId };
  }

  recordResult(input: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    actionId: string;
    result: string;
    tenantId?: string;
  }): void {
    this.ledger.recordResult(input.actionId, input.result);
    const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    if (tx) {
      const action = tx.actions.find((a) => a.actionId === input.actionId);
      if (action)
        this.idempotency.complete(action.idempotencyKey, input.result, {
          tenantId: input.tenantId,
        });
    }
  }

  recordError(input: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    actionId: string;
    error: string;
    tenantId?: string;
  }): void {
    this.ledger.recordError(input.actionId, input.error);
    const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    if (tx) {
      const action = tx.actions.find((a) => a.actionId === input.actionId);
      if (action)
        this.idempotency.fail(action.idempotencyKey, input.error, { tenantId: input.tenantId });
    }
  }

  commitRun(input: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
  }): CommitResult {
    const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    if (!tx) return { committed: false, reason: 'not_found' };
    if (tx.leaseToken !== input.leaseToken || tx.fencingEpoch !== input.fencingEpoch) {
      return { committed: false, reason: 'fenced' };
    }
    const ok = this.ledger.commit(input.runId, input.leaseToken, input.fencingEpoch, {
      tenantId: input.tenantId,
    });
    if (!ok) return { committed: false, reason: 'fenced' };
    this.lease.release(input.runId, input.leaseToken, { tenantId: input.tenantId });

    // Run committed successfully — clear the git snapshot, no rollback needed
    clearGitSnapshot(input.runId);

    return { committed: true };
  }

  async abortRun(input: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    reason: string;
    tenantId?: string;
    maxAttempts?: number;
  }): Promise<AbortResult> {
    const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    if (!tx)
      return {
        aborted: false,
        reason: 'not_found',
        outcome: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
      };
    if (tx.leaseToken !== input.leaseToken || tx.fencingEpoch !== input.fencingEpoch) {
      return {
        aborted: false,
        reason: 'fenced',
        outcome: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
      };
    }
    const res = await this.ledger.abortAndCompensate(
      input.runId,
      input.leaseToken,
      input.fencingEpoch,
      input.reason,
      { tenantId: input.tenantId, maxAttempts: input.maxAttempts },
    );
    this.lease.release(input.runId, input.leaseToken, { tenantId: input.tenantId });

    // If compensation had failures, attempt a git snapshot restore as a
    // last-resort full-workspace rollback. This catches the case where
    // per-file .atr-snapshot files were lost or incomplete.
    if (res.outcome.failed > 0) {
      try {
        const restored = restoreGitSnapshot(input.runId);
        if (restored) {
          // Log that we performed a full git restore — operators need to know
          // this happened because it discards ALL changes made during the run
        }
      } catch {
        /* best-effort — compensation already attempted */
      }
    } else {
      // All compensations succeeded — clear the snapshot
      clearGitSnapshot(input.runId);
    }

    return {
      aborted: res.aborted,
      reason: res.aborted ? undefined : 'fenced',
      outcome: res.outcome,
    };
  }

  resumeRun(input: { runId: string; tenantId?: string }): RunHandle | null {
    const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    if (!tx) return null;
    return {
      runId: tx.runId,
      state: tx.state,
      leaseToken: tx.leaseToken,
      fencingEpoch: tx.fencingEpoch,
      intentHash: tx.intentHash,
      tenantId: input.tenantId,
      metadata: tx.metadata,
      createdAt: tx.createdAt,
      resumed: true,
      acquired: false,
    };
  }

  /**
   * Persist PAUSED in the RunLedger (source of truth for HITL / budget / timer).
   * Must be called with valid lease credentials.
   */
  pauseRun(input: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
    resumeAt?: string | null;
    reason?: string;
  }): { paused: boolean; reason?: 'fenced' | 'not_found' } {
    const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    if (!tx) return { paused: false, reason: 'not_found' };
    if (tx.leaseToken !== input.leaseToken || tx.fencingEpoch !== input.fencingEpoch) {
      return { paused: false, reason: 'fenced' };
    }
    const ok = this.ledger.pause(input.runId, input.leaseToken, input.fencingEpoch, {
      tenantId: input.tenantId,
      resumeAt: input.resumeAt,
      reason: input.reason,
    });
    return ok ? { paused: true } : { paused: false, reason: 'fenced' };
  }

  /**
   * Schedule a delayed wake: PAUSED with resume_at. Equivalent to pauseRun with resumeAt.
   */
  scheduleResume(input: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    resumeAt: string;
    tenantId?: string;
    reason?: string;
  }): { scheduled: boolean; reason?: 'fenced' | 'not_found' } {
    const result = this.pauseRun({
      ...input,
      reason: input.reason ?? 'scheduled_resume',
    });
    return { scheduled: result.paused, reason: result.reason };
  }

  /**
   * Claim the next PAUSED run whose resume_at <= now, transitioning it to EXECUTING.
   */
  claimRunnableRun(options?: { tenantId?: string }): RunHandle | null {
    if (!canAdmitSchedulerWork()) {
      return null;
    }
    const candidates = this.ledger.listRunnablePaused({ tenantId: options?.tenantId });
    for (const tx of candidates) {
      let leaseToken = tx.leaseToken;
      let fencingEpoch = tx.fencingEpoch;

      const currentLease = this.lease.get(tx.runId, { tenantId: tx.tenantId });
      if (!currentLease || new Date(currentLease.expiresAt).getTime() <= Date.now()) {
        const leaseResult = this.lease.acquire(tx.runId, { tenantId: tx.tenantId });
        if (!leaseResult.acquired) continue;
        leaseToken = leaseResult.lease.token;
        fencingEpoch = leaseResult.lease.fencingEpoch;
        this.ledger.syncLeaseCredentials(tx.runId, leaseToken, fencingEpoch, {
          tenantId: tx.tenantId,
        });
      }

      const ok = this.ledger.beginExecuting(tx.runId, leaseToken, fencingEpoch, {
        tenantId: tx.tenantId,
      });
      if (!ok) continue;

      return {
        runId: tx.runId,
        state: 'EXECUTING',
        leaseToken,
        fencingEpoch,
        intentHash: tx.intentHash,
        tenantId: tx.tenantId,
        metadata: tx.metadata,
        createdAt: tx.createdAt,
        resumed: true,
        acquired: true,
      };
    }
    return null;
  }

  getRun(input: { runId: string; tenantId?: string }): RunTransaction | null {
    return this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
  }

  listActions(input: { runId: string; tenantId?: string; limit?: number }): CompensableAction[] {
    const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    if (!tx) return [];
    const limit = input.limit ?? 100;
    return tx.actions.slice(-limit).reverse();
  }

  killRun(input: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
  }): KillResult {
    const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    if (!tx) return { killed: false, reason: 'not_found' };
    if (tx.leaseToken !== input.leaseToken || tx.fencingEpoch !== input.fencingEpoch) {
      return { killed: false, reason: 'fenced' };
    }
    const released = this.lease.release(input.runId, input.leaseToken, {
      tenantId: input.tenantId,
    });
    return { killed: released, reason: released ? undefined : 'fenced' };
  }

  heartbeat(input: {
    runId: string;
    leaseToken: string;
    tenantId?: string;
    ttlSeconds?: number;
  }): boolean {
    return this.lease.heartbeat(input.runId, input.leaseToken, {
      tenantId: input.tenantId,
      ttlSeconds: input.ttlSeconds,
    });
  }

  checkpoint(input: SchedulerCheckpointInput): boolean {
    if (!this.checkpointer) return false;
    this.checkpointer.checkpoint(input.state);
    return true;
  }

  listRuns(input?: { state?: RunState; tenantId?: string }): RunTransaction[] {
    if (input?.state) return this.ledger.listByState(input.state, { tenantId: input.tenantId });
    const allStates: RunState[] = [
      'PENDING',
      'EXECUTING',
      'VERIFYING',
      'COMMITTED',
      'ABORTED',
      'COMPENSATED',
      'PAUSED',
    ];
    const tenantId = input?.tenantId;
    return allStates.flatMap((s) => this.ledger.listByState(s, { tenantId }));
  }

  registerCompensation(toolName: string, handler: CompensationHandler): void {
    // Reversibility audit: register only with RunLedger (single source of
    // truth). The legacy CompensationBridge dual-write was removed — its
    // internal `legacy.register()` was a redundant in-memory copy and its
    // `bundle.ledger.registerCompensation()` was a duplicate of this call.
    this.ledger.registerCompensation(toolName, handler);
  }

  registerDefaultCompensations(): void {
    for (const [toolName, handler] of Object.entries(defaultCompensationHandlers)) {
      this.ledger.registerCompensation(toolName, handler as CompensationHandler);
    }
  }
}

let schedulerSingleton: ReturnType<typeof createSchedulerSingleton> | null = null;

function createSchedulerSingleton() {
  return createTenantAwareSingleton<ExecutionScheduler>(
    () => {
      const bundle = getRunLedgerBundle();
      const scheduler = new ExecutionScheduler({
        lease: bundle.lease,
        idempotency: bundle.idempotency,
        ledger: bundle.ledger,
      });
      scheduler.registerDefaultCompensations();
      return scheduler;
    },
    { dispose: () => {} },
  );
}

export function getExecutionScheduler(): ExecutionScheduler {
  if (!schedulerSingleton) {
    schedulerSingleton = createSchedulerSingleton();
    // Subscribe to circuit.compensation_trigger events — when a circuit breaker
    // opens, trigger abortRun + compensation for the affected run.
    // Previously this event had no consumer, so circuit breaker trips never
    // triggered rollback of already-committed mutations.
    try {
      getMessageBus().subscribe('circuit.compensation_trigger', (event) => {
        const payload = (event.payload || {}) as Record<string, unknown>;
        const runId = payload.runId as string | undefined;
        if (!runId) return;

        getGlobalLogger().warn(
          'ExecutionScheduler',
          'Circuit breaker compensation trigger — aborting run',
          { runId, reason: payload.reason },
        );

        // Abort and compensate the run — this triggers saga compensation
        // for any uncommitted mutations, and restores the git snapshot if
        // compensation has failures. Fire-and-forget (async) since the bus
        // callback is synchronous.
        try {
          const sched = schedulerSingleton?.get();
          if (sched) {
            sched
              .abortRun({
                runId,
                leaseToken: '', // fence-safe: abort will use stored lease
                fencingEpoch: 0,
                reason: `circuit_breaker_open: ${payload.reason ?? 'unknown'}`,
                tenantId: payload.tenantId as string | undefined,
              })
              .catch((err: unknown) => {
                reportSilentFailure(err, 'scheduler:circuit-compensation-abort');
              });
          }
        } catch (err) {
          reportSilentFailure(err, 'scheduler:circuit-compensation-trigger');
        }
      });
    } catch (err) {
      reportSilentFailure(err, 'scheduler:subscribe-compensation-trigger');
    }
  }
  return schedulerSingleton.get();
}

export function resetExecutionScheduler(): void {
  schedulerSingleton?.reset();
}
