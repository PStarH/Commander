import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, isComplexTask } from '../../src/runtime/promptBuilder.js';
import type { AgentExecutionContext, RoutingDecision, Tool } from '../../src/runtime/types.js';
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
