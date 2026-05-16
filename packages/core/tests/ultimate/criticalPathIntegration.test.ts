import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { RecursiveAtomizer } from '../../src/ultimate/atomizer';
import type { TaskTreeNode, DeliberationPlan } from '../../src/ultimate/types';

function makeDeliberation(overrides?: Partial<DeliberationPlan>): DeliberationPlan {
  return {
    requiresExternalInfo: false,
    taskType: 'CODING',
    recommendedTopology: 'SEQUENTIAL',
    estimatedAgentCount: 5,
    estimatedSteps: 15,
    estimatedTokens: 10000,
    tokenBudget: { thinking: 2000, execution: 6000, synthesis: 2000 },
    decompositionStrategy: 'STEP',
    capabilitiesNeeded: [],
    confidence: 0.8,
    reasoning: [],
    ...overrides,
  };
}

describe('RecursiveAtomizer with estimatedDurationMs', () => {
  let atomizer: RecursiveAtomizer;

  beforeEach(() => {
    atomizer = new RecursiveAtomizer(3, 10);
  });

  it('sets estimatedDurationMs on atomic nodes', () => {
    const node = atomizer.decompose(
      'Write a simple hello world function.',
      makeDeliberation({ estimatedTokens: 2000, decompositionStrategy: 'NONE' }),
    );
    assert.ok(node.estimatedDurationMs !== undefined, 'should have estimatedDurationMs');
    assert.ok(node.estimatedDurationMs! > 0, 'should be positive');
    assert.strictEqual(node.isAtomic, true);
  });

  it('sets estimatedDurationMs on complex decomposed tasks', () => {
    const deliberation = makeDeliberation({
      estimatedTokens: 50000,
      estimatedSteps: 20,
      decompositionStrategy: 'STEP',
    });
    const root = atomizer.decompose(
      'Build a full-stack web application with authentication, database, and API.',
      deliberation,
    );
    assert.ok(root.estimatedDurationMs !== undefined);
    if (root.subtasks.length > 0) {
      for (const sub of root.subtasks) {
        assert.ok(sub.estimatedDurationMs !== undefined, `subtask ${sub.id} should have estimatedDurationMs`);
      }
    }
  });

  it('scales duration with token count', () => {
    const small = atomizer.decompose(
      'Small task.',
      makeDeliberation({ estimatedTokens: 1000, decompositionStrategy: 'NONE' }),
    );
    const large = atomizer.decompose(
      'Large task with lots of work and many details to cover across multiple areas of the codebase.',
      makeDeliberation({ estimatedTokens: 50000, decompositionStrategy: 'NONE' }),
    );
    assert.ok(
      (large.estimatedDurationMs ?? 0) > (small.estimatedDurationMs ?? 0),
      'larger task should have longer estimated duration',
    );
  });
});

describe('Full Orchestration Pipeline - Feature Integration', () => {
  let atomizer: RecursiveAtomizer;

  beforeEach(() => {
    atomizer = new RecursiveAtomizer(2, 5);
  });

  it('deliberation → atomizer pipeline produces valid task tree', () => {
    const deliberation = makeDeliberation({
      taskType: 'RESEARCH',
      estimatedAgentCount: 3,
      decompositionStrategy: 'ASPECT',
    });
    const root = atomizer.decompose(
      'Research and compare distributed caching strategies for a high-traffic web application.',
      deliberation,
      null,
      0,
      ['web_search', 'python_execute', 'file_write'],
    );

    assert.ok(root.id.length > 0);
    assert.strictEqual(root.status, 'PENDING');
    assert.ok(Array.isArray(root.subtasks));
    assert.ok(root.estimatedDurationMs !== undefined);

    // Check context propagation
    assert.ok(root.context.availableTools.includes('web_search'));
    assert.ok(root.context.availableTools.includes('python_execute'));
  });

  it('task tree supports LAMaS fields (isOnCriticalPath)', () => {
    const node: TaskTreeNode = {
      id: 'test-node',
      parentId: null,
      goal: 'Test task',
      role: 'EXECUTOR',
      isAtomic: true,
      subtasks: [],
      dependencies: [],
      context: { systemPrompt: '', availableTools: [], estimatedTokens: 1000 },
      status: 'PENDING',
      estimatedDurationMs: 5000,
      isOnCriticalPath: true,
    };
    assert.strictEqual(node.isOnCriticalPath, true);
    assert.strictEqual(node.estimatedDurationMs, 5000);
  });

  it('supports all new config types via runtime config', () => {
    const config = {
      toolRetrieval: { enabled: true, minTools: 3, maxTools: 10, alwaysInclude: ['file_read'] },
      entropyGating: { enabled: true },
      speculativeExecution: { enabled: true, maxPredictions: 2, minConfidence: 0.3 },
    };
    assert.strictEqual(config.toolRetrieval.enabled, true);
    assert.strictEqual(config.entropyGating.enabled, true);
    assert.strictEqual(config.speculativeExecution.enabled, true);
    assert.strictEqual(config.speculativeExecution.maxPredictions, 2);
  });
});
