/**
 * EffectReconciliationWorker — polls actions whose completion status is unknown
 * and reconciles them against durable approval interactions.
 *
 * When an external side effect is gated with `require_approval`, the action is
 * left in `COMPLETION_UNKNOWN` until the durable interaction store reports the
 * human decision. This worker bridges that gap without re-executing the effect.
 */

import type { DurableInteractionStore } from './durableInteractionStore';

export interface ReconciliationWorker {
  start(): void;
  stop(): void;
}

/** Minimal scheduler surface required by the reconciliation worker. */
export interface ExecutionSchedulerLike {
  listActionsByStatus(status: 'COMPLETION_UNKNOWN'): ReconcilableAction[];
  markActionCompleted(actionId: string, metadata?: Record<string, unknown>): Promise<void>;
  markActionFailed(actionId: string, metadata?: Record<string, unknown>): Promise<void>;
}

export interface ReconcilableAction {
  actionId: string;
  status: string;
}

export class EffectReconciliationWorker implements ReconciliationWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly scheduler: ExecutionSchedulerLike,
    private readonly interactionStore: DurableInteractionStore,
    private readonly intervalMs: number = 5000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const unknowns = this.scheduler.listActionsByStatus('COMPLETION_UNKNOWN');
    for (const action of unknowns) {
      const interaction = await this.interactionStore.getByActionId(action.actionId);
      if (interaction?.status === 'approved') {
        await this.scheduler.markActionCompleted(action.actionId, { reconciled: true });
      } else if (interaction?.status === 'denied') {
        await this.scheduler.markActionFailed(action.actionId, {
          reconciled: true,
          reason: 'approval_denied',
        });
      }
    }
  }
}
