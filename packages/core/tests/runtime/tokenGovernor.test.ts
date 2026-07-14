import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TokenGovernor,
  TokenBudgetManager,
  TenantBudgetExhaustedError,
  getTokenGovernor,
  resetTokenGovernor,
  getTokenBudgetManager,
  resetTokenBudgetManager,
} from '../../src/runtime/tokenGovernor';
import {
  setGlobalTenantProvider,
  resetGlobalTenantProvider,
  SimpleTenantProvider,
} from '../../src/runtime/tenantProvider';
import { runWithTenant } from '../../src/runtime/tenantContext';

describe('TokenGovernor', () => {
  it('starts in relaxed phase', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    const state = gov.getState();
    expect(state.phase).toBe('relaxed');
    expect(state.pressure).toBe(0);
    expect(state.remainingTokens).toBe(10000);
  });

  it('transitions to moderate phase', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reportUsage(5000); // 50%
    const state = gov.getState();
    expect(state.phase).toBe('moderate');
    expect(state.pressure).toBeGreaterThanOrEqual(0.4);
  });

  it('transitions to tight phase', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reportUsage(7000); // 70%
    const state = gov.getState();
    expect(state.phase).toBe('tight');
    expect(state.pressure).toBeGreaterThanOrEqual(0.65);
  });

  it('transitions to critical phase', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reportUsage(9000); // 90%
    const state = gov.getState();
    expect(state.phase).toBe('critical');
    expect(state.pressure).toBeGreaterThanOrEqual(0.85);
  });

  it('resets usage', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reportUsage(5000);
    gov.reset();
    const state = gov.getState();
    expect(state.usedTokens).toBe(0);
    expect(state.phase).toBe('relaxed');
  });

  it('resets with new budget', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reset(20000);
    const state = gov.getState();
    expect(state.totalBudget).toBe(20000);
  });

  describe('getRecommendations', () => {
    it('returns baseline masking in relaxed phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const recs = gov.getRecommendations();
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.some((r) => r.strategy === 'observation_mask')).toBe(true);
    });

    it('returns more strategies in moderate phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(5000);
      const recs = gov.getRecommendations();
      expect(recs.length).toBeGreaterThan(1);
      expect(recs.some((r) => r.strategy === 'tool_output_truncate')).toBe(true);
    });

    it('returns aggressive strategies in critical phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(9000);
      const recs = gov.getRecommendations();
      expect(recs.some((r) => r.strategy === 'verification_skip')).toBe(true);
      expect(recs.some((r) => r.strategy === 'context_compaction')).toBe(true);
      expect(recs.some((r) => r.strategy === 'speculative_skip')).toBe(true);
    });

    it('caches recommendations within same phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const recs1 = gov.getRecommendations();
      const recs2 = gov.getRecommendations();
      expect(recs1).toBe(recs2); // Same reference = cached
    });

    it('invalidates cache on reportUsage', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const recs1 = gov.getRecommendations();
      gov.reportUsage(5000);
      const recs2 = gov.getRecommendations();
      expect(recs1).not.toBe(recs2); // Different reference = recomputed
    });
  });

  describe('shouldApply', () => {
    it('returns apply=true for observation_mask in relaxed', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const result = gov.shouldApply('observation_mask');
      expect(result.apply).toBe(true);
      expect(result.intensity).toBeGreaterThan(0);
    });

    it('returns apply=false for strategies not in current phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const result = gov.shouldApply('speculative_skip');
      expect(result.apply).toBe(false);
    });
  });

  describe('task type awareness', () => {
    it('boosts response_format for structured tasks', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(5000); // moderate
      gov.setTaskCategory('structured');
      const recs = gov.getRecommendations();
      const rf = recs.find((r) => r.strategy === 'response_format');
      expect(rf).toBeDefined();
      expect(rf!.intensity).toBeGreaterThan(0.3);
    });

    it('reduces response_format for creative tasks', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(5000); // moderate
      gov.setTaskCategory('creative');
      const recs = gov.getRecommendations();
      const rf = recs.find((r) => r.strategy === 'response_format');
      // Should be reduced or not present for creative tasks
      if (rf) {
        expect(rf.intensity).toBeLessThanOrEqual(0.3);
      }
    });

    it('reduces verification_skip for code tasks in tight phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(7000); // tight
      gov.setTaskCategory('code');
      const recs = gov.getRecommendations();
      const vs = recs.find((r) => r.strategy === 'verification_skip');
      expect(vs).toBeDefined();
      // Code tasks should have lower verification skip intensity
      expect(vs!.intensity).toBeLessThan(0.5);
    });
  });

  describe('learning', () => {
    it('records outcomes', () => {
      const gov = new TokenGovernor({ totalBudget: 10000, enableLearning: true });
      gov.recordOutcome('observation_mask', 1000, 800);
      gov.recordOutcome('observation_mask', 1000, 900);
      gov.recordOutcome('observation_mask', 1000, 700);
      // Should not throw
    });

    it('demotes ineffective strategies', () => {
      const gov = new TokenGovernor({ totalBudget: 10000, enableLearning: true });
      // Record many ineffective outcomes
      for (let i = 0; i < 10; i++) {
        gov.recordOutcome('tool_output_truncate', 1000, 1000); // no savings
      }
      gov.reportUsage(5000); // moderate phase
      const recs = gov.getRecommendations();
      const tot = recs.find((r) => r.strategy === 'tool_output_truncate');
      // Should be demoted
      if (tot) {
        expect(tot.apply).toBe(false);
      }
    });

    it('reduces intensity for moderately ineffective strategies', () => {
      const gov = new TokenGovernor({ totalBudget: 10000, enableLearning: true });
      // 50/50 effectiveness
      for (let i = 0; i < 6; i++) {
        gov.recordOutcome('response_format', 1000, i % 2 === 0 ? 900 : 1000);
      }
      gov.reportUsage(5000);
      const recs = gov.getRecommendations();
      const rf = recs.find((r) => r.strategy === 'response_format');
      if (rf) {
        expect(rf.intensity).toBeLessThanOrEqual(0.3);
      }
    });

    it('boosts intensity for highly effective strategies', () => {
      const gov = new TokenGovernor({ totalBudget: 10000, enableLearning: true });
      for (let i = 0; i < 6; i++) {
        gov.recordOutcome('response_format', 1000, 100); // always saves
      }
      gov.reportUsage(5000);
      const recs = gov.getRecommendations();
      const rf = recs.find((r) => r.strategy === 'response_format');
      if (rf) {
        expect(rf.intensity).toBeGreaterThan(0.3);
      }
    });

    it('ignores outcomes when learning is disabled', () => {
      const gov = new TokenGovernor({ totalBudget: 10000, enableLearning: false });
      gov.recordOutcome('observation_mask', 1000, 500);
      // Should not throw and should not affect recommendations
      const recs = gov.getRecommendations();
      expect(recs.length).toBeGreaterThan(0);
    });

    it('evicts oldest record from ring buffer when full', () => {
      const gov = new TokenGovernor({ totalBudget: 10000, enableLearning: true });
      for (let i = 0; i < 510; i++) {
        gov.recordOutcome('observation_mask', 1000, 500);
      }
      // Should not throw; cache invalidation happens on each record
      expect(gov.getRecommendations().length).toBeGreaterThan(0);
    });
  });

  describe('estimateTokens', () => {
    it('estimates English text', () => {
      const tokens = TokenGovernor.estimateTokens('hello world test');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(10);
    });

    it('estimates CJK text with higher ratio', () => {
      const en = TokenGovernor.estimateTokens('abcd');
      const zh = TokenGovernor.estimateTokens('你好世界');
      // CJK should produce more tokens per char
      expect(zh).toBeGreaterThan(en);
    });
  });

  describe('budget estimation', () => {
    it('returns remaining tokens for a component ratio', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(2000);
      expect(gov.remainingForComponent(0.5)).toBe(4000);
    });
  });
});

describe('TokenGovernor — per-run budget tracking', () => {
  let gov: TokenGovernor;

  beforeEach(() => {
    vi.useFakeTimers();
    gov = new TokenGovernor({ totalBudget: 100000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a run and returns status', () => {
    const status = gov.startRun('run-1', { hardCap: 10000 });
    expect(status.runId).toBe('run-1');
    expect(status.hardCap).toBe(10000);
    expect(status.softCap).toBe(8000);
    expect(status.phase).toBe('relaxed');
  });

  it('uses custom soft cap when provided', () => {
    const status = gov.startRun('run-1', { hardCap: 10000, softCap: 5000 });
    expect(status.softCap).toBe(5000);
  });

  it('allocates equal shares when total estimate is zero', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    const allocations = gov.allocateToSubAgents('run-1', [
      { nodeId: 'a', estimatedTokens: 0 },
      { nodeId: 'b', estimatedTokens: 0 },
    ]);
    expect(allocations.get('a')).toBe(5000);
    expect(allocations.get('b')).toBe(5000);
  });

  it('allocates proportionally to sub-agents', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    const allocations = gov.allocateToSubAgents('run-1', [
      { nodeId: 'a', estimatedTokens: 1000 },
      { nodeId: 'b', estimatedTokens: 3000 },
    ]);
    expect(allocations.get('a')).toBe(2250); // 25% of 9000 reserve
    expect(allocations.get('b')).toBe(6750); // 75% of 9000 reserve
  });

  it('returns empty allocations for unknown run', () => {
    const allocations = gov.allocateToSubAgents('missing', [
      { nodeId: 'a', estimatedTokens: 1000 },
    ]);
    expect(allocations.size).toBe(0);
  });

  it('records run usage and detects warnings', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    const result = gov.recordRunUsage('run-1', 'a', 8500);
    expect(result.warning).toBe(true);
    expect(result.exceeded).toBe(false);
  });

  it('records run usage and detects exceeded', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    const result = gov.recordRunUsage('run-1', 'a', 10000);
    // warning is false when usage equals hardCap
    expect(result.warning).toBe(false);
    expect(result.exceeded).toBe(true);
  });

  it('tracks sub-agent hard cap exceeded', () => {
    gov.startRun('run-1', { hardCap: 1000 });
    gov.allocateToSubAgents('run-1', [{ nodeId: 'a', estimatedTokens: 100 }]);
    // reserve is 90% of hardCap -> allocated share = 900
    gov.recordRunUsage('run-1', 'a', 1200);
    const status = gov.getRunStatus('run-1');
    expect(status?.subAgents[0].hardCapExceeded).toBe(true);
  });

  it('marks sub-agent complete', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    gov.allocateToSubAgents('run-1', [{ nodeId: 'a', estimatedTokens: 1000 }]);
    gov.markSubAgentComplete('run-1', 'a', 900);
    const status = gov.getRunStatus('run-1');
    expect(status?.subAgents[0].status).toBe('completed');
  });

  it('returns null for unknown run status', () => {
    expect(gov.getRunStatus('missing')).toBeNull();
  });

  it('reports budget exceeded', () => {
    gov.startRun('run-1', { hardCap: 1000 });
    gov.recordRunUsage('run-1', 'a', 1000);
    expect(gov.isBudgetExceeded('run-1')).toBe(true);
  });

  it('returns remaining budget', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    gov.recordRunUsage('run-1', 'a', 3000);
    expect(gov.getRemainingBudget('run-1')).toBe(7000);
  });

  it('completes a run and removes tracking', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    gov.completeRun('run-1');
    expect(gov.getRunStatus('run-1')).toBeNull();
    expect(gov.getActiveBudgetCount()).toBe(0);
  });

  it('lists active budgets sorted by update time', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    vi.advanceTimersByTime(10);
    gov.startRun('run-2', { hardCap: 10000 });
    vi.advanceTimersByTime(10);
    gov.recordRunUsage('run-2', 'a', 100);
    const active = gov.getActiveBudgets();
    expect(active.length).toBe(2);
    expect(active[0].runId).toBe('run-2');
  });

  it('evicts oldest run when max active budgets exceeded', () => {
    for (let i = 0; i < 205; i++) {
      gov.startRun(`run-${i}`, { hardCap: 100 });
    }
    expect(gov.getActiveBudgetCount()).toBeLessThanOrEqual(200);
  });

  it('recordUsage alias works', () => {
    gov.startRun('run-1', { hardCap: 10000 });
    const result = gov.recordUsage('run-1', 'a', 9000);
    expect(result.warning).toBe(true);
  });
});

describe('TokenBudgetManager alias', () => {
  it('extends TokenGovernor', () => {
    const manager = new TokenBudgetManager({ totalBudget: 5000 });
    expect(manager.getState().totalBudget).toBe(5000);
  });
});

describe('TokenGovernor singletons', () => {
  it('getTokenGovernor returns the same instance', () => {
    resetTokenGovernor();
    const a = getTokenGovernor();
    const b = getTokenGovernor();
    expect(a).toBe(b);
  });

  it('resetTokenGovernor creates a new instance', () => {
    resetTokenGovernor();
    const a = getTokenGovernor();
    resetTokenGovernor();
    const b = getTokenGovernor();
    expect(a).not.toBe(b);
  });

  it('getTokenBudgetManager returns the same instance', () => {
    resetTokenBudgetManager();
    const a = getTokenBudgetManager();
    const b = getTokenBudgetManager();
    expect(a).toBe(b);
  });

  it('resetTokenBudgetManager creates a new instance', () => {
    resetTokenBudgetManager();
    const a = getTokenBudgetManager();
    resetTokenBudgetManager();
    const b = getTokenBudgetManager();
    expect(a).not.toBe(b);
  });
});

describe('TokenGovernor — tenant-level hard cap', () => {
  afterEach(() => {
    resetGlobalTenantProvider();
    delete process.env['TOKEN_BUDGET_HARD_CAP'];
  });

  it('does not throw by default even when tenant tokenBudget is exceeded', () => {
    const provider = new SimpleTenantProvider([
      {
        tenantId: 'default',
        tokenBudget: 100,
        maxConcurrency: 1,
        maxRunsPerMinute: 0,
        enabled: true,
      },
    ]);
    setGlobalTenantProvider(provider);

    const gov = new TokenGovernor({ totalBudget: 1000 });
    runWithTenant('default', () => {
      gov.reportUsage(150);
      expect(gov.getState().usedTokens).toBe(150);
    });
  });

  it('throws TenantBudgetExhaustedError from reportUsage when hardCap is enabled', () => {
    const provider = new SimpleTenantProvider([
      {
        tenantId: 'acme',
        tokenBudget: 100,
        maxConcurrency: 1,
        maxRunsPerMinute: 0,
        enabled: true,
        hardCap: true,
      },
    ]);
    setGlobalTenantProvider(provider);

    const gov = new TokenGovernor({ totalBudget: 1000 });
    runWithTenant('acme', () => {
      gov.reportUsage(80);
      expect(() => gov.reportUsage(30)).toThrow(TenantBudgetExhaustedError);
      expect(() => gov.reportUsage(30)).toThrow(/acme/);
    });
  });

  it('throws from recordUsage when the tenant hard cap is reached', () => {
    const provider = new SimpleTenantProvider([
      {
        tenantId: 'acme',
        tokenBudget: 100,
        maxConcurrency: 1,
        maxRunsPerMinute: 0,
        enabled: true,
        hardCap: true,
      },
    ]);
    setGlobalTenantProvider(provider);

    const gov = new TokenGovernor({ totalBudget: 1000 });
    runWithTenant('acme', () => {
      gov.startRun('run-1', { hardCap: 1000 });
      gov.recordUsage('run-1', 'agent-a', 80);
      expect(() => gov.recordUsage('run-1', 'agent-a', 25)).toThrow(TenantBudgetExhaustedError);
    });
  });

  it('throws from startRun when the tenant budget is already exhausted', () => {
    const provider = new SimpleTenantProvider([
      {
        tenantId: 'acme',
        tokenBudget: 50,
        maxConcurrency: 1,
        maxRunsPerMinute: 0,
        enabled: true,
        hardCap: true,
      },
    ]);
    setGlobalTenantProvider(provider);

    const gov = new TokenGovernor({ totalBudget: 1000 });
    runWithTenant('acme', () => {
      // Simulate a prior tracking path that left the tenant total over budget.
      (gov as unknown as Record<string, number>).tenantUsedTokens = 60;
      expect(() => gov.startRun('run-1', { hardCap: 1000 })).toThrow(TenantBudgetExhaustedError);
    });
  });

  it('throws from allocateToSubAgents when allocation would exceed tenant budget', () => {
    const provider = new SimpleTenantProvider([
      {
        tenantId: 'acme',
        tokenBudget: 100,
        maxConcurrency: 1,
        maxRunsPerMinute: 0,
        enabled: true,
        hardCap: true,
      },
    ]);
    setGlobalTenantProvider(provider);

    const gov = new TokenGovernor({ totalBudget: 1000 });
    runWithTenant('acme', () => {
      gov.startRun('run-1', { hardCap: 1000 });
      expect(() =>
        gov.allocateToSubAgents('run-1', [
          { nodeId: 'a', estimatedTokens: 60 },
          { nodeId: 'b', estimatedTokens: 60 },
        ]),
      ).toThrow(TenantBudgetExhaustedError);
    });
  });

  it('enables hard cap via TOKEN_BUDGET_HARD_CAP environment variable', () => {
    process.env['TOKEN_BUDGET_HARD_CAP'] = 'true';
    const provider = new SimpleTenantProvider([
      {
        tenantId: 'globex',
        tokenBudget: 50,
        maxConcurrency: 1,
        maxRunsPerMinute: 0,
        enabled: true,
      },
    ]);
    setGlobalTenantProvider(provider);

    const gov = new TokenGovernor({ totalBudget: 1000 });
    runWithTenant('globex', () => {
      gov.reportUsage(40);
      expect(() => gov.reportUsage(20)).toThrow(TenantBudgetExhaustedError);
    });
  });
});
