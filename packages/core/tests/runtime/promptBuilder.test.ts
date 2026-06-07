import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, isComplexTask, buildStableSystemPrefix, buildDynamicContext, computePrefixCacheKey } from '../../src/runtime/promptBuilder.js';
import type { AgentExecutionContext, RoutingDecision, Tool, AgentRuntimeConfig } from '../../src/runtime/types.js';
import { TokenGovernor } from '../../src/runtime/tokenGovernor.js';

function makeCtx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    agentId: 'a1',
    projectId: 'p1',
    goal: 'Refactor the auth module to use a single source of truth for token validation',
    tokenBudget: 100000,
    maxSteps: 30,
    availableTools: ['file_read', 'file_edit', 'code_search', 'bash', 'file_write'],
    contextData: {},
    ...overrides,
  };
}

function makeRouting(model = 'claude-sonnet-4-6', tier = 'standard'): RoutingDecision {
  return { modelId: model, tier: tier as RoutingDecision['tier'], reason: 'test' };
}

function makeTools(names: string[]): Map<string, Tool> {
  const map = new Map<string, Tool>();
  for (const name of names) {
    map.set(name, {
      definition: { name, description: `${name} description`, parameters: [] },
      async execute() { return { output: '' }; },
    } as unknown as Tool);
  }
  return map;
}

describe('buildSystemPrompt (P0 #3 #4 #5)', () => {
  it('includes the pre-yield verification checklist', () => {
    const prompt = buildSystemPrompt(makeCtx(), makeRouting(), { maxStepsPerRun: 30 } as never, makeTools(['file_read']), new TokenGovernor({ totalBudget: 100000 }));
    assert.match(prompt, /Pre-yield checklist/);
    assert.match(prompt, /Goal coverage/);
    assert.match(prompt, /Artifact propagation/);
    assert.match(prompt, /Evidence/);
  });

  it('includes the preamble (think before acting) section', () => {
    const prompt = buildSystemPrompt(makeCtx(), makeRouting(), { maxStepsPerRun: 30 } as never, makeTools(['file_read']), new TokenGovernor({ totalBudget: 100000 }));
    assert.match(prompt, /Preamble: Think Before Acting/);
    assert.match(prompt, /1\u20132 sentences of plain text/);
  });

  it('includes multi-file refactoring workflow for complex tasks', () => {
    const ctx = makeCtx({ goal: 'Refactor the entire authentication layer to use a centralized config' });
    const prompt = buildSystemPrompt(ctx, makeRouting(), { maxStepsPerRun: 30 } as never, makeTools(['file_read', 'file_edit', 'code_search']), new TokenGovernor({ totalBudget: 100000 }));
    assert.match(prompt, /Multi-File Refactoring Workflow/);
    assert.match(prompt, /Enumerate/);
    assert.match(prompt, /Read all first/);
    assert.match(prompt, /Cross-file verification/);
  });

  it('omits multi-file section for simple tasks', () => {
    const ctx = makeCtx({ goal: 'What is 2+2?' });
    const prompt = buildSystemPrompt(ctx, makeRouting(), { maxStepsPerRun: 30 } as never, makeTools(['file_read']), new TokenGovernor({ totalBudget: 100000 }));
    assert.doesNotMatch(prompt, /Multi-File Refactoring Workflow/);
  });

  it('isComplexTask detects refactor / multi-file / audit', () => {
    assert.equal(isComplexTask('refactor the auth module'), true);
    assert.equal(isComplexTask('multi-file migration'), true);
    assert.equal(isComplexTask('audit the security of the API'), true);
    assert.equal(isComplexTask('implement a new feature'), true);
    assert.equal(isComplexTask('what time is it'), false);
    assert.equal(isComplexTask('list files in current directory'), false);
  });
});

describe('buildStableSystemPrefix (KV-cache stability)', () => {
  const config: AgentRuntimeConfig = { maxStepsPerRun: 30 } as AgentRuntimeConfig;

  function makeToolsByDescription(...descs: string[]): Map<string, Tool> {
    const m = new Map<string, Tool>();
    descs.forEach((d, i) => {
      m.set(`t${i}`, {
        definition: { name: `t${i}`, description: d, parameters: [] },
        async execute() { return { output: '' }; },
      } as unknown as Tool);
    });
    return m;
  }

  it('produces identical output for tool-order variations', () => {
    const tools = makeToolsByDescription('zzz', 'aaa', 'mmm');
    const a = buildStableSystemPrefix(config, tools, null, undefined, ['t0', 't1', 't2']);
    const b = buildStableSystemPrefix(config, tools, null, undefined, ['t2', 't0', 't1']);
    assert.strictEqual(a, b);
  });

  it('excludes agent ID, goal, budget, and model from the prefix', () => {
    const tools = makeToolsByDescription('read files');
    const prefix = buildStableSystemPrefix(config, tools, null, undefined, ['t0']);
    assert.doesNotMatch(prefix, /agent-1|p1|m1|100000|claude/);
  });

  it('includes the governance profile when provided', () => {
    const tools = makeToolsByDescription('read files');
    const prefix = buildStableSystemPrefix(config, tools, { maxTokens: 5000 }, undefined, ['t0']);
    assert.match(prefix, /maxTokens/);
  });

  it('normalizes governance key order — same data, different insertion order, same output', () => {
    const tools = makeToolsByDescription('read files');
    const a = buildStableSystemPrefix(config, tools, { zzz: 1, aaa: 2, mmm: 3 }, undefined, ['t0']);
    const b = buildStableSystemPrefix(config, tools, { aaa: 2, mmm: 3, zzz: 1 }, undefined, ['t0']);
    assert.strictEqual(a, b);
  });

  it('shows "(no tools registered)" when activeToolNames is empty', () => {
    const prefix = buildStableSystemPrefix(config, new Map(), null, undefined, []);
    assert.match(prefix, /no tools registered/i);
  });

  it('hashes governance objects at the same value to the same prefix', () => {
    const tools = makeToolsByDescription('read files');
    const a = buildStableSystemPrefix(config, tools, { nested: { y: 1, x: 2 } }, undefined, ['t0']);
    const b = buildStableSystemPrefix(config, tools, { nested: { x: 2, y: 1 } }, undefined, ['t0']);
    assert.strictEqual(a, b);
  });
});

describe('buildDynamicContext', () => {
  const config: AgentRuntimeConfig = { maxStepsPerRun: 30 } as AgentRuntimeConfig;

  it('includes agent, project, budget, model, and tier', () => {
    const ctx = makeCtx({ agentId: 'agent-x', projectId: 'proj-y', tokenBudget: 12345 });
    const routing = makeRouting('gpt-5', 'power');
    const suffix = buildDynamicContext(ctx, routing, config);
    assert.match(suffix, /agent-x/);
    assert.match(suffix, /proj-y/);
    assert.match(suffix, /12345/);
    assert.match(suffix, /gpt-5/);
    assert.match(suffix, /power/);
  });

  it('includes mission ID when present', () => {
    const ctx = makeCtx({ missionId: 'msn-7' });
    const suffix = buildDynamicContext(ctx, makeRouting(), config);
    assert.match(suffix, /msn-7/);
  });

  it('omits mission ID when absent', () => {
    const ctx = makeCtx({ missionId: undefined });
    const suffix = buildDynamicContext(ctx, makeRouting(), config);
    assert.doesNotMatch(suffix, /Mission:/);
  });
});

describe('computePrefixCacheKey', () => {
  const config: AgentRuntimeConfig = { maxStepsPerRun: 30 } as AgentRuntimeConfig;

  it('is deterministic — same inputs produce the same key', () => {
    const tools = new Map<string, Tool>();
    const a = computePrefixCacheKey(config, tools, null);
    const b = computePrefixCacheKey(config, tools, null);
    assert.strictEqual(a, b);
  });

  it('returns a 64-char hex SHA-256 digest', () => {
    const key = computePrefixCacheKey(config, new Map(), null);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it('different governance profiles produce different keys', () => {
    const a = computePrefixCacheKey(config, new Map(), { x: 1 });
    const b = computePrefixCacheKey(config, new Map(), { x: 2 });
    assert.notStrictEqual(a, b);
  });

  it('different maxSteps produce different keys', () => {
    const a = computePrefixCacheKey({ maxStepsPerRun: 30 } as AgentRuntimeConfig, new Map(), null);
    const b = computePrefixCacheKey({ maxStepsPerRun: 50 } as AgentRuntimeConfig, new Map(), null);
    assert.notStrictEqual(a, b);
  });

  it('governance key insertion order does not affect the key', () => {
    const a = computePrefixCacheKey(config, new Map(), { z: 1, a: 2 });
    const b = computePrefixCacheKey(config, new Map(), { a: 2, z: 1 });
    assert.strictEqual(a, b);
  });
});

describe('buildSystemPrompt (cache split)', () => {
  const config: AgentRuntimeConfig = { maxStepsPerRun: 30 } as AgentRuntimeConfig;

  it('prefix portion is identical across calls with varying agent/goal/budget/model', () => {
    const tools = new Map<string, Tool>();
    tools.set('t0', { definition: { name: 't0', description: 'read', parameters: [] }, async execute() { return { output: '' }; } } as unknown as Tool);
    const prefixA = buildSystemPrompt(makeCtx({ agentId: 'A', goal: 'X', tokenBudget: 100 }), makeRouting('m1'), config, tools, new TokenGovernor({ totalBudget: 100000 })).split('## Run Context')[0];
    const prefixB = buildSystemPrompt(makeCtx({ agentId: 'B', goal: 'Y', tokenBudget: 200 }), makeRouting('m2'), config, tools, new TokenGovernor({ totalBudget: 100000 })).split('## Run Context')[0];
    assert.strictEqual(prefixA, prefixB);
  });

  it('low-budget phase returns terse format and skips the cache split', () => {
    const tools = new Map<string, Tool>();
    const tight = new TokenGovernor({ totalBudget: 100, warningThreshold: 0.5, criticalThreshold: 0.95 });
    // Force tight phase by reporting usage near the budget cap
    tight.reportUsage({ promptTokens: 90, completionTokens: 0, totalTokens: 90 });
    const prompt = buildSystemPrompt(makeCtx(), makeRouting(), config, tools, tight);
    assert.match(prompt, /Agent a1 \| Project p1/);
    assert.doesNotMatch(prompt, /Preamble: Think Before Acting/);
  });
});
