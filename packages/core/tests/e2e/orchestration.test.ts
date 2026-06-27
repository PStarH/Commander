/**
 * End-to-End Orchestration Test
 *
 * Exercises the full UltimateOrchestrator pipeline:
 *   DELIBERATION → EFFORT_SCALING → TOPOLOGY_ROUTING → DECOMPOSITION
 *   → TEAM_FORMATION → EXECUTION → SYNTHESIS
 *
 * All LLM calls are served by MockLLMProvider so the test is deterministic
 * and does not require network access or API keys.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UltimateOrchestrator } from '../../src/ultimate/orchestrator';
import { TELOSOrchestrator } from '../../src/telos/telosOrchestrator';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { resetArtifactSystem } from '../../src/ultimate/artifactSystem';
import { resetTeamManager } from '../../src/ultimate/agentTeamManager';
import { resetTokenSentinel } from '../../src/telos/tokenSentinel';
import { resetProviderPool } from '../../src/telos/providerPool';
import { resetWorkCoordinator } from '../../src/ultimate/workCoordinator';
import { resetExecutionScheduler } from '../../src/atr/scheduler';
import { resetLaneManager } from '../../src/sandbox/lane';
import { resetTokenBudgetManager } from '../../src/runtime/tokenGovernor';
import { resetCheckpointWriter } from '../../src/runtime/checkpointWriter';
import { resetMetricsCollector } from '../../src/runtime/metricsCollector';
import { resetSLOManager } from '../../src/observability/sloManager';
import { getModelRouter } from '../../src/runtime/modelRouter';
import { resetEnterpriseSecurityGateway } from '../../src/security/enterpriseSecurityGateway';
import { resetBillExplosionGuard } from '../../src/security/billExplosionGuard';
import { resetCostGuard } from '../../src/security/costGuard';
import { resetSecurityMonitor } from '../../src/security/securityMonitor';
import { resetGuardianAgent } from '../../src/security/guardianAgent';

describe('E2E: UltimateOrchestrator full pipeline', () => {
  function resetGlobals() {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    resetArtifactSystem();
    resetTeamManager();
    resetTokenSentinel();
    resetProviderPool();
    resetWorkCoordinator();
    resetExecutionScheduler();
    resetLaneManager();
    resetTokenBudgetManager();
    resetCheckpointWriter();
    resetMetricsCollector();
    resetSLOManager();
    resetEnterpriseSecurityGateway();
    resetBillExplosionGuard();
    resetCostGuard();
    resetSecurityMonitor();
    resetGuardianAgent();
  }

  function makeRuntime(): AgentRuntime {
    const router = new ModelRouter();
    const runtime = new AgentRuntime(
      {
        maxRetries: 1,
        timeoutMs: 10000,
        maxConcurrency: 64,
        budgetHardCapTokens: 200000,
      },
      router,
    );

    // UltimateOrchestrator looks for providers in this order.
    // Register a deterministic mock under the first slot.
    const mockProvider = new MockLLMProvider('openai', {
      defaultResponse:
        'I have analyzed the request and produced a concise, accurate result based on the available information.',
    });
    runtime.registerProvider('openai', mockProvider);

    // Ensure the router knows the provider is available.
    const modelRouter = getModelRouter();
    for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
      modelRouter.registerModel({
        id: `gpt-4o@${tier}`,
        provider: 'openai',
        tier,
        costPer1MInput: 1,
        costPer1MOutput: 3,
        capabilities: ['code', 'reasoning', 'analysis'],
        contextWindow: 128000,
        priority: 0,
      });
    }

    return runtime;
  }

  function makeOrchestrator(runtime: AgentRuntime): UltimateOrchestrator {
    const telos = new TELOSOrchestrator(runtime);
    return new UltimateOrchestrator(telos, runtime, {
      enableDeliberation: true,
      enableTeams: true,
      defaultBudget: { hardCapTokens: 200000, softCapTokens: 150000, costCapUsd: 5 },
      maxRecursiveDepth: 2,
      maxParallelSubAgents: 8,
    });
  }

  beforeEach(() => {
    resetGlobals();
  });

  it('runs the complete deliberation → execution → synthesis pipeline', async () => {
    const runtime = makeRuntime();
    const orchestrator = makeOrchestrator(runtime);

    const phases: string[] = [];
    const result = await orchestrator.execute({
      projectId: 'e2e-test-project',
      agentId: 'e2e-lead',
      goal: 'Implement a function that validates email addresses and returns structured error messages.',
      contextData: {
        governanceProfile: { riskLevel: 'LOW' },
        availableTools: [],
      },
      onProgress: (phase) => phases.push(phase),
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.synthesis).toBeTruthy();
    expect(result.synthesis.length).toBeGreaterThan(10);
    expect(result.reasoning.length).toBeGreaterThan(0);
    expect(result.metrics.subAgentsSpawned).toBeGreaterThanOrEqual(1);
    expect(result.executionTree.length).toBeGreaterThanOrEqual(1);

    // Pipeline phase progression
    const expectedPhases = [
      'INIT',
      'DELIBERATION',
      'EFFORT_SCALING',
      'TOPOLOGY_ROUTING',
      'DECOMPOSITION',
    ];
    for (const phase of expectedPhases) {
      expect(phases).toContain(phase);
    }
    expect(phases).toContain('EXECUTION');
    expect(phases.some((p) => p === 'SYNTHESIS' || p === 'COMPLETE')).toBe(true);
  }, 30000);

  it('supports explicit DISPATCH topology and executes subtasks in parallel', async () => {
    const runtime = makeRuntime();
    const orchestrator = makeOrchestrator(runtime);

    const result = await orchestrator.execute({
      projectId: 'e2e-test-project',
      agentId: 'e2e-lead',
      goal: 'Compare three approaches to caching HTTP responses and summarize trade-offs.',
      topology: 'DISPATCH',
      contextData: {
        governanceProfile: { riskLevel: 'LOW' },
        availableTools: [],
      },
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.metrics.topologyUsed).toBe('DISPATCH');
    expect(result.metrics.subAgentsSpawned).toBeGreaterThanOrEqual(2);
    expect(result.synthesis).toContain('trade');
  }, 30000);

  it('gracefully handles a trivial factual task with SINGLE topology', async () => {
    const runtime = makeRuntime();
    const orchestrator = makeOrchestrator(runtime);

    const result = await orchestrator.execute({
      projectId: 'e2e-test-project',
      agentId: 'e2e-lead',
      goal: 'What is 2 + 2?',
      topology: 'SINGLE',
      contextData: {
        governanceProfile: { riskLevel: 'LOW' },
      },
    });

    expect(['SUCCESS', 'PARTIAL']).toContain(result.status);
    expect(result.synthesis).toBeTruthy();
    expect(result.metrics.subAgentsSpawned).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('does not leak state between consecutive executions', async () => {
    const runtime = makeRuntime();
    const orchestrator = makeOrchestrator(runtime);

    const first = await orchestrator.execute({
      projectId: 'p1',
      agentId: 'a1',
      goal: 'Summarize the benefits of TypeScript.',
      topology: 'SINGLE',
      contextData: { governanceProfile: { riskLevel: 'LOW' } },
    });

    const second = await orchestrator.execute({
      projectId: 'p2',
      agentId: 'a2',
      goal: 'List three JavaScript array methods.',
      topology: 'SINGLE',
      contextData: { governanceProfile: { riskLevel: 'LOW' } },
    });

    expect(first.status).toBe('SUCCESS');
    expect(second.status).toBe('SUCCESS');
    expect(first.id).not.toBe(second.id);
    expect(orchestrator.listExecutions()).toHaveLength(0);
  }, 30000);
});
