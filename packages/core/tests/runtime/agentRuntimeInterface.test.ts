/**
 * AgentRuntimeInterface testability
 *
 * Verifies that the pipeline can be driven entirely by a fake runtime that
 * satisfies AgentRuntimeInterface, without touching the concrete AgentRuntime.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UltimateOrchestrator } from '../../src/ultimate/orchestrator';
import { TELOSOrchestrator } from '../../src/telos/telosOrchestrator';
import type { AgentRuntimeInterface } from '../../src/runtime';
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRuntimeConfig,
  LLMProvider,
  Tool,
} from '../../src/runtime/types';
import { resetArtifactSystem } from '../../src/ultimate/artifactSystem';
import { resetTeamManager } from '../../src/ultimate/agentTeamManager';
import { resetTokenSentinel } from '../../src/telos/tokenSentinel';
import { resetProviderPool } from '../../src/telos/providerPool';
import { resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';

function makeFakeRuntime(): AgentRuntimeInterface {
  return {
    execute: vi.fn(async (ctx: AgentExecutionContext): Promise<AgentExecutionResult> => {
      const summary = `Fake runtime processed: ${ctx.goal.slice(0, 80)}`;
      return {
        runId: `fake-run-${Date.now()}`,
        agentId: ctx.agentId,
        missionId: ctx.missionId,
        status: 'success',
        summary,
        steps: [
          {
            stepNumber: 1,
            timestamp: new Date().toISOString(),
            type: 'response',
            content: summary,
            durationMs: 1,
          },
        ],
        totalTokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        totalDurationMs: 2,
      };
    }),
    registerProvider: vi.fn(),
    registerTool: vi.fn(),
    getProvider: vi.fn().mockReturnValue({ name: 'fake', call: vi.fn() } as unknown as LLMProvider),
    getSmartRouter: vi.fn().mockReturnValue(null),
    getTool: vi.fn().mockReturnValue(undefined),
    getConfig: vi.fn().mockReturnValue({} as AgentRuntimeConfig),
    getMemoryStore: vi.fn().mockReturnValue(null),
    getCheckpointer: vi.fn(),
    getInbox: vi.fn(),
    getTeamRegistry: vi.fn(),
    getHandoff: vi.fn(),
    getExecutionScheduler: vi.fn(),
    getCompensationRegistry: vi.fn().mockReturnValue({
      compensateAll: vi.fn().mockResolvedValue({ errors: [] }),
    }),
    getReliabilityEngine: vi.fn().mockReturnValue({
      getStats: vi.fn().mockReturnValue({
        circuit: { state: 'CLOSED', failureCount: 0 },
        dlq: [],
        compensation: { pending: 0, compensated: 0 },
        checkpointCount: 0,
      }),
    }),
    cancelAllSteps: vi.fn().mockReturnValue(0),
    getStepTimeoutManager: vi.fn(),
    listUnfinishedRuns: vi.fn().mockReturnValue([]),
    resume: vi.fn().mockResolvedValue(null),
    listResumableRuns: vi.fn().mockReturnValue([]),
    pauseRun: vi.fn().mockReturnValue(true),
    unpauseRun: vi.fn(),
    isPaused: vi.fn().mockReturnValue(false),
    getActiveRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRunActive: vi.fn().mockReturnValue(false),
    getSemanticCacheStats: vi.fn().mockReturnValue({ totalEntries: 0, estimatedCostSavedUsd: 0 }),
    getSingleFlightStats: vi.fn().mockReturnValue({ hitCount: 0, missCount: 0, savedMs: 0 }),
    getGeminiCacheStats: vi.fn().mockReturnValue({ entryCount: 0, estimatedSavingsUsd: 0 }),
    getCostEstimatorHistory: vi.fn().mockReturnValue([]),
    getProviderHealth: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
  } as unknown as AgentRuntimeInterface;
}

describe('AgentRuntimeInterface testability', () => {
  beforeEach(() => {
    resetArtifactSystem();
    resetTeamManager();
    resetTokenSentinel();
    resetProviderPool();
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
  });

  it('TELOSOrchestrator accepts a fake runtime and executes a plan', async () => {
    const fake = makeFakeRuntime();
    const telos = new TELOSOrchestrator(fake);

    const plan = telos.plan({
      projectId: 'interface-test',
      agentId: 'agent-1',
      goal: 'Simple task',
    });

    expect(plan.planId).toBeTruthy();

    const preflight = telos.preflight(plan.planId);
    expect(preflight.allowed).toBe(true);

    const result = await telos.execute(plan.planId);
    expect(result.status).toBe('success');
    expect(fake.execute).toHaveBeenCalled();
  });

  it('UltimateOrchestrator accepts a fake runtime and runs the full pipeline', async () => {
    const fake = makeFakeRuntime();
    const telos = new TELOSOrchestrator(fake);
    const orchestrator = new UltimateOrchestrator(telos, fake, {
      enableDeliberation: false,
      enableTeams: false,
      defaultBudget: { hardCapTokens: 50000, softCapTokens: 30000, costCapUsd: 1 },
      maxRecursiveDepth: 1,
      maxParallelSubAgents: 4,
    });

    const result = await orchestrator.execute({
      projectId: 'interface-test',
      agentId: 'agent-1',
      goal: 'Implement a small function and verify it works.',
      topology: 'SINGLE',
      contextData: { governanceProfile: { riskLevel: 'LOW' } },
    });

    expect(['SUCCESS', 'PARTIAL']).toContain(result.status);
    expect(fake.execute).toHaveBeenCalled();
    expect(result.synthesis).toBeTruthy();
  }, 30000);

  it('UltimateOrchestrator pipeline does not import the concrete AgentRuntime class', () => {
    // This test documents the intent: consumers depend only on the interface.
    // TypeScript enforces it at compile time because UltimateOrchestrator's
    // constructor requires AgentRuntimeInterface.
    const fake = makeFakeRuntime();
    const telos = new TELOSOrchestrator(fake);
    expect(() => new UltimateOrchestrator(telos, fake)).not.toThrow();
  });
});
