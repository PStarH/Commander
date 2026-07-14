/**
 * UnifiedCostAuthority (UCA) tests.
 *
 * Coverage:
 *  - Basic preCall ALLOW + postCall record
 *  - Layered budget: per-request / per-run / per-tenant(daily/monthly) / global(daily)
 *  - Per-tool cost tier gating: costTier × perCallCeiling + perRunCallCap
 *  - Three-tier response: WARN(80%) / THROTTLE(90%) / MELT(100%)
 *  - preCall never returns MELT (only postCall triggers MELT)
 *  - AnomalyObserver: 3σ deviation detection (requires sufficient samples)
 *  - Ledger recording + disposeRun cleanup
 *  - Multi-tenant isolation
 */
import { it, describe, beforeAll, afterEach, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

import {
  UnifiedCostAuthority,
  TIER_DEFAULTS,
  DEFAULT_UCA_CONFIG,
  type ToolCostTier,
} from '../../src/security/unifiedCostAuthority';
import {
  setGlobalTenantProvider,
  resetGlobalTenantProvider,
  SimpleTenantProvider,
} from '../../src/runtime/tenantProvider';
import { runWithTenant } from '../../src/runtime/tenantContext';

describe('UnifiedCostAuthority', () => {
  let uca: UnifiedCostAuthority;

  beforeAll(() => {
    uca = new UnifiedCostAuthority();
  });

  describe('basic preCall / postCall', () => {
    it('should ALLOW a small LLM call within budget', () => {
      const decision = uca.preCall({
        runId: 'test-run-basic',
        model: 'gpt-4o-mini',
        estimatedTokens: 1000,
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.action, 'ALLOW');
      assert.ok(decision.estimatedCostUsd > 0);
    });

    it('should record actual cost via postCall', () => {
      const result = uca.postCall(
        { runId: 'test-run-basic', model: 'gpt-4o-mini' },
        { costUsd: 0.001, promptTokens: 800, completionTokens: 200 },
      );
      assert.equal(result.melted, false);
      assert.ok(result.snapshot.perRun.used > 0);
    });

    it('should return ALLOW for a free-tier tool call', () => {
      const decision = uca.preCall({
        runId: 'test-run-tool-free',
        tool: { name: 'memory_read', costTier: 'free' },
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.action, 'ALLOW');
    });
  });

  describe('layered budget enforcement', () => {
    it('should THROTTLE when per-request cost exceeds cap', () => {
      const expensiveUca = new UnifiedCostAuthority();
      // per-request cap is $5 by default; force a cost > $5
      // 10M tokens × $5/M = $50
      const decision = expensiveUca.preCall({
        runId: 'test-run-expensive',
        model: 'gpt-4o',
        estimatedTokens: 10_000_000,
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.action, 'THROTTLE');
      assert.ok(decision.reason?.includes('Per-request'));
    });

    it('should THROTTLE when per-run budget exceeded', () => {
      const runId = 'test-run-budget-exceed';
      const localUca = new UnifiedCostAuthority();
      // per-run cap is $50; accumulate $49 then try $2 more
      localUca.postCall({ runId, model: 'gpt-4o' }, { costUsd: 49.0 });
      const decision = localUca.preCall({
        runId,
        model: 'gpt-4o',
        estimatedTokens: 400_000, // 400K × $5/M = $2
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.action, 'THROTTLE');
      assert.ok(decision.reason?.includes('Per-run'));
    });

    it('should trigger MELT via postCall when per-run cap reached', () => {
      const runId = 'test-run-melt';
      const localUca = new UnifiedCostAuthority();
      // per-run cap is $50; record $51
      const result = localUca.postCall({ runId, model: 'gpt-4o' }, { costUsd: 51.0 });
      assert.equal(result.melted, true);
      assert.ok(result.reason?.includes('Per-run budget MELT'));
    });

    it('should enforce per-tenant daily budget', () => {
      const tenantId = 'tenant-daily-test';
      const localUca = new UnifiedCostAuthority();
      // per-tenant daily cap is $500; per-run cap is $50.
      // Spread $499 across 10 runIds (each ~$49.9) so no single run
      // trips the per-run check, then a fresh runId preCall with $2
      // should hit the per-tenant daily check (projected 501 > 500).
      for (let i = 0; i < 10; i++) {
        localUca.postCall(
          { runId: `tenant-daily-run-${i}`, tenantId, model: 'gpt-4o' },
          { costUsd: 49.9 },
        );
      }
      // Total tenant daily used = 499.0; fresh runId keeps per-run at 0.
      const decision = localUca.preCall({
        runId: 'tenant-daily-run-fresh',
        tenantId,
        model: 'gpt-4o',
        estimatedTokens: 400_000, // 400K × $5/M = $2
      });
      assert.equal(decision.allowed, false);
      assert.ok(
        decision.reason?.includes('Per-tenant daily'),
        `expected reason to include 'Per-tenant daily', got: ${decision.reason}`,
      );
    });

    it('should enforce global daily budget', () => {
      const localUca = new UnifiedCostAuthority();
      // global daily cap is $5000; per-run cap is $50; per-tenant daily cap is $500.
      // Spread $4999 across 10 tenants × 10 runIds each (each run ~$49.99)
      // so neither per-run nor per-tenant daily trips, then a fresh
      // tenant+runId preCall with $2 should hit the global daily check
      // (projected 5001 > 5000).
      for (let t = 0; t < 10; t++) {
        for (let r = 0; r < 10; r++) {
          localUca.postCall(
            {
              runId: `global-daily-run-t${t}-r${r}`,
              tenantId: `global-daily-tenant-${t}`,
              model: 'gpt-4o',
            },
            { costUsd: 49.99 },
          );
        }
      }
      // Total global daily used = 4999.0; fresh tenant+runId keeps
      // per-run and per-tenant daily at 0.
      const decision = localUca.preCall({
        runId: 'global-daily-run-fresh',
        tenantId: 'global-daily-tenant-fresh',
        model: 'gpt-4o',
        estimatedTokens: 400_000, // 400K × $5/M = $2
      });
      assert.equal(decision.allowed, false);
      assert.ok(
        decision.reason?.includes('Global daily'),
        `expected reason to include 'Global daily', got: ${decision.reason}`,
      );
    });
  });

  describe('three-tier response (WARN / THROTTLE)', () => {
    it('should WARN at 80% per-run utilization', () => {
      const runId = 'test-run-warn';
      const localUca = new UnifiedCostAuthority();
      // per-run cap is $50; accumulate $39 (78%) then try $1 (80%)
      localUca.postCall({ runId, model: 'gpt-4o' }, { costUsd: 39.0 });
      const decision = localUca.preCall({
        runId,
        model: 'gpt-4o',
        estimatedTokens: 200_000, // 200K × $5/M = $1
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.action, 'WARN');
    });

    it('should THROTTLE at 90% per-run utilization', () => {
      const runId = 'test-run-throttle';
      const localUca = new UnifiedCostAuthority();
      // per-run cap is $50; accumulate $44 (88%) then try $1 (90%)
      localUca.postCall({ runId, model: 'gpt-4o' }, { costUsd: 44.0 });
      const decision = localUca.preCall({
        runId,
        model: 'gpt-4o',
        estimatedTokens: 200_000,
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.action, 'THROTTLE');
    });

    it('preCall should NEVER return MELT (only postCall triggers MELT)', () => {
      const runId = 'test-run-no-melt-precall';
      const localUca = new UnifiedCostAuthority();
      // Accumulate $49.99 (99.98%) then try $0.01
      localUca.postCall({ runId, model: 'gpt-4o' }, { costUsd: 49.99 });
      const decision = localUca.preCall({
        runId,
        model: 'gpt-4o',
        estimatedTokens: 2000, // tiny cost
      });
      // Should be THROTTLE (allowed=true), NOT MELT
      assert.notEqual(decision.action, 'MELT');
    });
  });

  describe('per-tool cost tier gating', () => {
    it('should enforce per-call cost ceiling per tier', () => {
      const runId = 'test-tool-ceiling';
      const localUca = new UnifiedCostAuthority();
      // critical tier: perCallCostCeilingUsd = $1.0
      // But UCA estimates tool cost as outputTokens/1M × $5
      // critical: 100K output tokens → $0.5 (under $1 ceiling) → ALLOW
      const decision = localUca.preCall({
        runId,
        tool: { name: 'shell_exec', costTier: 'critical' },
      });
      // critical tier default: 100K tokens × $5/M = $0.5 < $1 ceiling → ALLOW
      assert.equal(decision.allowed, true);
    });

    it('should enforce per-run call cap per tier', () => {
      const runId = 'test-tool-callcap';
      const localUca = new UnifiedCostAuthority();
      // critical tier: perRunCallCap = 10
      // Make 10 calls (all should succeed since cap is checked pre-call)
      for (let i = 0; i < 10; i++) {
        const decision = localUca.preCall({
          runId,
          tool: { name: 'shell_exec', costTier: 'critical' },
        });
        assert.equal(decision.allowed, true, `call ${i + 1} should be allowed`);
        // Record the call
        localUca.postCall(
          { runId, tool: { name: 'shell_exec', costTier: 'critical' } },
          { costUsd: 0.001 },
        );
      }
      // 11th call should be rejected
      const decision = localUca.preCall({
        runId,
        tool: { name: 'shell_exec', costTier: 'critical' },
      });
      assert.equal(decision.allowed, false);
      assert.ok(decision.reason?.includes('per-run call cap reached'));
    });

    it('should use TIER_DEFAULTS for unspecified tiers', () => {
      const freeDefaults = TIER_DEFAULTS.free;
      assert.equal(freeDefaults.perRunCallCap, 500);
      assert.equal(freeDefaults.perCallCostCeilingUsd, 0.001);

      const criticalDefaults = TIER_DEFAULTS.critical;
      assert.equal(criticalDefaults.perRunCallCap, 10);
      assert.equal(criticalDefaults.perCallCostCeilingUsd, 1.0);
    });

    it('should track different tools independently in same run', () => {
      const runId = 'test-tool-independent';
      const localUca = new UnifiedCostAuthority();
      // tool_a low tier (cap 200), tool_b critical tier (cap 10)
      for (let i = 0; i < 5; i++) {
        const da = localUca.preCall({
          runId,
          tool: { name: 'tool_a', costTier: 'low' },
        });
        assert.equal(da.allowed, true);
        localUca.postCall({ runId, tool: { name: 'tool_a', costTier: 'low' } }, { costUsd: 0.001 });

        const db = localUca.preCall({
          runId,
          tool: { name: 'tool_b', costTier: 'critical' },
        });
        assert.equal(db.allowed, true);
        localUca.postCall(
          { runId, tool: { name: 'tool_b', costTier: 'critical' } },
          { costUsd: 0.001 },
        );
      }
      // tool_b should be at cap (5/10), tool_a well under (5/200)
      const db = localUca.preCall({
        runId,
        tool: { name: 'tool_b', costTier: 'critical' },
      });
      assert.equal(db.allowed, true); // 6th call, still under 10
    });
  });

  describe('ledger + disposeRun', () => {
    it('should record entries in the ledger', () => {
      const runId = 'test-ledger';
      const localUca = new UnifiedCostAuthority();
      localUca.postCall({ runId, model: 'gpt-4o' }, { costUsd: 0.05 });
      localUca.postCall(
        { runId, tool: { name: 'web_search', costTier: 'low' } },
        { costUsd: 0.01 },
      );
      const ledger = localUca.readLedger();
      assert.ok(ledger.length >= 2);
      const lastEntry = ledger[ledger.length - 1];
      assert.equal(lastEntry.kind, 'tool');
      assert.equal(lastEntry.modelOrTool, 'web_search');
      assert.equal(lastEntry.toolCostTier, 'low');
    });

    it('should clean up run state on disposeRun', () => {
      const runId = 'test-dispose';
      const localUca = new UnifiedCostAuthority();
      localUca.postCall({ runId, model: 'gpt-4o' }, { costUsd: 1.0 });
      const before = localUca.getSnapshot(runId);
      assert.ok(before.perRun.used > 0);

      localUca.disposeRun(runId);
      const after = localUca.getSnapshot(runId);
      assert.equal(after.perRun.used, 0); // state reset
    });
  });

  describe('multi-tenant isolation', () => {
    it('should isolate per-run budgets across tenants', () => {
      const runId = 'test-tenant-iso';
      const localUca = new UnifiedCostAuthority();
      // Tenant A uses $10
      localUca.postCall({ runId, tenantId: 'tenant-a', model: 'gpt-4o' }, { costUsd: 10.0 });
      // Tenant B's snapshot for same runId should be 0
      const snapshotB = localUca.getSnapshot(runId, 'tenant-b');
      assert.equal(snapshotB.perRun.used, 0);

      // Tenant A's snapshot should show $10
      const snapshotA = localUca.getSnapshot(runId, 'tenant-a');
      assert.ok(snapshotA.perRun.used >= 10.0);
    });
  });

  describe('snapshot consistency', () => {
    it('should return consistent snapshot after each call', () => {
      const runId = 'test-snapshot';
      const localUca = new UnifiedCostAuthority();
      const snap0 = localUca.getSnapshot(runId);
      assert.equal(snap0.perRun.used, 0);

      localUca.postCall({ runId, model: 'gpt-4o' }, { costUsd: 5.0 });
      const snap1 = localUca.getSnapshot(runId);
      assert.ok(snap1.perRun.used >= 5.0);
      assert.ok(snap1.perTenantDaily.used >= 5.0);
      assert.ok(snap1.globalDaily.used >= 5.0);
    });
  });

  describe('tenant billing cycle configuration', () => {
    beforeEach(() => {
      resetGlobalTenantProvider();
    });

    afterEach(() => {
      resetGlobalTenantProvider();
    });

    it('uses daily tenant budget by default and rejects when daily cap projected', () => {
      const tenantId = 'tenant-daily-default';
      const provider = new SimpleTenantProvider([
        {
          tenantId,
          tokenBudget: 0,
          maxConcurrency: 1,
          maxRunsPerMinute: 0,
          enabled: true,
        },
      ]);
      setGlobalTenantProvider(provider);

      const localUca = new UnifiedCostAuthority();
      runWithTenant(tenantId, () => {
        // Daily cap is $500 by default; monthly is $10,000. Stay well under monthly.
        localUca.postCall({ runId: 'run-1', tenantId, model: 'gpt-4o' }, { costUsd: 499.0 });
        const decision = localUca.preCall({
          runId: 'run-2',
          tenantId,
          model: 'gpt-4o',
          estimatedTokens: 400_000, // ~$2
        });
        assert.equal(decision.allowed, false);
        assert.ok(decision.reason?.includes('daily'));
        assert.ok(decision.reason?.includes(tenantId));
      });
    });

    it('uses monthly tenant budget when metadata.billingCycle is monthly', () => {
      const tenantId = 'tenant-monthly';
      const provider = new SimpleTenantProvider([
        {
          tenantId,
          tokenBudget: 0,
          maxConcurrency: 1,
          maxRunsPerMinute: 0,
          enabled: true,
          metadata: { billingCycle: 'monthly' },
        },
      ]);
      setGlobalTenantProvider(provider);

      const localUca = new UnifiedCostAuthority();
      // Lift per-run/request/global caps so the monthly tenant cap is the limiter.
      localUca.updateConfig({
        perRunUsd: 20_000,
        perRequestUsd: 20_000,
        globalDailyUsd: 20_000,
      });

      runWithTenant(tenantId, () => {
        // Spend more than the daily cap but less than the monthly cap.
        localUca.postCall({ runId: 'run-1', tenantId, model: 'gpt-4o' }, { costUsd: 600.0 });
        let decision = localUca.preCall({
          runId: 'run-2',
          tenantId,
          model: 'gpt-4o',
          estimatedTokens: 200_000, // ~$1
        });
        assert.equal(decision.allowed, true, `expected ALLOW but got: ${decision.reason}`);

        // Now spend up to the monthly cap.
        localUca.postCall({ runId: 'run-3', tenantId, model: 'gpt-4o' }, { costUsd: 9_399.0 });
        decision = localUca.preCall({
          runId: 'run-4',
          tenantId,
          model: 'gpt-4o',
          estimatedTokens: 400_000, // ~$2 to push projected usage over the cap
        });
        assert.equal(decision.allowed, false);
        assert.ok(decision.reason?.includes('monthly'));
        assert.ok(decision.reason?.includes(tenantId));
      });
    });

    it('triggers MELT on monthly cycle when monthly cap is reached', () => {
      const tenantId = 'tenant-monthly-melt';
      const provider = new SimpleTenantProvider([
        {
          tenantId,
          tokenBudget: 0,
          maxConcurrency: 1,
          maxRunsPerMinute: 0,
          enabled: true,
          metadata: { billingCycle: 'monthly' },
        },
      ]);
      setGlobalTenantProvider(provider);

      const localUca = new UnifiedCostAuthority();
      localUca.updateConfig({
        perRunUsd: 20_000,
        perRequestUsd: 20_000,
        globalDailyUsd: 20_000,
      });

      runWithTenant(tenantId, () => {
        const result = localUca.postCall(
          { runId: 'run-1', tenantId, model: 'gpt-4o' },
          { costUsd: DEFAULT_UCA_CONFIG.perTenantMonthlyUsd + 1.0 },
        );
        assert.equal(result.melted, true);
        assert.ok(result.reason?.includes('monthly'));
        assert.ok(result.reason?.includes(tenantId));
      });
    });
  });
});
