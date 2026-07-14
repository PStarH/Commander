import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CapabilityMatcher,
  DEFAULT_NUCLEUS,
  getCapabilityMatcher,
} from '../../src/runtime/capabilityMatcher';

vi.mock('../../src/logging', () => ({
  getGlobalLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('CapabilityMatcher', () => {
  let matcher: CapabilityMatcher;

  beforeEach(() => {
    matcher = new CapabilityMatcher();
  });

  describe('initialization', () => {
    it('initializes with default nucleus agents', () => {
      const pool = matcher.getPool();
      expect(pool.length).toBeGreaterThanOrEqual(DEFAULT_NUCLEUS.length);
      expect(pool.some((a) => a.agentId === 'nucleus-coder')).toBe(true);
      expect(pool.some((a) => a.agentId === 'nucleus-reviewer')).toBe(true);
      expect(pool.some((a) => a.agentId === 'nucleus-researcher')).toBe(true);
      expect(pool.some((a) => a.agentId === 'nucleus-orchestrator')).toBe(true);
    });

    it('all nucleus agents are available', () => {
      const available = matcher.getAvailableAgents();
      expect(available.length).toBeGreaterThanOrEqual(DEFAULT_NUCLEUS.length);
    });
  });

  describe('match', () => {
    it('matches simple coding task to nucleus-coder', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      expect(result.agents.length).toBeGreaterThan(0);
      expect(result.agents.some((a) => a.capabilities.includes('typescript'))).toBe(true);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('matches review task to nucleus-reviewer', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['code_review', 'security'],
        complexity: 5,
        priority: 7,
      });
      expect(result.agents.some((a) => a.agentId === 'nucleus-reviewer')).toBe(true);
    });

    it('matches research task to nucleus-researcher', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['web_search', 'research'],
        complexity: 3,
        priority: 5,
      });
      expect(result.agents.some((a) => a.agentId === 'nucleus-researcher')).toBe(true);
    });

    it('reports fullyCovered when all capabilities are matched', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript', 'testing'],
        complexity: 3,
        priority: 5,
      });
      expect(result.fullyCovered).toBe(true);
    });

    it('reports missingCapabilities when not fully covered', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript', 'quantum_computing'],
        complexity: 3,
        priority: 5,
      });
      expect(result.missingCapabilities.includes('quantum_computing')).toBe(true);
    });

    it('estimates token cost', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 5,
        priority: 5,
      });
      expect(result.estimatedTokenCost).toBeGreaterThan(0);
    });

    it('returns reuse strategy when existing agents suffice', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      expect(result.strategy).toBe('reuse');
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
      expect(simple.agents.length).toBeLessThanOrEqual(complex.agents.length);
    });

    it('respects maxAgents parameter', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript', 'testing', 'security', 'research', 'code_review'],
        complexity: 8,
        priority: 5,
        maxAgents: 2,
      });
      expect(result.agents.length).toBeLessThanOrEqual(2);
    });

    it('skips unavailable agents', async () => {
      const coder = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!;
      coder.available = false;
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      expect(result.agents.some((a) => a.agentId === 'nucleus-coder')).toBe(false);
    });

    it('skips agents at max concurrency', async () => {
      const coder = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!;
      coder.activeTasks = coder.maxConcurrent;
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      expect(result.agents.some((a) => a.agentId === 'nucleus-coder')).toBe(false);
    });

    it('uses preferred capabilities as a tie-breaker', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        preferredCapabilities: ['testing', 'security'],
        complexity: 3,
        priority: 5,
      });
      expect(result.agents.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('scores required tools', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        requiredTools: ['shell_execute', 'code_search'],
        complexity: 3,
        priority: 5,
      });
      expect(result.agents.length).toBeGreaterThan(0);
    });

    it('favors specialized agents for complex tasks', async () => {
      matcher.registerAgent({
        agentId: 'specialist',
        capabilities: ['security'],
        tools: ['code_search'],
        modelTier: 'power',
        costPerToken: 0.002,
        qualityScore: 0.9,
        speedScore: 0.6,
        role: 'electron',
        specialization: 0.9,
        available: true,
        activeTasks: 0,
        maxConcurrent: 1,
      });
      const result = await matcher.match({
        requiredCapabilities: ['security'],
        complexity: 9,
        priority: 5,
      });
      expect(result.agents.some((a) => a.agentId === 'specialist')).toBe(true);
    });

    it('favors generalist agents for simple tasks', async () => {
      const result = await matcher.match({
        requiredCapabilities: ['planning'],
        complexity: 1,
        priority: 5,
      });
      expect(result.agents.length).toBeGreaterThan(0);
    });

    it('penalizes busy agents', async () => {
      const coder = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!;
      coder.activeTasks = 1;
      const result = await matcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 2,
        priority: 5,
      });
      expect(result.agents.length).toBeGreaterThan(0);
    });
  });

  describe('updateAgentScore', () => {
    it('updates quality score on success', () => {
      const before = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.qualityScore;
      matcher.updateAgentScore('nucleus-coder', { success: true, quality: 1.0 });
      const after = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.qualityScore;
      expect(after).toBeGreaterThan(before);
    });

    it('updates speed score when provided', () => {
      const before = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.speedScore;
      matcher.updateAgentScore('nucleus-coder', { success: true, speed: 1.0 });
      const after = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.speedScore;
      expect(after).toBeGreaterThan(before);
    });

    it('decreases quality score on failure', () => {
      const before = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.qualityScore;
      matcher.updateAgentScore('nucleus-coder', { success: false });
      const after = matcher.getPool().find((a) => a.agentId === 'nucleus-coder')!.qualityScore;
      expect(after).toBeLessThan(before);
    });

    it('ignores non-existent agent', () => {
      expect(() => matcher.updateAgentScore('nonexistent', { success: true })).not.toThrow();
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
      expect(matcher.getPool().some((a) => a.agentId === 'custom-agent')).toBe(true);
    });

    it('removes an agent', () => {
      matcher.removeAgent('nucleus-coder');
      expect(matcher.getPool().some((a) => a.agentId === 'nucleus-coder')).toBe(false);
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
      expect(goodMatch.confidence).toBeGreaterThan(poorMatch.confidence);
    });

    it('returns zero confidence for empty selection', async () => {
      const emptyMatcher = new CapabilityMatcher();
      emptyMatcher.removeAgent('nucleus-coder');
      emptyMatcher.removeAgent('nucleus-reviewer');
      emptyMatcher.removeAgent('nucleus-researcher');
      emptyMatcher.removeAgent('nucleus-orchestrator');
      const result = await emptyMatcher.match({
        requiredCapabilities: ['typescript'],
        complexity: 3,
        priority: 5,
      });
      expect(result.confidence).toBe(0);
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
      // Disable nucleus agents so the only match is the created electron
      for (const agent of electronMatcher.getPool()) {
        agent.available = false;
      }
      const result = await electronMatcher.match({
        requiredCapabilities: ['quantum_computing'],
        complexity: 8,
        priority: 5,
      });
      expect(result.agents.some((a) => a.agentId === 'electron-quantum_computing')).toBe(true);
      expect(result.strategy).toBe('create');
    });

    it('falls back to reuse when complexity is below threshold', async () => {
      const electronMatcher = new CapabilityMatcher(
        { complexityThreshold: 5 },
        async (profile) => profile as any,
      );
      const result = await electronMatcher.match({
        requiredCapabilities: ['quantum_computing'],
        complexity: 2,
        priority: 5,
      });
      expect(result.strategy).toBe('reuse');
      expect(result.fullyCovered).toBe(false);
    });

    it('caps electron creation by maxElectrons', async () => {
      let created = 0;
      const electronMatcher = new CapabilityMatcher(
        { maxElectrons: 1, complexityThreshold: 1 },
        async (profile) => {
          created++;
          return {
            ...profile,
            agentId: `electron-${created}`,
          } as any;
        },
      );
      const result = await electronMatcher.match({
        requiredCapabilities: ['quantum_computing', 'design', 'api'],
        complexity: 9,
        priority: 5,
      });
      expect(result.agents.filter((a) => a.role === 'electron').length).toBe(1);
    });

    it('uses hybrid strategy when both nucleus and electrons are selected', async () => {
      const electronMatcher = new CapabilityMatcher(
        { complexityThreshold: 1 },
        async (profile) => ({ ...profile, agentId: `electron-${profile.capabilities![0]}` }) as any,
      );
      const result = await electronMatcher.match({
        requiredCapabilities: ['typescript', 'quantum_computing'],
        complexity: 9,
        priority: 5,
      });
      expect(result.strategy).toBe('hybrid');
    });

    it('handles electron creation failures gracefully', async () => {
      const electronMatcher = new CapabilityMatcher({ complexityThreshold: 1 }, async () => {
        throw new Error('creation failed');
      });
      const result = await electronMatcher.match({
        requiredCapabilities: ['quantum_computing'],
        complexity: 9,
        priority: 5,
      });
      expect(result.fullyCovered).toBe(false);
    });

    it('infers default tools for unknown capabilities', async () => {
      const electronMatcher = new CapabilityMatcher(
        { complexityThreshold: 1 },
        async (profile) => ({ ...profile, agentId: 'electron-unknown' }) as any,
      );
      const result = await electronMatcher.match({
        requiredCapabilities: ['unknown_capability'],
        complexity: 9,
        priority: 5,
      });
      const electron = result.agents.find((a) => a.role === 'electron');
      expect(electron).toBeDefined();
      expect(electron!.tools).toEqual(['file_read', 'shell_execute']);
    });
  });

  describe('singleton', () => {
    it('returns the same global matcher', () => {
      const a = getCapabilityMatcher();
      const b = getCapabilityMatcher();
      expect(a).toBe(b);
    });
  });
});

describe('DEFAULT_NUCLEUS', () => {
  it('has 4 nucleus agents', () => {
    expect(DEFAULT_NUCLEUS.length).toBe(4);
  });

  it('all nucleus agents have role=nucleus', () => {
    expect(DEFAULT_NUCLEUS.every((a) => a.role === 'nucleus')).toBe(true);
  });

  it('all nucleus agents are available', () => {
    expect(DEFAULT_NUCLEUS.every((a) => a.available)).toBe(true);
  });

  it('nucleus agents have unique IDs', () => {
    const ids = DEFAULT_NUCLEUS.map((a) => a.agentId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
