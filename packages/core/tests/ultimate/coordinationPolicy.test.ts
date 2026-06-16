import { describe, expect, it } from 'vitest';
import { evaluateCoordinationPolicy } from '../../src/ultimate/coordinationPolicy';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import type { DeliberationPlan, TaskDAGEdge, TaskDAGNode } from '../../src/ultimate/types';

function plan(overrides: Partial<DeliberationPlan> = {}): DeliberationPlan {
  return {
    requiresExternalInfo: false,
    taskType: 'FACTUAL',
    recommendedTopology: 'SINGLE',
    estimatedAgentCount: 1,
    estimatedSteps: 3,
    estimatedTokens: 1000,
    estimatedDurationMs: 5000,
    tokenBudget: { thinking: 256, execution: 512, synthesis: 256 },
    decompositionStrategy: 'NONE',
    capabilitiesNeeded: ['reasoning'],
    confidence: 0.9,
    reasoning: [],
    suitableForSpeculation: false,
    taskNature: 'MIXED',
    timeBudgetPerAgentMs: 5000,
    ...overrides,
  };
}

function node(id: string): TaskDAGNode {
  return {
    id,
    label: id,
    estimatedComplexity: 3,
    estimatedTokens: 1000,
    requiredCapabilities: ['search'],
    atomic: true,
  };
}

describe('evaluateCoordinationPolicy', () => {
  it('keeps simple local tasks single-agent even if a multi-agent topology is proposed', () => {
    const decision = evaluateCoordinationPolicy(plan(), 'PARALLEL');

    expect(decision.negativeRoi).toBe(true);
    expect(decision.fallbackTopology).toBe('SINGLE');
    expect(decision.mode).toBe('single');
    expect(decision.reasons.join(' ')).toContain('Low-token local task');
  });

  it('accepts specialist swarm for independent breadth-first research', () => {
    const router = new TopologyRouter();
    const nodes = ['a', 'b', 'c', 'd', 'e'].map(node);
    const dag = router.buildDAG(nodes, []);
    const decision = evaluateCoordinationPolicy(plan({
      requiresExternalInfo: true,
      taskType: 'RESEARCH',
      estimatedAgentCount: 5,
      estimatedTokens: 30000,
      taskNature: 'IO_BOUND',
      suitableForSpeculation: true,
      capabilitiesNeeded: ['web_search', 'reasoning'],
    }), 'PARALLEL', dag);

    expect(decision.negativeRoi).toBe(false);
    expect(decision.pattern).toBe('SPECIALIST_SWARM');
    expect(decision.mode).toBe('swarm');
    expect(decision.gain.netRoi).toBeGreaterThan(0.05);
  });

  it('marks tightly coupled work as negative ROI and falls back to sequential', () => {
    const router = new TopologyRouter();
    const nodes = ['a', 'b', 'c'].map(node);
    const edges: TaskDAGEdge[] = [
      { from: 'a', to: 'b', type: 'SEQUENTIAL', dataDependency: true },
      { from: 'b', to: 'c', type: 'SEQUENTIAL', dataDependency: true },
    ];
    const dag = router.buildDAG(nodes, edges);
    const decision = evaluateCoordinationPolicy(plan({
      taskType: 'CODING',
      estimatedAgentCount: 3,
      estimatedTokens: 6000,
      capabilitiesNeeded: ['code_understanding', 'reasoning'],
    }), 'PARALLEL', dag);

    expect(decision.negativeRoi).toBe(true);
    expect(decision.fallbackTopology).toBe('SEQUENTIAL');
    expect(decision.overhead.coordinationChannels).toBe(3);
  });

  it('exposes coordination ROI from topology routing', () => {
    const result = new TopologyRouter().route(plan({
      taskType: 'RESEARCH',
      requiresExternalInfo: true,
      estimatedAgentCount: 6,
      estimatedTokens: 20000,
      taskNature: 'IO_BOUND',
    }));

    expect(result.coordination).toBeDefined();
    expect(result.reasoning.some(line => line.includes('Coordination ROI'))).toBe(true);
  });
});
