import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { TELOSOrchestrator } from '../../src/telos/telosOrchestrator';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { resetTokenSentinel } from '../../src/telos/tokenSentinel';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetMetaLearner } from '../../src/selfEvolution/metaLearner';

describe('TELOSOrchestrator', () => {
  let orchestrator: TELOSOrchestrator;
  let runtime: AgentRuntime;
  let provider: MockLLMProvider;

  function setupOrchestrator(maxRetries = 0): TELOSOrchestrator {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetMetaLearner();
    resetTokenSentinel();

    const router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries, timeoutMs: 5000 }, router);
    provider = new MockLLMProvider('test-openai', {
      defaultResponse: 'Completed the assigned task successfully.',
    });
    runtime.registerProvider('openai', provider);

    return new TELOSOrchestrator(runtime, {
      enableBudgetEnforcement: true,
      enableCostTracking: true,
    });
  }

  before(() => {
    orchestrator = setupOrchestrator();
  });

  describe('plan', () => {
    it('creates a plan for a simple task', () => {
      const plan = orchestrator.plan({
        projectId: 'test-project',
        agentId: 'agent-builder',
        goal: 'Write a simple function',
      });

      expect(plan.planId).toBeTruthy();
      expect(plan.mode).toBe('SEQUENTIAL');
      expect(plan.agentAssignments.length).toBe(1);
      expect(plan.slimContext.estimatedContextTokens).toBeGreaterThan(0);
    });

    it('selects CONSENSUS for critical risk tasks', () => {
      const plan = orchestrator.plan({
        projectId: 'test',
        agentId: 'agent',
        goal: 'A'.repeat(600),
        contextData: {
          governanceProfile: { riskLevel: 'CRITICAL' },
          availableTools: ['a', 'b', 'c', 'd', 'e', 'f'],
        },
      });

      expect(plan.mode).toBe('CONSENSUS');
      expect(plan.governance.requiresApproval).toBe(true);
    });

    it('selects appropriate mode for medium-high complexity', () => {
      const plan = orchestrator.plan({
        projectId: 'test',
        agentId: 'agent',
        goal: 'A'.repeat(300) + ' detailed analysis with multiple steps.',
        contextData: {
          governanceProfile: { riskLevel: 'HIGH' },
          availableTools: ['tool1', 'tool2', 'tool3', 'tool4'],
        },
      });

      expect(['MAGENTIC', 'HANDOFF', 'PARALLEL']).toContain(plan.mode);
    });

    it('includes reasoning in the plan', () => {
      const plan = orchestrator.plan({
        projectId: 'test',
        agentId: 'agent',
        goal: 'Test task',
      });

      expect(plan.reasoning.length).toBeGreaterThan(0);
    });

    it('builds context once', () => {
      const plan = orchestrator.plan({
        projectId: 'test',
        agentId: 'agent',
        goal: 'Test task',
      });

      expect(plan.slimContext.systemPrompt).toContain('agent');
      expect(plan.slimContext.systemPrompt).toContain('SEQUENTIAL');
      expect(plan.slimContext.goal).toBe('Test task');
    });
  });

  describe('preflight', () => {
    it('allows plans within budget', () => {
      const plan = orchestrator.plan({
        projectId: 'test',
        agentId: 'agent',
        goal: 'Simple task',
      });

      const check = orchestrator.preflight(plan.planId);
      expect(check.allowed).toBe(true);
    });

    it('rejects non-existent plans', () => {
      const check = orchestrator.preflight('no-such-plan');
      expect(check.allowed).toBe(false);
    });
  });

  describe('execute', () => {
    it('executes a plan successfully', async () => {
      const plan = orchestrator.plan({
        projectId: 'test',
        agentId: 'agent',
        goal: 'Analyze the system.',
      });

      const result = await orchestrator.execute(plan.planId);
      expect(result.status).toBe('success');
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.totalTokens).toBeGreaterThan(0);
    });

    it('returns results per agent', async () => {
      const plan = orchestrator.plan({
        projectId: 'test',
        agentId: 'agent',
        goal: 'Simple task',
        contextData: { governanceProfile: { riskLevel: 'LOW' } },
      });

      const result = await orchestrator.execute(plan.planId);
      expect(result.results[0].agentId).toBe('agent');
      expect(result.results[0].status).toBe('success');
    });
  });

  describe('planAndExecute', () => {
    it('plans and executes in one call', async () => {
      const result = await orchestrator.planAndExecute({
        projectId: 'test',
        agentId: 'agent',
        goal: 'Do something.',
      });

      expect(result.plan).toBeDefined();
      expect(result.plan.planId).toBeTruthy();
      expect(result.status).toBe('success');
      expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
    });
  });

  describe('plan management', () => {
    it('retrieves stored plans', () => {
      const plan = orchestrator.plan({ projectId: 'test', agentId: 'agent', goal: 'Task' });
      const retrieved = orchestrator.getPlan(plan.planId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.planId).toBe(plan.planId);
    });

    it('lists all active plans', () => {
      orchestrator.plan({ projectId: 'test', agentId: 'agent-1', goal: 'Task 1' });
      orchestrator.plan({ projectId: 'test', agentId: 'agent-2', goal: 'Task 2' });
      expect(orchestrator.listPlans().length).toBe(2);
    });
  });
});
