import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContextInjector } from '../../src/runtime/executionContextInjector';
import type { AgentExecutionContext } from '../../src/runtime/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'agent-1',
    missionId: 'mission-1',
    goal: 'Analyze the codebase and write a comprehensive report about the architecture',
    tokenBudget: 200000,
    availableTools: ['file_read', 'file_write'],
    maxSteps: 10,
    ...overrides,
  } as AgentExecutionContext;
}

function makeInbox(
  messages: Array<{ id: string; from: string; subject: string; body: string }> = [],
) {
  return {
    pollInbox: vi.fn(() => messages),
    acknowledge: vi.fn(),
    dispose: vi.fn(),
  } as any;
}

function makeMemory(memories: any[] = []) {
  return {
    query: vi.fn(() => memories),
  } as any;
}

function makeSecurityOrch(memories: any[] = []) {
  return {
    sanitizeMemoryShare: vi.fn((_raw: any[], _agentId: string) => ({
      result: memories,
      privacyBudgetUsed: 0,
    })),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionContextInjector', () => {
  let injector: ExecutionContextInjector;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs with deps', () => {
    injector = new ExecutionContextInjector({
      agentInbox: makeInbox(),
      getMemory: () => null,
      securityOrch: makeSecurityOrch(),
    });
    expect(injector).toBeDefined();
  });

  it('returns empty or minimal content when no inbox/memory sources have data', async () => {
    // Note: skills injection may still produce content even without inbox/memory.
    // The test verifies that inbox and memory do not contribute.
    injector = new ExecutionContextInjector({
      agentInbox: makeInbox([]),
      getMemory: () => null,
      securityOrch: makeSecurityOrch(),
    });

    const result = await injector.inject({ ctx: makeCtx(), tokenBudget: 200000 });
    // Skills may inject content, but inbox/memory should not
    expect(result.content).not.toContain('Pending Messages');
    expect(result.content).not.toContain('Relevant Past Experiences');
  });

  it('injects inbox messages when available', async () => {
    const inbox = makeInbox([
      {
        id: 'msg-1',
        from: 'coordinator',
        subject: 'Priority task',
        body: 'Please focus on the API layer',
      },
    ]);
    injector = new ExecutionContextInjector({
      agentInbox: inbox,
      getMemory: () => null,
      securityOrch: makeSecurityOrch(),
    });

    const result = await injector.inject({ ctx: makeCtx(), tokenBudget: 200000 });
    expect(result.partCount).toBeGreaterThanOrEqual(1);
    expect(result.content).toContain('Pending Messages');
    expect(result.content).toContain('coordinator');
    expect(result.content).toContain('Priority task');
    expect(inbox.acknowledge).toHaveBeenCalledWith('agent-1', 'msg-1');
  });

  it('injects memory entries when available', async () => {
    const memories = [
      {
        layer: 'episodic',
        content: 'Last time we used a chain topology for similar tasks',
        importance: 0.8,
        tags: ['topology', 'chain'],
      },
    ];
    const memory = makeMemory(memories);
    injector = new ExecutionContextInjector({
      agentInbox: makeInbox([]),
      getMemory: () => memory,
      securityOrch: makeSecurityOrch(memories),
    });

    const result = await injector.inject({ ctx: makeCtx(), tokenBudget: 200000 });
    expect(result.content).toContain('Relevant Past Experiences');
    expect(result.content).toContain('episodic');
    expect(result.content).toContain('topology');
  });

  it('respects token budget cap — skips inbox content that exceeds cap', async () => {
    // Create inbox messages whose combined block exceeds the token cap.
    // body.slice(0, 300) limits each body to 300 chars, so we need many messages.
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: `msg-${i}`,
      from: `sender-${i}`,
      subject: `Subject ${i}`,
      body: 'y'.repeat(300),
    }));
    const inbox = makeInbox(messages);
    injector = new ExecutionContextInjector({
      agentInbox: inbox,
      getMemory: () => null,
      securityOrch: makeSecurityOrch(),
    });

    // tokenBudget = 1000 → cap = max(2000, 200) = 2000 tokens
    // 20 messages × ~350 chars each = ~7000 chars → ~2000 tokens → exceeds cap
    const result = await injector.inject({ ctx: makeCtx(), tokenBudget: 1000 });
    // The inbox block should be skipped because it exceeds the token cap
    expect(result.content).not.toContain('Pending Messages');
    // But acknowledge should still be called for all messages
    expect(inbox.acknowledge).toHaveBeenCalledTimes(30);
  });

  it('handles memory query failure gracefully', async () => {
    const memory = {
      query: vi.fn(() => {
        throw new Error('memory store unavailable');
      }),
    } as any;
    injector = new ExecutionContextInjector({
      agentInbox: makeInbox([]),
      getMemory: () => memory,
      securityOrch: makeSecurityOrch(),
    });

    const result = await injector.inject({ ctx: makeCtx(), tokenBudget: 200000 });
    // Should complete without throwing, return empty or partial content
    expect(typeof result.content).toBe('string');
  });

  it('handles securityOrch.sanitizeMemoryShare failure gracefully', async () => {
    const memory = makeMemory([{ layer: 'episodic', content: 'test', importance: 0.5, tags: [] }]);
    const securityOrch = {
      sanitizeMemoryShare: vi.fn(() => {
        throw new Error('DP sanitization failed');
      }),
    } as any;
    injector = new ExecutionContextInjector({
      agentInbox: makeInbox([]),
      getMemory: () => memory,
      securityOrch,
    });

    const result = await injector.inject({ ctx: makeCtx(), tokenBudget: 200000 });
    // Should complete without throwing
    expect(typeof result.content).toBe('string');
  });

  it('combines multiple context sources into a single message', async () => {
    const inbox = makeInbox([
      { id: 'msg-1', from: 'agent-2', subject: 'Handoff', body: 'Here are the files you need' },
    ]);
    const memories = [
      {
        layer: 'semantic',
        content: 'The project uses TypeScript with vitest',
        importance: 0.9,
        tags: ['typescript', 'vitest'],
      },
    ];
    injector = new ExecutionContextInjector({
      agentInbox: inbox,
      getMemory: () => makeMemory(memories),
      securityOrch: makeSecurityOrch(memories),
    });

    const result = await injector.inject({ ctx: makeCtx(), tokenBudget: 200000 });
    expect(result.partCount).toBeGreaterThanOrEqual(2);
    expect(result.content).toContain('---');
    expect(result.content).toContain('Pending Messages');
    expect(result.content).toContain('Relevant Past Experiences');
  });

  it('extracts keywords from goal for memory query', async () => {
    const memory = makeMemory([]);
    injector = new ExecutionContextInjector({
      agentInbox: makeInbox([]),
      getMemory: () => memory,
      securityOrch: makeSecurityOrch([]),
    });

    await injector.inject({
      ctx: makeCtx({ goal: 'comprehensive architecture analysis codebase report' }),
      tokenBudget: 200000,
    });

    expect(memory.query).toHaveBeenCalled();
    const queryArg = memory.query.mock.calls[0][0];
    expect(queryArg.keywords).toContain('comprehensive');
    expect(queryArg.keywords).toContain('architecture');
    expect(queryArg.limit).toBe(5);
    expect(queryArg.importanceThreshold).toBe(0.3);
  });

  it('skips memory query when goal has no keywords longer than 4 chars', async () => {
    const memory = makeMemory([]);
    injector = new ExecutionContextInjector({
      agentInbox: makeInbox([]),
      getMemory: () => memory,
      securityOrch: makeSecurityOrch([]),
    });

    await injector.inject({
      ctx: makeCtx({ goal: 'hi go do it now' }), // all words ≤ 4 chars
      tokenBudget: 200000,
    });

    expect(memory.query).not.toHaveBeenCalled();
  });
});
