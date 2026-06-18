import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolResultCache } from '../../src/runtime/toolResultCache';
import { ToolOutputManager } from '../../src/runtime/toolOutputManager';
import { ToolOrchestrator } from '../../src/runtime/toolOrchestrator';
import { ToolPlanner } from '../../src/runtime/toolPlanner';
import {
  ToolAvailabilityManager,
  evaluate,
  allOf,
  anyOf,
  not,
  always,
  never,
  earlySteps,
  budgetRelaxed,
  budgetNotCritical,
  taskType,
  notYetUsed,
  requiresTool,
  createDefaultRules,
} from '../../src/runtime/toolAvailability';
import type { AvailabilityContext } from '../../src/runtime/toolAvailability';
import type { ToolCall, Tool, ToolResult } from '../../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function makeToolCall(name: string, args: Record<string, unknown> = {}, id?: string): ToolCall {
  return { id: id ?? `tc_${Math.random().toString(36).slice(2, 7)}`, name, arguments: args };
}

function makeToolResult(output: string, error?: string): ToolResult {
  return { toolCallId: 'tc1', name: 'test', output, error, durationMs: 100 };
}

function makeTool(name: string, opts?: Partial<Tool>): Tool {
  return {
    definition: { name, description: `${name} tool`, inputSchema: {} },
    execute: async (args: Record<string, unknown>) => `result: ${JSON.stringify(args)}`,
    ...opts,
  };
}

function makeContext(overrides?: Partial<AvailabilityContext>): AvailabilityContext {
  return {
    stepNumber: 0,
    maxSteps: 20,
    budgetPhase: 'relaxed',
    remainingTokens: 50000,
    taskType: 'general',
    toolsUsed: [],
    toolsErrored: [],
    agentId: 'agent-1',
    runId: 'run-1',
    ...overrides,
  };
}

// ============================================================================
// ToolResultCache
// ============================================================================

describe('ToolResultCache', () => {
  it('returns undefined when disabled', async () => {
    const cache = new ToolResultCache({ enabled: false });
    const tc = makeToolCall('web_search', { query: 'test' });
    await cache.set(tc, makeToolResult('hello'));
    assert.equal(cache.get(tc), undefined);
  });

  it('caches and returns results when enabled', async () => {
    const cache = new ToolResultCache({ enabled: true });
    const tc = makeToolCall('web_search', { query: 'test' });
    const result = makeToolResult('search results');
    await cache.set(tc, result);
    const cached = cache.get(tc);
    assert.ok(cached);
    assert.equal(cached!.output, 'search results');
    assert.equal(cached!.durationMs, 0); // cached = zero cost
  });

  it('misses on different args', async () => {
    const cache = new ToolResultCache({ enabled: true });
    const tc1 = makeToolCall('web_search', { query: 'foo' });
    const tc2 = makeToolCall('web_search', { query: 'bar' });
    await cache.set(tc1, makeToolResult('foo results'));
    assert.equal(cache.get(tc2), undefined);
  });

  it('produces deterministic keys regardless of arg order', () => {
    const tc1 = makeToolCall('test', { b: 2, a: 1 });
    const tc2 = makeToolCall('test', { a: 1, b: 2 });
    const key1 = ToolResultCache.computeKey(tc1.name, tc1.arguments);
    const key2 = ToolResultCache.computeKey(tc2.name, tc2.arguments);
    assert.equal(key1, key2);
  });

  it('never caches side-effect tools', async () => {
    const cache = new ToolResultCache({ enabled: true });
    const tc = makeToolCall('shell_execute', { cmd: 'ls' });
    await cache.set(tc, makeToolResult('file1\nfile2'));
    assert.equal(cache.get(tc), undefined);
  });

  it('never caches errors', async () => {
    const cache = new ToolResultCache({ enabled: true });
    const tc = makeToolCall('web_fetch', { url: 'http://example.com' });
    await cache.set(tc, makeToolResult('', 'Connection failed'));
    assert.equal(cache.get(tc), undefined);
  });

  it('respects TTL expiry', async () => {
    const cache = new ToolResultCache({ enabled: true, defaultTtlMs: 50 });
    const tc = makeToolCall('web_search', { query: 'test' });
    await cache.set(tc, makeToolResult('results'));
    assert.ok(cache.get(tc));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cache.get(tc), undefined);
  });

  it('evicts LRU when at capacity', async () => {
    const cache = new ToolResultCache({ enabled: true, maxEntries: 2 });
    const tc1 = makeToolCall('web_search', { query: 'a' });
    const tc2 = makeToolCall('web_search', { query: 'b' });
    const tc3 = makeToolCall('web_search', { query: 'c' });
    await cache.set(tc1, makeToolResult('a'));
    await new Promise((r) => setTimeout(r, 5));
    await cache.set(tc2, makeToolResult('b'));
    await new Promise((r) => setTimeout(r, 5));
    cache.get(tc1); // access tc1 to make it more recent
    await new Promise((r) => setTimeout(r, 5));
    await cache.set(tc3, makeToolResult('c')); // should evict tc2 (oldest access)
    assert.ok(cache.get(tc1));
    assert.equal(cache.get(tc2), undefined);
    assert.ok(cache.get(tc3));
  });

  it('invalidates by tool name', async () => {
    const cache = new ToolResultCache({ enabled: true });
    await cache.set(makeToolCall('web_search', { query: 'a' }), makeToolResult('a'));
    await cache.set(makeToolCall('web_search', { query: 'b' }), makeToolResult('b'));
    await cache.set(makeToolCall('web_fetch', { url: 'http://c.com' }), makeToolResult('c'));
    const removed = cache.invalidateTool('web_search');
    assert.equal(removed, 2);
    const stats = cache.getStats();
    assert.equal(stats.totalEntries, 1);
  });

  it('invalidates by pattern', async () => {
    const cache = new ToolResultCache({ enabled: true });
    await cache.set(makeToolCall('web_search', { query: 'a' }), makeToolResult('a'));
    await cache.set(makeToolCall('web_fetch', { url: 'http://b.com' }), makeToolResult('b'));
    await cache.set(makeToolCall('memory_recall', { query: 'c' }), makeToolResult('c'));
    cache.invalidatePattern('web_*');
    const stats = cache.getStats();
    assert.equal(stats.totalEntries, 1);
  });

  it('tracks stats correctly', async () => {
    const cache = new ToolResultCache({ enabled: true });
    const tc = makeToolCall('web_search', { query: 'test' });
    await cache.set(tc, makeToolResult('results'));
    cache.get(tc); // hit
    cache.get(makeToolCall('web_search', { query: 'miss' })); // miss
    const stats = cache.getStats();
    assert.equal(stats.totalHits, 1);
    assert.equal(stats.totalMisses, 1);
    assert.equal(stats.hitRate, 0.5);
  });

  it('prunes expired entries', async () => {
    const cache = new ToolResultCache({ enabled: true, defaultTtlMs: 30 });
    await cache.set(makeToolCall('web_search', { query: 'a' }), makeToolResult('a'));
    await cache.set(makeToolCall('web_search', { query: 'b' }), makeToolResult('b'));
    await new Promise((r) => setTimeout(r, 60));
    const pruned = cache.prune();
    assert.equal(pruned, 2);
    assert.equal(cache.getStats().totalEntries, 0);
  });
});

// ============================================================================
// ToolOutputManager
// ============================================================================

describe('ToolOutputManager', () => {
  it('passes through output that fits within cap', () => {
    const mgr = new ToolOutputManager({ enabled: true, defaultCap: 1000 });
    const tc = makeToolCall('web_search');
    const result = makeToolResult('short output');
    const managed = mgr.manage(tc, result);
    assert.equal(managed.output, 'short output');
    assert.equal(managed.truncated, false);
  });

  it('truncates output exceeding per-tool cap', () => {
    const mgr = new ToolOutputManager({
      enabled: true,
      toolCaps: { web_search: 50 },
      defaultCap: 1000,
    });
    const tc = makeToolCall('web_search');
    const longOutput = 'x'.repeat(200);
    const managed = mgr.manage(tc, makeToolResult(longOutput));
    assert.ok(managed.output.length <= 50);
    assert.equal(managed.truncated, true);
    assert.equal(managed.originalSize, 200);
  });

  it('enforces per-turn budget', () => {
    const mgr = new ToolOutputManager({
      enabled: true,
      defaultCap: 10000,
      turnBudget: 100,
    });
    mgr.resetTurn();
    const tc1 = makeToolCall('file_read');
    const tc2 = makeToolCall('file_read');
    mgr.manage(tc1, makeToolResult('a'.repeat(60)));
    const managed2 = mgr.manage(tc2, makeToolResult('b'.repeat(60)));
    // Second result should be capped by remaining turn budget
    assert.ok(managed2.output.length <= 40);
  });

  it('resets turn budget correctly', () => {
    const mgr = new ToolOutputManager({ enabled: true, turnBudget: 100 });
    mgr.resetTurn();
    mgr.manage(makeToolCall('x'), makeToolResult('a'.repeat(80)));
    const state1 = mgr.getTurnBudget();
    assert.equal(state1.used, 80);
    assert.equal(state1.remaining, 20);

    mgr.resetTurn();
    const state2 = mgr.getTurnBudget();
    assert.equal(state2.used, 0);
    assert.equal(state2.remaining, 100);
  });

  it('manageBatch resets and distributes budget', () => {
    const mgr = new ToolOutputManager({
      enabled: true,
      defaultCap: 1000,
      turnBudget: 200,
    });
    const calls = [
      { toolCall: makeToolCall('a'), result: makeToolResult('x'.repeat(100)) },
      { toolCall: makeToolCall('b'), result: makeToolResult('y'.repeat(100)) },
      { toolCall: makeToolCall('c'), result: makeToolResult('z'.repeat(100)) },
    ];
    const outputs = mgr.manageBatch(calls);
    assert.equal(outputs.length, 3);
    // Third should be truncated by turn budget
    const totalOutput = outputs.reduce((sum, o) => sum + o.output.length, 0);
    assert.ok(totalOutput <= 200);
  });

  it('is a no-op when disabled', () => {
    const mgr = new ToolOutputManager({ enabled: false });
    const tc = makeToolCall('test');
    const output = 'x'.repeat(50000);
    const managed = mgr.manage(tc, makeToolResult(output));
    assert.equal(managed.output, output);
    assert.equal(managed.truncated, false);
  });

  it('shell output keeps tail lines', () => {
    const mgr = new ToolOutputManager({
      enabled: true,
      toolCaps: { shell_execute: 100 },
      defaultCap: 1000,
    });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    lines.push('ERROR: something failed');
    lines.push('exit code 1');
    const output = lines.join('\n');
    const managed = mgr.manage(makeToolCall('shell_execute'), makeToolResult(output));
    assert.ok(managed.output.includes('ERROR: something failed'));
  });
});

// ============================================================================
// ToolOrchestrator
// ============================================================================

describe('ToolOrchestrator', () => {
  it('partitions tools into concurrent and serial', async () => {
    const orch = new ToolOrchestrator({ enabled: true });
    const tools = new Map<string, Tool>();
    tools.set('web_search', makeTool('web_search', { isConcurrencySafe: true }));
    tools.set('file_write', makeTool('file_write', { isConcurrencySafe: false }));

    const plan = await orch.planExecution(
      [makeToolCall('web_search'), makeToolCall('file_write')],
      tools,
    );
    assert.equal(plan.concurrent.length, 1);
    assert.equal(plan.serial.length, 1);
    assert.equal(plan.concurrent[0].name, 'web_search');
    assert.equal(plan.serial[0].name, 'file_write');
  });

  it('executes concurrent tools in parallel', async () => {
    const orch = new ToolOrchestrator({ enabled: true });
    const tools = new Map<string, Tool>();
    tools.set('web_search', makeTool('web_search', { isConcurrencySafe: true }));

    const plan = await orch.planExecution(
      [makeToolCall('web_search', { query: 'a' }), makeToolCall('web_search', { query: 'b' })],
      tools,
    );
    const result = await orch.execute(plan, tools, { runId: 'r1', agentId: 'a1', stepNumber: 0 });
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.output.startsWith('result:')));
  });

  it('handles tool not found gracefully', async () => {
    const orch = new ToolOrchestrator({ enabled: true });
    const tools = new Map<string, Tool>();
    const plan = await orch.planExecution([makeToolCall('nonexistent')], tools);
    const result = await orch.execute(plan, tools, { runId: 'r1', agentId: 'a1', stepNumber: 0 });
    assert.ok(result.results[0].error?.includes('TOOL_NOT_FOUND'));
  });

  it('circuit breaker opens after repeated failures', async () => {
    const orch = new ToolOrchestrator({
      enabled: true,
      circuitBreakerThreshold: 2,
      maxRetries: 0,
    });
    const tools = new Map<string, Tool>();
    tools.set('fail_tool', {
      definition: { name: 'fail_tool', description: 'fails', inputSchema: {} },
      execute: async () => {
        throw new Error('always fails');
      },
    });

    // First two calls fail and record in circuit breaker
    const plan1 = await orch.planExecution([makeToolCall('fail_tool')], tools);
    await orch.execute(plan1, tools, { runId: 'r1', agentId: 'a1', stepNumber: 0 });
    const plan2 = await orch.planExecution([makeToolCall('fail_tool')], tools);
    await orch.execute(plan2, tools, { runId: 'r1', agentId: 'a1', stepNumber: 1 });

    // Third call should be circuit-broken
    const plan3 = await orch.planExecution([makeToolCall('fail_tool')], tools);
    assert.equal(plan3.circuitBroken.length, 1);
  });

  it('resets circuit breaker on success', async () => {
    const orch = new ToolOrchestrator({
      enabled: true,
      circuitBreakerThreshold: 3,
      maxRetries: 0,
    });
    const tools = new Map<string, Tool>();
    let fail = true;
    tools.set('flaky', {
      definition: { name: 'flaky', description: 'flaky', inputSchema: {} },
      execute: async () => {
        if (fail) throw new Error('fail');
        return 'ok';
      },
    });

    // Fail once
    const plan1 = await orch.planExecution([makeToolCall('flaky')], tools);
    await orch.execute(plan1, tools, { runId: 'r1', agentId: 'a1', stepNumber: 0 });
    assert.equal(orch.getCircuitState('flaky').failures, 1);

    // Succeed — resets failures
    fail = false;
    const plan2 = await orch.planExecution([makeToolCall('flaky')], tools);
    await orch.execute(plan2, tools, { runId: 'r1', agentId: 'a1', stepNumber: 1 });
    assert.equal(orch.getCircuitState('flaky').failures, 0);
  });

  it('skips approval-rejected tools', async () => {
    const mockApproval = {
      requestApproval: async () => ({
        approved: false,
        requestId: 'req-1',
        approvedAt: new Date().toISOString(),
        reason: 'Too dangerous',
      }),
    };
    const orch = new ToolOrchestrator({ enabled: true, useApproval: true }, mockApproval as any);
    const tools = new Map<string, Tool>();
    tools.set('shell_execute', makeTool('shell_execute'));

    const plan = await orch.planExecution([makeToolCall('shell_execute')], tools);
    assert.equal(plan.skipped.length, 1);
    assert.ok(plan.skipped[0].reason.includes('dangerous'));
  });
});

// ============================================================================
// ToolAvailability
// ============================================================================

describe('ToolAvailability', () => {
  describe('evaluate', () => {
    it('evaluates always/never', () => {
      assert.equal(evaluate(always(), makeContext()), true);
      assert.equal(evaluate(never(), makeContext()), false);
    });

    it('evaluates allOf', () => {
      const ctx = makeContext({ stepNumber: 2, budgetPhase: 'relaxed' });
      assert.equal(evaluate(allOf(earlySteps(5), budgetRelaxed()), ctx), true);
      assert.equal(evaluate(allOf(earlySteps(1), budgetRelaxed()), ctx), false);
    });

    it('evaluates anyOf', () => {
      const ctx = makeContext({ budgetPhase: 'critical' });
      assert.equal(evaluate(anyOf(budgetRelaxed(), budgetNotCritical()), ctx), false);
      assert.equal(evaluate(anyOf(budgetRelaxed(), always()), ctx), true);
    });

    it('evaluates not', () => {
      assert.equal(evaluate(not(always()), makeContext()), false);
      assert.equal(evaluate(not(never()), makeContext()), true);
    });

    it('evaluates earlySteps', () => {
      assert.equal(evaluate(earlySteps(5), makeContext({ stepNumber: 3 })), true);
      assert.equal(evaluate(earlySteps(5), makeContext({ stepNumber: 5 })), false);
    });

    it('evaluates taskType', () => {
      assert.equal(evaluate(taskType('code', 'analysis'), makeContext({ taskType: 'code' })), true);
      assert.equal(
        evaluate(taskType('code', 'analysis'), makeContext({ taskType: 'search' })),
        false,
      );
    });

    it('evaluates notYetUsed', () => {
      assert.equal(evaluate(notYetUsed(), makeContext({ toolsUsed: [] })), true);
      assert.equal(evaluate(notYetUsed(), makeContext({ toolsUsed: ['web_search'] })), false);
    });

    it('evaluates requiresTool', () => {
      assert.equal(
        evaluate(requiresTool('web_search'), makeContext({ toolsUsed: ['web_search'] })),
        true,
      );
      assert.equal(evaluate(requiresTool('web_search'), makeContext({ toolsUsed: [] })), false);
    });
  });

  describe('ToolAvailabilityManager', () => {
    it('filters tools based on rules', () => {
      const mgr = new ToolAvailabilityManager();
      mgr.addRule({
        toolPattern: 'agent',
        when: earlySteps(5),
        priority: 10,
      });

      const tools = ['web_search', 'agent', 'file_read'];
      const early = mgr.filterTools(tools, makeContext({ stepNumber: 2 }));
      assert.ok(early.includes('agent'));

      const late = mgr.filterTools(tools, makeContext({ stepNumber: 10 }));
      assert.ok(!late.includes('agent'));
    });

    it('supports wildcard patterns', () => {
      const mgr = new ToolAvailabilityManager();
      mgr.addRule({
        toolPattern: 'file_*',
        when: budgetNotCritical(),
        priority: 5,
      });

      const tools = ['file_read', 'file_write', 'web_search'];
      const filtered = mgr.filterTools(tools, makeContext({ budgetPhase: 'critical' }));
      assert.ok(!filtered.includes('file_read'));
      assert.ok(!filtered.includes('file_write'));
      assert.ok(filtered.includes('web_search'));
    });

    it('higher priority rules override lower', () => {
      const mgr = new ToolAvailabilityManager();
      mgr.addRule({ toolPattern: '*', when: always(), priority: 1 });
      mgr.addRule({ toolPattern: 'agent', when: never(), priority: 10 });

      const filtered = mgr.filterTools(['agent', 'web_search'], makeContext());
      assert.ok(!filtered.includes('agent'));
      assert.ok(filtered.includes('web_search'));
    });

    it('getStatus returns availability details', () => {
      const mgr = new ToolAvailabilityManager();
      mgr.addRule({
        toolPattern: 'agent',
        when: earlySteps(5),
        priority: 10,
        reason: 'Only early steps',
      });

      const status = mgr.getStatus(['agent'], makeContext({ stepNumber: 10 }));
      assert.equal(status[0].available, false);
      assert.equal(status[0].reason, 'Only early steps');
    });

    it('createDefaultRules returns sensible defaults', () => {
      const rules = createDefaultRules();
      assert.ok(rules.length > 0);
      const mgr = new ToolAvailabilityManager();
      mgr.addRules(rules);
      assert.ok(mgr.getRuleCount() > 0);
    });
  });
});

// ============================================================================
// ToolPlanner
// ============================================================================

describe('ToolPlanner', () => {
  const tools = new Map<string, Tool>();
  tools.set('web_search', makeTool('web_search', { isConcurrencySafe: true, isReadOnly: true }));
  tools.set('web_fetch', makeTool('web_fetch', { isConcurrencySafe: true, isReadOnly: true }));
  tools.set('file_read', makeTool('file_read', { isReadOnly: true }));
  tools.set('file_write', makeTool('file_write'));
  tools.set('file_edit', makeTool('file_edit'));

  it('returns empty plan for no tool calls', () => {
    const planner = new ToolPlanner();
    const plan = planner.plan([], tools);
    assert.equal(plan.stages.length, 0);
    assert.equal(plan.estimatedDurationMs, 0);
  });

  it('single tool call produces single stage', () => {
    const planner = new ToolPlanner();
    const plan = planner.plan([makeToolCall('web_search')], tools);
    assert.equal(plan.stages.length, 1);
    assert.equal(plan.stages[0].toolCalls.length, 1);
  });

  it('parallelizes independent read-only tools', () => {
    const planner = new ToolPlanner();
    const calls = [
      makeToolCall('web_search', { query: 'a' }),
      makeToolCall('web_search', { query: 'b' }),
      makeToolCall('web_fetch', { url: 'http://x.com' }),
    ];
    const plan = planner.plan(calls, tools);
    // All read-only, no shared resources → single stage
    assert.equal(plan.stages.length, 1);
    assert.equal(plan.stages[0].toolCalls.length, 3);
    assert.equal(plan.hasParallelism, true);
  });

  it('serializes write-after-read on same resource', () => {
    const planner = new ToolPlanner();
    const calls = [
      makeToolCall('file_read', { path: '/tmp/test.txt' }),
      makeToolCall('file_write', { path: '/tmp/test.txt', content: 'new' }),
    ];
    const plan = planner.plan(calls, tools);
    // Should be 2 stages: read first, then write
    assert.ok(plan.stages.length >= 2);
    assert.ok(plan.dependencies.length > 0);
  });

  it('serializes write-write on same resource', () => {
    const planner = new ToolPlanner();
    const calls = [
      makeToolCall('file_write', { path: '/tmp/a.txt', content: 'x' }),
      makeToolCall('file_write', { path: '/tmp/a.txt', content: 'y' }),
    ];
    const plan = planner.plan(calls, tools);
    assert.ok(plan.stages.length >= 2);
  });

  it('parallelizes tools on different resources', () => {
    const planner = new ToolPlanner();
    const calls = [
      makeToolCall('file_read', { path: '/tmp/a.txt' }),
      makeToolCall('file_read', { path: '/tmp/b.txt' }),
    ];
    const plan = planner.plan(calls, tools);
    // Different resources, both read-only → parallel
    assert.equal(plan.stages.length, 1);
    assert.equal(plan.stages[0].toolCalls.length, 2);
  });

  it('identifies speculative candidates', () => {
    const planner = new ToolPlanner();
    const calls = [
      makeToolCall('web_search', { query: 'a' }),
      makeToolCall('file_read', { path: '/tmp/x.txt' }),
    ];
    const plan = planner.plan(calls, tools);
    assert.ok(plan.speculativeCandidates.length > 0);
  });

  it('detects resource conflicts', () => {
    const planner = new ToolPlanner();
    const calls = [
      makeToolCall('file_read', { path: '/shared.txt' }),
      makeToolCall('file_write', { path: '/shared.txt', content: 'x' }),
    ];
    const plan = planner.plan(calls, tools);
    assert.ok(plan.conflicts.length > 0);
    assert.equal(plan.conflicts[0].resource, '/shared.txt');
  });

  it('handles circular dependencies gracefully', () => {
    const planner = new ToolPlanner();
    // These tools share resources creating potential cycles
    const calls = [
      makeToolCall('file_write', { path: '/a', content: '1' }),
      makeToolCall('file_write', { path: '/a', content: '2' }),
      makeToolCall('file_write', { path: '/a', content: '3' }),
    ];
    const plan = planner.plan(calls, tools);
    // Should still produce a valid plan
    assert.ok(plan.stages.length > 0);
    const totalCalls = plan.stages.reduce((sum, s) => sum + s.toolCalls.length, 0);
    assert.equal(totalCalls, 3);
  });
});
