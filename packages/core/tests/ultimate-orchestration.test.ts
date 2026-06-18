import { describe, it, before } from 'node:test';
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
  UltimateOrchestrator,
} from '../src/ultimate/index';

import type {
  DeliberationPlan,
  OrchestrationTopology,
  TaskTreeNode,
  EffortLevel,
} from '../src/ultimate/index';

import type { PinnedSessionConfig } from '../src/ultimate/orchestrator';
import { TELOSOrchestrator } from '../src/telos/telosOrchestrator';
import type { AgentRuntimeInterface } from '../src/runtime/agentRuntimeInterface';
import type { ExecutionExperience } from '../src/runtime/types';
import { getMetaLearner, clearMetaLearnerState } from '../src/selfEvolution/metaLearner';

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
      'A'.repeat(500) +
        'Compare the performance characteristics of React, Vue, and Angular for building a large-scale enterprise dashboard application.',
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
      estimatedDurationMs: 5000,
      suitableForSpeculation: false,
      taskNature: 'MIXED',
      timeBudgetPerAgentMs: 5000,
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
      estimatedDurationMs: 60000,
      suitableForSpeculation: true,
      taskNature: 'IO_BOUND',
      timeBudgetPerAgentMs: 51000,
    };
    const tree = atomizer.decompose(
      'A'.repeat(300) +
        'Research the impact of AI on healthcare including diagnostics, drug discovery, patient monitoring, treatment planning, medical imaging analysis, and personalized medicine approaches across different healthcare settings and regulatory frameworks.',
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
      estimatedDurationMs: 300000,
      suitableForSpeculation: true,
      taskNature: 'IO_BOUND',
      timeBudgetPerAgentMs: 210000,
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
      estimatedDurationMs: 5000,
      suitableForSpeculation: false,
      taskNature: 'MIXED',
      timeBudgetPerAgentMs: 5000,
    };
    const result = router.route(plan);
    assert.strictEqual(result.topology, 'SINGLE');
    assert.ok(result.reasoning.length > 0);
  });

  it('should build DAG from nodes and edges', () => {
    const router = new TopologyRouter();
    const dag = router.buildDAG(
      [
        {
          id: 'a',
          label: 'Task A',
          estimatedComplexity: 3,
          estimatedTokens: 1000,
          requiredCapabilities: ['search'],
          atomic: true,
        },
        {
          id: 'b',
          label: 'Task B',
          estimatedComplexity: 4,
          estimatedTokens: 2000,
          requiredCapabilities: ['code'],
          atomic: true,
        },
        {
          id: 'c',
          label: 'Task C',
          estimatedComplexity: 2,
          estimatedTokens: 500,
          requiredCapabilities: ['reasoning'],
          atomic: true,
        },
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
    const ref = await system.write(
      'agent-1',
      'RESEARCH_FINDING',
      'Test Finding',
      'A test summary',
      'Detailed content here',
      ['test'],
    );
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
  function clearRegistry() {
    getCapabilityRegistry().clear();
  }

  it('should register and retrieve agents', () => {
    clearRegistry();
    const registry = getCapabilityRegistry();
    registry.register('agent-builder', {
      capabilities: [
        {
          name: 'code_understanding',
          domain: 'engineering',
          strength: 0.9,
          description: 'Code analysis',
        },
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
      capabilities: [
        { name: 'code_understanding', domain: 'engineering', strength: 0.95, description: '' },
      ],
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
    const plan = deliberate(
      'Design and implement a user authentication system with JWT, OAuth, and session management',
    );
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
    const plan = deliberate(
      'Analyze system performance and provide optimization recommendations for a microservices architecture',
    );
    assert.ok(plan.taskType);
    assert.ok(plan.recommendedTopology);
    assert.ok(plan.estimatedAgentCount > 0);
    assert.ok(plan.estimatedTokens > 0);
    assert.ok(
      plan.tokenBudget.thinking + plan.tokenBudget.execution + plan.tokenBudget.synthesis > 0,
    );

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

// ============================================================================
// Session Pinning — config version-locking per run
// ============================================================================

/** Minimal mock AgentRuntimeInterface for testing session pinning. */
function createMockRuntime(): AgentRuntimeInterface {
  return {
    execute: async () => ({
      status: 'success',
      summary: '',
      steps: [],
      totalTokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
      },
      totalDurationMs: 0,
      artifacts: [],
    }),
    registerProvider: () => {},
    registerTool: () => {},
    getProvider: () => undefined,
    getSmartRouter: () => null,
    getTool: () => undefined,
    getConfig: () => ({
      maxStepsPerRun: 10,
      maxRetries: 3,
      timeoutMs: 60000,
      maxConcurrency: 5,
      budgetHardCapTokens: 200000,
      budgetSoftCapTokens: 100000,
      budgetCostCapUsd: 5,
      defaultModel: 'test-model',
      enableReflection: false,
      enableThinking: false,
    }),
    getMemoryStore: () => null,
    getCheckpointer: () =>
      ({ save: () => {}, load: () => null, delete: () => {}, list: () => [] }) as any,
    getInbox: () => ({ send: () => {}, receive: () => [], acknowledge: () => {} }) as any,
    getTeamRegistry: () => ({ register: () => {}, get: () => null, list: () => [] }) as any,
    getHandoff: () => ({ handoff: async () => ({ accepted: false }), cancel: () => {} }) as any,
    getExecutionScheduler: () => ({ schedule: () => {}, cancel: () => {}, list: () => [] }) as any,
    getCompensationRegistry: () => ({ register: () => {}, get: () => null, list: () => [] }) as any,
    cancelAllSteps: () => 0,
    getStepTimeoutManager: () =>
      ({ register: () => '', cancel: () => {}, cancelAll: () => 0 }) as any,
    listUnfinishedRuns: () => [],
    resume: async () => null,
    listResumableRuns: () => [],
    pauseRun: () => false,
    unpauseRun: () => {},
    isPaused: () => false,
    getActiveRuns: () => [],
    getActiveRunCount: () => 0,
    isRunActive: () => false,
    getSemanticCacheStats: () => ({ hits: 0, misses: 0, size: 0, hitRate: 0, evictions: 0 }),
    getSingleFlightStats: () => ({ hits: 0, misses: 0, inflight: 0 }),
    getGeminiCacheStats: () => ({ activeCaches: 0, totalTokensCached: 0, estimatedSavingsUsd: 0 }),
    getCostEstimatorHistory: () => [],
    dispose: () => {},
  };
}

describe('Session Pinning', () => {
  let orchestrator: UltimateOrchestrator;

  before(() => {
    const mockRuntime = createMockRuntime();
    const telos = new TELOSOrchestrator(mockRuntime);
    orchestrator = new UltimateOrchestrator(telos, mockRuntime);
  });

  it('pins a session config and retrieves it', () => {
    orchestrator.pinSessionConfig('run-001', 'PARALLEL', 'MODERATE');
    const pinned = orchestrator.getSessionPinnedConfig('run-001');

    assert.ok(pinned !== null);
    assert.strictEqual(pinned!.runId, 'run-001');
    assert.strictEqual(pinned!.topology, 'PARALLEL');
    assert.strictEqual(pinned!.effortLevel, 'MODERATE');
    assert.strictEqual(typeof pinned!.configHash, 'string');
    assert.strictEqual(pinned!.configHash.length, 8);
    assert.ok(typeof pinned!.pinnedAt === 'string');
  });

  it('returns null for unpinned session', () => {
    const pinned = orchestrator.getSessionPinnedConfig('nonexistent');
    assert.strictEqual(pinned, null);
  });

  it('produces deterministic config hash for same config', () => {
    const hash1 = orchestrator['computeConfigHash']();
    const hash2 = orchestrator['computeConfigHash']();

    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 8);
    // Hash should be hex
    assert.ok(/^[0-9a-f]{8}$/.test(hash1), `Hash "${hash1}" should be 8 hex chars`);
  });

  it('records modelTierMapping in pinned session', () => {
    orchestrator.pinSessionConfig('run-002', 'SEQUENTIAL', 'SIMPLE');
    const pinned = orchestrator.getSessionPinnedConfig('run-002')!;

    assert.ok(pinned.modelTierMapping);
    assert.strictEqual(typeof pinned.modelTierMapping, 'object');
    // Default config maps SIMPLE → eco
    assert.strictEqual(pinned.modelTierMapping.SIMPLE, 'eco');
  });

  it('records qualityGateThresholds in pinned session', () => {
    orchestrator.pinSessionConfig('run-003', 'HIERARCHICAL', 'COMPLEX');
    const pinned = orchestrator.getSessionPinnedConfig('run-003')!;

    assert.ok(pinned.qualityGateThresholds);
    assert.strictEqual(typeof pinned.qualityGateThresholds, 'object');
    // Should have known quality gates like hallucination, consistency
    const gateNames = Object.keys(pinned.qualityGateThresholds);
    assert.ok(gateNames.length >= 3, `Expected >= 3 quality gates, got ${gateNames.length}`);
    for (const name of gateNames) {
      assert.ok(pinned.qualityGateThresholds[name] > 0 && pinned.qualityGateThresholds[name] <= 1);
    }
  });

  it('lists pinned sessions sorted by pin time (newest first)', async () => {
    orchestrator.pinSessionConfig('run-a', 'SINGLE', 'SIMPLE');
    // Small delay to ensure different pinnedAt timestamps
    await new Promise((r) => setTimeout(r, 5));
    orchestrator.pinSessionConfig('run-b', 'SEQUENTIAL', 'MODERATE');
    const sessions = orchestrator.getPinnedSessions();

    assert.ok(sessions.length >= 2);
    // Newest (run-b) should be first
    assert.strictEqual(sessions[0].runId, 'run-b');
    // Config hashes are identical because the orchestrator config hasn't changed
    assert.strictEqual(sessions[0].configHash, sessions[1].configHash);
  });

  it('getPinnedSessionCount reflects pinned sessions', () => {
    const before = orchestrator.getPinnedSessionCount();
    orchestrator.pinSessionConfig('run-count', 'SINGLE', 'SIMPLE');
    assert.strictEqual(orchestrator.getPinnedSessionCount(), before + 1);
  });

  it('evicts oldest session when exceeding max capacity', () => {
    // Use a fresh orchestrator to avoid pollution from other tests
    const mockRuntime = createMockRuntime();
    const telos = new TELOSOrchestrator(mockRuntime);
    const freshOrch = new UltimateOrchestrator(telos, mockRuntime);

    // Pin sessions up to max + extras
    const maxPinned = 100;
    for (let i = 0; i < maxPinned + 5; i++) {
      freshOrch.pinSessionConfig(`evict-${i}`, 'SINGLE', 'SIMPLE');
    }

    // The Map should not grow beyond maxPinnedSessions
    const count = freshOrch.getPinnedSessionCount();
    assert.ok(count <= maxPinned, `Expected <= ${maxPinned} pinned sessions, got ${count}`);

    // The first pinned (evict-0) should be evicted
    const first = freshOrch.getSessionPinnedConfig('evict-0');
    assert.strictEqual(first, null);

    // But recent sessions should still be there
    const last = freshOrch.getSessionPinnedConfig(`evict-${maxPinned + 4}`);
    assert.ok(last !== null);
  });

  it('hashes diverge when config changes', () => {
    // Create a fresh orchestrator with DEFAULT_ULTIMATE_CONFIG
    const mockRuntime2 = createMockRuntime();
    const telos2 = new TELOSOrchestrator(mockRuntime2);
    const orch2 = new UltimateOrchestrator(telos2, mockRuntime2);

    const hash1 = orch2['computeConfigHash']();

    // Modify config
    const config2 = orch2.getConfig();
    config2.maxParallelSubAgents = 999;
    const orch3 = new UltimateOrchestrator(telos2, mockRuntime2, config2);
    const hash2 = orch3['computeConfigHash']();

    assert.notStrictEqual(hash1, hash2, 'Different configs should produce different hashes');
  });

  it('PinnedSessionConfig has the correct shape', () => {
    orchestrator.pinSessionConfig('run-shape', 'HYBRID', 'DEEP_RESEARCH');
    const pinned = orchestrator.getSessionPinnedConfig('run-shape')!;

    assert.strictEqual(typeof pinned.runId, 'string');
    assert.strictEqual(typeof pinned.configHash, 'string');
    assert.strictEqual(typeof pinned.topology, 'string');
    assert.strictEqual(typeof pinned.effortLevel, 'string');
    assert.strictEqual(typeof pinned.modelTierMapping, 'object');
    assert.strictEqual(typeof pinned.qualityGateThresholds, 'object');
    assert.strictEqual(typeof pinned.pinnedAt, 'string');
  });
});

// ============================================================================
// Session Pinning — Integration (full execute() pipeline)
// ============================================================================

describe('Session Pinning — Integration', () => {
  it('pins session config during execute() with correct topology and effortLevel', async () => {
    const mockRuntime = createMockRuntime();
    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    const result = await orchestrator.execute({
      projectId: 'test-pin-project',
      agentId: 'test-pin-agent',
      goal: 'Summarize the key benefits of using TypeScript for large-scale applications.',
      topology: 'SEQUENTIAL',
      effortLevel: 'MODERATE',
    });

    assert.ok(result.id, 'Execution should return a run ID');

    // Verify the session was pinned during execution
    const pinned = orchestrator.getSessionPinnedConfig(result.id);
    assert.ok(pinned !== null, `Session ${result.id} should be pinned`);
    assert.strictEqual(pinned!.runId, result.id);
    assert.strictEqual(pinned!.topology, 'SEQUENTIAL');
    assert.strictEqual(pinned!.effortLevel, 'MODERATE');
    assert.strictEqual(pinned!.configHash.length, 8);
    assert.ok(/^[0-9a-f]{8}$/.test(pinned!.configHash));
    assert.ok(new Date(pinned!.pinnedAt).getTime() > 0, 'pinnedAt should be a valid ISO timestamp');
  });

  it('pinned modelTierMapping and qualityGateThresholds match orchestrator config', async () => {
    const mockRuntime = createMockRuntime();
    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    const result = await orchestrator.execute({
      projectId: 'test-pin-config',
      agentId: 'test-pin-config-agent',
      goal: 'Explain the difference between async/await and Promises in JavaScript.',
      topology: 'SINGLE',
      effortLevel: 'SIMPLE',
    });

    const pinned = orchestrator.getSessionPinnedConfig(result.id)!;
    const config = orchestrator.getConfig();

    // Model tier mapping should match
    for (const [effortLevel, model] of Object.entries(config.modelTierMapping)) {
      assert.strictEqual(
        pinned.modelTierMapping[effortLevel],
        model,
        `modelTierMapping.${effortLevel} should match orchestrator config`,
      );
    }

    // Quality gate thresholds should match
    for (const gate of config.qualityGates) {
      assert.strictEqual(
        pinned.qualityGateThresholds[gate.name],
        gate.threshold,
        `qualityGateThresholds.${gate.name} should match orchestrator config`,
      );
    }
  });

  it('multiple execute() calls each produce distinct pinned sessions', async () => {
    const mockRuntime = createMockRuntime();
    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    const result1 = await orchestrator.execute({
      projectId: 'test-multi-1',
      agentId: 'test-multi-agent-1',
      goal: 'What is TypeScript?',
      topology: 'SINGLE',
      effortLevel: 'SIMPLE',
    });

    const result2 = await orchestrator.execute({
      projectId: 'test-multi-2',
      agentId: 'test-multi-agent-2',
      goal: 'Explain the Node.js event loop in detail for a developer audience.',
      topology: 'PARALLEL',
      effortLevel: 'MODERATE',
    });

    const pinned1 = orchestrator.getSessionPinnedConfig(result1.id);
    const pinned2 = orchestrator.getSessionPinnedConfig(result2.id);

    assert.ok(pinned1 !== null, 'First session should be pinned');
    assert.ok(pinned2 !== null, 'Second session should be pinned');
    assert.notStrictEqual(pinned1!.runId, pinned2!.runId);
    assert.strictEqual(pinned1!.topology, 'SINGLE');
    assert.strictEqual(pinned2!.topology, 'PARALLEL');
    assert.strictEqual(pinned1!.effortLevel, 'SIMPLE');
    assert.strictEqual(pinned2!.effortLevel, 'MODERATE');
    // Different runs → different pinnedAt timestamps
    assert.notStrictEqual(pinned1!.pinnedAt, pinned2!.pinnedAt);
    // Same config → same config hash
    assert.strictEqual(pinned1!.configHash, pinned2!.configHash);
  });

  it('pinned session is retrievable after execute() completes (not cleaned up)', async () => {
    const mockRuntime = createMockRuntime();
    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    const result = await orchestrator.execute({
      projectId: 'test-persist',
      agentId: 'test-persist-agent',
      goal: 'List three advantages of functional programming.',
      effortLevel: 'SIMPLE',
    });

    // Session should still be retrievable after execution completes
    const pinned = orchestrator.getSessionPinnedConfig(result.id);
    assert.ok(
      pinned !== null,
      'Pinned session should persist after execute() completes (not cleaned up by finally block)',
    );
    assert.strictEqual(pinned!.runId, result.id);
  });

  it('pinned session count increases with each execute() call', async () => {
    const mockRuntime = createMockRuntime();
    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    const before = orchestrator.getPinnedSessionCount();

    await orchestrator.execute({
      projectId: 'test-count',
      agentId: 'test-count-agent',
      goal: 'What are the SOLID principles?',
      topology: 'SINGLE',
      effortLevel: 'SIMPLE',
    });

    const after = orchestrator.getPinnedSessionCount();
    assert.strictEqual(
      after,
      before + 1,
      `Pinned session count should increase by 1 after execute(), got ${before} → ${after}`,
    );
  });
});

// ============================================================================
// Shadow Mode — Integration (full execute() pipeline with challenger)
// ============================================================================

/** Feed MetaLearner experiences so selectShadowStrategy returns a runner-up. */
function feedShadowExperiences(taskType: string): void {
  const ml = getMetaLearner();
  const makeExp = (
    id: string,
    strategy: string,
    success: boolean,
    durationMs: number,
    tokenCost: number,
  ): ExecutionExperience => ({
    id,
    runId: id,
    agentId: 'test-shadow-agent',
    taskType,
    modelUsed: 'test-model',
    strategyUsed: strategy,
    success,
    durationMs,
    tokenCost,
    lessons: [],
    timestamp: new Date().toISOString(),
  });
  // Primary strategy: SEQUENTIAL (10 successes)
  for (let i = 0; i < 10; i++) {
    ml.recordExperience(makeExp(`shadow-feed-seq-${i}`, 'SEQUENTIAL', true, 3000, 500));
  }
  // Runner-up: PARALLEL (5 successes)
  for (let i = 0; i < 5; i++) {
    ml.recordExperience(makeExp(`shadow-feed-par-${i}`, 'PARALLEL', true, 2000, 400));
  }
}

describe('Shadow Mode — Integration', () => {
  // Ensure MetaLearner isolation: clear state before each shadow test
  function resetShadowState(): void {
    clearMetaLearnerState();
  }

  it('shadow mode runs challenger strategy and records comparison in MetaLearner', async () => {
    resetShadowState();
    feedShadowExperiences('SEQUENTIAL');

    // Track runtime.execute calls to observe shadow execution
    const executeCalls: Array<{ agentId: string; tools: string[] }> = [];
    const mockRuntime = createMockRuntime();
    const originalExecute = mockRuntime.execute;
    mockRuntime.execute = async (ctx) => {
      executeCalls.push({
        agentId: ctx.agentId as string,
        tools: (ctx.availableTools as string[]) ?? [],
      });
      return originalExecute(ctx);
    };

    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    const beforeComparisons = getMetaLearner().getShadowComparisons().length;

    await orchestrator.execute({
      projectId: 'test-shadow',
      agentId: 'test-shadow-agent',
      goal: 'Summarize the key features of TypeScript for a developer audience.',
      topology: 'SEQUENTIAL',
      effortLevel: 'MODERATE',
    });

    // Verify shadow comparison was recorded
    const comparisons = getMetaLearner().getShadowComparisons();
    assert.ok(
      comparisons.length > beforeComparisons,
      `Expected shadow comparisons to increase from ${beforeComparisons}, got ${comparisons.length}`,
    );

    const latest = comparisons[comparisons.length - 1];
    assert.ok(
      latest.mainStrategy.includes('SEQUENTIAL'),
      `mainStrategy should include SEQUENTIAL, got: ${latest.mainStrategy}`,
    );
    assert.ok(
      latest.shadowStrategy.length > 0,
      `shadowStrategy should be non-empty, got: ${latest.shadowStrategy}`,
    );
    assert.notStrictEqual(
      latest.shadowStrategy,
      latest.mainStrategy,
      'Shadow strategy should differ from main strategy',
    );

    // Verify shadow execution call was made
    const shadowCalls = executeCalls.filter((c) => c.agentId.startsWith('shadow-'));
    assert.ok(
      shadowCalls.length >= 1,
      `Expected at least 1 shadow execute call, got ${shadowCalls.length}`,
    );
  });

  it('shadow execution filters out write tools (read-only execution)', async () => {
    resetShadowState();
    feedShadowExperiences('SEQUENTIAL');

    // Rich tool list including write tools
    const allTools = ['file_read', 'file_write', 'file_edit', 'web_search', 'grep', 'bash'];

    const executeCalls: Array<{ agentId: string; tools: string[] }> = [];
    const mockRuntime = createMockRuntime();
    const originalExecute = mockRuntime.execute;
    mockRuntime.execute = async (ctx) => {
      executeCalls.push({
        agentId: ctx.agentId as string,
        tools: (ctx.availableTools as string[]) ?? [],
      });
      return originalExecute(ctx);
    };

    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    await orchestrator.execute({
      projectId: 'test-shadow-tools',
      agentId: 'test-shadow-tools-agent',
      goal: 'Summarize TypeScript benefits.',
      topology: 'SEQUENTIAL',
      effortLevel: 'MODERATE',
      contextData: { availableTools: allTools },
    });

    // Find the shadow execution call
    const shadowCall = executeCalls.find((c) => c.agentId.startsWith('shadow-'));
    assert.ok(shadowCall, 'Shadow execution should have been triggered');

    // Verify write tools are filtered out of shadow execution
    const writeTools = ['file_write', 'file_edit', 'apply_patch', 'git', 'shell_execute'];
    const leakedWriteTools = shadowCall!.tools.filter((t) => writeTools.includes(t));
    assert.strictEqual(
      leakedWriteTools.length,
      0,
      `Shadow execution should not receive write tools, got: ${leakedWriteTools.join(', ')}`,
    );

    // Verify read tools are preserved
    assert.ok(
      shadowCall!.tools.includes('file_read'),
      'Shadow execution should retain read tools like file_read',
    );
    assert.ok(
      shadowCall!.tools.includes('web_search'),
      'Shadow execution should retain safe tools like web_search',
    );
  });

  it('shadow mode is skipped when MetaLearner has insufficient data (no challenger)', async () => {
    resetShadowState();
    // After clearing state, selectShadowStrategy returns null — no challenger available
    const executeCalls: Array<{ agentId: string }> = [];
    const mockRuntime = createMockRuntime();
    const originalExecute = mockRuntime.execute;
    mockRuntime.execute = async (ctx) => {
      executeCalls.push({ agentId: ctx.agentId as string });
      return originalExecute(ctx);
    };

    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    const beforeComparisons = getMetaLearner().getShadowComparisons().length;

    await orchestrator.execute({
      projectId: 'test-shadow-skip',
      agentId: 'test-shadow-skip-agent',
      goal: 'What is 2+2?',
      topology: 'SINGLE',
      effortLevel: 'SIMPLE',
    });

    // No shadow calls should have been made
    const shadowCalls = executeCalls.filter((c) => c.agentId.startsWith('shadow-'));
    assert.strictEqual(
      shadowCalls.length,
      0,
      'No shadow execution should happen without a challenger',
    );

    // No new shadow comparison should be recorded
    const comparisons = getMetaLearner().getShadowComparisons();
    assert.strictEqual(
      comparisons.length,
      beforeComparisons,
      'Shadow comparisons should not increase without a challenger',
    );
  });

  it('shadow comparison records correct success/failure and timing', async () => {
    resetShadowState();
    feedShadowExperiences('SEQUENTIAL');

    const mockRuntime = createMockRuntime();
    const telos = new TELOSOrchestrator(mockRuntime);
    const orchestrator = new UltimateOrchestrator(telos, mockRuntime);

    await orchestrator.execute({
      projectId: 'test-shadow-timing',
      agentId: 'test-shadow-timing-agent',
      goal: 'Explain the benefits of statically typed languages.',
      topology: 'SEQUENTIAL',
      effortLevel: 'MODERATE',
    });

    const comparisons = getMetaLearner().getShadowComparisons();
    const latest = comparisons[comparisons.length - 1];

    // Verify comparison fields are populated
    assert.ok(latest.runId.length > 0);
    assert.ok(latest.taskType.length > 0);
    assert.strictEqual(typeof latest.mainSuccess, 'boolean');
    assert.strictEqual(typeof latest.shadowSuccess, 'boolean');
    assert.ok(latest.mainDurationMs >= 0);
    assert.ok(latest.shadowDurationMs >= 0);
    assert.ok(new Date(latest.timestamp).getTime() > 0);

    // mainSuccess should be true (mock runtime returns success)
    assert.strictEqual(latest.mainSuccess, true, 'Main execution should succeed with mock runtime');
    // shadowSuccess should be true (mock runtime returns success)
    assert.strictEqual(
      latest.shadowSuccess,
      true,
      'Shadow execution should succeed with mock runtime',
    );
  });
});
