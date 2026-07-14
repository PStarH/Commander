/**
 * V2 Multi-Replica Kernel Simulation — Distributed Coordination Proofs.
 *
 * These tests simulate a multi-replica deployment (multiple schedulers and
 * workers) against a single shared `InMemoryKernelRepository`, which stands in
 * for the shared Postgres backing store that real replicas would contend on.
 * They prove the kernel's distributed-coordination invariants without
 * requiring a real database or multiple processes:
 *
 *   1. No double-claim across two schedulers sharing one store
 *   2. Worker failover: surviving worker picks up unclaimed work
 *   3. Lease expiry + cross-worker reclaim with monotonic fencing epoch
 *   4. Multi-tenant concurrent processing with full tenant isolation
 *   5. Per-tenant concurrency limits cannot be exhausted across tenants
 *   6. Scheduler partitioning by tenant with no cross-tenant leakage
 *   7. Worker kind routing: capabilities gate which steps a worker may claim
 *   8. Burst handling with fair distribution across workers
 *   9. Sequential dependency chain with multi-worker handoff
 *  10. Mixed workload: concurrent tenants, dependencies, and worker types
 *
 * Uses InMemoryKernelRepository to avoid Postgres dependency.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import type { KernelStep } from '../../../kernel/src/types.js';

function createRunCommand(tenantId: string, stepCount: number, kind = 'agent', maxAttempts = 3) {
  const runId = randomUUID();
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(runId).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'test-policy',
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `${runId}-step-${i}`,
      kind,
      input: { goal: `Task ${i}`, agentId: 'test-agent' },
      maxAttempts,
    })),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drains all claimable steps for a worker (claim → complete loop) and records
 * the tenant + kind of every step it touched. Used to simulate a single worker
 * processing a (possibly scoped) work queue to completion.
 */
async function drainTenant(
  kernel: InMemoryKernelRepository,
  workerId: string,
  tenantIds: string[],
  capabilities: string[],
  maxIterations = 50,
): Promise<{ stepIds: string[]; tenants: string[]; kinds: string[] }> {
  const stepIds: string[] = [];
  const tenants: string[] = [];
  const kinds: string[] = [];
  for (let i = 0; i < maxIterations; i++) {
    const step = await kernel.claimNextStep({
      workerId,
      leaseTtlMs: 30_000,
      tenantIds,
      capabilities,
    });
    if (!step) break;
    stepIds.push(step.id);
    tenants.push(step.tenantId);
    kinds.push(step.kind);
    await kernel.completeStep({
      stepId: step.id,
      tenantId: step.tenantId,
      lease: step.lease!,
      expectedVersion: step.version,
      output: { status: 'success', summary: `completed by ${workerId}` },
      actor: workerId,
    });
  }
  return { stepIds, tenants, kinds };
}

describe('V2 Multi-Replica Simulation — Distributed Kernel Coordination', () => {
  let kernel: InMemoryKernelRepository;

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  // ── 1. Two schedulers claiming from shared store: no double-claim ──
  it('prevents double-claim when two schedulers alternately claim from a shared store', async () => {
    const command = createRunCommand('tenant-shared', 10);
    await kernel.createRun(command, 'gateway');

    const claimedByA: string[] = [];
    const claimedByB: string[] = [];
    const ownerForStep = new Map<string, string>();

    // Alternate claims between worker-A and worker-B until the store is drained.
    for (let round = 0; round < 10; round++) {
      const a = await kernel.claimNextStep({
        workerId: 'worker-A',
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: [],
      });
      if (a) {
        claimedByA.push(a.id);
        ownerForStep.set(a.id, a.lease!.workerId);
      }

      const b = await kernel.claimNextStep({
        workerId: 'worker-B',
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: [],
      });
      if (b) {
        claimedByB.push(b.id);
        ownerForStep.set(b.id, b.lease!.workerId);
      }
    }

    const allClaimed = [...claimedByA, ...claimedByB];

    // All 10 steps claimed exactly once (no duplicates).
    assert.equal(allClaimed.length, 10, 'All 10 steps should be claimed');
    assert.equal(new Set(allClaimed).size, 10, 'No step should be claimed twice');

    // No overlap between the two schedulers (no double-claim).
    const overlap = claimedByA.filter((id) => claimedByB.includes(id));
    assert.equal(overlap.length, 0, 'No step should be claimed by both workers');

    // Each step has exactly one owning workerId drawn from the scheduler set.
    assert.equal(ownerForStep.size, 10, 'Each step should have exactly one owning worker');
    for (const [stepId, workerId] of ownerForStep) {
      assert.ok(
        workerId === 'worker-A' || workerId === 'worker-B',
        `Step ${stepId} has unexpected owner ${workerId}`,
      );
    }
  });

  // ── 2. Worker failover: worker-A crashes, worker-B picks up unclaimed work ──
  it('supports worker failover: worker-B picks up unclaimed work after worker-A crashes', async () => {
    const command = createRunCommand('tenant-failover', 5);
    await kernel.createRun(command, 'gateway');

    // Worker-A claims 3 steps but never completes them (simulated crash).
    const heldByA: string[] = [];
    for (let i = 0; i < 3; i++) {
      const claimed = await kernel.claimNextStep({
        workerId: 'worker-A',
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: [],
      });
      assert.ok(claimed, `Worker-A should claim step ${i}`);
      heldByA.push(claimed!.id);
    }

    // Worker-B claims the remaining unclaimed work.
    const heldByB: string[] = [];
    for (let i = 0; i < 5; i++) {
      const claimed = await kernel.claimNextStep({
        workerId: 'worker-B',
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: [],
      });
      if (claimed) heldByB.push(claimed.id);
    }

    assert.equal(heldByA.length, 3, 'Worker-A should have held 3 steps before crashing');
    assert.equal(heldByB.length, 2, 'Worker-B should pick up exactly the 2 remaining steps');

    // No step held by both workers.
    const overlap = heldByA.filter((id) => heldByB.includes(id));
    assert.equal(overlap.length, 0, 'No step should be held by both workers');
  });

  // ── 3. Lease expiry + cross-worker reclaim: fencing epoch monotonicity ──
  it('reclaims expired leases across workers with a monotonically higher fencing epoch', async () => {
    const command = createRunCommand('tenant-lease', 1, 'agent', 3);
    await kernel.createRun(command, 'gateway');

    // Worker-A claims with a short 50ms lease, then "crashes" (no completion).
    const claimedByA = await kernel.claimNextStep({
      workerId: 'worker-A',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimedByA, 'Worker-A should claim the step');
    const epochA = claimedByA!.lease!.fencingEpoch;

    await sleep(80);

    // Reclaim expired leases (the 50ms lease has actually expired).
    const reclaimed = await kernel.reclaimExpiredLeases(new Date(), 100);
    assert.equal(reclaimed.length, 1, 'One expired lease should be reclaimed');
    assert.equal(
      reclaimed[0].state,
      'RETRY_WAIT',
      'Reclaimed step should be requeued as RETRY_WAIT',
    );

    // Worker-B claims the reclaimed step (gets a fresh lease).
    const claimedByB = await kernel.claimNextStep({
      workerId: 'worker-B',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimedByB, 'Worker-B should claim the reclaimed step');
    const epochB = claimedByB!.lease!.fencingEpoch;

    assert.ok(
      epochB > epochA,
      `Worker-B fencing epoch (${epochB}) must exceed worker-A's (${epochA})`,
    );

    // Worker-B completes the step successfully.
    const completed = await kernel.completeStep({
      stepId: claimedByB!.id,
      tenantId: claimedByB!.tenantId,
      lease: claimedByB!.lease!,
      expectedVersion: claimedByB!.version,
      output: { status: 'success', summary: 'Recovered by worker-B' },
      actor: 'worker-B',
    });
    assert.ok(completed, 'Worker-B should complete the reclaimed step');
    assert.equal(completed!.state, 'SUCCEEDED');

    const run = await kernel.getRun(command.id, 'tenant-lease');
    assert.equal(run!.state, 'SUCCEEDED', 'Run should reach SUCCEEDED after reclaim + complete');
  });

  // ── 4. Multi-tenant concurrent processing: tenant A and B in parallel ──
  it('processes multiple tenants in parallel with full tenant isolation', async () => {
    const cmdA = createRunCommand('tenant-A', 3);
    const cmdB = createRunCommand('tenant-B', 3);
    await kernel.createRun(cmdA, 'gateway');
    await kernel.createRun(cmdB, 'gateway');

    // Worker-1 is scoped to tenant-A; worker-2 to tenant-B. Both drain concurrently.
    const [w1, w2] = await Promise.all([
      drainTenant(kernel, 'worker-1', ['tenant-A'], []),
      drainTenant(kernel, 'worker-2', ['tenant-B'], []),
    ]);

    assert.equal(w1.stepIds.length, 3, 'Worker-1 should claim all 3 tenant-A steps');
    assert.equal(w2.stepIds.length, 3, 'Worker-2 should claim all 3 tenant-B steps');

    for (const t of w1.tenants) {
      assert.equal(t, 'tenant-A', 'Worker-1 must only ever see tenant-A steps');
    }
    for (const t of w2.tenants) {
      assert.equal(t, 'tenant-B', 'Worker-2 must only ever see tenant-B steps');
    }

    // No cross-tenant leakage: the two workers' step sets are disjoint.
    const overlap = w1.stepIds.filter((id) => w2.stepIds.includes(id));
    assert.equal(overlap.length, 0, 'No step should be claimed by both workers');

    // Both tenants complete independently.
    const runA = await kernel.getRun(cmdA.id, 'tenant-A');
    const runB = await kernel.getRun(cmdB.id, 'tenant-B');
    assert.equal(runA!.state, 'SUCCEEDED', 'Tenant-A run should complete');
    assert.equal(runB!.state, 'SUCCEEDED', 'Tenant-B run should complete');
  });

  // ── 5. Per-tenant concurrency limit: one tenant cannot exhaust another ──
  it("enforces per-tenant concurrency limits so one tenant cannot exhaust another's capacity", async () => {
    // Tenant-A is capped at 2 concurrent steps; tenant-B has no limit set.
    await kernel.setTenantConcurrencyLimit('tenant-A', 2);

    const cmdA = createRunCommand('tenant-A', 5);
    const cmdB = createRunCommand('tenant-B', 5);
    await kernel.createRun(cmdA, 'gateway');
    await kernel.createRun(cmdB, 'gateway');

    // Claim up to 5 steps for tenant-A → only 2 should be claimable (limit reached).
    const aClaims: KernelStep[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await kernel.claimNextStep({
        workerId: 'worker-A',
        leaseTtlMs: 30_000,
        tenantIds: ['tenant-A'],
        capabilities: [],
      });
      if (!c) break;
      aClaims.push(c);
    }
    assert.equal(aClaims.length, 2, 'Tenant-A should only claim 2 steps (concurrency limit = 2)');

    // Claim up to 5 steps for tenant-B → all 5 should be claimable (no limit set).
    const bClaims: KernelStep[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await kernel.claimNextStep({
        workerId: 'worker-B',
        leaseTtlMs: 30_000,
        tenantIds: ['tenant-B'],
        capabilities: [],
      });
      if (!c) break;
      bClaims.push(c);
    }
    assert.equal(bClaims.length, 5, 'Tenant-B should claim all 5 steps (no limit set)');

    // Complete tenant-A's 2 held steps → capacity frees up for 2 more.
    for (const s of aClaims) {
      await kernel.completeStep({
        stepId: s.id,
        tenantId: s.tenantId,
        lease: s.lease!,
        expectedVersion: s.version,
        output: { status: 'success' },
        actor: 'worker-A',
      });
    }

    const aClaims2: KernelStep[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await kernel.claimNextStep({
        workerId: 'worker-A',
        leaseTtlMs: 30_000,
        tenantIds: ['tenant-A'],
        capabilities: [],
      });
      if (!c) break;
      aClaims2.push(c);
    }
    assert.equal(
      aClaims2.length,
      2,
      '2 more tenant-A steps should become available after completing the held steps',
    );

    // Sanity: tenant-B's capacity was never affected by tenant-A's limit.
    assert.equal(bClaims.length, 5, 'Tenant-B still fully claimable regardless of tenant-A limit');
  });

  // ── 6. Scheduler partition: two schedulers handle different tenants ──
  it('partitions schedulers by tenant with no cross-tenant leakage', async () => {
    const cmdA = createRunCommand('tenant-A', 3);
    const cmdB = createRunCommand('tenant-B', 3);
    await kernel.createRun(cmdA, 'gateway');
    await kernel.createRun(cmdB, 'gateway');

    // Scheduler-1 owns tenant-A; scheduler-2 owns tenant-B. Both run concurrently.
    const [s1, s2] = await Promise.all([
      drainTenant(kernel, 'scheduler-1', ['tenant-A'], []),
      drainTenant(kernel, 'scheduler-2', ['tenant-B'], []),
    ]);

    assert.equal(s1.stepIds.length, 3, 'Scheduler-1 should complete all 3 tenant-A steps');
    assert.equal(s2.stepIds.length, 3, 'Scheduler-2 should complete all 3 tenant-B steps');

    for (const t of s1.tenants) {
      assert.equal(t, 'tenant-A', 'Scheduler-1 must only process tenant-A steps');
    }
    for (const t of s2.tenants) {
      assert.equal(t, 'tenant-B', 'Scheduler-2 must only process tenant-B steps');
    }

    // No cross-tenant leakage.
    const overlap = s1.stepIds.filter((id) => s2.stepIds.includes(id));
    assert.equal(overlap.length, 0, 'No step should be processed by both schedulers');

    const runA = await kernel.getRun(cmdA.id, 'tenant-A');
    const runB = await kernel.getRun(cmdB.id, 'tenant-B');
    assert.equal(runA!.state, 'SUCCEEDED', 'Tenant-A run should reach SUCCEEDED');
    assert.equal(runB!.state, 'SUCCEEDED', 'Tenant-B run should reach SUCCEEDED');
  });

  // ── 7. Worker kind routing: only matching capabilities claim steps ──
  it('routes steps to workers based on declared capabilities', async () => {
    // Create a run with 2 'agent' steps and 2 'tool' steps.
    const command = createRunCommand('tenant-kind', 4, 'agent', 3);
    command.steps[2].kind = 'tool';
    command.steps[3].kind = 'tool';
    await kernel.createRun(command, 'gateway');

    // Worker-A only handles 'agent' steps.
    const workerASteps: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await kernel.claimNextStep({
        workerId: 'worker-A',
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: ['agent'],
      });
      if (!c) break;
      assert.equal(c.kind, 'agent', 'Worker-A must only claim agent-kind steps');
      workerASteps.push(c.id);
    }
    assert.equal(workerASteps.length, 2, 'Worker-A should claim exactly the 2 agent steps');

    // Worker-B only handles 'tool' steps.
    const workerBSteps: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await kernel.claimNextStep({
        workerId: 'worker-B',
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: ['tool'],
      });
      if (!c) break;
      assert.equal(c.kind, 'tool', 'Worker-B must only claim tool-kind steps');
      workerBSteps.push(c.id);
    }
    assert.equal(workerBSteps.length, 2, 'Worker-B should claim exactly the 2 tool steps');

    // No mismatch: disjoint sets covering all 4 steps.
    const overlap = workerASteps.filter((id) => workerBSteps.includes(id));
    assert.equal(overlap.length, 0, 'No step should be claimed by both workers');
    assert.equal(
      workerASteps.length + workerBSteps.length,
      4,
      'All 4 steps should be claimed across the two capability-scoped workers',
    );
  });

  // ── 8. Burst handling: 30 steps across 3 workers with fair distribution ──
  it('distributes a burst of 30 steps fairly across 3 workers', async () => {
    const command = createRunCommand('tenant-burst', 30);
    await kernel.createRun(command, 'gateway');

    const claimsByWorker: KernelStep[][] = [[], [], []];

    // 10 rounds; each round every worker claims once (round-robin).
    for (let round = 0; round < 10; round++) {
      for (let w = 0; w < 3; w++) {
        const c = await kernel.claimNextStep({
          workerId: `worker-${w}`,
          leaseTtlMs: 30_000,
          tenantIds: [],
          capabilities: [],
        });
        if (c) claimsByWorker[w]!.push(c);
      }
    }

    const total = claimsByWorker.reduce((sum, list) => sum + list.length, 0);
    assert.equal(total, 30, 'All 30 steps should be claimed');

    // Fair distribution: each worker gets ~10 steps (±1 tolerance).
    for (let w = 0; w < 3; w++) {
      const count = claimsByWorker[w]!.length;
      assert.ok(
        count >= 9 && count <= 11,
        `Worker-${w} should get 9–11 steps for fairness, got ${count}`,
      );
    }

    // No duplicate claims.
    const allIds = claimsByWorker.flat().map((s) => s.id);
    assert.equal(new Set(allIds).size, 30, 'No step should be claimed twice');

    // Complete all claimed steps → run reaches SUCCEEDED.
    for (const list of claimsByWorker) {
      for (const s of list) {
        await kernel.completeStep({
          stepId: s.id,
          tenantId: s.tenantId,
          lease: s.lease!,
          expectedVersion: s.version,
          output: { status: 'success' },
          actor: s.lease!.workerId,
        });
      }
    }

    const run = await kernel.getRun(command.id, 'tenant-burst');
    assert.equal(run!.state, 'SUCCEEDED', 'Run should reach SUCCEEDED after all steps complete');
  });

  // ── 9. Sequential dependency chain: multi-worker handoff ──
  it('enforces sequential dependency order across multiple workers', async () => {
    const runId = randomUUID();
    const command = {
      id: runId,
      tenantId: 'tenant-seq',
      intentHash: createHash('sha256').update(runId).digest('hex'),
      workGraphHash: createHash('sha256').update(runId).digest('hex'),
      workGraphVersion: 'v1',
      policySnapshotId: 'test-policy',
      steps: [
        {
          id: `${runId}-step-0`,
          kind: 'agent',
          input: { goal: 'First', agentId: 'test-agent' },
          maxAttempts: 3,
          dependencies: [],
        },
        {
          id: `${runId}-step-1`,
          kind: 'agent',
          input: { goal: 'Second', agentId: 'test-agent' },
          maxAttempts: 3,
          dependencies: [`${runId}-step-0`],
        },
        {
          id: `${runId}-step-2`,
          kind: 'agent',
          input: { goal: 'Third', agentId: 'test-agent' },
          maxAttempts: 3,
          dependencies: [`${runId}-step-1`],
        },
      ],
    };
    await kernel.createRun(command, 'gateway');

    const claimOrder: string[] = [];

    // Worker-A claims step-0 (the only step whose dependencies are satisfied).
    const step0 = await kernel.claimNextStep({
      workerId: 'worker-A',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(step0, 'Worker-A should claim step-0');
    assert.equal(step0!.id, `${runId}-step-0`, 'First claimable step must be step-0');
    claimOrder.push(step0!.id);

    // While step-0 is RUNNING (not yet SUCCEEDED), step-1 must remain blocked.
    const blocked1 = await kernel.claimNextStep({
      workerId: 'worker-B',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(blocked1, null, 'step-1 must stay blocked until step-0 succeeds');

    // Worker-A completes step-0, unblocking step-1.
    await kernel.completeStep({
      stepId: step0!.id,
      tenantId: step0!.tenantId,
      lease: step0!.lease!,
      expectedVersion: step0!.version,
      output: { status: 'success' },
      actor: 'worker-A',
    });

    // Worker-B claims step-1 (dependency on step-0 now satisfied).
    const step1 = await kernel.claimNextStep({
      workerId: 'worker-B',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(step1, 'Worker-B should claim step-1');
    assert.equal(step1!.id, `${runId}-step-1`, 'Second claimable step must be step-1');
    claimOrder.push(step1!.id);

    // step-2 stays blocked until step-1 succeeds.
    const blocked2 = await kernel.claimNextStep({
      workerId: 'worker-A',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(blocked2, null, 'step-2 must stay blocked until step-1 succeeds');

    await kernel.completeStep({
      stepId: step1!.id,
      tenantId: step1!.tenantId,
      lease: step1!.lease!,
      expectedVersion: step1!.version,
      output: { status: 'success' },
      actor: 'worker-B',
    });

    // Worker-A claims step-2 (dependency on step-1 now satisfied).
    const step2 = await kernel.claimNextStep({
      workerId: 'worker-A',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(step2, 'Worker-A should claim step-2');
    assert.equal(step2!.id, `${runId}-step-2`, 'Third claimable step must be step-2');
    claimOrder.push(step2!.id);

    await kernel.completeStep({
      stepId: step2!.id,
      tenantId: step2!.tenantId,
      lease: step2!.lease!,
      expectedVersion: step2!.version,
      output: { status: 'success' },
      actor: 'worker-A',
    });

    // Step order was enforced: step-0 → step-1 → step-2.
    assert.deepEqual(
      claimOrder,
      [`${runId}-step-0`, `${runId}-step-1`, `${runId}-step-2`],
      'Steps must be claimed in dependency order',
    );

    const run = await kernel.getRun(runId, 'tenant-seq');
    assert.equal(run!.state, 'SUCCEEDED', 'Run should reach SUCCEEDED after the chain completes');
  });

  // ── 10. Mixed workload: concurrent tenants, dependencies, and worker types ──
  it('handles mixed workloads: concurrent tenants, dependencies, and worker types', async () => {
    // Run-1 (tenant-A): 2 sequential 'agent' steps.
    const runIdA = randomUUID();
    const cmdA = {
      id: runIdA,
      tenantId: 'tenant-A',
      intentHash: createHash('sha256').update(runIdA).digest('hex'),
      workGraphHash: createHash('sha256').update(runIdA).digest('hex'),
      workGraphVersion: 'v1',
      policySnapshotId: 'test-policy',
      steps: [
        {
          id: `${runIdA}-step-0`,
          kind: 'agent',
          input: { goal: 'A-1', agentId: 'test-agent' },
          maxAttempts: 3,
          dependencies: [],
        },
        {
          id: `${runIdA}-step-1`,
          kind: 'agent',
          input: { goal: 'A-2', agentId: 'test-agent' },
          maxAttempts: 3,
          dependencies: [`${runIdA}-step-0`],
        },
      ],
    };

    // Run-2 (tenant-B): 2 independent 'tool' steps.
    const runIdB = randomUUID();
    const cmdB = {
      id: runIdB,
      tenantId: 'tenant-B',
      intentHash: createHash('sha256').update(runIdB).digest('hex'),
      workGraphHash: createHash('sha256').update(runIdB).digest('hex'),
      workGraphVersion: 'v1',
      policySnapshotId: 'test-policy',
      steps: [
        {
          id: `${runIdB}-step-0`,
          kind: 'tool',
          input: { goal: 'B-1', agentId: 'test-agent' },
          maxAttempts: 3,
        },
        {
          id: `${runIdB}-step-1`,
          kind: 'tool',
          input: { goal: 'B-2', agentId: 'test-agent' },
          maxAttempts: 3,
        },
      ],
    };

    await kernel.createRun(cmdA, 'gateway');
    await kernel.createRun(cmdB, 'gateway');

    // Worker-1: agent capability, scoped to tenant-A.
    // Worker-2: tool capability, scoped to tenant-B.
    // Both process their tenants concurrently.
    const [w1, w2] = await Promise.all([
      drainTenant(kernel, 'worker-1', ['tenant-A'], ['agent']),
      drainTenant(kernel, 'worker-2', ['tenant-B'], ['tool']),
    ]);

    // Both runs complete successfully.
    assert.equal(w1.stepIds.length, 2, 'Worker-1 should complete 2 sequential agent steps');
    assert.equal(w2.stepIds.length, 2, 'Worker-2 should complete 2 independent tool steps');

    for (const k of w1.kinds) {
      assert.equal(k, 'agent', 'Worker-1 must only process agent-kind steps');
    }
    for (const k of w2.kinds) {
      assert.equal(k, 'tool', 'Worker-2 must only process tool-kind steps');
    }

    // Cross-tenant isolation: worker-1 never sees tenant-B and vice versa.
    for (const t of w1.tenants) {
      assert.equal(t, 'tenant-A', 'Worker-1 must never see tenant-B steps');
    }
    for (const t of w2.tenants) {
      assert.equal(t, 'tenant-B', 'Worker-2 must never see tenant-A steps');
    }

    const overlap = w1.stepIds.filter((id) => w2.stepIds.includes(id));
    assert.equal(overlap.length, 0, 'No step should be claimed by both workers');

    const runA = await kernel.getRun(runIdA, 'tenant-A');
    const runB = await kernel.getRun(runIdB, 'tenant-B');
    assert.equal(runA!.state, 'SUCCEEDED', 'Run-1 (tenant-A) should succeed');
    assert.equal(runB!.state, 'SUCCEEDED', 'Run-2 (tenant-B) should succeed');
  });
});
