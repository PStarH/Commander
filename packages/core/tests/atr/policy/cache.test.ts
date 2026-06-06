import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DecisionCache } from '../../../src/atr/policy/cache';
import { parsePolicyPack } from '../../../src/atr/policy/loader';
import { PolicyEngine } from '../../../src/atr/policy/engine';
import type { PolicyInput, PolicyDecision } from '../../../src/atr/policy/types';

function mkInput(): PolicyInput {
  return {
    phase: 'tool',
    run: { id: 'r1', state: 'EXECUTING', fencingEpoch: 1, intentHash: 'h', tenantId: 't1', agentId: 'a1', goal: 'g', metadata: {}, createdAt: 0, actionsSoFar: [] },
    tool: { name: 'read', riskLevel: 'low', destructive: false, isReadOnly: true, isIdempotent: true, category: 'file_read' },
    action: { args: { path: '/tmp/a' }, idempotencyKey: 'k', stepNumber: 1, callSite: 'agent', leaseToken: 'lt', fencingEpoch: 1 },
    tenant: { id: 't1', config: { tokenBudget: 1000, maxConcurrency: 1, maxRunsPerMinute: 1, maxActionsPerRun: 100, allowShell: false, allowNetwork: false, requiresApprovalBypass: false } },
    metrics: { tokensUsedThisRun: 0, tokensUsedThisHour: 0, actionsThisRun: 0, destructiveThisRun: 0, estimatedCostUsd: 0 },
    time: { now: 0, hourOfDay: 12, isWeekend: false },
  };
}

function mkDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    effect: 'allow',
    reason: 'test',
    decisionPath: ['r1'],
    matchedRule: 'r1',
    riskScore: 0,
    budget: { tokensUsed: 0, tokensBudget: 1000, actionsUsed: 0, actionsBudget: 100, estimatedCostUsd: 0 },
    latencyMs: 0.1,
    cached: false,
    cacheable: true,
    decisionId: 'pd_1',
    packVersion: 1,
    packName: 'test',
    tenantId: 't1',
    runId: 'r1',
    ...overrides,
  };
}

describe('DecisionCache', () => {
  it('returns null on miss', () => {
    const c = new DecisionCache();
    assert.strictEqual(c.get('missing'), null);
  });

  it('returns cached value on hit and marks cached=true', () => {
    const c = new DecisionCache();
    const d = mkDecision();
    c.set('k1', d);
    const got = c.get('k1');
    assert.ok(got);
    assert.strictEqual(got.cached, true);
  });

  it('rejects non-cacheable decisions', () => {
    const c = new DecisionCache();
    const d = mkDecision({ cacheable: false });
    c.set('k1', d);
    assert.strictEqual(c.get('k1'), null);
  });

  it('expires after TTL', async () => {
    const c = new DecisionCache({ cacheTtlMs: 10 });
    c.set('k1', mkDecision());
    assert.ok(c.get('k1'));
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(c.get('k1'), null);
  });

  it('LRU eviction when over maxEntries', () => {
    const c = new DecisionCache({ maxCacheEntries: 3 });
    c.set('a', mkDecision());
    c.set('b', mkDecision());
    c.set('c', mkDecision());
    c.set('d', mkDecision());
    assert.strictEqual(c.size(), 3);
    assert.strictEqual(c.get('a'), null);
  });

  it('invalidateByRun removes matching keys', () => {
    const c = new DecisionCache();
    c.set('tenant:t1:run:r1:pack:1:x', mkDecision());
    c.set('tenant:t1:run:r2:pack:1:x', mkDecision());
    const removed = c.invalidateByRun('r1');
    assert.strictEqual(removed, 1);
  });

  it('invalidateByTenant removes matching keys', () => {
    const c = new DecisionCache();
    c.set('tenant:t1:run:r1:x', mkDecision());
    c.set('tenant:t2:run:r1:x', mkDecision());
    const removed = c.invalidateByTenant('t1');
    assert.strictEqual(removed, 1);
  });

  it('hitRate tracks hits and misses', () => {
    const c = new DecisionCache();
    c.set('k', mkDecision());
    c.get('k');
    c.get('k');
    c.get('missing');
    assert.strictEqual(c.hitRate(), 2 / 3);
  });

  it('dedupe returns same promise for concurrent calls', async () => {
    const c = new DecisionCache();
    let invocations = 0;
    const factory = () => { invocations++; return new Promise<string>((r) => setTimeout(() => r('done'), 10)); };
    const [a, b] = await Promise.all([
      c.dedupe('k1', factory),
      c.dedupe('k1', factory),
    ]);
    assert.strictEqual(a, b);
    assert.strictEqual(invocations, 1);
  });
});
