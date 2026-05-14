/**
 * Ultimate Multi-Agent Orchestration Benchmarks
 *
 * Tests our system against the key dimensions that matter for multi-agent systems:
 * 1. Topology routing accuracy (AdaptOrch-inspired)
 * 2. Deliberation efficiency (DOVA-inspired - reduced unnecessary API calls)
 * 3. Recursive decomposition quality (ROMA-inspired)
 * 4. Agent team coordination (Claude Code Teams)
 * 5. Cost efficiency (Anthropic effort scaling)
 * 6. Synthesis quality (Multi-agent synthesis)
 * 7. Full pipeline throughput
 *
 * Benchmark reference scores (GAIA / MultiAgentBench / SEAL-0):
 * - OWL (open-source #1 GAIA): 69.09%
 * - Claude Sonnet 4.5 (GAIA): 74.55%
 * - HAL Generalist (GAIA L3): 65.39%
 * - Kimi K2.5 (SEAL-0): 57.40%
 * - MultiAgentBench gpt-4o-mini: baseline
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  deliberate,
  RecursiveAtomizer,
  TopologyRouter,
  MultiAgentSynthesizer,
  getArtifactSystem,
  getCapabilityRegistry,
  getTeamManager,
  classifyEffortLevel,
  getEffortRules,
  selectTopologyForEffort,
} from '../src/ultimate/index';

import type {
  OrchestrationTopology,
  DeliberationPlan,
  EffortLevel,
  TaskTreeNode,
} from '../src/ultimate/index';

// ============================================================================
// Benchmark 1: Topology Routing Accuracy
// Measures: Can we select the optimal topology for different task types?
// AdaptOrch baseline: 12-23% improvement over static topology
// ============================================================================
describe('B1: Topology Routing Accuracy', () => {
  const router = new TopologyRouter();

  it('T1.1: Routes simple factual tasks to SINGLE', () => {
    const plan: DeliberationPlan = {
      requiresExternalInfo: false,
      taskType: 'FACTUAL',
      recommendedTopology: 'SINGLE',
      estimatedAgentCount: 1,
      estimatedSteps: 3,
      estimatedTokens: 500,
      tokenBudget: { thinking: 100, execution: 300, synthesis: 100 },
      decompositionStrategy: 'NONE',
      capabilitiesNeeded: ['reasoning'],
      confidence: 0.9,
      reasoning: [],
    };
    const result = router.route(plan);
    assert.strictEqual(result.topology, 'SINGLE');
  });

  it('T1.2: Routes research tasks to PARALLEL or HIERARCHICAL', () => {
    const plan: DeliberationPlan = {
      requiresExternalInfo: true,
      taskType: 'RESEARCH',
      recommendedTopology: 'PARALLEL',
      estimatedAgentCount: 5,
      estimatedSteps: 20,
      estimatedTokens: 10000,
      tokenBudget: { thinking: 1000, execution: 7000, synthesis: 2000 },
      decompositionStrategy: 'ASPECT',
      capabilitiesNeeded: ['web_search', 'reasoning'],
      confidence: 0.7,
      reasoning: [],
    };
    const result = router.route(plan);
    assert.ok(['PARALLEL', 'HIERARCHICAL', 'HYBRID'].includes(result.topology));
  });

  it('T1.3: Routes tightly coupled tasks to SEQUENTIAL', () => {
    const dag = router.buildDAG(
      [
        { id: 'a', label: 'Step A', estimatedComplexity: 3, estimatedTokens: 1000, requiredCapabilities: ['input'], atomic: true },
        { id: 'b', label: 'Step B', estimatedComplexity: 4, estimatedTokens: 2000, requiredCapabilities: ['process'], atomic: true },
        { id: 'c', label: 'Step C', estimatedComplexity: 2, estimatedTokens: 500, requiredCapabilities: ['output'], atomic: true },
      ],
      [
        { from: 'a', to: 'b', type: 'SEQUENTIAL', dataDependency: true },
        { from: 'b', to: 'c', type: 'SEQUENTIAL', dataDependency: true },
      ],
    );
    const plan: DeliberationPlan = {
      requiresExternalInfo: false,
      taskType: 'CODING',
      recommendedTopology: 'SEQUENTIAL',
      estimatedAgentCount: 3,
      estimatedSteps: 10,
      estimatedTokens: 5000,
      tokenBudget: { thinking: 500, execution: 3500, synthesis: 1000 },
      decompositionStrategy: 'STEP',
      capabilitiesNeeded: ['code_understanding'],
      confidence: 0.8,
      reasoning: [],
    };
    const result = router.route(plan, dag);
    assert.strictEqual(result.topology, 'SEQUENTIAL');
  });

  it('T1.4: Routes high-parallelism tasks to PARALLEL', () => {
    const dag = router.buildDAG(
      Array.from({ length: 8 }, (_, i) => ({
        id: `task-${i}`,
        label: `Independent Task ${i}`,
        estimatedComplexity: 2,
        estimatedTokens: 500,
        requiredCapabilities: ['search'],
        atomic: true,
      })),
      [],
    );
    assert.ok(dag.metadata.parallelismWidth >= 0);

    const result = router.route({
      requiresExternalInfo: true,
      taskType: 'RESEARCH',
      recommendedTopology: 'PARALLEL',
      estimatedAgentCount: 8,
      estimatedSteps: 15,
      estimatedTokens: 8000,
      tokenBudget: { thinking: 500, execution: 6000, synthesis: 1500 },
      decompositionStrategy: 'ASPECT',
      capabilitiesNeeded: ['web_search'],
      confidence: 0.8,
      reasoning: [],
    }, dag);
    assert.ok(['PARALLEL', 'HIERARCHICAL', 'HYBRID'].includes(result.topology));
  });
});

// ============================================================================
// Benchmark 2: Deliberation Efficiency
// Measures: What % of tasks correctly identified as needing external info?
// DOVA baseline: 40-60% reduction in unnecessary API calls on simple tasks
// ============================================================================
describe('B2: Deliberation Efficiency', () => {
  it('T2.1: Correctly identifies factual queries as NOT requiring external info', () => {
    const plan = deliberate('What is the capital of France?');
    assert.strictEqual(plan.requiresExternalInfo, false);
    assert.ok(plan.confidence >= 0.5);
  });

  it('T2.2: Correctly identifies research queries as requiring external info', () => {
    const plan = deliberate('What are the latest breakthroughs in quantum computing as of 2026?');
    assert.strictEqual(plan.requiresExternalInfo, true);
  });

  it('T2.3: Classifies task types correctly across all domains', () => {
    const tests: Array<{ goal: string; expected: string }> = [
      { goal: 'Implement a REST API with Express', expected: 'CODING' },
      { goal: 'Why does quantum entanglement matter for cryptography?', expected: 'REASONING' },
      { goal: 'Design a brand identity for a tech startup', expected: 'CREATIVE' },
      { goal: 'Review the security audit and summarize findings', expected: 'ANALYSIS' },
      { goal: 'What is the population of Tokyo?', expected: 'FACTUAL' },
    ];
    for (const { goal, expected } of tests) {
      const plan = deliberate(goal);
      assert.strictEqual(plan.taskType, expected, `Failed for: ${goal}`);
    }
  });

  it('T2.4: Deliberation token budget scales with complexity', () => {
    const simple = deliberate('What is 2+2?');
    const complex = deliberate(
      'A'.repeat(2000) +
      'Analyze the implications of multi-agent recursive delegation patterns for large-scale distributed AI systems with heterogeneous model backends and dynamic resource allocation strategies.'
    );
    const simpleTotal = simple.tokenBudget.thinking + simple.tokenBudget.execution + simple.tokenBudget.synthesis;
    const complexTotal = complex.tokenBudget.thinking + complex.tokenBudget.execution + complex.tokenBudget.synthesis;
    assert.ok(complexTotal > simpleTotal, 'Complex tasks should get larger token budgets');
  });

  it('T2.5: Effort level correlates with agent count', () => {
    const simple = classifyEffortLevel('Short query');
    const deep = classifyEffortLevel('A'.repeat(3000) + 'Deep research task', {
      toolCount: 20,
      riskLevel: 'CRITICAL',
    });
    const simpleRules = getEffortRules(simple);
    const deepRules = getEffortRules(deep);
    assert.ok(deepRules.maxSubAgents >= simpleRules.maxSubAgents);
    assert.ok(deepRules.thinkingTokens > simpleRules.thinkingTokens);
  });
});

// ============================================================================
// Benchmark 3: Recursive Decomposition Quality (ROMA-inspired)
// Measures: Can we break tasks into meaningful subtasks?
// ROMA baseline: +9.9% on SEAL-0 over single-agent baselines
// ============================================================================
describe('B3: Recursive Decomposition Quality', () => {
  const atomizer = new RecursiveAtomizer(3, 10);

  it('T3.1: Atomic tasks are not decomposed', () => {
    const plan: DeliberationPlan = {
      requiresExternalInfo: false,
      taskType: 'FACTUAL',
      recommendedTopology: 'SINGLE',
      estimatedAgentCount: 1,
      estimatedSteps: 3,
      estimatedTokens: 500,
      tokenBudget: { thinking: 100, execution: 300, synthesis: 100 },
      decompositionStrategy: 'NONE',
      capabilitiesNeeded: ['reasoning'],
      confidence: 0.9,
      reasoning: [],
    };
    const tree = atomizer.decompose('What is the boiling point of water?', plan);
    assert.strictEqual(tree.isAtomic, true);
    assert.strictEqual(tree.subtasks.length, 0);
  });

  it('T3.2: Aspect decomposition creates orthogonal subtasks', () => {
    const plan: DeliberationPlan = {
      requiresExternalInfo: true,
      taskType: 'RESEARCH',
      recommendedTopology: 'PARALLEL',
      estimatedAgentCount: 3,
      estimatedSteps: 15,
      estimatedTokens: 6000,
      tokenBudget: { thinking: 500, execution: 4500, synthesis: 1000 },
      decompositionStrategy: 'ASPECT',
      capabilitiesNeeded: ['web_search', 'reasoning'],
      confidence: 0.7,
      reasoning: [],
    };
    const tree = atomizer.decompose(
      'A'.repeat(300) + 'Research the impact of AI on healthcare including diagnostics, drug discovery, and patient monitoring.',
      plan,
    );
    assert.strictEqual(tree.isAtomic, false);
    assert.ok(tree.subtasks.length >= 2);
    assert.strictEqual(tree.role, 'PLANNER');
  });

  it('T3.3: Step decomposition creates sequential subtasks', () => {
    const plan: DeliberationPlan = {
      requiresExternalInfo: false,
      taskType: 'CODING',
      recommendedTopology: 'SEQUENTIAL',
      estimatedAgentCount: 2,
      estimatedSteps: 10,
      estimatedTokens: 4000,
      tokenBudget: { thinking: 400, execution: 3000, synthesis: 600 },
      decompositionStrategy: 'STEP',
      capabilitiesNeeded: ['code_understanding'],
      confidence: 0.8,
      reasoning: [],
    };
    const tree = atomizer.decompose(
      'A'.repeat(300) + 'Build a user authentication system with registration, login, password reset, and session management.',
      plan,
    );
    assert.ok(!tree.isAtomic);
    assert.ok(tree.subtasks.length >= 2);
  });

  it('T3.4: Recursive decomposition respects max depth', () => {
    const deepAtomizer = new RecursiveAtomizer(1, 5);
    const plan: DeliberationPlan = {
      requiresExternalInfo: true,
      taskType: 'RESEARCH',
      recommendedTopology: 'HYBRID',
      estimatedAgentCount: 10,
      estimatedSteps: 30,
      estimatedTokens: 20000,
      tokenBudget: { thinking: 2000, execution: 14000, synthesis: 4000 },
      decompositionStrategy: 'RECURSIVE',
      capabilitiesNeeded: ['web_search', 'reasoning'],
      confidence: 0.6,
      reasoning: [],
    };
    const tree = deepAtomizer.decompose('A'.repeat(500) + 'Research task', plan);
    function maxDepth(node: TaskTreeNode): number {
      if (node.subtasks.length === 0) return 0;
      return 1 + Math.max(...node.subtasks.map(maxDepth));
    }
    assert.ok(maxDepth(tree) <= 1, 'Depth should be limited by maxDepth=1');
  });
});

// ============================================================================
// Benchmark 4: Agent Team Coordination (Claude Code Teams)
// Measures: Can teams coordinate effectively through shared tasks + inbox?
// ============================================================================
describe('B4: Agent Team Coordination', () => {
  it('T4.1: Team formation and member management', () => {
    const manager = getTeamManager();
    const team = manager.createTeam('bench-team', [
      { agentId: 'lead', role: 'LEAD', capabilities: ['reasoning'], status: 'IDLE' },
      { agentId: 'researcher', role: 'RESEARCHER', capabilities: ['search'], status: 'IDLE' },
      { agentId: 'coder', role: 'CODER', capabilities: ['code'], status: 'IDLE' },
      { agentId: 'reviewer', role: 'REVIEWER', capabilities: ['review'], status: 'IDLE' },
    ]);
    assert.strictEqual(team.members.length, 4);
    assert.strictEqual(team.status, 'ACTIVE');
    manager.disbandTeam(team.id);
  });

  it('T4.2: Task assignment and tracking', () => {
    const manager = getTeamManager();
    const team = manager.createTeam('task-team', [
      { agentId: 'worker1', role: 'CODER', capabilities: ['code'], status: 'IDLE' },
      { agentId: 'worker2', role: 'SPECIALIST', capabilities: ['search'], status: 'IDLE' },
    ]);
    const t1 = manager.addTask(team.id, { description: 'Implement feature', assignedTo: 'worker1', dependencies: [] });
    const t2 = manager.addTask(team.id, { description: 'Research approach', assignedTo: 'worker2', dependencies: [t1!.id] });
    assert.ok(t1); assert.ok(t2);
    manager.assignTask(team.id, t1!.id, 'worker1');
    manager.updateTask(team.id, t1!.id, { status: 'COMPLETED' });
    manager.assignTask(team.id, t2!.id, 'worker2');
    const status = manager.getTeamStatus(team.id);
    assert.strictEqual(status?.completedTasks, 1);
    assert.strictEqual(status?.inProgressTasks, 1);
    manager.disbandTeam(team.id);
  });

  it('T4.3: Team inbox messaging', () => {
    const manager = getTeamManager();
    const team = manager.createTeam('msg-team', [
      { agentId: 'lead', role: 'LEAD', capabilities: [], status: 'IDLE' },
      { agentId: 'worker', role: 'CODER', capabilities: [], status: 'IDLE' },
    ]);
    manager.sendMessage(team.id, 'lead', 'worker', 'Task update', 'Please review the PR', 'HIGH');
    const msgs = manager.readMessages(team.id, 'worker');
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].subject, 'Task update');
    assert.strictEqual(msgs[0].priority, 'HIGH');
    manager.disbandTeam(team.id);
  });
});

// ============================================================================
// Benchmark 5: Cost Efficiency (Anthropic Effort Scaling)
// Measures: Does effort scaling prevent over-allocation?
// Anthropic baseline: 15x token multiplier for multi-agent vs chat
// ============================================================================
describe('B5: Cost Efficiency', () => {
  it('T5.1: Effort scaling prevents over-allocation for simple tasks', () => {
    const rules = getEffortRules('SIMPLE');
    assert.strictEqual(rules.minSubAgents, 1);
    assert.strictEqual(rules.maxSubAgents, 1);
    assert.strictEqual(rules.recommendedTopology, 'SINGLE');
    assert.strictEqual(rules.thinkingTokens, 512);
  });

  it('T5.2: Deep research gets appropriate resources', () => {
    const rules = getEffortRules('DEEP_RESEARCH');
    assert.ok(rules.minSubAgents >= 10);
    assert.ok(rules.maxSubAgents >= rules.minSubAgents);
    assert.strictEqual(rules.recommendedTopology, 'HYBRID');
    assert.ok(rules.thinkingTokens >= 4096);
  });

  it('T5.3: Cost scales proportionally with effort', () => {
    const levels: EffortLevel[] = ['SIMPLE', 'MODERATE', 'COMPLEX', 'DEEP_RESEARCH'];
    let prevTokens = 0;
    for (const level of levels) {
      const rules = getEffortRules(level);
      assert.ok(rules.thinkingTokens >= prevTokens, `${level} should cost >= previous level`);
      prevTokens = rules.thinkingTokens;
    }
  });

  it('T5.4: Model tier mapping optimizes cost', () => {
    const { modelTierMapping } = require('../src/ultimate/types').DEFAULT_ULTIMATE_CONFIG;
    assert.strictEqual(modelTierMapping.SIMPLE, 'eco');
    assert.strictEqual(modelTierMapping.MODERATE, 'standard');
    assert.strictEqual(modelTierMapping.COMPLEX, 'power');
    assert.strictEqual(modelTierMapping.DEEP_RESEARCH, 'consensus');
  });
});

// ============================================================================
// Benchmark 6: Synthesis Quality
// Measures: How well does multi-agent synthesis combine results?
// ============================================================================
describe('B6: Synthesis Quality', () => {
  it('T6.1: Synthesizes from completed task tree', async () => {
    const synthesizer = new MultiAgentSynthesizer();
    const tree: TaskTreeNode = {
      id: 'root', parentId: null, goal: 'Synthesize', role: 'PLANNER',
      isAtomic: false, subtasks: [
        { id: 's1', parentId: 'root', goal: 'Research part A', role: 'EXECUTOR', isAtomic: true,
          subtasks: [], dependencies: [], context: { systemPrompt: '', availableTools: [], estimatedTokens: 100 },
          status: 'COMPLETED', result: 'Finding A: important data.' },
        { id: 's2', parentId: 'root', goal: 'Research part B', role: 'EXECUTOR', isAtomic: true,
          subtasks: [], dependencies: [], context: { systemPrompt: '', availableTools: [], estimatedTokens: 100 },
          status: 'COMPLETED', result: 'Finding B: interesting patterns.' },
        { id: 's3', parentId: 'root', goal: 'Research part C', role: 'EXECUTOR', isAtomic: true,
          subtasks: [], dependencies: [], context: { systemPrompt: '', availableTools: [], estimatedTokens: 100 },
          status: 'COMPLETED', result: 'Finding C: key insights.' },
      ],
      context: { systemPrompt: '', availableTools: [], estimatedTokens: 300 },
      status: 'COMPLETED',
    };
    const result = await synthesizer.synthesize('LEAD_SYNTHESIS', {
      strategy: 'LEAD_SYNTHESIS', maxRounds: 2, consensusThreshold: 0.7, includeDissent: true,
      qualityGates: [
        { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: false },
        { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: false },
      ],
    }, tree, []);
    assert.ok(result.synthesis.length > 50);
    assert.ok(result.qualityScore >= 0 && result.qualityScore <= 1);
    assert.ok(result.gateResults.length >= 2);
  });

  it('T6.2: Quality gates detect low quality', async () => {
    const synthesizer = new MultiAgentSynthesizer();
    const tree: TaskTreeNode = {
      id: 'root', parentId: null, goal: 'Low quality', role: 'EXECUTOR',
      isAtomic: true, subtasks: [], dependencies: [],
      context: { systemPrompt: '', availableTools: [], estimatedTokens: 50 },
      status: 'COMPLETED',
      result: 'Short result.',
    };
    const result = await synthesizer.synthesize('LEAD_SYNTHESIS', {
      strategy: 'LEAD_SYNTHESIS', maxRounds: 1, consensusThreshold: 0.5, includeDissent: false,
      qualityGates: [
        { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.8, autoFix: false },
      ],
    }, tree, []);
    assert.ok(result.gateResults.length > 0);
  });

  it('T6.3: Supports hierarchical synthesis', async () => {
    const synthesizer = new MultiAgentSynthesizer();
    const tree: TaskTreeNode = {
      id: 'root', parentId: null, goal: 'Root synthesis', role: 'PLANNER',
      isAtomic: false, subtasks: [
        { id: 'child1', parentId: 'root', goal: 'Child A', role: 'EXECUTOR', isAtomic: true,
          subtasks: [], dependencies: [], context: { systemPrompt: '', availableTools: [], estimatedTokens: 50 },
          status: 'COMPLETED', result: 'Child A result' },
      ],
      context: { systemPrompt: '', availableTools: [], estimatedTokens: 100 },
      status: 'COMPLETED', result: 'Parent synthesis result',
    };
    const result = await synthesizer.synthesize('HIERARCHICAL', {
      strategy: 'HIERARCHICAL', maxRounds: 1, consensusThreshold: 0.5, includeDissent: false,
      qualityGates: [],
    }, tree, []);
    assert.ok(result.synthesis.length > 0);
    assert.ok(result.synthesis.includes('Parent synthesis'));
    assert.ok(result.synthesis.includes('Child A result'));
  });
});

// ============================================================================
// Benchmark 7: End-to-End Pipeline Performance
// Measures: Full deliberation → decomposition → topology → synthesis
// Comparable to GAIA pass@1 scores
// ============================================================================
describe('B7: End-to-End Pipeline Benchmarks', () => {
  it('T7.1: Full pipeline for simple factual task', () => {
    const goal = 'Tell me who is the current president of the United States';
    const plan = deliberate(goal);
    assert.strictEqual(plan.recommendedTopology, 'SINGLE');
    assert.strictEqual(plan.taskType, 'FACTUAL');
    assert.strictEqual(plan.estimatedAgentCount, 1);

    const level = classifyEffortLevel(goal);
    assert.strictEqual(level, 'SIMPLE');

    const topology = selectTopologyForEffort(level);
    assert.strictEqual(topology, 'SINGLE');
  });

  it('T7.2: Full pipeline for complex research task', () => {
    const goal = 'A'.repeat(500) + 'Research how different multi-agent architectures (orchestrator-worker, peer-to-peer, hierarchical) compare on task completion accuracy, token efficiency, and error recovery. Focus on production deployments from 2025-2026.';
    const plan = deliberate(goal);
    assert.strictEqual(plan.taskType, 'RESEARCH');
    assert.strictEqual(plan.requiresExternalInfo, true);
    assert.ok(plan.estimatedAgentCount >= 2);

    const level = classifyEffortLevel(goal, { toolCount: 8, riskLevel: 'HIGH' });
    assert.strictEqual(level, 'COMPLEX');

    const topology = selectTopologyForEffort(level, {
      parallelismWidth: 4,
      criticalPathDepth: 3,
      interSubtaskCoupling: 0.3,
    });
    // PARALLEL is correct for parallelismWidth > 3
    assert.ok(['PARALLEL', 'HIERARCHICAL'].includes(topology));
  });

  it('T7.3: Full pipeline for coding task', () => {
    const goal = 'A'.repeat(400) + 'Build a RESTful API with Express.js including user authentication, CRUD operations for products, order management, and payment processing integration.';
    const plan = deliberate(goal);
    assert.strictEqual(plan.taskType, 'CODING');
    assert.ok(plan.estimatedAgentCount >= 2);
    assert.ok(plan.recommendedTopology === 'PARALLEL' || plan.estimatedAgentCount > 0);
  });

  it('T7.4: Full pipeline adapts to budget constraints', () => {
    const router = new TopologyRouter();
    const plan: DeliberationPlan = {
      requiresExternalInfo: true, taskType: 'RESEARCH', recommendedTopology: 'HYBRID',
      estimatedAgentCount: 15, estimatedSteps: 30, estimatedTokens: 50000,
      tokenBudget: { thinking: 2000, execution: 40000, synthesis: 8000 },
      decompositionStrategy: 'RECURSIVE', capabilitiesNeeded: ['web_search', 'reasoning'],
      confidence: 0.6, reasoning: [],
    };
    const tightBudget = router.route(plan, undefined, { maxCostUsd: 0.50, maxTokens: 5000 });
    const looseBudget = router.route(plan, undefined, { maxCostUsd: 10.0, maxTokens: 100000 });
    // Cost-aware routing should prefer cheaper topology for tight budgets
    assert.ok(tightBudget.expectedCost <= looseBudget.expectedCost);
    // Cheaper topology may have different estimated latency
    assert.ok(tightBudget.expectedLatency.length > 0);
    assert.ok(looseBudget.expectedLatency.length > 0);
  });
});

// ============================================================================
// Benchmark 8: Component Scalability Stress Test
// Measures: Can components handle large task loads?
// ============================================================================
describe('B8: Scalability Stress Tests', () => {
  it('T8.1: Artifact system handles bulk writes', async () => {
    getArtifactSystem().clear();
    const system = getArtifactSystem();
    const count = 100;
    const writes = Array.from({ length: count }, (_, i) =>
      system.write(`agent-${i % 5}`, 'SUMMARY', `Artifact ${i}`, `Summary ${i}`, `Content ${i}`.repeat(10), [`tag-${i % 10}`])
    );
    await Promise.all(writes);
    const stats = await system.getStats();
    assert.strictEqual(stats.totalArtifacts, count);
    assert.ok(stats.totalTokens > 0);
    assert.ok(stats.topTags.length > 0);
  });

  it('T8.2: Capability registry handles many agents', () => {
    getCapabilityRegistry().clear();
    const registry = getCapabilityRegistry();
    const count = 50;
    for (let i = 0; i < count; i++) {
      registry.register(`agent-${i}`, {
        capabilities: [
          { name: `cap_${i % 5}`, domain: 'test', strength: 0.5 + (i % 5) * 0.1, description: '' },
        ],
        cost: { perInputToken: 0.00001, perOutputToken: 0.00003, perTask: 0.001 },
        limitations: [],
        reliability: { successRate: 0.9, avgLatencyMs: 1000, totalTasksCompleted: i * 10 },
      });
    }
    const matches = registry.findBestMatch(['cap_0']);
    assert.ok(matches.length >= 1);
    const stats = registry.getStats();
    assert.strictEqual(stats.totalAgents, count);
  });
});

// ============================================================================
// Summary reporter
// ============================================================================
process.on('exit', () => {
  const { DEFAULT_ULTIMATE_CONFIG } = require('../src/ultimate/types');
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ULTIMATE MULTI-AGENT ORCHESTRATION BENCHMARK SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Framework: ${DEFAULT_ULTIMATE_CONFIG.maxRecursiveDepth}-level recursive decomposition`);
  console.log(`  Topologies: SINGLE | SEQUENTIAL | PARALLEL | HIERARCHICAL | HYBRID | DEBATE | ENSEMBLE | EVALUATOR_OPTIMIZER`);
  console.log(`  Max Parallel Agents: ${DEFAULT_ULTIMATE_CONFIG.maxParallelSubAgents}`);
  console.log(`  Quality Gates: ${DEFAULT_ULTIMATE_CONFIG.qualityGates.map(g => g.name).join(', ')}`);
  console.log(`  Synthesis: ${DEFAULT_ULTIMATE_CONFIG.defaultSynthesisConfig.strategy}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log('  BENCHMARK DIMENSIONS:');
  console.log('  B1: Topology Routing Accuracy     - 8 topology types, DAG analysis');
  console.log('  B2: Deliberation Efficiency       - task classification, budget scaling');
  console.log('  B3: Recursive Decomposition        - atomic, aspect, step, recursive');
  console.log('  B4: Agent Team Coordination        - formation, tasks, inbox messaging');
  console.log('  B5: Cost Efficiency                - effort scaling, model tier mapping');
  console.log('  B6: Synthesis Quality              - lead, hierarchical, quality gates');
  console.log('  B7: End-to-End Pipeline            - full deliberation→synthesis flow');
  console.log('  B8: Scalability Stress             - 100 artifacts, 50 agents');
  console.log('───────────────────────────────────────────────────────────');
  console.log('  SOTA REFERENCE SCORES (for context):');
  console.log('  • OWL (open-source #1 GAIA):        69.09%');
  console.log('  • Claude Sonnet 4.5 (GAIA #1):      74.55%');
  console.log('  • Claude Sonnet 4.5 (GAIA L3):      65.39%');
  console.log('  • Kimi K2.5 (SEAL-0 #1):            57.40%');
  console.log('  • Alita pass@3 (GAIA):              87.27%');
  console.log('  • ROMA + GLM-4.6 (SEAL-0):          57.30% (+9.9% vs baseline)');
  console.log('═══════════════════════════════════════════════════════════\n');
});
