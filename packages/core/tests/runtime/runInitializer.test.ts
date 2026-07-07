import { describe, it, expect, vi } from 'vitest';
import { RunInitializer } from '../../src/runtime/runInitializer';
import { runWithTenant } from '../../src/runtime/tenantContext';
import type { AgentExecutionContext } from '../../src/runtime/types';

vi.mock('../../src/runtime/intentLog', () => ({
  getIntentLog: vi.fn(() => ({ write: vi.fn() })),
}));

vi.mock('../../src/runtime/tenantProvider', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('../../src/runtime/tenantProvider');
  return {
    ...original,
    getGlobalTenantProvider: vi.fn(() => ({
      getCurrentTenantId: vi.fn(() => undefined),
      getTenantConfig: vi.fn(() => undefined),
      getKnownTenants: vi.fn(() => []),
      validateWorkspacePath: vi.fn(() => true),
    })),
  };
});

describe('RunInitializer', () => {
  const makeDeps = () => {
    const concurrencyController = { acquireSlot: vi.fn(), releaseSlot: vi.fn() };
    const tenantProvider = { getTenantConfig: vi.fn(() => undefined) };
    const tenantManager = { releaseTenantConcurrency: vi.fn() };
    const laneManager = {
      acquireSlot: vi.fn(async () => 'lane-1'),
      releaseSlot: vi.fn(),
    };
    const runLifecycle = {
      addRun: vi.fn(),
      getActiveRuns: vi.fn(() => []),
      getActiveRunCount: vi.fn(() => 1),
      removeRun: vi.fn(),
    };
    const freezeDryManager = { setActiveRuns: vi.fn() };
    const tracer = { startRun: vi.fn(), completeRun: vi.fn(), recordDecision: vi.fn() };
    const executionScheduler = {
      beginRun: vi.fn(() => ({ runId: 'r1', endRun: vi.fn() })),
    };

    return {
      getConfig: () => ({ maxRetries: 2 }) as any,
      getConcurrencyController: () => concurrencyController,
      getTenantProvider: () => tenantProvider,
      getTenantManager: () => tenantManager,
      getLaneManager: () => laneManager,
      getRunLifecycle: () => runLifecycle,
      getFreezeDryManager: () => freezeDryManager,
      getTracer: () => tracer,
      getExecutionScheduler: () => executionScheduler,
    };
  };

  const ctx: AgentExecutionContext = {
    agentId: 'a1',
    missionId: 'm1',
    goal: 'test goal',
    availableTools: [],
  } as any;

  it('initializes a run and returns required fields', async () => {
    const deps = makeDeps();
    const init = new RunInitializer(deps as any);
    const result = await runWithTenant('test-tenant', () => init.initialize(ctx));

    expect(result.runId).toBeDefined();
    expect(result.currentLane).toBe('lane-1');
    expect(result.startTime).toBeGreaterThan(0);
    expect(result.circuitReleased).toBe(false);
    expect(deps.getConcurrencyController().acquireSlot).toHaveBeenCalled();
    expect(deps.getExecutionScheduler().beginRun).toHaveBeenCalled();
  });

  it('toErrorResult returns a failed result shape', () => {
    const init = new RunInitializer(makeDeps() as any);
    const result = init.toErrorResult(ctx, new Error('boom'));
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
  });
});
