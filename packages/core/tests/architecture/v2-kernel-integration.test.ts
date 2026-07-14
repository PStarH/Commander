/**
 * V2 Kernel Integration Tests — Architecture V2 full-path integration.
 *
 * These tests prove the complete execution path works end-to-end:
 *   Gateway → Kernel (createRun) → Worker (claimNextStep) → Executor → Kernel (completeStep) → Run SUCCEEDED
 *
 * Uses InMemoryKernelRepository (test-only) to avoid Postgres dependency.
 * The executor is a mock that simulates AgentRuntime.execute().
 *
 * These tests are CI-blocking architecture invariants: they prove the V2
 * shared execution kernel can orchestrate a run from submission to completion
 * without any process-local AgentRuntime state in the Gateway.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

// Kernel imports (test-only in-memory repository)
import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import type { KernelRepository } from '../../../kernel/src/repository.js';
import type { KernelRun, KernelStep, KernelEvent } from '../../../kernel/src/types.js';

// Worker-plane types (structural — no package import needed)
interface ClaimedStep {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  version: number;
  attempt: number;
  input: Record<string, unknown>;
  lease: { workerId: string; token: string; fencingEpoch: number; expiresAt: string };
}

interface StepExecutor {
  execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: { id: string; kind: string; capabilities: string[] } },
  ): Promise<Record<string, unknown> | undefined>;
}

/**
 * Mock executor that simulates AgentRuntime.execute().
 * Records all executions and returns configurable results.
 */
class MockStepExecutor implements StepExecutor {
  readonly executions: ClaimedStep[] = [];
  private results = new Map<string, Record<string, unknown>>();
  private failureMode: { match?: (step: ClaimedStep) => boolean; error: Error } | null = null;
  private delayMs = 0;

  setResult(stepKind: string, output: Record<string, unknown>): void {
    this.results.set(stepKind, output);
  }

  setFailure(match: (step: ClaimedStep) => boolean, error: Error): void {
    this.failureMode = { match, error };
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  async execute(
    step: ClaimedStep,
    _context: { signal: AbortSignal; worker: { id: string; kind: string; capabilities: string[] } },
  ): Promise<Record<string, unknown> | undefined> {
    this.executions.push(step);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failureMode?.match?.(step)) throw this.failureMode.error;
    return (
      this.results.get(step.kind) ?? {
        status: 'success',
        summary: `Executed ${step.kind}`,
        runId: step.runId,
      }
    );
  }
}

/**
 * Minimal WorkerService simulation for integration testing.
 * Mirrors the real WorkerService.execute() lifecycle without the registration/heartbeat overhead.
 */
async function executeStep(
  kernel: KernelRepository,
  workerId: string,
  executor: StepExecutor,
  leaseTtlMs = 30_000,
): Promise<{
  step: ClaimedStep | null;
  completed: boolean;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}> {
  const claimed = await kernel.claimNextStep({
    workerId,
    leaseTtlMs,
    tenantIds: [],
    capabilities: [],
  });
  if (!claimed) return { step: null, completed: false };

  const step: ClaimedStep = {
    id: claimed.id,
    runId: claimed.runId,
    tenantId: claimed.tenantId,
    kind: claimed.kind,
    version: claimed.version,
    attempt: claimed.attempt,
    input: claimed.input,
    lease: claimed.lease!,
  };

  const controller = new AbortController();
  try {
    const output = await executor.execute(step, {
      signal: controller.signal,
      worker: { id: workerId, kind: 'agent', capabilities: [] },
    });
    await kernel.completeStep({
      stepId: step.id,
      tenantId: step.tenantId,
      lease: step.lease,
      expectedVersion: step.version,
      output,
      actor: workerId,
    });
    return { step, completed: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = message.includes('timeout') || message.includes('temporary');
    await kernel.failStep({
      stepId: step.id,
      tenantId: step.tenantId,
      lease: step.lease,
      expectedVersion: step.version,
      error: { code: 'EXECUTOR_FAILED', message, retryable },
      actor: workerId,
    });
    return { step, completed: false, error: { code: 'EXECUTOR_FAILED', message, retryable } };
  }
}

// Helper to create a run with steps
function createRunCommand(
  tenantId: string,
  steps: Array<{
    kind: string;
    input?: Record<string, unknown>;
    dependencies?: string[];
    maxAttempts?: number;
  }>,
) {
  const runId = randomUUID();
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    input: s.input ?? { goal: `Execute ${s.kind}`, agentId: 'test-agent' },
    dependencies: s.dependencies,
    maxAttempts: s.maxAttempts,
  }));
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(JSON.stringify(stepDefs)).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'test-policy',
    steps: stepDefs,
  };
}

describe('V2 Kernel Integration — Full Execution Path', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-test';
  const workerId = 'worker-1';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('should complete a single-step run from submission to SUCCEEDED', async () => {
    // 1. Gateway submits run to kernel
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Say hello', agentId: 'greeter' } },
    ]);
    const run = await kernel.createRun(command, 'gateway');
    assert.equal(run.state, 'PENDING');

    // 2. Worker claims the step
    const executor = new MockStepExecutor();
    executor.setResult('agent', { status: 'success', summary: 'Said hello', runId: run.id });

    const result = await executeStep(kernel, workerId, executor);

    // 3. Step should be completed
    assert.ok(result.step, 'Should have claimed a step');
    assert.equal(result.completed, true);
    assert.equal(result.step!.kind, 'agent');

    // 4. Run should be SUCCEEDED
    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'SUCCEEDED');

    // 5. Events should be recorded
    const events = await kernel.listEvents(run.id, tenantId);
    const eventTypes = events.map((e: KernelEvent) => e.type);
    assert.ok(eventTypes.includes('run.created'), 'Should have run.created event');
    assert.ok(eventTypes.includes('step.claimed'), 'Should have step.claimed event');
    assert.ok(eventTypes.includes('step.succeeded'), 'Should have step.succeeded event');
    assert.ok(eventTypes.includes('run.succeeded'), 'Should have run.succeeded event');
  });

  it('should execute multi-step run with dependencies in correct order', async () => {
    const stepAId = 'step-a';
    const stepBId = 'step-b';
    const stepCId = 'step-c';

    const command = createRunCommand(tenantId, [
      { kind: 'research', input: { goal: 'Research topic', agentId: 'researcher' } },
      { kind: 'code', input: { goal: 'Write code', agentId: 'coder' }, dependencies: [stepAId] },
      {
        kind: 'review',
        input: { goal: 'Review code', agentId: 'reviewer' },
        dependencies: [stepBId],
      },
    ]);
    // Override step IDs for dependency tracking
    command.steps[0].id = stepAId;
    command.steps[1].id = stepBId;
    command.steps[1].dependencies = [stepAId];
    command.steps[2].id = stepCId;
    command.steps[2].dependencies = [stepBId];

    const run = await kernel.createRun(command, 'gateway');

    const executor = new MockStepExecutor();
    executor.setResult('research', { status: 'success', summary: 'Research done', runId: run.id });
    executor.setResult('code', { status: 'success', summary: 'Code written', runId: run.id });
    executor.setResult('review', { status: 'success', summary: 'Review passed', runId: run.id });

    const executionOrder: string[] = [];

    // Execute steps one by one (simulating sequential worker)
    for (let i = 0; i < 3; i++) {
      const result = await executeStep(kernel, workerId, executor);
      if (result.step) executionOrder.push(result.step.kind);
    }

    // Verify execution order respects dependencies
    assert.equal(executionOrder[0], 'research', 'Research should execute first');
    assert.equal(executionOrder[1], 'code', 'Code should execute second (after research)');
    assert.equal(executionOrder[2], 'review', 'Review should execute last (after code)');

    // Verify run is SUCCEEDED
    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'SUCCEEDED');
  });

  it('should fail run when a step fails terminally', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Fail this', agentId: 'failer' }, maxAttempts: 1 },
    ]);
    const run = await kernel.createRun(command, 'gateway');

    const executor = new MockStepExecutor();
    executor.setFailure(() => true, new Error('Agent execution failed permanently'));

    const result = await executeStep(kernel, workerId, executor);

    assert.equal(result.completed, false);
    assert.ok(result.error);

    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'FAILED');

    const events = await kernel.listEvents(run.id, tenantId);
    const eventTypes = events.map((e: KernelEvent) => e.type);
    assert.ok(eventTypes.includes('step.failed'), 'Should have step.failed event');
    assert.ok(eventTypes.includes('run.failed'), 'Should have run.failed event');
  });

  it('should handle concurrent workers claiming the same step (exactly-once claim)', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Concurrent test', agentId: 'agent' } },
    ]);
    const run = await kernel.createRun(command, 'gateway');

    const executor = new MockStepExecutor();

    // Two workers try to claim simultaneously
    const [result1, result2] = await Promise.all([
      executeStep(kernel, 'worker-A', executor),
      executeStep(kernel, 'worker-B', executor),
    ]);

    // Exactly one should have claimed and completed the step
    const claimed = [result1, result2].filter((r) => r.step !== null);
    assert.equal(claimed.length, 1, 'Exactly one worker should claim the step');

    // The claiming worker should have completed it
    assert.equal(claimed[0].completed, true);

    // Run should be SUCCEEDED
    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'SUCCEEDED');

    // Executor should have been called exactly once
    assert.equal(executor.executions.length, 1, 'Executor should run exactly once');
  });

  it('should enforce tenant concurrency limits', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Task 1', agentId: 'agent' } },
      { kind: 'agent', input: { goal: 'Task 2', agentId: 'agent' } },
      { kind: 'agent', input: { goal: 'Task 3', agentId: 'agent' } },
    ]);
    const run = await kernel.createRun(command, 'gateway');

    // Set concurrency limit to 2
    await kernel.setTenantConcurrencyLimit(tenantId, 2);

    const executor = new MockStepExecutor();
    executor.setDelay(50); // Small delay to keep steps running

    // Claim 3 steps concurrently
    const results = await Promise.all([
      executeStep(kernel, 'worker-1', executor),
      executeStep(kernel, 'worker-2', executor),
      executeStep(kernel, 'worker-3', executor),
    ]);

    // With concurrency limit 2, at least one should not be claimed
    const claimed = results.filter((r) => r.step !== null);
    assert.ok(claimed.length <= 2, 'Should not exceed tenant concurrency limit');
  });

  it('should support tenant isolation — worker cannot see other tenant steps', async () => {
    const tenantA = 'tenant-A';
    const tenantB = 'tenant-B';

    const commandA = createRunCommand(tenantA, [
      { kind: 'agent', input: { goal: 'Tenant A task', agentId: 'agent' } },
    ]);
    const commandB = createRunCommand(tenantB, [
      { kind: 'agent', input: { goal: 'Tenant B task', agentId: 'agent' } },
    ]);

    await kernel.createRun(commandA, 'gateway');
    await kernel.createRun(commandB, 'gateway');

    // Worker scoped to tenant A should only see tenant A steps
    const claimed = await kernel.claimNextStep({
      workerId,
      leaseTtlMs: 30_000,
      tenantIds: [tenantA],
      capabilities: [],
    });

    assert.ok(claimed, 'Should claim a step');
    assert.equal(claimed!.tenantId, tenantA, 'Claimed step should belong to tenant A');

    // Get run from tenant B should return null for tenant A request
    const crossTenantRun = await kernel.getRun(commandB.id, tenantA);
    assert.equal(crossTenantRun, null, 'Tenant A should not see tenant B runs');
  });
});
