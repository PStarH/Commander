import type { SagaStateSnapshot, SagaEvent, RunState, NodeState } from './types';
import type { SagaStore } from './sagaStore';

export interface RecoveredState {
  snapshot: SagaStateSnapshot;
  eventsAfterSnapshot: SagaEvent[];
  allEvents: SagaEvent[];
}

export class CheckpointManager {
  constructor(private readonly store: SagaStore) {}

  /** Expose the underlying store for idempotency lookups. */
  getStore(): SagaStore {
    return this.store;
  }

  async saveSnapshot(snapshot: SagaStateSnapshot): Promise<void> {
    await this.store.writeSnapshot(snapshot);
  }

  async loadSnapshot(runId: string): Promise<SagaStateSnapshot | undefined> {
    return this.store.readSnapshot(runId);
  }

  async appendEvent(event: SagaEvent): Promise<void> {
    await this.store.appendEvent(event);
  }

  async loadEvents(runId: string): Promise<SagaEvent[]> {
    return this.store.readEvents(runId);
  }

  async recover(runId: string): Promise<RecoveredState | undefined> {
    const [snapshot, allEvents] = await Promise.all([
      this.store.readSnapshot(runId),
      this.store.readEvents(runId),
    ]);

    if (!snapshot && allEvents.length === 0) {
      return undefined;
    }

    if (!snapshot) {
      throw new CheckpointError(`Run ${runId} has events but no snapshot — cannot recover`);
    }

    const snapshotTime = new Date(snapshot.updatedAt).getTime();
    const eventsAfterSnapshot = allEvents.filter(
      (e) => new Date(e.timestamp).getTime() > snapshotTime,
    );

    return { snapshot, eventsAfterSnapshot, allEvents };
  }

  async deleteRun(runId: string): Promise<void> {
    await this.store.deleteRun(runId);
  }

  createSnapshot(params: {
    runId: string;
    state: RunState;
    intentHash: string;
    fencingEpoch: number;
    nodeStates: Record<string, NodeState>;
    parentRunId?: string;
    childRunIds?: string[];
    error?: string;
    tenantId?: string;
    idempotencyKey?: string;
    previous?: SagaStateSnapshot;
  }): SagaStateSnapshot {
    const now = new Date().toISOString();
    const { previous, childRunIds = [], ...rest } = params;

    if (!previous) {
      return {
        ...rest,
        childRunIds,
        createdAt: now,
        updatedAt: now,
        checkpointVersion: 1,
      };
    }

    return {
      ...previous,
      ...rest,
      childRunIds,
      createdAt: previous.createdAt,
      updatedAt: now,
      checkpointVersion: previous.checkpointVersion + 1,
    };
  }
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

export function snapshotFor(
  runId: string,
  state: RunState,
  nodeStates: Record<string, NodeState>,
): SagaStateSnapshot {
  const now = new Date().toISOString();
  return {
    runId,
    state,
    intentHash: '',
    fencingEpoch: 0,
    nodeStates,
    childRunIds: [],
    createdAt: now,
    updatedAt: now,
    checkpointVersion: 1,
  };
}
