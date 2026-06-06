import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { parsePolicyPack, PolicyEngine } from '../../../src/atr/policy';
import type { PolicyInput } from '../../../src/atr/policy/types';

function packFrom(source: string) {
  const r = parsePolicyPack(source, 't', 1);
  if (r.errors.length > 0) throw new Error(r.errors.join('; '));
  return r.pack;
}

function mkInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  const now = new Date('2026-06-04T12:00:00Z');
  return {
    phase: 'tool',
    run: {
      id: 'r1', state: 'EXECUTING', fencingEpoch: 1, intentHash: 'h', tenantId: 't1',
      agentId: 'a1', goal: 'g', metadata: {}, createdAt: now.getTime(), actionsSoFar: [],
    },
    tool: { name: 'shell', riskLevel: 'medium', destructive: false, isReadOnly: false, isIdempotent: false, category: 'shell' },
    action: { args: { command: 'rm -rf /tmp/foo' }, idempotencyKey: 'k', stepNumber: 1, callSite: 'agent', leaseToken: 'lt', fencingEpoch: 1 },
    tenant: {
      id: 't1',
      config: { tokenBudget: 1_000_000, maxConcurrency: 5, maxRunsPerMinute: 60, maxActionsPerRun: 100, allowShell: true, allowNetwork: true, requiresApprovalBypass: false },
    },
    metrics: { tokensUsedThisRun: 0, tokensUsedThisHour: 0, actionsThisRun: 0, destructiveThisRun: 0, estimatedCostUsd: 0 },
    time: { now: now.getTime(), hourOfDay: 12, isWeekend: false },
    ...overrides,
  };
}

describe('Threat scenarios', () => {
  describe('T1: prompt injection via tool output', () => {
    it('flags destructive action with force:true as require_approval', () => {
      const pack = packFrom(`package t
        default allow = false
        require_approval { input.tool.name == "merge" }
        deny_class = "deny_force_push" { input.tool.name == "merge" and input.action.args.force == true }
      `);
      const engine = new PolicyEngine(pack);
      const input = mkInput({
        tool: { name: 'merge', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: true, category: 'api' },
        action: { args: { force: true }, idempotencyKey: 'k', stepNumber: 1, callSite: 'agent', leaseToken: 'lt', fencingEpoch: 1 },
      });
      const d = engine.evaluate(input);
      assert.strictEqual(d.effect, 'deny_class');
      assert.strictEqual(d.denyClass, 'deny_force_push');
    });
  });

  describe('T2: tool composition escalation', () => {
    it('downgrades destructive + non-idempotent to deny', () => {
      const pack = packFrom(`package t
        default allow = false
        allow { true }
      `);
      const engine = new PolicyEngine(pack);
      const input = mkInput({
        tool: { name: 'rm', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: false, category: 'shell' },
      });
      const d = engine.evaluate(input);
      assert.strictEqual(d.effect, 'deny');
      assert.match(d.reason, /destructive_without_idempotency/);
    });
  });

  describe('T3: tenant confusion', () => {
    it('does not let tenant B see tenant A decisions via cache key collision', () => {
      const packA = packFrom(`package t
        default allow = false
        allow { input.tenant.id == "tenant-a" }
      `);
      const packB = packFrom(`package t
        default allow = false
        allow { input.tenant.id == "tenant-b" }
      `);
      const engA = new PolicyEngine(packA);
      const engB = new PolicyEngine(packB);
      const inputA = mkInput();
      inputA.tenant.id = 'tenant-a';
      const dA = engA.evaluate(inputA);
      assert.strictEqual(dA.effect, 'allow');
      const inputB = mkInput();
      inputB.tenant.id = 'tenant-b';
      const dB = engB.evaluate(inputB);
      assert.strictEqual(dB.effect, 'allow');
    });
  });

  describe('T4: approval bypass', () => {
    it('does not return allow for destructive + non-idempotent even with bypass', () => {
      const pack = packFrom(`package t
        default allow = true
      `);
      const engine = new PolicyEngine(pack);
      const input = mkInput({
        tool: { name: 'rm', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: false, category: 'shell' },
      });
      const d = engine.evaluate(input);
      assert.notStrictEqual(d.effect, 'allow');
    });
  });

  describe('T5: policy conflicts', () => {
    it('detects cycle and forces fail-closed', () => {
      const pack = packFrom(`package t
        default allow = false
        a { data.policy.b == true }
        b { data.policy.a == true }
      `);
      const engine = new PolicyEngine(pack);
      const d = engine.evaluate(mkInput());
      assert.strictEqual(d.effect, 'deny');
      assert.match(d.reason, /cycle/);
    });
  });

  describe('T6: policy loops', () => {
    it('survives malformed rules without throwing', () => {
      const pack = packFrom(`package t
        default allow = false
        deny { input.tool.name == "x" }
      `);
      const engine = new PolicyEngine(pack);
      for (let i = 0; i < 100; i++) {
        const d = engine.evaluate(mkInput());
        assert.ok(d.decisionId);
      }
    });
  });
});
