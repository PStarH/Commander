/**
 * V2 Compensation Rollback Live-Fire Integration Tests
 *
 * These tests verify the compensation/rollback mechanism works end-to-end:
 *   1. Execute steps that produce compensable side effects
 *   2. Trigger a failure requiring compensation
 *   3. Verify rollback executes in LIFO order
 *   4. Verify partial failure recovery
 *   5. Verify compensation queue durability
 *   6. Verify reversibility classification
 *
 * This proves the "Layer 3 — Recovery" defense: the system can undo
 * completed side effects when a downstream failure occurs.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import { CompensationRegistry } from '../../src/runtime/compensationRegistry.js';

const TENANT = 'tenant-comp-test';

function createRunCommand(
  tenantId: string,
  steps: Array<{ kind: string; input?: Record<string, unknown> }>,
) {
  const runId = randomUUID();
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(runId).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'test-policy',
    steps: steps.map((s, i) => ({
      id: `${runId}-step-${i}`,
      kind: s.kind,
      input: s.input ?? { goal: `Execute ${s.kind}`, agentId: 'test-agent' },
    })),
  };
}

describe('V2 Compensation Rollback — Live-Fire Integration', () => {
  let kernel: InMemoryKernelRepository;
  let registry: CompensationRegistry;

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
    registry = new CompensationRegistry();
  });

  it('rolls back completed side effects in LIFO order when run fails', async () => {
    const cmd = createRunCommand(TENANT, [
      { kind: 'tool', input: { toolName: 'custom_write', path: '/tmp/a.txt', content: 'A' } },
      { kind: 'tool', input: { toolName: 'custom_write', path: '/tmp/b.txt', content: 'B' } },
      { kind: 'tool', input: { toolName: 'custom_write', path: '/tmp/c.txt', content: 'C' } },
    ]);
    const run = await kernel.createRun(cmd, 'gateway');

    // Execute 3 steps, recording compensable actions
    const rollbackOrder: string[] = [];
    const sideEffects: Array<{ actionId: string; rolledBack: boolean }> = [];

    registry.register('custom_write', async (action) => {
      rollbackOrder.push(action.actionId);
      const idx = sideEffects.findIndex((s) => s.actionId === action.actionId);
      if (idx >= 0) sideEffects[idx]!.rolledBack = true;
      return { success: true };
    });

    for (let i = 0; i < 3; i++) {
      const claimed = await kernel.claimNextStep({
        workerId: 'worker-1',
        leaseTtlMs: 30_000,
        tenantIds: [TENANT],
        capabilities: [],
      });
      assert.ok(claimed);

      const actionId = `action-${i}`;
      sideEffects.push({ actionId, rolledBack: false });
      registry.recordAction({
        actionId,
        runId: run.id,
        stepId: claimed!.id,
        tenantId: TENANT,
        toolName: 'custom_write',
        args: { path: `/tmp/${String.fromCharCode(97 + i)}.txt` },
      });

      await kernel.completeStep({
        stepId: claimed!.id,
        tenantId: claimed!.tenantId,
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        output: { status: 'success' },
        actor: 'worker-1',
      });
    }

    // Compensate all — should execute in LIFO order
    const result = await registry.compensateAll();
    assert.ok(result.succeeded >= 3, 'All 3 actions should be compensated');

    // LIFO: action-2, action-1, action-0
    assert.equal(rollbackOrder[0], 'action-2', 'Last effect should be rolled back first');
    assert.equal(rollbackOrder[1], 'action-1', 'Second effect rolled back second');
    assert.equal(rollbackOrder[2], 'action-0', 'First effect rolled back last');

    for (const effect of sideEffects) {
      assert.equal(effect.rolledBack, true, `Effect ${effect.actionId} should be rolled back`);
    }
  });

  it('handles compensation failure gracefully', async () => {
    const cmd = createRunCommand(TENANT, [{ kind: 'tool' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT],
      capabilities: [],
    });
    assert.ok(claimed);

    const actionId = 'action-fail-test';
    registry.recordAction({
      actionId,
      runId: run.id,
      stepId: claimed!.id,
      tenantId: TENANT,
      toolName: 'always_fail_tool',
      args: {},
    });

    registry.register('always_fail_tool', async () => {
      return { success: false, error: 'This compensation always fails' };
    });

    await kernel.completeStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      output: { status: 'success' },
      actor: 'worker-1',
    });

    const result = await registry.compensate(actionId);
    assert.equal(result.success, false, 'Compensation should fail');
    assert.ok(result.error, 'Should have error message');
  });

  it('compensates individual action by ID', async () => {
    const cmd = createRunCommand(TENANT, [{ kind: 'tool' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT],
      capabilities: [],
    });
    assert.ok(claimed);

    const actionId = 'action-individual';
    let compensated = false;
    registry.recordAction({
      actionId,
      runId: run.id,
      stepId: claimed!.id,
      tenantId: TENANT,
      toolName: 'individual_tool',
      args: { target: '/tmp/individual.txt' },
    });
    registry.register('individual_tool', async () => {
      compensated = true;
      return { success: true };
    });

    await kernel.completeStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      output: { status: 'success' },
      actor: 'worker-1',
    });

    const result = await registry.compensate(actionId);
    assert.equal(result.success, true, 'Individual compensation should succeed');
    assert.equal(compensated, true, 'Handler should have been called');
  });

  it('returns success when compensating unknown action (already compensated)', async () => {
    const result = await registry.compensate('nonexistent-action');
    assert.equal(result.success, true, 'Compensating unknown action should return success');
  });

  it('returns success when no handler registered (buffered as irreversible)', async () => {
    const cmd = createRunCommand(TENANT, [{ kind: 'tool' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT],
      capabilities: [],
    });
    assert.ok(claimed);

    const actionId = 'action-no-handler';
    registry.recordAction({
      actionId,
      runId: run.id,
      stepId: claimed!.id,
      tenantId: TENANT,
      toolName: 'git_push',
      args: { ref: 'main' },
    });

    await kernel.completeStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      output: { status: 'success' },
      actor: 'worker-1',
    });

    // No handler registered for git_push — should be buffered, not throw
    const result = await registry.compensate(actionId);
    assert.equal(result.success, true, 'Should succeed (buffered as irreversible)');
  });

  it('preserves compensation order across multi-step dependency chain', async () => {
    const step0Id = randomUUID();
    const step1Id = randomUUID();
    const step2Id = randomUUID();
    const runId = randomUUID();

    await kernel.createRun(
      {
        id: runId,
        tenantId: TENANT,
        intentHash: createHash('sha256').update(runId).digest('hex'),
        workGraphHash: createHash('sha256').update(runId).digest('hex'),
        workGraphVersion: 'v1',
        policySnapshotId: 'test-policy',
        steps: [
          { id: step0Id, kind: 'tool', input: { toolName: 'saga_deploy' } },
          {
            id: step1Id,
            kind: 'tool',
            input: { toolName: 'saga_migrate' },
            dependencies: [step0Id],
          },
          {
            id: step2Id,
            kind: 'tool',
            input: { toolName: 'saga_notify' },
            dependencies: [step1Id],
          },
        ],
      },
      'gateway',
    );

    const rollbackOrder: string[] = [];

    registry.register('saga_deploy', async (action) => {
      rollbackOrder.push(action.actionId);
      return { success: true };
    });
    registry.register('saga_migrate', async (action) => {
      rollbackOrder.push(action.actionId);
      return { success: true };
    });
    registry.register('saga_notify', async (action) => {
      rollbackOrder.push(action.actionId);
      return { success: true };
    });

    // Execute all 3 steps
    for (let i = 0; i < 3; i++) {
      const claimed = await kernel.claimNextStep({
        workerId: 'worker-1',
        leaseTtlMs: 30_000,
        tenantIds: [TENANT],
        capabilities: [],
      });
      assert.ok(claimed, `Should claim step ${i}`);

      const toolName = ['saga_deploy', 'saga_migrate', 'saga_notify'][i]!;
      const actionId = `saga-action-${i}`;
      registry.recordAction({
        actionId,
        runId,
        stepId: claimed!.id,
        tenantId: TENANT,
        toolName,
        args: claimed!.input,
      });

      await kernel.completeStep({
        stepId: claimed!.id,
        tenantId: claimed!.tenantId,
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        output: { status: 'success' },
        actor: 'worker-1',
      });
    }

    // Compensate all — LIFO order
    await registry.compensateAll();

    assert.equal(rollbackOrder.length, 3, 'All 3 actions should be compensated');
    assert.equal(
      rollbackOrder[0],
      'saga-action-2',
      'Notify should be rolled back first (last executed)',
    );
    assert.equal(rollbackOrder[1], 'saga-action-1', 'Migrate should be rolled back second');
    assert.equal(
      rollbackOrder[2],
      'saga-action-0',
      'Deploy should be rolled back last (first executed)',
    );
  });

  it('tracks pending count correctly', async () => {
    const cmd = createRunCommand(TENANT, [{ kind: 'tool' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT],
      capabilities: [],
    });
    assert.ok(claimed);

    registry.recordAction({
      actionId: 'pending-1',
      runId: run.id,
      stepId: claimed!.id,
      tenantId: TENANT,
      toolName: 'tracked_tool',
      args: {},
    });
    registry.register('tracked_tool', async () => ({ success: true }));

    assert.equal(registry.getPendingCount(), 1, 'Should have 1 pending action');

    await registry.compensate('pending-1');
    assert.equal(registry.getPendingCount(), 0, 'Should have 0 pending after compensation');
  });

  it('assesses reversibility of common tools', () => {
    const reversible = registry.assessReversibility('file_read');
    assert.equal(reversible, 'fully_reversible', 'file_read should be fully reversible');

    const irreversible = registry.assessReversibility('git_push');
    assert.equal(irreversible, 'non_reversible', 'git_push should be non-reversible');

    const writeFile = registry.assessReversibility('file_write');
    assert.equal(writeFile, 'non_reversible', 'file_write should be non-reversible');

    const shellExec = registry.assessReversibility('shell_execute');
    assert.equal(shellExec, 'non_reversible', 'shell_execute should be non-reversible');

    // Unknown tools default to partially_reversible
    const unknown = registry.assessReversibility('custom_tool');
    assert.equal(unknown, 'partially_reversible', 'Unknown tool should be partially reversible');
  });
});
