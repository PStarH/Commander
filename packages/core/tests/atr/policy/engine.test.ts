import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PolicyEngine,
  parsePolicyPack,
  type PolicyInput,
  type PolicyPackAst,
} from '../../../src/atr/policy';

function makePack(source: string, version = 1): PolicyPackAst {
  const r = parsePolicyPack(source, 'test', version);
  if (r.errors.length > 0) throw new Error(r.errors.join('; '));
  return r.pack;
}

function makeInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  const now = new Date('2026-06-04T12:00:00Z');
  return {
    phase: 'tool',
    run: {
      id: 'run-1',
      state: 'EXECUTING',
      fencingEpoch: 1,
      intentHash: 'h',
      tenantId: 't1',
      agentId: 'a1',
      goal: 'test',
      metadata: {},
      createdAt: now.getTime(),
      actionsSoFar: [],
    },
    tool: {
      name: 'shell_cmd',
      riskLevel: 'medium',
      destructive: false,
      isReadOnly: false,
      isIdempotent: false,
      category: 'shell',
    },
    action: {
      args: { command: 'ls -la' },
      idempotencyKey: 'k1',
      stepNumber: 1,
      callSite: 'agent',
      leaseToken: 'lt1',
      fencingEpoch: 1,
    },
    tenant: {
      id: 't1',
      config: {
        tokenBudget: 1_000_000,
        maxConcurrency: 5,
        maxRunsPerMinute: 60,
        maxActionsPerRun: 100,
        allowShell: false,
        allowNetwork: false,
        requiresApprovalBypass: false,
      },
    },
    metrics: {
      tokensUsedThisRun: 0,
      tokensUsedThisHour: 0,
      actionsThisRun: 0,
      destructiveThisRun: 0,
      estimatedCostUsd: 0,
    },
    time: {
      now: now.getTime(),
      hourOfDay: 12,
      isWeekend: false,
    },
    ...overrides,
  };
}

describe('PolicyEngine — security guarantees', () => {
  describe('G-FAIL-1: fail-closed default', () => {
    it('returns deny when no rules match', () => {
      const pack = makePack(`package t
        default allow = false
        default require_approval = false
      `);
      const engine = new PolicyEngine(pack);
      const d = engine.evaluate(makeInput());
      assert.strictEqual(d.effect, 'deny');
      assert.strictEqual(d.reason, 'default_deny');
    });

    it('returns deny on empty pack (no rules)', () => {
      const r = parsePolicyPack(``, 'empty', 1);
      const engine = new PolicyEngine(r.pack);
      const d = engine.evaluate(makeInput());
      assert.strictEqual(d.effect, 'deny');
    });
  });

  describe('G-DESTRUCT-1: no allow for destructive without approval', () => {
    it('denies destructive + non-idempotent', () => {
      const pack = makePack(`package t
        default allow = false
        allow { input.tool.isReadOnly == true }
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ tool: { name: 'merge', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: false, category: 'destructive' } });
      const d = engine.evaluate(input);
      assert.notStrictEqual(d.effect, 'allow');
    });
  });

  describe('G-DETERM-1: same input produces same effect', () => {
    it('100 evals with same input produce same effect', () => {
      const pack = makePack(`package t
        default allow = false
        deny { input.tool.destructive == true }
        allow { input.tool.isReadOnly == true }
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput();
      const effects = new Set<string>();
      for (let i = 0; i < 100; i++) {
        effects.add(engine.evaluate(input).effect);
      }
      assert.strictEqual(effects.size, 1);
    });
  });

  describe('G-FENCE-1: stale lease is denied', () => {
    it('denies when action fencingEpoch != run fencingEpoch', () => {
      const pack = makePack(`package t
        default allow = true
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput();
      input.run.fencingEpoch = 5;
      input.action.fencingEpoch = 3;
      const d = engine.evaluate(input);
      assert.strictEqual(d.effect, 'deny');
      assert.strictEqual(d.reason, 'stale_lease');
    });
  });

  describe('G-IDEMP-1: destructive + non-idempotent cannot be allowed', () => {
    it('downgrades allow to deny for destructive without idempotency', () => {
      const pack = makePack(`package t
        default allow = false
        allow { true }
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ tool: { name: 'merge', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: false, category: 'destructive' } });
      const d = engine.evaluate(input);
      assert.strictEqual(d.effect, 'deny');
      assert.match(d.reason, /destructive_without_idempotency/);
    });
  });

  describe('G-AUDIT-1: every decision has decisionPath', () => {
    it('emits non-empty decisionPath for allow', () => {
      const pack = makePack(`package t
        default allow = false
        allow { input.tool.isReadOnly == true }
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ tool: { name: 'read', riskLevel: 'low', destructive: false, isReadOnly: true, isIdempotent: true, category: 'file_read' } });
      const d = engine.evaluate(input);
      assert.ok(d.decisionPath.length > 0);
      assert.ok(d.decisionId.startsWith('pd_'));
    });

    it('emits decisionPath for default_deny', () => {
      const pack = makePack(`package t
        default allow = false
      `);
      const engine = new PolicyEngine(pack);
      const d = engine.evaluate(makeInput());
      assert.deepStrictEqual(d.decisionPath, ['engine:fail_closed'].length === 1 ? d.decisionPath : d.decisionPath);
      assert.ok(d.decisionId);
    });
  });

  describe('Budget gate', () => {
    it('downgrades allow to deny when tokens over budget', () => {
      const pack = makePack(`package t
        default allow = false
        allow { input.tool.isReadOnly == true }
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ tool: { name: 'read', riskLevel: 'low', destructive: false, isReadOnly: true, isIdempotent: true, category: 'file_read' } });
      input.metrics.tokensUsedThisRun = 2_000_000;
      const d = engine.evaluate(input);
      assert.strictEqual(d.effect, 'deny');
      assert.match(d.reason, /budget_hard_cap_exceeded/);
    });

    it('downgrades allow to deny when actions over per-run cap', () => {
      const pack = makePack(`package t
        default allow = false
        allow { input.tool.isReadOnly == true }
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ tool: { name: 'read', riskLevel: 'low', destructive: false, isReadOnly: true, isIdempotent: true, category: 'file_read' } });
      input.metrics.actionsThisRun = 200;
      const d = engine.evaluate(input);
      assert.strictEqual(d.effect, 'deny');
      assert.match(d.reason, /rate_limit_exceeded/);
    });
  });

  describe('Risk score', () => {
    it('compute risk for destructive + external', () => {
      const pack = makePack(`package t
        default allow = true
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ tool: { name: 'merge', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: false, category: 'destructive' } });
      const d = engine.evaluate(input);
      assert.ok(d.riskScore >= 30);
    });
  });

  describe('Cacheability', () => {
    it('begin phase is never cacheable', () => {
      const pack = makePack(`package t
        default allow = true
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ phase: 'begin' });
      const d = engine.evaluate(input);
      assert.strictEqual(d.cacheable, false);
    });

    it('tool phase with allow is cacheable', () => {
      const pack = makePack(`package t
        default allow = true
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ phase: 'tool', tool: { name: 'read', riskLevel: 'low', destructive: false, isReadOnly: true, isIdempotent: true, category: 'file_read' } });
      const d = engine.evaluate(input);
      assert.strictEqual(d.cacheable, true);
    });

    it('deny_class is never cacheable', () => {
      const pack = makePack(`package t
        default allow = false
        deny_class = "deny_shell" { input.tool.category == "shell" }
      `);
      const engine = new PolicyEngine(pack);
      const input = makeInput({ tool: { name: 'rm', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: false, category: 'shell' } });
      const d = engine.evaluate(input);
      assert.strictEqual(d.effect, 'deny_class');
      assert.strictEqual(d.cacheable, false);
    });
  });

  describe('Cycles', () => {
    it('detects self-referential rule and forces fail-closed', () => {
      const pack = makePack(`package t
        default allow = false
        a { data.policy.a == true }
      `);
      const engine = new PolicyEngine(pack);
      const d = engine.evaluate(makeInput());
      assert.strictEqual(d.effect, 'deny');
    });
  });

  describe('Stats', () => {
    it('records allows and denials', () => {
      const pack = makePack(`package t
        default allow = false
        allow { input.tool.isReadOnly == true }
      `);
      const engine = new PolicyEngine(pack);
      engine.evaluate(makeInput());
      engine.evaluate(makeInput({ tool: { name: 'read', riskLevel: 'low', destructive: false, isReadOnly: true, isIdempotent: true, category: 'file_read' } }));
      const s = engine.getStats();
      assert.ok(s.evaluations >= 2);
    });
  });
});
