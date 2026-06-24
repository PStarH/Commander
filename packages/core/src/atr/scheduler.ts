/**
 * ExecutionScheduler — the single ATR entry point.
 *
 * Owns: run lease, idempotency, checkpoint version, saga state machine.
 * Composes: LeaseManager + IdempotencyStore + RunLedger + CompensationBridge + StateCheckpointer.
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
 */

import type { CheckpointState } from '../runtime/stateCheckpointer';
import { StateCheckpointer } from '../runtime/stateCheckpointer';
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
import { CompensationBridge } from './compensationBridge';
import { defaultCompensationHandlers } from './defaultCompensation';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

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
  bridge: CompensationBridge;
  checkpointer?: StateCheckpointer;
}

export class ExecutionScheduler {
  private lease: LeaseManager;
  private idempotency: IdempotencyStore;
  private ledger: RunLedger;
  private bridge: CompensationBridge;
  private checkpointer?: StateCheckpointer;

  constructor(opts: ExecutionSchedulerOptions) {
    this.lease = opts.lease;
    this.idempotency = opts.idempotency;
    this.ledger = opts.ledger;
    this.bridge = opts.bridge;
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
    this.ledger.registerCompensation(toolName, handler);
    this.bridge.register(toolName, handler);
  }

  registerDefaultCompensations(): void {
    const bridge = this.bridge;
    for (const [toolName, handler] of Object.entries(defaultCompensationHandlers)) {
      this.ledger.registerCompensation(toolName, handler as Parameters<typeof bridge.register>[1]);
      bridge.register(toolName, handler as Parameters<typeof bridge.register>[1]);
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
        bridge: new CompensationBridge(),
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
  }
  return schedulerSingleton.get();
}

export function resetExecutionScheduler(): void {
  schedulerSingleton?.reset();
}
