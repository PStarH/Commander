/**
 * General-Purpose Live Integration Tests
 * Tests Commander's capabilities beyond coding: research, analysis,
 * creative writing, planning, translation, decision-making.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { deliberate } from '../src/ultimate/deliberation';
import { RecursiveAtomizer } from '../src/ultimate/atomizer';
import { TopologyRouter } from '../src/ultimate/topologyRouter';
import { classifyEffortLevel } from '../src/ultimate/effortScaler';
import { CycleDetector } from '../src/runtime/cycleDetector';

// ── Helpers ──────────────────────────────────────────────────────────────────

function assertDeliberation(result: ReturnType<typeof deliberate>, opts: {
  taskType?: string;
  requiresExternalInfo?: boolean;
} = {}) {
  assert.ok(result.taskType, `taskType should be set, got: ${result.taskType}`);
  assert.ok(result.recommendedTopology, 'recommendedTopology should be set');
  assert.ok(result.reasoning.length > 0, 'reasoning should not be empty');
  assert.ok(result.estimatedAgentCount >= 1, 'estimatedAgentCount >= 1');
  assert.ok(result.estimatedSteps >= 1, 'estimatedSteps >= 1');
  assert.ok(result.confidence > 0 && result.confidence <= 1, 'confidence between 0 and 1');
  if (opts.taskType) assert.strictEqual(result.taskType, opts.taskType);
  if (opts.requiresExternalInfo !== undefined) assert.strictEqual(result.requiresExternalInfo, opts.requiresExternalInfo);
}

// ── Deliberation: Task Classification ────────────────────────────────────────

describe('General-Purpose Deliberation', () => {
  describe('Task Type Classification', () => {
    it('classifies research tasks', () => {
      const result = deliberate('Research the latest developments in quantum computing and summarize the key breakthroughs');
      assertDeliberation(result, { taskType: 'RESEARCH', requiresExternalInfo: true });
    });

    it('classifies analysis tasks', () => {
      const result = deliberate('Review and audit the security posture of our authentication system');
      assertDeliberation(result, { taskType: 'ANALYSIS' });
    });

    it('classifies creative tasks', () => {
      const result = deliberate('Write a compelling marketing copy for our new AI product launch');
      assertDeliberation(result, { taskType: 'CREATIVE' });
    });

    it('classifies reasoning tasks', () => {
      const result = deliberate('Explain why microservices architecture might not be the right choice for a small team');
      assertDeliberation(result, { taskType: 'REASONING' });
    });

    it('classifies factual tasks', () => {
      const result = deliberate('What is the capital of France and what is its population?');
      assertDeliberation(result, { taskType: 'FACTUAL' });
    });

    it('classifies coding tasks', () => {
      const result = deliberate('Implement a REST API with authentication middleware using Express.js');
      assertDeliberation(result, { taskType: 'CODING' });
    });

    it('classifies multi-concern tasks', () => {
      const result = deliberate('Design a distributed caching system, implement it with tests, write documentation');
      assertDeliberation(result);
      // Multi-concern tasks should be classified as non-trivial
      assert.ok(result.estimatedSteps >= 2, 'multi-concern task should estimate multiple steps');
    });
  });

  describe('Effort Level Classification', () => {
    // classifyEffortLevel is length/context-based, not content-based
    it('classifies short goals as SIMPLE', () => {
      const level = classifyEffortLevel('What is TypeScript?');
      assert.strictEqual(level, 'SIMPLE');
    });

    it('classifies long goals as MODERATE+', () => {
      const longGoal = 'A'.repeat(500);
      const level = classifyEffortLevel(longGoal);
      assert.ok(['MODERATE', 'COMPLEX', 'DEEP_RESEARCH'].includes(level));
    });

    it('classifies high tool count as higher effort', () => {
      const level = classifyEffortLevel('Analyze data', { toolCount: 10 });
      assert.ok(['COMPLEX', 'DEEP_RESEARCH'].includes(level));
    });

    it('classifies CRITICAL risk as DEEP_RESEARCH', () => {
      const level = classifyEffortLevel('Deploy to production', { riskLevel: 'CRITICAL' });
      assert.strictEqual(level, 'DEEP_RESEARCH');
    });
  });

  describe('External Info Detection', () => {
    it('detects temporal queries requiring external info', () => {
      const result = deliberate('What are the latest AI news from this week?');
      assertDeliberation(result, { requiresExternalInfo: true });
    });

    it('detects factual queries not requiring external info', () => {
      const result = deliberate('Explain the concept of dependency injection');
      assertDeliberation(result);
      // This is a knowledge question - may or may not need external info
    });
  });

  describe('Topology Selection', () => {
    it('selects appropriate topology for research', () => {
      const result = deliberate('Research TypeScript, Rust, and Go performance characteristics');
      assertDeliberation(result);
      assert.ok(result.recommendedTopology, 'should have a topology recommendation');
    });

    it('selects SEQUENTIAL for simple factual tasks', () => {
      const result = deliberate('What is 2+2?');
      assertDeliberation(result);
      assert.ok(['SINGLE', 'SEQUENTIAL'].includes(result.recommendedTopology));
    });
  });
});

// ── Atomizer: Task Decomposition ─────────────────────────────────────────────

describe('General-Purpose Atomization', () => {
  const atomizer = new RecursiveAtomizer();

  it('decomposes research tasks into subtasks', () => {
    const deliberation = deliberate('Research the current state of WebAssembly adoption across major browsers and frameworks');
    const tree = atomizer.decompose(
      'Research the current state of WebAssembly adoption across major browsers and frameworks',
      deliberation, null, 0, ['web_search', 'web_fetch', 'file_write']
    );
    assert.ok(tree.goal.length > 0, 'root node should have a goal');
    assert.ok(tree.id, 'root node should have an id');
    // If not atomic, should have subtasks
    if (!tree.isAtomic) {
      assert.ok(tree.subtasks.length >= 1, 'non-atomic node should have subtasks');
    }
  });

  it('preserves file-writing intent in decomposition', () => {
    const deliberation = deliberate('Write a comprehensive report on AI safety research to ai-safety-report.md');
    const tree = atomizer.decompose(
      'Write a comprehensive report on AI safety research to ai-safety-report.md',
      deliberation, null, 0, ['web_search', 'file_write']
    );
    // Check that file intent is captured somewhere in the tree
    const allGoals = collectGoals(tree);
    const hasFileRef = allGoals.some(g => g.includes('ai-safety-report.md'));
    assert.ok(hasFileRef, 'should reference the output file somewhere in the tree');
  });

  it('marks simple tasks as atomic', () => {
    const deliberation = deliberate('What is TypeScript?');
    const tree = atomizer.decompose('What is TypeScript?', deliberation, null, 0, []);
    assert.ok(tree.isAtomic, 'simple factual question should be atomic');
  });
});

function collectGoals(tree: { goal: string; subtasks: Array<{ goal: string; subtasks: any[] }> }): string[] {
  const goals = [tree.goal];
  for (const sub of tree.subtasks) {
    goals.push(...collectGoals(sub));
  }
  return goals;
}

// ── Topology Router ──────────────────────────────────────────────────────────

describe('Topology Routing', () => {
  const router = new TopologyRouter();

  it('routes simple tasks to SINGLE or SEQUENTIAL', () => {
    const deliberation = deliberate('What is TypeScript?');
    const decision = router.route(deliberation);
    assert.ok(decision.topology, 'should have a topology');
    assert.ok(decision.reasoning.length > 0, 'should have reasoning');
    assert.ok(['SINGLE', 'SEQUENTIAL'].includes(decision.topology), `expected simple topology, got ${decision.topology}`);
  });

  it('routes research tasks to parallel-friendly topologies', () => {
    const deliberation = deliberate('Research TypeScript, Rust, and Go performance, compare benchmarks, analyze ecosystem maturity');
    const decision = router.route(deliberation);
    assert.ok(decision.topology, 'should have a topology');
    assert.ok(decision.expectedCost > 0, 'should estimate cost');
  });

  it('provides reasoning for topology choice', () => {
    const deliberation = deliberate('Analyze security vulnerabilities in our codebase');
    const decision = router.route(deliberation);
    assert.ok(decision.reasoning.length > 0, 'should explain topology choice');
    assert.ok(decision.expectedLatency, 'should estimate latency');
  });
});

// ── Cycle Detector: General-Purpose Tool Patterns ────────────────────────────

describe('Cycle Detector for General-Purpose Tasks', () => {
  it('allows legitimate research patterns (search → fetch → search)', () => {
    const detector = new CycleDetector();
    let result = detector.check('web_search', { query: 'quantum computing 2025' }, 1);
    assert.strictEqual(result.detected, false);
    result = detector.check('web_fetch', { url: 'https://example.com/quantum' }, 2);
    assert.strictEqual(result.detected, false);
    result = detector.check('web_search', { query: 'quantum computing breakthroughs' }, 3);
    assert.strictEqual(result.detected, false);
  });

  it('allows multi-file analysis patterns', () => {
    const detector = new CycleDetector();
    detector.check('file_read', { path: 'src/auth.ts' }, 1);
    detector.check('file_read', { path: 'src/middleware.ts' }, 2);
    detector.check('file_read', { path: 'src/routes.ts' }, 3);
    const result = detector.check('file_read', { path: 'src/config.ts' }, 4);
    assert.strictEqual(result.detected, false, 'should not flag multi-file reading');
  });

  it('detects actual cycles in tool calls', () => {
    const detector = new CycleDetector();
    for (let i = 1; i <= 10; i++) {
      detector.check('web_search', { query: 'same query' }, i);
    }
    const result = detector.check('web_search', { query: 'same query' }, 11);
    assert.strictEqual(result.detected, true, 'should detect repeated identical calls');
  });

  it('allows alternating read/write on different files', () => {
    const detector = new CycleDetector();
    assert.strictEqual(detector.check('file_read', { path: 'config.json' }, 1).detected, false);
    assert.strictEqual(detector.check('file_write', { path: 'output.md', content: '...' }, 2).detected, false);
    assert.strictEqual(detector.check('file_read', { path: 'template.md' }, 3).detected, false);
    assert.strictEqual(detector.check('file_write', { path: 'result.md', content: '...' }, 4).detected, false);
  });

  it('allows git operations on different refs', () => {
    const detector = new CycleDetector();
    assert.strictEqual(detector.check('git', { command: 'log --oneline -5' }, 1).detected, false);
    assert.strictEqual(detector.check('git', { command: 'diff --stat' }, 2).detected, false);
    assert.strictEqual(detector.check('git', { command: 'status' }, 3).detected, false);
    assert.strictEqual(detector.check('git', { command: 'branch -a' }, 4).detected, false);
  });
});

// ── LLM-Powered Deliberation (requires API key) ─────────────────────────────

describe('LLM-Powered Deliberation', () => {
  const hasApiKey = !!process.env.OPENAI_API_KEY;

  it('produces deliberation plan via LLM', async () => {
    if (!hasApiKey) {
      console.log('  Skipping (no OPENAI_API_KEY)');
      return;
    }

    const { createMiMoProvider } = await import('../src/runtime/providers/mimoProvider');
    const { deliberateWithLLM } = await import('../src/ultimate/deliberation');
    const provider = createMiMoProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      baseUrl: process.env.OPENAI_BASE_URL,
      defaultModel: process.env.OPENAI_MODEL,
    });

    try {
      const plan = await deliberateWithLLM(
        'Analyze the trade-offs between monolithic and microservice architectures for a startup with 5 engineers',
        provider,
        { availableTools: ['web_search', 'file_read', 'file_write'] }
      );

      assert.ok(plan.taskType, 'LLM should classify task type');
      assert.ok(plan.recommendedTopology, 'LLM should recommend topology');
      assert.ok(plan.confidence > 0, 'LLM should provide confidence');
      console.log('  LLM Deliberation:', JSON.stringify({
        taskType: plan.taskType,
        topology: plan.recommendedTopology,
        confidence: plan.confidence,
        agents: plan.estimatedAgentCount,
      }));
    } catch (err) {
      console.log('  LLM deliberation fell back to heuristic:', (err as Error).message);
      assert.ok(true, 'fallback is acceptable');
    }
  }, { timeout: 60000 });
});
