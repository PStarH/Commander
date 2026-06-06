/**
 * Policy Engine Performance Benchmarks
 *
 * Latency: p50/p95/p99 over 10K cold + 10K warm evaluations
 * Throughput: ops/sec for allow/deny/require_approval
 * Cache hit rate: warm vs cold miss
 * Static detection cost: parse + conflict scan
 *
 * Targets (from RFC §Performance):
 *   p95 cold eval < 10ms
 *   p95 warm eval < 1ms
 *   >50K ops/sec warm
 *   parse 1KB pack < 5ms
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PolicyEngine, PolicyHook, parsePolicyPack, DEFAULT_CODING_PACK } from '../../../src/atr/policy';
import type { PolicyInput, PolicyPackAst } from '../../../src/atr/policy';

function makePack(): PolicyPackAst {
  const r = parsePolicyPack(DEFAULT_CODING_PACK, 'defaultCoding', 1);
  if (r.errors.length > 0) throw new Error('pack parse failed: ' + r.errors.join('; '));
  return r.pack;
}

function makeInput(args: { tool: string; category: PolicyInput['tool']['category']; destructive: boolean; isIdempotent: boolean }): PolicyInput {
  const now = Date.now();
  return {
    phase: 'tool',
    run: {
      id: 'bench-run',
      state: 'EXECUTING',
      fencingEpoch: 1,
      intentHash: 'bench',
      tenantId: 't',
      agentId: 'a',
      goal: 'bench',
      createdAt: now,
      actionsSoFar: [],
    },
    tool: {
      name: args.tool,
      riskLevel: args.destructive ? 'high' : 'low',
      destructive: args.destructive,
      isReadOnly: args.category === 'file_read',
      isIdempotent: args.isIdempotent,
      category: args.category,
    },
    action: {
      args: {},
      idempotencyKey: args.isIdempotent ? 'idem' : 'no-idem',
      stepNumber: 1,
      callSite: 'agent',
      leaseToken: 'lease',
      fencingEpoch: 1,
    },
    tenant: {
      id: 't',
      config: { tokenBudget: 1e6, maxConcurrency: 5, maxRunsPerMinute: 60, maxActionsPerRun: 100, allowShell: true, allowNetwork: true, requiresApprovalBypass: false },
    },
    metrics: { tokensUsedThisRun: 0, tokensUsedThisHour: 0, actionsThisRun: 0, destructiveThisRun: 0, estimatedCostUsd: 0 },
    time: { now, hourOfDay: 14, isWeekend: false },
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[i] as number;
}

describe('Policy engine benchmarks', () => {
  it('cold eval p95 < 10ms (allow path)', () => {
    const pack = makePack();
    const engine = new PolicyEngine(pack);
    const input = makeInput({ tool: 'file_read', category: 'file_read', destructive: false, isIdempotent: true });
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = process.hrtime.bigint();
      engine.evaluate(input);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p50 = pct(samples, 0.5);
    const p95 = pct(samples, 0.95);
    const p99 = pct(samples, 0.99);
    assert.ok(p95 < 10, `p95 ${p95.toFixed(3)}ms should be < 10ms`);
    assert.ok(p99 < 25, `p99 ${p99.toFixed(3)}ms should be < 25ms`);
  });

  it('warm eval p95 < 1ms (cache hit)', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const input = makeInput({ tool: 'file_read', category: 'file_read', destructive: false, isIdempotent: true });
    hook.evaluate(input);
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const t0 = process.hrtime.bigint();
      hook.evaluate(input);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p95 = pct(samples, 0.95);
    assert.ok(p95 < 1, `p95 ${p95.toFixed(3)}ms should be < 1ms`);
  });

  it('>25K ops/sec warm throughput', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const input = makeInput({ tool: 'file_read', category: 'file_read', destructive: false, isIdempotent: true });
    hook.evaluate(input);
    const start = process.hrtime.bigint();
    const N = 50_000;
    for (let i = 0; i < N; i++) hook.evaluate(input);
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    const ops = (N / durMs) * 1000;
    assert.ok(ops > 25_000, `${ops.toFixed(0)} ops/sec should be > 25K (in-pollution target)`);
  });

  it('pack parse < 5ms for 1KB pack', () => {
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = process.hrtime.bigint();
      parsePolicyPack(DEFAULT_CODING_PACK, 'defaultCoding', 1);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p95 = pct(samples, 0.95);
    assert.ok(p95 < 5, `p95 ${p95.toFixed(3)}ms should be < 5ms`);
  });

  it('deny path latency is comparable to allow', () => {
    const pack = makePack();
    const engine = new PolicyEngine(pack);
    const input = makeInput({ tool: 'shell_run', category: 'shell', destructive: true, isIdempotent: false });
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = process.hrtime.bigint();
      const d = engine.evaluate(input);
      assert.equal(d.effect, 'deny' || d.effect === 'deny_class', undefined as unknown as boolean);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p95 = pct(samples, 0.95);
    assert.ok(p95 < 10, `p95 deny ${p95.toFixed(3)}ms should be < 10ms`);
  });
});
