import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteInteractionStore,
  type ApprovalInteraction,
} from '../../src/atr/durableInteractionStore';

describe('SqliteInteractionStore', () => {
  let store: SqliteInteractionStore;

  beforeEach(() => {
    store = new SqliteInteractionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

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

  it('create + getByActionId round-trip', async () => {
    const interaction = makeInteraction();
    await store.create(interaction);
    const found = await store.getByActionId(interaction.actionId);
    expect(found).toEqual(interaction);
  });

  it('resolve approved updates status and resolvedAt', async () => {
    const interaction = makeInteraction({ interactionId: 'apv-2', actionId: 'action-2' });
    await store.create(interaction);
    await store.resolve(interaction.interactionId, 'approved');
    const found = await store.getByActionId(interaction.actionId);
    expect(found?.status).toBe('approved');
    expect(found?.resolvedAt).toBeDefined();
    expect(new Date(found!.resolvedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(interaction.createdAt).getTime(),
    );
  });

  it('resolve denied updates status and resolvedAt', async () => {
    const interaction = makeInteraction({ interactionId: 'apv-3', actionId: 'action-3' });
    await store.create(interaction);
    await store.resolve(interaction.interactionId, 'denied');
    const found = await store.getByActionId(interaction.actionId);
    expect(found?.status).toBe('denied');
    expect(found?.resolvedAt).toBeDefined();
  });

  it('listPending filters by runId', async () => {
    await store.create(
      makeInteraction({ interactionId: 'apv-a', actionId: 'action-a', runId: 'run-a' }),
    );
    await store.create(
      makeInteraction({ interactionId: 'apv-b', actionId: 'action-b', runId: 'run-b' }),
    );
    await store.create(
      makeInteraction({
        interactionId: 'apv-c',
        actionId: 'action-c',
        runId: 'run-a',
        status: 'approved',
      }),
    );

    const pendingA = await store.listPending('run-a');
    expect(pendingA.map((i) => i.interactionId).sort()).toEqual(['apv-a']);

    const pendingB = await store.listPending('run-b');
    expect(pendingB.map((i) => i.interactionId)).toEqual(['apv-b']);

    const allPending = await store.listPending();
    expect(allPending.map((i) => i.interactionId).sort()).toEqual(['apv-a', 'apv-b']);
  });

  it('throws when resolving an unknown interaction', async () => {
    await expect(store.resolve('apv-unknown', 'approved')).rejects.toThrow('Interaction not found');
  });
});
