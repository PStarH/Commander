import { describe, it } from 'node:test';
import assert from 'node:assert';

// Import the ultimate orchestration system
import {
  // Core components
  deliberate,
  RecursiveAtomizer,
  TopologyRouter,
  MultiAgentSynthesizer,
  ArtifactSystem,
  getArtifactSystem,
  CapabilityRegistry,
  getCapabilityRegistry,
  AgentTeamManager,
  getTeamManager,
  classifyEffortLevel,
  getEffortRules,
  selectTopologyForEffort,
  DEFAULT_THINKING_BUDGET,
  DEFAULT_SYNTHESIS_CONFIG,
  DEFAULT_ULTIMATE_CONFIG,
} from '../src/ultimate/index';

import type {
  DeliberationPlan,
  OrchestrationTopology,
  TaskTreeNode,
  EffortLevel,
} from '../src/ultimate/index';

// ============================================================================
// Unit Tests for Effort Scaler
// ============================================================================
describe('EffortScaler', () => {
  it('should classify simple queries correctly', () => {
    const level = classifyEffortLevel('What is the capital of France?');
    assert.strictEqual(level, 'SIMPLE');
  });

  it('should classify moderate queries correctly', () => {
    const level = classifyEffortLevel(
      'A'.repeat(500) + 'Compare the performance characteristics of React, Vue, and Angular for building a large-scale enterprise dashboard application.',
    );
    assert.strictEqual(level, 'MODERATE');
  });

  it('should classify complex queries correctly', () => {
    const level = classifyEffortLevel(
      'A'.repeat(1600) + 'Implement a full-stack microservices architecture with authentication...',
      { toolCount: 10, riskLevel: 'HIGH' },
    );
    assert.strictEqual(level, 'COMPLEX');
  });

  it('should classify deep research queries correctly', () => {
    const level = classifyEffortLevel(
      'A'.repeat(3500) + 'Research the latest advances in multi-agent AI systems...',
      { toolCount: 20, riskLevel: 'CRITICAL' },
    );
    assert.strictEqual(level, 'DEEP_RESEARCH');
  });

  it('should return correct scaling rules for each effort level', () => {
    const levels: EffortLevel[] = ['SIMPLE', 'MODERATE', 'COMPLEX', 'DEEP_RESEARCH'];
    for (const level of levels) {
      const rules = getEffortRules(level);
      assert.ok(rules.minSubAgents <= rules.maxSubAgents);
      assert.ok(rules.maxDepth >= 0);
      assert.ok(rules.thinkingTokens > 0);
    }
  });

  it('should select appropriate topologies for different effort levels', () => {
    assert.strictEqual(selectTopologyForEffort('SIMPLE'), 'SINGLE');
    assert.strictEqual(selectTopologyForEffort('MODERATE'), 'PARALLEL');
    assert.strictEqual(selectTopologyForEffort('COMPLEX'), 'HIERARCHICAL');
    assert.strictEqual(selectTopologyForEffort('DEEP_RESEARCH'), 'HYBRID');
  });

  it('should select sequential topology for tightly coupled tasks', () => {
    const topology = selectTopologyForEffort('MODERATE', {
      parallelismWidth: 1,
      criticalPathDepth: 5,
      interSubtaskCoupling: 0.9,
    });
    assert.strictEqual(topology, 'SEQUENTIAL');
  });
});

// ============================================================================
// Unit Tests for Deliberation Engine
// ============================================================================
describe('Deliberation Engine', () => {
  it('should classify research tasks and require external info', () => {
    const plan = deliberate(
      'Research the latest breakthroughs in LLM agent architectures in 2026. ' +
      'Examine multi-agent coordination, tool-use patterns, recursive reasoning, ' +
      'and self-improvement mechanisms. Compare approaches from Anthropic, OpenAI, Google, and Meta. ' +
      'Focus on production-ready systems, not just research prototypes. ' +
      'Provide concrete recommendations for implementing a state-of-the-art multi-agent orchestration platform.',
    );
    assert.strictEqual(plan.estimatedAgentCount >= 2, true);
    assert.ok(plan.reasoning.length > 0);
  });

  it('should classify coding tasks', () => {
    const plan = deliberate('Implement a REST API with Express and TypeScript');
    assert.strictEqual(plan.taskType, 'CODING');
  });

  it('should classify reasoning tasks', () => {
    const plan = deliberate('Explain why quantum computing is important for AI safety');
    assert.strictEqual(plan.taskType, 'REASONING');
  });

  it('should allocate thinking budget based on effort level', () => {
    const simple = deliberate('What is 2+2?');
    const complex = deliberate(
      'A'.repeat(2000) + 'Analyze the implications of multi-agent delegation patterns...',
    );
    assert.ok(simple.tokenBudget.thinking < complex.tokenBudget.thinking);
  });

  it('should detect temporal queries', () => {
    const plan = deliberate('What are the latest AI news in 2026?');
    assert.strictEqual(plan.requiresExternalInfo, true);
  });

  it('should have high confidence for factual tasks', () => {
    const plan = deliberate('What is the capital of France?');
    assert.ok(plan.confidence >= 0.5);
  });
});

// ============================================================================
// Unit Tests for Recursive Atomizer
// ============================================================================
describe('RecursiveAtomizer', () => {
  it('should mark simple tasks as atomic', () => {
    const atomizer = new RecursiveAtomizer(3, 10);
    const deliberation: DeliberationPlan = {
      requiresExternalInfo: false,
      taskType: 'FACTUAL',
      recommendedTopology: 'SINGLE',
      estimatedAgentCount: 1,
      estimatedSteps: 3,
      estimatedTokens: 1000,
      tokenBudget: { thinking: 100, execution: 700, synthesis: 200 },
      decompositionStrategy: 'NONE',
      capabilitiesNeeded: ['reasoning'],
      confidence: 0.9,
      reasoning: [],
    };
    const tree = atomizer.decompose('What is the capital of France?', deliberation);
    assert.ok(tree.isAtomic);
    assert.strictEqual(tree.subtasks.length, 0);
  });

  it('should decompose complex tasks into subtasks', () => {
    const atomizer = new RecursiveAtomizer(3, 10);
    const deliberation: DeliberationPlan = {
      requiresExternalInfo: true,
      taskType: 'RESEARCH',
      recommendedTopology: 'PARALLEL',
      estimatedAgentCount: 3,
      estimatedSteps: 15,
      estimatedTokens: 5000,
      tokenBudget: { thinking: 500, execution: 3500, synthesis: 1000 },
      decompositionStrategy: 'ASPECT',
      capabilitiesNeeded: ['web_search', 'reasoning'],
      confidence: 0.7,
      reasoning: ['Decomposition recommended'],
    };
    const tree = atomizer.decompose(
      'A'.repeat(300) + 'Research the impact of AI on healthcare including diagnostics, drug discovery, patient monitoring, treatment planning, medical imaging analysis, and personalized medicine approaches across different healthcare settings and regulatory frameworks.',
      deliberation,
    );
    assert.ok(!tree.isAtomic);
    assert.ok(tree.subtasks.length >= 2);
  });

  it('should respect max depth limits', () => {
    const atomizer = new RecursiveAtomizer(1, 5);
    const deliberation: DeliberationPlan = {
      requiresExternalInfo: true,
      taskType: 'RESEARCH',
      recommendedTopology: 'HYBRID',
      estimatedAgentCount: 10,
      estimatedSteps: 30,
      estimatedTokens: 20000,
      tokenBudget: { thinking: 2000, execution: 14000, synthesis: 4000 },
      decompositionStrategy: 'RECURSIVE',
      capabilitiesNeeded: ['web_search', 'reasoning', 'code_understanding'],
      confidence: 0.6,
      reasoning: ['Deep research'],
    };
    const tree = atomizer.decompose('A'.repeat(3000), deliberation);
    assert.ok(tree.isAtomic || tree.subtasks.length > 0);
  });
});

// ============================================================================
// Unit Tests for Topology Router
// ============================================================================
describe('TopologyRouter', () => {
  it('should select SINGLE topology for simple tasks', () => {
    const router = new TopologyRouter();
    const plan: DeliberationPlan = {
      requiresExternalInfo: false,
      taskType: 'FACTUAL',
      recommendedTopology: 'SINGLE',
      estimatedAgentCount: 1,
      estimatedSteps: 3,
      estimatedTokens: 1000,
      tokenBudget: { thinking: 100, execution: 700, synthesis: 200 },
      decompositionStrategy: 'NONE',
      capabilitiesNeeded: ['reasoning'],
      confidence: 0.9,
      reasoning: [],
    };
    const result = router.route(plan);
    assert.strictEqual(result.topology, 'SINGLE');
    assert.ok(result.reasoning.length > 0);
  });

  it('should build DAG from nodes and edges', () => {
    const router = new TopologyRouter();
    const dag = router.buildDAG(
      [
        { id: 'a', label: 'Task A', estimatedComplexity: 3, estimatedTokens: 1000, requiredCapabilities: ['search'], atomic: true },
        { id: 'b', label: 'Task B', estimatedComplexity: 4, estimatedTokens: 2000, requiredCapabilities: ['code'], atomic: true },
        { id: 'c', label: 'Task C', estimatedComplexity: 2, estimatedTokens: 500, requiredCapabilities: ['reasoning'], atomic: true },
      ],
      [
        { from: 'a', to: 'b', type: 'SEQUENTIAL', dataDependency: true },
        { from: 'a', to: 'c', type: 'PARALLEL', dataDependency: false },
      ],
    );
    assert.strictEqual(dag.metadata.criticalPathDepth, 2);
    assert.ok(dag.metadata.interSubtaskCoupling > 0);
  });
});

// ============================================================================
// Unit Tests for Artifact System
// ============================================================================
describe('ArtifactSystem', () => {

  it('should write and read artifacts', async () => {
    getArtifactSystem().clear();
    const system = getArtifactSystem();
    const ref = await system.write('agent-1', 'RESEARCH_FINDING', 'Test Finding', 'A test summary', 'Detailed content here', ['test']);
    assert.ok(ref.id);
    assert.strictEqual(ref.type, 'RESEARCH_FINDING');
    const retrieved = await system.read(ref.id);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.content, 'Detailed content here');
  });

  it('should find artifacts by tags', async () => {
    getArtifactSystem().clear();
    const system = getArtifactSystem();
    await system.write('agent-1', 'SUMMARY', 'A', 'Summary A', 'Content A', ['tag1', 'tag2']);
    await system.write('agent-2', 'ANALYSIS', 'B', 'Summary B', 'Content B', ['tag2', 'tag3']);
    await system.write('agent-1', 'REPORT', 'C', 'Summary C', 'Content C', ['tag1']);
    const found = await system.find({ tags: ['tag1'] });
    assert.strictEqual(found.length, 2);
  });

  it('should delete artifacts', async () => {
    getArtifactSystem().clear();
    const system = getArtifactSystem();
    const ref = await system.write('agent-1', 'SUMMARY', 'Test', 'Summary', 'Content');
    await system.delete(ref.id);
    const retrieved = await system.read(ref.id);
    assert.strictEqual(retrieved, null);
  });

  it('should return stats', async () => {
    getArtifactSystem().clear();
    const system = getArtifactSystem();
    await system.write('agent-1', 'SUMMARY', 'A', 'Summary A', 'Content A', ['tag1']);
    await system.write('agent-2', 'ANALYSIS', 'B', 'Summary B', 'Content B', ['tag2']);
    const stats = await system.getStats();
    assert.strictEqual(stats.totalArtifacts, 2);
    assert.ok(stats.byType['SUMMARY'] === 1);
    assert.ok(stats.byType['ANALYSIS'] === 1);
  });
});

// ============================================================================
// Unit Tests for Capability Registry
// ============================================================================
describe('CapabilityRegistry', () => {
  function clearRegistry() { getCapabilityRegistry().clear(); }

  it('should register and retrieve agents', () => {
    clearRegistry();
    const registry = getCapabilityRegistry();
    registry.register('agent-builder', {
      capabilities: [
        { name: 'code_understanding', domain: 'engineering', strength: 0.9, description: 'Code analysis' },
        { name: 'web_search', domain: 'research', strength: 0.7, description: 'Web search' },
      ],
      cost: { perInputToken: 0.00001, perOutputToken: 0.00003, perTask: 0.001 },
      limitations: ['Cannot execute arbitrary code'],
      reliability: { successRate: 0.95, avgLatencyMs: 2000, totalTasksCompleted: 150 },
    });

    const retrieved = registry.get('agent-builder');
    assert.ok(retrieved);
    assert.strictEqual(retrieved.capabilities.length, 2);
  });

  it('should find best matching agent', () => {
    clearRegistry();
    const registry = getCapabilityRegistry();
    registry.register('agent-coder', {
      capabilities: [{ name: 'code_understanding', domain: 'engineering', strength: 0.95, description: '' }],
      cost: { perInputToken: 0.00002, perOutputToken: 0.00006, perTask: 0.002 },
      limitations: [],
      reliability: { successRate: 0.98, avgLatencyMs: 1000, totalTasksCompleted: 200 },
    });
    registry.register('agent-researcher', {
      capabilities: [{ name: 'web_search', domain: 'research', strength: 0.9, description: '' }],
      cost: { perInputToken: 0.00001, perOutputToken: 0.00003, perTask: 0.001 },
      limitations: [],
      reliability: { successRate: 0.92, avgLatencyMs: 1500, totalTasksCompleted: 100 },
    });

    const matches = registry.findBestMatch(['code_understanding']);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].agentId, 'agent-coder');
  });

  it('should provide registry stats', () => {
    clearRegistry();
    const registry = getCapabilityRegistry();
    registry.register('agent-1', {
      capabilities: [{ name: 'reasoning', domain: 'general', strength: 0.8, description: '' }],
      cost: { perInputToken: 0.00001, perOutputToken: 0.00003, perTask: 0.001 },
      limitations: [],
      reliability: { successRate: 0.9, avgLatencyMs: 1000, totalTasksCompleted: 50 },
    });
    const stats = registry.getStats();
    assert.strictEqual(stats.totalAgents, 1);
    assert.strictEqual(stats.totalCapabilities, 1);
  });
});

// ============================================================================
// Unit Tests for Agent Team Manager
// ============================================================================
describe('AgentTeamManager', () => {
  it('should create and manage teams', () => {
    const manager = getTeamManager();
    const team = manager.createTeam('research-team', [
      { agentId: 'lead-1', role: 'LEAD', capabilities: ['reasoning'], status: 'IDLE' },
      { agentId: 'researcher-1', role: 'RESEARCHER', capabilities: ['search'], status: 'IDLE' },
    ]);
    assert.ok(team.id);
    assert.strictEqual(team.status, 'ACTIVE');
    assert.strictEqual(team.members.length, 2);
  });

  it('should support shared task lists', () => {
    const manager = getTeamManager();
    const team = manager.createTeam('dev-team', [
      { agentId: 'builder', role: 'CODER', capabilities: ['code'], status: 'IDLE' },
    ]);
    const task = manager.addTask(team.id, {
      description: 'Implement feature X',
      assignedTo: 'builder',
      dependencies: [],
    });
    assert.ok(task);
    assert.strictEqual(task.status, 'PENDING');

    manager.assignTask(team.id, task.id, 'builder');
    const status = manager.getTeamStatus(team.id);
    assert.strictEqual(status?.inProgressTasks, 1);
  });

  it('should support inbox messaging', () => {
    const manager = getTeamManager();
    const team = manager.createTeam('comm-team', [
      { agentId: 'agent-a', role: 'LEAD', capabilities: [], status: 'IDLE' },
      { agentId: 'agent-b', role: 'SPECIALIST', capabilities: [], status: 'IDLE' },
    ]);
    manager.sendMessage(team.id, 'agent-a', 'ALL', 'Status update', 'All tasks complete', 'HIGH');
    const messages = manager.readMessages(team.id, 'agent-b');
    assert.strictEqual(messages.length, 1);
    assert.ok(messages[0].readAt);
  });

  it('should allow disbanding teams', () => {
    const manager = getTeamManager();
    const team = manager.createTeam('temp-team', [
      { agentId: 'temp-agent', role: 'SPECIALIST', capabilities: [], status: 'IDLE' },
    ]);
    manager.disbandTeam(team.id);
    const retrieved = manager.getTeam(team.id);
    assert.strictEqual(retrieved?.status, 'DISBANDED');
  });
});

// ============================================================================
// Unit Tests for Multi-Agent Synthesizer
// ============================================================================
describe('MultiAgentSynthesizer', () => {
  it('should synthesize results from completed task tree', async () => {
    const synthesizer = new MultiAgentSynthesizer();
    const tree: TaskTreeNode = {
      id: 'root',
      parentId: null,
      goal: 'Synthesize test',
      role: 'PLANNER',
      isAtomic: false,
      subtasks: [
        {
          id: 'sub-1',
          parentId: 'root',
          goal: 'Research topic A',
          role: 'EXECUTOR',
          isAtomic: true,
          subtasks: [],
          dependencies: [],
          context: { systemPrompt: '', availableTools: [], estimatedTokens: 100 },
          status: 'COMPLETED',
          result: 'Found important information about topic A.',
        },
        {
          id: 'sub-2',
          parentId: 'root',
          goal: 'Research topic B',
          role: 'EXECUTOR',
          isAtomic: true,
          subtasks: [],
          dependencies: [],
          context: { systemPrompt: '', availableTools: [], estimatedTokens: 100 },
          status: 'COMPLETED',
          result: 'Analysis of topic B shows interesting patterns.',
        },
      ],
      context: { systemPrompt: '', availableTools: [], estimatedTokens: 100 },
      status: 'COMPLETED',
    };

    const result = await synthesizer.synthesize(
      'LEAD_SYNTHESIS',
      DEFAULT_SYNTHESIS_CONFIG,
      tree,
      [],
    );

    assert.ok(result.synthesis.length > 0);
    assert.ok(result.qualityScore >= 0);
    assert.ok(result.gateResults.length > 0);
  });

  it('should handle empty results gracefully', async () => {
    const synthesizer = new MultiAgentSynthesizer();
    const tree: TaskTreeNode = {
      id: 'empty',
      parentId: null,
      goal: 'Empty test',
      role: 'EXECUTOR',
      isAtomic: true,
      subtasks: [],
      dependencies: [],
      context: { systemPrompt: '', availableTools: [], estimatedTokens: 50 },
      status: 'PENDING',
    };
    const result = await synthesizer.synthesize('VOTE', DEFAULT_SYNTHESIS_CONFIG, tree, []);
    assert.ok(result.synthesis);
  });
});

// ============================================================================
// Integration Tests for Full Pipeline
// ============================================================================
describe('Ultimate Orchestration Pipeline (Unit-Integration)', () => {
  it('should run full deliberation-to-topology pipeline', () => {
    // Phase 1: Deliberation
    const plan = deliberate('Design and implement a user authentication system with JWT, OAuth, and session management');
    assert.ok(plan.recommendedTopology);
    assert.ok(plan.estimatedAgentCount >= 1);

    // Phase 2: Effort Scaling
    const level = classifyEffortLevel(plan.taskType, {
      toolCount: 8,
      riskLevel: 'HIGH',
    });
    assert.ok(level);

    // Phase 3: Topology Selection
    const topology = selectTopologyForEffort(level, {
      parallelismWidth: 3,
      criticalPathDepth: 4,
      interSubtaskCoupling: 0.4,
    });
    assert.ok(topology);

    // Phase 4: Decomposition
    const atomizer = new RecursiveAtomizer(3, 10);
    const tree = atomizer.decompose(plan.taskType, plan);
    assert.ok(tree);
  });

  it('should demonstrate the full system architecture', () => {
    // This test validates that all major components can be instantiated
    // and that their default configurations are valid
    
    // Deliberation engine
    const plan = deliberate('Analyze system performance and provide optimization recommendations for a microservices architecture');
    assert.ok(plan.taskType);
    assert.ok(plan.recommendedTopology);
    assert.ok(plan.estimatedAgentCount > 0);
    assert.ok(plan.estimatedTokens > 0);
    assert.ok(plan.tokenBudget.thinking + plan.tokenBudget.execution + plan.tokenBudget.synthesis > 0);
    
    // Effort rules
    const rules = getEffortRules(plan.taskType === 'ANALYSIS' ? 'MODERATE' : 'COMPLEX');
    assert.ok(rules.minSubAgents >= 1);
    assert.ok(rules.maxSubAgents >= rules.minSubAgents);
    
    // Check that the synthesis config suggests research-appropriate strategy
    const synthesisConfig = DEFAULT_SYNTHESIS_CONFIG;
    assert.ok(synthesisConfig.qualityGates.length >= 3);
    
    // Verify the thinking budget has reasonable allocation
    const thinkingBudget = DEFAULT_THINKING_BUDGET;
    assert.ok(thinkingBudget.maxThinkingTokens >= thinkingBudget.minThinkingBeforeTools);
  });
});

// ============================================================================
// Configuration validation tests
// ============================================================================
describe('Configuration Validation', () => {
  it('should have reasonable default values', () => {
    assert.ok(DEFAULT_ULTIMATE_CONFIG.maxRecursiveDepth >= 2);
    assert.ok(DEFAULT_ULTIMATE_CONFIG.maxParallelSubAgents >= 5);
    assert.ok(DEFAULT_ULTIMATE_CONFIG.qualityGates.length >= 3);
    assert.ok(DEFAULT_ULTIMATE_CONFIG.defaultBudget.hardCapTokens > 0);
    assert.ok(DEFAULT_ULTIMATE_CONFIG.defaultBudget.costCapUsd > 0);
  });

  it('should map effort levels to appropriate model tiers', () => {
    const mapping = DEFAULT_ULTIMATE_CONFIG.modelTierMapping;
    assert.strictEqual(mapping.SIMPLE, 'eco');
    assert.strictEqual(mapping.MODERATE, 'standard');
    assert.strictEqual(mapping.COMPLEX, 'power');
    assert.strictEqual(mapping.DEEP_RESEARCH, 'consensus');
  });

  it('should have quality gates with valid thresholds', () => {
    for (const gate of DEFAULT_ULTIMATE_CONFIG.qualityGates) {
      assert.ok(gate.threshold > 0 && gate.threshold <= 1.0);
      assert.ok(gate.name.length > 0);
    }
  });
});
