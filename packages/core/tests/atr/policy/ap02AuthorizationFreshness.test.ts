/**
 * AP-02 regression — an `allow` must never be replayed from a decision that was
 * computed under a different budget, lease, tenant config, epoch, metric,
 * wall-clock or tool flag.
 *
 * Defect (`.internal/audit-2026-09-10/atr-policy-checkpoint.md` §AP-02):
 * `PolicyHook` cached tool-phase decisions and keyed them with a bare SHA-256
 * over a *subset* of the decision input (no `tenant.config`, `metrics`, `time`,
 * `run.fencingEpoch`, `isReadOnly`/`isIdempotent`), while
 * `DecisionCache.invalidateByRun/Tenant/PackVersion` searched for
 * `run:`/`tenant:`/`pack:` substrings that a hex digest can never contain. Every
 * invalidation returned 0, so a stale `allow` could be served even after the
 * engine's own run/action epoch comparison should have rejected it.
 *
 * Fix taken (the audit's preferred option): the authorization-result cache is
 * deleted rather than repaired. A key that covers the *complete* decision input
 * must include `input.time.now`, which changes on every call, so a sound cache
 * could never hit — repair would add a store, an index and three invalidation
 * methods for a mechanism whose best-case hit rate is 0.
 *
 * Each test below flips exactly one decision input and requires a fresh
 * (non-`cached`) re-evaluation, which is the observable mechanism now.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PolicyHook } from '../../../src/atr/policy/integration/scheduler';
import type { PolicyInput } from '../../../src/atr/policy/types';

function makeInput(): PolicyInput {
  return {
    phase: 'tool',
    run: {
      id: 'run-ap02',
      state: 'EXECUTING',
      fencingEpoch: 1,
      intentHash: 'hash-ap02',
      tenantId: 'tenant-ap02',
      agentId: 'agent-ap02',
      goal: 'ap02',
      metadata: {},
      createdAt: 1_700_000_000_000,
      actionsSoFar: [],
    },
    tool: {
      name: 'read',
      riskLevel: 'low',
      destructive: false,
      isReadOnly: true,
      isIdempotent: true,
      category: 'file_read',
    },
    action: {
      args: { path: '/tmp/ap02.txt' },
      idempotencyKey: 'idem-ap02',
      stepNumber: 1,
      callSite: 'agent',
      leaseToken: 'lease-ap02',
      fencingEpoch: 1,
    },
    tenant: {
      id: 'tenant-ap02',
      config: {
        tokenBudget: 1000,
        maxConcurrency: 1,
        maxRunsPerMinute: 1,
        maxActionsPerRun: 100,
        allowShell: true,
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
    time: { now: 1_700_000_000_000, hourOfDay: 12, isWeekend: false },
  };
}

/** A pack whose only rule is the supplied one, on top of `default allow = true`. */
function hookWithRule(rule = ''): PolicyHook {
  return new PolicyHook({
    enableAudit: false,
    pack: { source: `default allow = true\n${rule}\n`, name: 'ap02', version: 1 },
  });
}

describe('AP-02 authorization freshness (result cache removed)', () => {
  it('re-runs the engine for an identical second evaluation (no cache hit)', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const input = makeInput();

    const first = hook.evaluate(input);
    const evaluationsAfterFirst = hook.getStats().evaluations;
    const second = hook.evaluate(input);
    const evaluationsAfterSecond = hook.getStats().evaluations;

    assert.strictEqual(first.effect, 'allow');
    assert.strictEqual(second.effect, 'allow');
    // A cache hit would set `cached: true`, reuse the decision id, and leave the
    // engine's evaluation counter unchanged. None of that may happen.
    assert.strictEqual(second.cached, false);
    assert.notStrictEqual(second.decisionId, first.decisionId);
    assert.strictEqual(evaluationsAfterSecond, evaluationsAfterFirst + 1);
  });

  it('keeps no invalidation surface (nothing is stored, so nothing can go stale)', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const surface = hook as unknown as Record<string, unknown>;
    assert.strictEqual(surface.invalidateRun, undefined);
    assert.strictEqual(surface.invalidateTenant, undefined);
    assert.strictEqual(surface.invalidatePack, undefined);
    const stats = hook.getStats() as unknown as Record<string, unknown>;
    assert.strictEqual(stats.cacheSize, undefined);
    assert.strictEqual(stats.cacheHitRate, undefined);
  });

  it('denies after the tenant token budget shrinks instead of replaying the allow', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const input = makeInput();
    input.metrics.tokensUsedThisRun = 50;
    assert.strictEqual(hook.evaluate(input).effect, 'allow');

    // Budget change only: usage and every other input stay identical.
    input.tenant.config.tokenBudget = 10;
    const second = hook.evaluate(input);
    assert.notStrictEqual(second.effect, 'allow');
    assert.strictEqual(second.cached, false);
  });

  it('denies after run metrics change instead of replaying the allow', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const input = makeInput();
    assert.strictEqual(hook.evaluate(input).effect, 'allow');

    input.metrics.tokensUsedThisRun = 1001;
    const second = hook.evaluate(input);
    assert.notStrictEqual(second.effect, 'allow');
    assert.strictEqual(second.cached, false);
  });

  it('denies after the run fencing epoch advances (stale lease)', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const input = makeInput();
    assert.strictEqual(hook.evaluate(input).effect, 'allow');

    // The lease the run holds moved on; `action.fencingEpoch` intentionally
    // stays behind, which is exactly the case the old key could not see.
    input.run.fencingEpoch = 2;
    const second = hook.evaluate(input);
    assert.notStrictEqual(second.effect, 'allow');
    assert.strictEqual(second.cached, false);
  });

  it('denies after tenant config changes instead of replaying the allow', () => {
    const hook = hookWithRule('deny { input.tenant.config.allowShell == false }');
    const input = makeInput();
    input.tool = { ...input.tool, name: 'shell', category: 'shell', isReadOnly: false };
    assert.strictEqual(hook.evaluate(input).effect, 'allow');

    input.tenant.config.allowShell = false;
    const second = hook.evaluate(input);
    assert.notStrictEqual(second.effect, 'allow');
    assert.strictEqual(second.cached, false);
  });

  it('denies after the wall clock changes instead of replaying the allow', () => {
    const hook = hookWithRule('deny { input.time.hourOfDay < 6 }');
    const input = makeInput();
    assert.strictEqual(hook.evaluate(input).effect, 'allow');

    input.time.hourOfDay = 3;
    const second = hook.evaluate(input);
    assert.notStrictEqual(second.effect, 'allow');
    assert.strictEqual(second.cached, false);
  });

  it('denies after tool.isReadOnly changes instead of replaying the allow', () => {
    const hook = hookWithRule('deny { input.tool.isReadOnly == true }');
    const input = makeInput();
    input.tool = { ...input.tool, isReadOnly: false };
    assert.strictEqual(hook.evaluate(input).effect, 'allow');

    input.tool = { ...input.tool, isReadOnly: true };
    const second = hook.evaluate(input);
    assert.notStrictEqual(second.effect, 'allow');
    assert.strictEqual(second.cached, false);
  });

  it('denies after tool.isIdempotent changes instead of replaying the allow', () => {
    const hook = hookWithRule();
    const input = makeInput();
    input.tool = { ...input.tool, destructive: true, isReadOnly: false, isIdempotent: true };
    assert.strictEqual(hook.evaluate(input).effect, 'allow');

    input.tool = { ...input.tool, isIdempotent: false };
    const second = hook.evaluate(input);
    assert.notStrictEqual(second.effect, 'allow');
    assert.strictEqual(second.cached, false);
  });
});
