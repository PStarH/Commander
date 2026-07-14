import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  EffectReconciliationWorker,
  type ExecutionSchedulerLike,
  type ReconcilableAction,
} from '../../src/atr/effectReconciliationWorker';
import {
  SqliteInteractionStore,
  type ApprovalInteraction,
} from '../../src/atr/durableInteractionStore';

class InMemorySchedulerStub implements ExecutionSchedulerLike {
  private actions = new Map<string, ReconcilableAction>();

  scheduleAction(action: ReconcilableAction): void {
    this.actions.set(action.actionId, action);
  }

  getAction(actionId: string): ReconcilableAction | undefined {
    return this.actions.get(actionId);
  }

  listActionsByStatus(status: string): ReconcilableAction[] {
    return Array.from(this.actions.values()).filter((a) => a.status === status);
  }

  async markActionCompleted(actionId: string, _metadata?: Record<string, unknown>): Promise<void> {
    const action = this.actions.get(actionId);
    if (action) action.status = 'completed';
  }

  async markActionFailed(actionId: string, _metadata?: Record<string, unknown>): Promise<void> {
    const action = this.actions.get(actionId);
    if (action) action.status = 'failed';
  }
}

function makeInteraction(overrides?: Partial<ApprovalInteraction>): ApprovalInteraction {
  return {
    interactionId: 'apv-1',
    actionId: 'action-1',
    runId: 'run-1',
    tenantId: 'tenant-1',
    toolName: 'send_email',
    externalRequestHash: 'hash-abc',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('EffectReconciliationWorker', () => {
  let scheduler: InMemorySchedulerStub;
  let store: SqliteInteractionStore;
  let worker: EffectReconciliationWorker;

  beforeEach(() => {
    scheduler = new InMemorySchedulerStub();
    store = new SqliteInteractionStore(':memory:');
    worker = new EffectReconciliationWorker(scheduler, store, 10);
  });

  afterEach(() => {
    worker.stop();
    store.close();
  });

  it('reconciles COMPLETION_UNKNOWN to completed after interaction approved', async () => {
    scheduler.scheduleAction({ actionId: 'a1', status: 'COMPLETION_UNKNOWN' });
    await store.create(makeInteraction({ interactionId: 'i1', actionId: 'a1' }));
    await store.resolve('i1', 'approved');

    worker.start();
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();

    const action = scheduler.getAction('a1');
    expect(action?.status).toBe('completed');
  });

  it('reconciles COMPLETION_UNKNOWN to failed after interaction denied', async () => {
    scheduler.scheduleAction({ actionId: 'a2', status: 'COMPLETION_UNKNOWN' });
    await store.create(makeInteraction({ interactionId: 'i2', actionId: 'a2' }));
    await store.resolve('i2', 'denied');

    worker.start();
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();

    const action = scheduler.getAction('a2');
    expect(action?.status).toBe('failed');
  });

  it('takes no action when interaction is still pending', async () => {
    scheduler.scheduleAction({ actionId: 'a3', status: 'COMPLETION_UNKNOWN' });
    await store.create(makeInteraction({ interactionId: 'i3', actionId: 'a3' }));

    worker.start();
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();

    const action = scheduler.getAction('a3');
    expect(action?.status).toBe('COMPLETION_UNKNOWN');
  });
});
