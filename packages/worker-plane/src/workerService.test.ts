import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resetControlPlane } from '@commander/core';
import { InMemoryWorkerRegistry } from './registry.js';
import { WorkerService } from './workerService.js';
import { WorkerExecutionError } from './types.js';
import type { ClaimedStep, KernelWorkerPort, WorkerLease } from './types.js';
import { getStepWorkloadBinding } from './stepWorkloadIdentity.js';

const identity = {
  subject: 'spiffe://commander/worker/agent-1',
  token: 'test-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const definition = {
  id: 'agent-1',
  kind: 'agent' as const,
  version: 'v1',
  capabilities: ['agent'],
  maxConcurrency: 2,
};
const auth = { authenticate: async () => ({ tenantIds: ['tenant-a'], capabilities: ['agent'] }) };

class FakeKernel implements KernelWorkerPort {
  lastClaimGeneration: number | undefined;
  lastFailureCode: string | undefined;
  private readonly steps: Array<
    ClaimedStep & { state: 'PENDING' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCEEDED'; maxAttempts: number }
  > = [];
  private readonly runs = new Map<string, { tenantId: string; state: 'PENDING' | 'SUCCEEDED' }>();
  private readonly limits = new Map<string, number>();
  addRun(id: string, tenantId: string, definitions: Array<{ id: string; kind: string }>): void {
    this.runs.set(id, { tenantId, state: 'PENDING' });
    for (const definition of definitions)
      this.steps.push({
        ...definition,
        runId: id,
        tenantId,
        version: 1,
        attempt: 0,
        input: {},
        state: 'PENDING',
        maxAttempts: 2,
        lease: { workerId: '', token: '', fencingEpoch: 0, expiresAt: '' },
      });
  }
  setLimit(tenantId: string, value: number): void {
    this.limits.set(tenantId, value);
  }
  async claimNextStep(request: {
    workerId: string;
    workerGeneration?: number;
    leaseTtlMs: number;
    tenantIds: string[];
    capabilities: string[];
  }): Promise<ClaimedStep | null> {
    this.lastClaimGeneration = request.workerGeneration;
    const step = this.steps.find(
      (candidate) =>
        ['PENDING', 'RETRY_WAIT'].includes(candidate.state) &&
        (request.tenantIds.length === 0 || request.tenantIds.includes(candidate.tenantId)) &&
        request.capabilities.includes(candidate.kind) &&
        this.steps.filter(
          (other) => other.tenantId === candidate.tenantId && other.state === 'RUNNING',
        ).length < (this.limits.get(candidate.tenantId) ?? Number.MAX_SAFE_INTEGER),
    );
    if (!step) return null;
    step.state = 'RUNNING';
    step.version++;
    step.attempt++;
    step.lease = {
      workerId: request.workerId,
      workerGeneration: request.workerGeneration ?? 0,
      token: `lease-${step.id}`,
      fencingEpoch: step.lease.fencingEpoch + 1,
      expiresAt: new Date(Date.now() + request.leaseTtlMs).toISOString(),
    };
    return structuredClone(step);
  }
  async heartbeatStep(
    _stepId: string,
    _tenantId: string,
    _lease: WorkerLease,
    _leaseTtlMs: number,
  ): Promise<unknown | null> {
    return {};
  }
  async completeStep(request: {
    stepId: string;
    tenantId: string;
    lease: WorkerLease;
    expectedVersion: number;
  }): Promise<unknown | null> {
    const step = this.steps.find((candidate) => candidate.id === request.stepId);
    if (
      !step ||
      step.state !== 'RUNNING' ||
      step.version !== request.expectedVersion ||
      step.lease.token !== request.lease.token
    )
      return null;
    step.state = 'SUCCEEDED';
    const all = this.steps.filter((candidate) => candidate.runId === step.runId);
    if (all.every((candidate) => candidate.state === 'SUCCEEDED'))
      this.runs.get(step.runId)!.state = 'SUCCEEDED';
    return {};
  }
  async failStep(request: {
    stepId: string;
    tenantId: string;
    lease: WorkerLease;
    expectedVersion: number;
    error: { retryable: boolean; code?: string };
    retryAt?: Date;
  }): Promise<unknown | null> {
    const step = this.steps.find((candidate) => candidate.id === request.stepId);
    if (
      !step ||
      step.state !== 'RUNNING' ||
      step.version !== request.expectedVersion ||
      step.lease.token !== request.lease.token
    )
      return null;
    this.lastFailureCode = request.error.code;
    step.state = request.error.retryable && request.retryAt ? 'RETRY_WAIT' : 'PENDING';
    return {};
  }
  getRun(id: string): { state: string } | undefined {
    return this.runs.get(id);
  }
  getStep(id: string): { state: string } | undefined {
    return this.steps.find((step) => step.id === id);
  }
}

describe('worker plane', () => {
  it('wraps each claimed step with step-scoped workload identity ALS', async () => {
    resetControlPlane();
    const kernel = new FakeKernel();
    kernel.addRun('run-wrapped', 'tenant-a', [{ id: 'wrapped-step', kind: 'agent' }]);
    let seenBinding: ReturnType<typeof getStepWorkloadBinding>;
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async (step) => {
          seenBinding = getStepWorkloadBinding();
          assert.ok(seenBinding);
          assert.equal(seenBinding.tenantId, step.tenantId);
          assert.equal(seenBinding.runId, step.runId);
          assert.equal(seenBinding.stepId, step.id);
          return { ok: true };
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );
    await service.start();
    assert.equal(await service.pollOnce(), true);
    await service.waitForIdle();
    assert.ok(seenBinding);
    assert.equal(getStepWorkloadBinding(), undefined);
    await service.stop();
  });

  it('authenticates, registers, claims only authorized work, and completes through the kernel', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-a', 'tenant-a', [{ id: 'agent-step', kind: 'agent' }]);
    kernel.addRun('run-b', 'tenant-b', [{ id: 'tool-step', kind: 'tool' }]);
    const registry = new InMemoryWorkerRegistry();
    const service = new WorkerService(
      definition,
      identity,
      auth,
      registry,
      kernel,
      { execute: async () => ({ completed: true }) },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );
    await service.start();
    assert.equal(await service.pollOnce(), true);
    assert.equal(kernel.lastClaimGeneration, 1);
    await service.waitForIdle();
    assert.equal(kernel.getRun('run-a')?.state, 'SUCCEEDED');
    assert.equal(kernel.getRun('run-b')?.state, 'PENDING');
    assert.equal((await registry.get('agent-1'))?.identitySubject, identity.subject);
    await service.stop();
  });

  it('enforces the shared tenant concurrency limit before local worker capacity', async () => {
    const kernel = new FakeKernel();
    kernel.setLimit('tenant-a', 1);
    kernel.addRun('run-a', 'tenant-a', [
      { id: 'a-1', kind: 'agent' },
      { id: 'a-2', kind: 'agent' },
    ]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          await blocked;
          return {};
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );
    await service.start();
    assert.equal(await service.pollOnce(), true);
    assert.equal(await service.pollOnce(), false);
    release();
    await service.waitForIdle();
    assert.equal(await service.pollOnce(), true);
    await service.waitForIdle();
    await service.stop();
  });

  it('rejects unapproved capability declarations and preserves executor retry intent', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-a', 'tenant-a', [{ id: 'agent-step', kind: 'agent' }]);
    const denied = new WorkerService(
      { ...definition, capabilities: ['agent', 'tool'] },
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      { execute: async () => ({}) },
    );
    await assert.rejects(denied.start(), /not authorized/);

    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          throw new WorkerExecutionError('provider timeout', {
            code: 'PROVIDER_TIMEOUT',
            retryable: true,
            retryDelayMs: 1,
          });
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );
    await service.start();
    await service.pollOnce();
    await service.waitForIdle();
    assert.equal(kernel.getStep('agent-step')?.state, 'RETRY_WAIT');
    await service.stop();
  });

  it('refuses to initialize the registry when sandbox readiness fails', async () => {
    const kernel = new FakeKernel();
    const registry = new InMemoryWorkerRegistry();
    let initialized = false;
    const initialize = registry.initialize.bind(registry);
    registry.initialize = async () => {
      initialized = true;
      await initialize();
    };
    const service = new WorkerService(
      definition,
      identity,
      auth,
      registry,
      kernel,
      { execute: async () => ({}) },
      {
        sandboxReadiness: {
          assertReady: async () => {
            throw new Error('SANDBOX_UNAVAILABLE: docker runtime is unavailable');
          },
        },
      },
    );

    await assert.rejects(service.start(), /SANDBOX_UNAVAILABLE/);
    assert.equal(initialized, false);
    assert.equal(service.record, null);
  });

  it('fails a claimed step with SANDBOX_UNAVAILABLE instead of completing it', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-sandbox', 'tenant-a', [{ id: 'sandbox-step', kind: 'agent' }]);
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          const error = new Error('required Docker workload could not start');
          error.name = 'SandboxInitializationError';
          throw error;
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );

    await service.start();
    assert.equal(await service.pollOnce(), true);
    await service.waitForIdle();
    assert.equal(kernel.lastFailureCode, 'SANDBOX_UNAVAILABLE');
    assert.notEqual(kernel.getStep('sandbox-step')?.state, 'SUCCEEDED');
    await service.stop();
  });

  it('maps sandbox errors wrapped by executors into WorkerExecutionError to SANDBOX_UNAVAILABLE', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-wrapped', 'tenant-a', [{ id: 'wrapped-step', kind: 'agent' }]);
    const sandboxCause = new Error('required Docker workload could not start');
    sandboxCause.name = 'SandboxInitializationError';
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          throw new WorkerExecutionError(
            'effect failed: sandbox probe error',
            { code: 'EFFECT_EXECUTION_FAILED', retryable: false },
            sandboxCause,
          );
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );

    await service.start();
    assert.equal(await service.pollOnce(), true);
    await service.waitForIdle();
    assert.equal(kernel.lastFailureCode, 'SANDBOX_UNAVAILABLE');
    assert.notEqual(kernel.getStep('wrapped-step')?.state, 'SUCCEEDED');
    await service.stop();
  });
});
