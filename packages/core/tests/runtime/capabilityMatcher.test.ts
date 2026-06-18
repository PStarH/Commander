import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityMatcher, DEFAULT_NUCLEUS } from '../../src/runtime/capabilityMatcher';

describe('CapabilityMatcher', () => {
  let matcher: CapabilityMatcher;

  beforeEach(() => {
    matcher = new CapabilityMatcher();
  });

  describe('initialization', () => {
    it('initializes with default nucleus agents', () => {
      const pool = matcher.getPool();
      assert.ok(pool.length >= DEFAULT_NUCLEUS.length);
      assert.ok(pool.some((a) => a.agentId === 'nucleus-coder'));
      assert.ok(pool.some((a) => a.agentId === 'nucleus-reviewer'));
      assert.ok(pool.some((a) => a.agentId === 'nucleus-researcher'));
      assert.ok(pool.some((a) => a.agentId === 'nucleus-orchestrator'));
    });

    it('all nucleus agents are available', () => {
      const available = matcher.getAvailableAgents();
      assert.ok(available.length >= DEFAULT_NUCLEUS.length);
    });
  });

  describe('match', () => {
    it('matches simple coding task to nucleus-coder', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      assert.ok(result.agents.length > 0);
      assert.ok(result.agents.some((a) => a.capabilities.includes('typescript')));
      assert.ok(result.confidence > 0);
    });

    it('matches review task to nucleus-reviewer', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['code_review', 'security'],
        complexity: 5,
        priority: 7,
      });
      assert.ok(result.agents.some((a) => a.agentId === 'nucleus-reviewer'));
    });

    it('matches research task to nucleus-researcher', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['web_search', 'research'],
        complexity: 3,
        priority: 5,
      });
      assert.ok(result.agents.some((a) => a.agentId === 'nucleus-researcher'));
    });

    it('reports fullyCovered when all capabilities are matched', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript', 'testing'],
        complexity: 3,
        priority: 5,
      });
      assert.ok(result.fullyCovered);
    });

    it('reports missingCapabilities when not fully covered', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript', 'quantum_computing'],
        complexity: 3,
        priority: 5,
      });
      assert.ok(result.missingCapabilities.includes('quantum_computing'));
    });

    it('estimates token cost', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 5,
        priority: 5,
      });
      assert.ok(result.estimatedTokenCost > 0);
    });

    it('returns reuse strategy when existing agents suffice', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      assert.equal(result.strategy, 'reuse');
    });

    it('limits agents based on complexity', async () => {
      const simple = await matcher.match({
        requiredCapabilities: ['typescript', 'testing', 'security', 'research'],
        complexity: 1,
        priority: 5,
      });
      const complex = await matcher.match({
        requiredCapabilities: ['typescript', 'testing', 'security', 'research'],
        complexity: 9,
        priority: 5,
      });
      // Simple tasks should get fewer agents
      assert.ok(simple.agents.length <= complex.agents.length);
    });

    it('respects maxAgents parameter', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript', 'testing', 'security', 'research', 'code_review'],
        complexity: 8,
        priority: 5,
        maxAgents: 2,
      });
      assert.ok(result.agents.length <= 2);
    });

    it('skips unavailable agents', async () => {
      // Mark nucleus-coder as unavailable
      const coder = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!;
      coder.available = false;
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      assert.ok(!result.agents.some((a) => a.agentId === 'nucleus-coder'));
    });

    it('skips agents at max concurrency', async () => {
      const coder = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!;
      coder.activeTasks = coder.maxConcurrent;
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      assert.ok(!result.agents.some((a) => a.agentId === 'nucleus-coder'));
    });
  });

  describe('updateAgentScore', () => {
    it('updates quality score on success', () => {
      const before = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.qualityScore;
      matcher.updateAgentScore('nucleus-coder', { success: true, quality: 1.0 });
      const after = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.qualityScore;
      assert.ok(after > before);
    });

    it('decreases quality score on failure', () => {
      const before = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.qualityScore;
      matcher.updateAgentScore('nucleus-coder', { success: false });
      const after = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.qualityScore;
      assert.ok(after < before);
    });

    it('ignores non-existent agent', () => {
      // Should not throw
      matcher.updateAgentScore('nonexistent', { success: true });
    });
  });

  describe('registerAgent / removeAgent', () => {
    it('registers a new agent', () => {
      matcher.registerAgent({
        agentId: 'custom-agent',
        capabilities: ['rust'],
        tools: ['file_read'],
        modelTier: 'standard',
        costPerToken: 0.001,
        qualityScore: 0.8,
        speedScore: 0.7,
        role: 'electron',
        specialization: 0.9,
        available: true,
        activeTasks: 0,
        maxConcurrent: 1,
      });
      assert.ok(matcher.getPool().some((a) => a.agentId === 'custom-agent'));
    });

    it('removes an agent', () => {
      matcher.removeAgent('nucleus-coder');
      assert.ok(!matcher.getPool().some((a) => a.agentId === 'nucleus-coder'));
    });
  });

  describe('confidence calculation', () => {
    it('returns higher confidence for better matches', async () => {
      const goodMatch = await matcher.match({
        requiredCapabilities: ['typescript', 'testing'],
        complexity: 3,
        priority: 5,
      });
      const poorMatch = await matcher.match({
        requiredCapabilities: ['nonexistent_capability'],
        complexity: 3,
        priority: 5,
      });
      assert.ok(goodMatch.confidence > poorMatch.confidence);
    });
  });

  describe('electron creation', () => {
    it('creates electron agents when createAgentFn is provided', async () => {
      const electronMatcher = new CapabilityMatcher(
        {},
        async (profile) =>
          ({
            ...profile,
            agentId: `electron-${profile.capabilities![0]}`,
          }) as any,
      );
      const result = await electronMatcher.match({
        requiredCapabilities: ['quantum_computing'],
        complexity: 8,
        priority: 5,
      });
      // Should have created an electron for the missing capability
      assert.ok(result.agents.some((a) => a.agentId === 'electron-quantum_computing'));
    });
  });
});

describe('DEFAULT_NUCLEUS', () => {
  it('has 4 nucleus agents', () => {
    assert.equal(DEFAULT_NUCLEUS.length, 4);
  });

  it('all nucleus agents have role=nucleus', () => {
    assert.ok(DEFAULT_NUCLEUS.every((a) => a.role === 'nucleus'));
  });

  it('all nucleus agents are available', () => {
    assert.ok(DEFAULT_NUCLEUS.every((a) => a.available));
  });

  it('nucleus agents have unique IDs', () => {
    const ids = DEFAULT_NUCLEUS.map((a) => a.agentId);
    assert.equal(new Set(ids).size, ids.length);
  });
});
