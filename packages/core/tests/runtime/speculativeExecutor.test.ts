import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PatternTracker,
  resetPatternTracker,
  getPatternTracker,
  planSpeculativeExecution,
  isSpeculativelySafe,
} from '../../src/runtime/speculativeExecutor';

describe('SpeculativeExecutor - isSpeculativelySafe', () => {
  it('returns true for read-only tools', () => {
    expect(isSpeculativelySafe('web_search')).toBe(true);
    expect(isSpeculativelySafe('file_read')).toBe(true);
    expect(isSpeculativelySafe('memory_recall')).toBe(true);
  });

  it('returns false for state-mutating tools', () => {
    expect(isSpeculativelySafe('shell_execute')).toBe(false);
    expect(isSpeculativelySafe('file_write')).toBe(false);
    expect(isSpeculativelySafe('git')).toBe(false);
  });
});

describe('SpeculativeExecutor - PatternTracker', () => {
  let tracker: PatternTracker;

  beforeEach(() => {
    tracker = new PatternTracker();
  });

  it('starts with no patterns', () => {
    expect(tracker.getTopPatterns(10)).toHaveLength(0);
  });

  it('records single sequences', () => {
    tracker.recordSequence(['web_search', 'web_fetch']);
    const patterns = tracker.getTopPatterns(10);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
  });

  it('records longer sequences', () => {
    tracker.recordSequence(['web_search', 'web_fetch', 'file_write']);
    tracker.recordSequence(['web_search', 'web_fetch', 'file_write']);
    const patterns = tracker.getTopPatterns(10);
    const webSearchFetchWrite = patterns.find(
      (p) => p.sequence.join('→') === 'web_search→web_fetch→file_write',
    );
    expect(webSearchFetchWrite).toBeDefined();
    expect(webSearchFetchWrite!.frequency).toBe(2);
  });

  it('predicts next tool from observed patterns', () => {
    tracker.recordSequence(['web_search', 'web_fetch']);
    tracker.recordSequence(['web_search', 'web_fetch']);
    tracker.recordSequence(['web_search', 'web_fetch']);

    const predictions = tracker.predictNext(['web_search']);
    expect(predictions.length).toBeGreaterThan(0);
    expect(predictions[0].toolName).toBe('web_fetch');
    expect(predictions[0].confidence).toBeGreaterThan(0);
  });

  it('returns empty predictions for unknown sequences', () => {
    const predictions = tracker.predictNext(['unknown_tool']);
    expect(predictions).toHaveLength(0);
  });

  it('increases confidence with frequency', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordSequence(['file_read', 'file_edit', 'file_write']);
    }
    const predictions = tracker.predictNext(['file_read']);
    const fileEdit = predictions.find((p) => p.toolName === 'file_edit');
    expect(fileEdit).toBeDefined();
    expect(fileEdit!.confidence).toBeGreaterThan(0.5);
  });

  it('returns top patterns sorted by frequency', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordSequence(['a', 'b']);
    }
    for (let i = 0; i < 3; i++) {
      tracker.recordSequence(['c', 'd']);
    }
    const top = tracker.getTopPatterns(5);
    expect(top[0].sequence.join('→')).toBe('a→b');
    expect(top[0].frequency).toBe(5);
  });
});

describe('SpeculativeExecutor - getPatternTracker', () => {
  beforeEach(() => {
    resetPatternTracker();
  });

  it('returns a singleton instance', () => {
    const t1 = getPatternTracker();
    const t2 = getPatternTracker();
    expect(t1).toBe(t2);
  });

  it('reset creates a new instance', () => {
    const t1 = getPatternTracker();
    resetPatternTracker();
    const t2 = getPatternTracker();
    expect(t1).not.toBe(t2);
  });
});

describe('SpeculativeExecutor - planSpeculativeExecution', () => {
  let tracker: PatternTracker;

  beforeEach(() => {
    tracker = new PatternTracker();
  });

  it('returns empty plan with no patterns', () => {
    const plan = planSpeculativeExecution(
      tracker,
      [{ name: 'web_search', arguments: { query: 'test' } }],
      ['web_search', 'web_fetch'],
    );
    expect(plan).toHaveLength(0);
  });

  it('predicts next tool from learned pattern', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordSequence(['web_search', 'web_fetch']);
    }

    const plan = planSpeculativeExecution(
      tracker,
      [{ name: 'web_search', arguments: { query: 'test' } }],
      ['web_search', 'web_fetch', 'file_read'],
    );

    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0].name).toBe('web_fetch');
  });

  it('skips unsafe tools in predictions', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordSequence(['file_read', 'shell_execute']);
    }

    const plan = planSpeculativeExecution(
      tracker,
      [{ name: 'file_read', arguments: { path: '/test' } }],
      ['file_read', 'shell_execute'],
    );

    const hasUnsafe = plan.some((p) => p.name === 'shell_execute');
    expect(hasUnsafe).toBe(false);
  });

  it('limits to max 2 predictions', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordSequence(['file_read', 'file_search', 'file_edit', 'file_write']);
    }

    const plan = planSpeculativeExecution(
      tracker,
      [{ name: 'file_read', arguments: { path: '/test' } }],
      ['file_read', 'file_search', 'file_edit', 'file_write'],
    );

    expect(plan.length).toBeLessThanOrEqual(2);
  });
});

describe('SpeculativeExecutor - triggerSpeculativeExecution integration', () => {
  beforeEach(() => {
    resetPatternTracker();
  });

  it('triggerSpeculativeExecution is a no-op when config disabled', async () => {
    // When speculativeExecution.enabled is not set (default), the method
    // should return immediately without touching the cache or tools.
    const { ToolExecutionService } = await import('../../src/runtime/toolExecutionService');
    const mockCache = { get: () => null, set: () => {} };
    const svc = new ToolExecutionService({
      tools: new Map(),
      compensationService: {} as never,
      cacheManager: { getToolCache: () => mockCache } as never,
      dlq: {} as never,
      getRunHandle: () => null,
      config: {} as never,
      reflexionGenerator: {} as never,
      stepTimeout: {} as never,
      getPromotedTools: () => new Set(),
      generateActionId: () => 'test',
      getBreakerRegistry: () => ({ get: () => null }) as never,
    });
    // Should not throw and should return void
    await expect(svc.triggerSpeculativeExecution()).resolves.toBeUndefined();
  });

  it('triggerSpeculativeExecution does not execute when no patterns learned', async () => {
    const { ToolExecutionService } = await import('../../src/runtime/toolExecutionService');
    let executeCalled = false;
    const mockTool = {
      execute: async () => {
        executeCalled = true;
        return 'result';
      },
    };
    const tools = new Map([['file_read', mockTool as never]]);
    const mockCache = { get: () => null, set: () => {} };
    const svc = new ToolExecutionService({
      tools,
      compensationService: {} as never,
      cacheManager: { getToolCache: () => mockCache } as never,
      dlq: {} as never,
      getRunHandle: () => null,
      config: { speculativeExecution: { enabled: true } } as never,
      reflexionGenerator: {} as never,
      stepTimeout: {} as never,
      getPromotedTools: () => new Set(),
      generateActionId: () => 'test',
      getBreakerRegistry: () => ({ get: () => null }) as never,
    });
    await svc.triggerSpeculativeExecution();
    expect(executeCalled).toBe(false);
  });

  it('skips speculative execute when security gate blocks', async () => {
    vi.resetModules();
    vi.doMock('../../src/security/securityGuardianFacade', () => ({
      checkToolGuardian: () => ({
        allowed: false,
        reason: 'blocked for test',
        kind: 'gateway_blocked',
      }),
    }));

    const { ToolExecutionService } = await import('../../src/runtime/toolExecutionService');
    const { getPatternTracker } = await import('../../src/runtime/speculativeExecutor');

    let executeCalled = false;
    let cacheSetCalled = false;
    const mockTool = {
      execute: async () => {
        executeCalled = true;
        return 'secret-result';
      },
    };
    const tools = new Map([['file_read', mockTool as never]]);
    const mockCache = {
      get: () => null,
      set: () => {
        cacheSetCalled = true;
      },
    };

    const tracker = getPatternTracker();
    for (let i = 0; i < 10; i++) {
      tracker.recordSequence(['file_search', 'file_read']);
    }

    const svc = new ToolExecutionService({
      tools,
      compensationService: {} as never,
      cacheManager: { getToolCache: () => mockCache } as never,
      dlq: {} as never,
      getRunHandle: () => null,
      config: {
        speculativeExecution: { enabled: true },
        securityMonitor: { enabled: true },
      } as never,
      reflexionGenerator: {} as never,
      stepTimeout: {} as never,
      getPromotedTools: () => new Set(),
      generateActionId: () => 'test',
      getBreakerRegistry: () => ({ get: () => null }) as never,
    });

    // Seed recent calls so planSpeculativeExecution can predict file_read
    (svc as unknown as { recentToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> }).recentToolCalls =
      [{ name: 'file_search', arguments: { q: 'x' } }];

    await svc.triggerSpeculativeExecution();

    expect(executeCalled).toBe(false);
    expect(cacheSetCalled).toBe(false);

    vi.doUnmock('../../src/security/securityGuardianFacade');
    vi.resetModules();
  });
});
