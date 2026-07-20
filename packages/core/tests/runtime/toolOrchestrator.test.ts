import { describe, it, expect } from 'vitest';
import { ToolOrchestrator } from '../../src/runtime/toolOrchestrator';

process.env.COMMANDER_ATR_MEMORY = '1';

describe('ToolOrchestrator', () => {
  describe('constructor', () => {
    it('creates orchestrator with default config', () => {
      const orchestrator = new ToolOrchestrator({});
      expect(orchestrator).toBeDefined();
    });

    it('creates orchestrator with custom config', () => {
      const orchestrator = new ToolOrchestrator({
        maxRetries: 5,
        timeoutMs: 60000,
      });
      expect(orchestrator).toBeDefined();
    });

    it('creates orchestrator with approval mode', () => {
      const orchestrator = new ToolOrchestrator({
        maxRetries: 3,
        timeoutMs: 30000,
      });
      expect(orchestrator).toBeDefined();
    });
  });
});

describe('ToolOrchestrator timeout abort', () => {
  it('passes abortSignal to tool.execute and surfaces TOOL_TIMEOUT', async () => {
    let sawAbort = false;
    const tool = {
      definition: {
        name: 'slow',
        description: 'slow tool',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_args: Record<string, unknown>, ctx?: { abortSignal?: AbortSignal }) => {
        await new Promise<void>((_resolve, reject) => {
          const signal = ctx?.abortSignal;
          if (!signal) {
            reject(new Error('missing abortSignal'));
            return;
          }
          if (signal.aborted) {
            sawAbort = true;
            reject(new Error('aborted early'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
        return 'never';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 30,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c1', name: 'slow', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const result = await orchestrator.execute(plan, new Map([['slow', tool as any]]), {
      runId: 'run-1',
      agentId: 'agent-1',
      stepNumber: 1,
    });

    expect(result.results).toHaveLength(1);
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_TIMEOUT');
    expect(sawAbort).toBe(true);
  });

  it('force-completes await after grace when tool ignores abortSignal', async () => {
    let started = false;
    const tool = {
      definition: {
        name: 'deaf',
        description: 'ignores abort',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        started = true;
        // Never settles and never observes abortSignal — must not pin orchestrator.
        await new Promise<void>(() => undefined);
        return 'never';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 30,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c2', name: 'deaf', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const startedAt = Date.now();
    const result = await orchestrator.execute(plan, new Map([['deaf', tool as any]]), {
      runId: 'run-2',
      agentId: 'agent-1',
      stepNumber: 1,
    });
    const elapsed = Date.now() - startedAt;

    expect(started).toBe(true);
    expect(result.results).toHaveLength(1);
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_TIMEOUT');
    // soft=30ms + grace=max(25,min(30,50))=30ms → hard fail ~60ms; allow headroom
    expect(elapsed).toBeLessThan(2_000);
    expect(msg).toContain('(non-cooperative)');
  });

  it('links parent abortSignal and does not forge empty agentContext fields', async () => {
    const parent = new AbortController();
    let sawAbort = false;
    let receivedCtx: Record<string, unknown> | undefined;
    const tool = {
      definition: {
        name: 'watch',
        description: 'observes ctx',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
        receivedCtx = ctx;
        await new Promise<void>((_resolve, reject) => {
          const signal = ctx?.abortSignal as AbortSignal | undefined;
          if (!signal) {
            reject(new Error('missing abortSignal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              // Cooperative cancel: reject with the same reason reference (#72 identity).
              reject(signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
        return 'never';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 5_000,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c3', name: 'watch', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const execPromise = orchestrator.execute(plan, new Map([['watch', tool as any]]), {
      runId: 'run-3',
      agentId: 'agent-1',
      stepNumber: 1,
      abortSignal: parent.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    parent.abort(new Error('parent cancel'));
    const result = await execPromise;

    expect(sawAbort).toBe(true);
    expect(receivedCtx?.goal).toBeUndefined();
    expect(receivedCtx?.availableTools).toBeUndefined();
    expect(receivedCtx?.tokenBudget).toBeUndefined();
    expect(receivedCtx?.agentId).toBe('agent-1');
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_ABORTED');
    expect(msg).not.toContain('TOOL_TIMEOUT');
    expect(msg).not.toContain('(non-cooperative)');
  });

  it('force-exits non-cooperative tool on parent abort within grace (not full timeoutMs)', async () => {
    const parent = new AbortController();
    const tool = {
      definition: {
        name: 'hang',
        description: 'ignores abort',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        await new Promise<void>(() => undefined);
        return 'never';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 5_000,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c4', name: 'hang', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const startedAt = Date.now();
    const execPromise = orchestrator.execute(plan, new Map([['hang', tool as any]]), {
      runId: 'run-4',
      agentId: 'agent-1',
      stepNumber: 1,
      abortSignal: parent.signal,
    });
    parent.abort();
    const result = await execPromise;
    const elapsed = Date.now() - startedAt;

    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_ABORTED');
    expect(msg).not.toContain('TOOL_TIMEOUT');
    expect(msg).toContain('(non-cooperative)');
    // grace-only bound (~50ms); must not wait full 5s timeoutMs
    expect(elapsed).toBeLessThan(400);
  });

  it('parent abort + late success resolve is non-cooperative', async () => {
    const parent = new AbortController();
    const tool = {
      definition: {
        name: 'late',
        description: 'ignores abort then succeeds',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return 'late-ok';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 5_000,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c4b', name: 'late', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const execPromise = orchestrator.execute(plan, new Map([['late', tool as any]]), {
      runId: 'run-4b',
      agentId: 'agent-1',
      stepNumber: 1,
      abortSignal: parent.signal,
    });
    parent.abort();
    const result = await execPromise;
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_ABORTED');
    expect(msg).toContain('(non-cooperative)');
  });

  it('timeout + late success resolve is non-cooperative', async () => {
    const tool = {
      definition: {
        name: 'late-to',
        description: 'ignores abort then succeeds after timeout',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return 'late-ok';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 30,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c4c', name: 'late-to', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const result = await orchestrator.execute(plan, new Map([['late-to', tool as any]]), {
      runId: 'run-4c',
      agentId: 'agent-1',
      stepNumber: 1,
    });
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_TIMEOUT');
    expect(msg).toContain('(non-cooperative)');
  });

  it('parent abort + late throw (ignore signal) is non-cooperative', async () => {
    const parent = new AbortController();
    const tool = {
      definition: {
        name: 'late-throw',
        description: 'ignores abort then throws unrelated error',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 40));
        throw new Error('side-effect done');
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 5_000,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c4d', name: 'late-throw', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const execPromise = orchestrator.execute(plan, new Map([['late-throw', tool as any]]), {
      runId: 'run-4d',
      agentId: 'agent-1',
      stepNumber: 1,
      abortSignal: parent.signal,
    });
    parent.abort();
    const result = await execPromise;
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_ABORTED');
    expect(msg).toContain('(non-cooperative)');
  });

  it('parent abort + late throw signal.reason (ignore) is non-cooperative', async () => {
    const parent = new AbortController();
    const tool = {
      definition: {
        name: 'late-throw-reason',
        description: 'ignores abort, side effects, then throws signal.reason',
        inputSchema: { type: 'object', properties: {} },
      },
      // 忽略 abort、做完副作用后再抛同一 reason — 不得标 coop（对齐 #72 dual-dispatch）。
      execute: async (_args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
        const signal = ctx?.abortSignal as AbortSignal | undefined;
        await new Promise((r) => setTimeout(r, 40));
        throw signal?.reason ?? new Error('missing reason');
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 5_000,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c4e', name: 'late-throw-reason', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const execPromise = orchestrator.execute(plan, new Map([['late-throw-reason', tool as any]]), {
      runId: 'run-4e',
      agentId: 'agent-1',
      stepNumber: 1,
      abortSignal: parent.signal,
    });
    parent.abort();
    const result = await execPromise;
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_ABORTED');
    expect(msg).toContain('(non-cooperative)');
  });

  it('timeout + late throw signal.reason (ignore) is non-cooperative', async () => {
    const tool = {
      definition: {
        name: 'late-to-reason',
        description: 'ignores timeout abort then throws signal.reason',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
        const signal = ctx?.abortSignal as AbortSignal | undefined;
        await new Promise((r) => setTimeout(r, 80));
        throw signal?.reason ?? new Error('missing reason');
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 30,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c4f', name: 'late-to-reason', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const result = await orchestrator.execute(plan, new Map([['late-to-reason', tool as any]]), {
      runId: 'run-4f',
      agentId: 'agent-1',
      stepNumber: 1,
    });
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_TIMEOUT');
    expect(msg).toContain('(non-cooperative)');
  });

  // Probe B: abort 监听器内同步副作用后再 setTimeout(0) reject(signal.reason)
  // —— settle 宏任务晚于关窗，不得标 coop（对齐 #72 dual-dispatch）。
  it('parent abort + abort-listener SE then setTimeout(0) reject(reason) is non-cooperative', async () => {
    const parent = new AbortController();
    let sideEffect = false;
    const tool = {
      definition: {
        name: 'probe-b-parent',
        description: 'SE then macrotask reject reason',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
        const signal = ctx?.abortSignal as AbortSignal | undefined;
        await new Promise<void>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('missing abortSignal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              sideEffect = true;
              setTimeout(() => reject(signal.reason), 0);
            },
            { once: true },
          );
        });
        return 'never';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 5_000,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c4g', name: 'probe-b-parent', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const execPromise = orchestrator.execute(plan, new Map([['probe-b-parent', tool as any]]), {
      runId: 'run-4g',
      agentId: 'agent-1',
      stepNumber: 1,
      abortSignal: parent.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    parent.abort();
    const result = await execPromise;
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(sideEffect).toBe(true);
    expect(msg).toContain('TOOL_ABORTED');
    expect(msg).toContain('(non-cooperative)');
  });

  it('timeout + abort-listener SE then setTimeout(0) reject(reason) is non-cooperative', async () => {
    let sideEffect = false;
    const tool = {
      definition: {
        name: 'probe-b-timeout',
        description: 'SE then macrotask reject reason on timeout abort',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
        const signal = ctx?.abortSignal as AbortSignal | undefined;
        await new Promise<void>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('missing abortSignal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              sideEffect = true;
              setTimeout(() => reject(signal.reason), 0);
            },
            { once: true },
          );
        });
        return 'never';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 30,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c4h', name: 'probe-b-timeout', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const result = await orchestrator.execute(plan, new Map([['probe-b-timeout', tool as any]]), {
      runId: 'run-4h',
      agentId: 'agent-1',
      stepNumber: 1,
    });
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(sideEffect).toBe(true);
    expect(msg).toContain('TOOL_TIMEOUT');
    expect(msg).toContain('(non-cooperative)');
  });

  it('does not retry after TOOL_TIMEOUT even when maxRetries > 0', async () => {
    let executions = 0;
    const tool = {
      definition: {
        name: 'deaf',
        description: 'ignores abort',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        executions += 1;
        await new Promise<void>(() => undefined);
        return 'never';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 2,
      defaultToolTimeoutMs: 30,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c5', name: 'deaf', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const result = await orchestrator.execute(plan, new Map([['deaf', tool as any]]), {
      runId: 'run-5',
      agentId: 'agent-1',
      stepNumber: 1,
    });

    expect(executions).toBe(1);
    expect(result.retriedCount).toBe(0);
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_TIMEOUT');
    // formatError 不得建议模型重试（orphan 可能仍在跑 → 跨层 dual-dispatch）
    expect(msg).toContain('Do not retry this call');
    expect(msg).not.toContain('If transient, retry the call');
    expect(msg).toContain('(non-cooperative)');
    expect(msg).toContain('retry risks dual-dispatch');
  });

  it('does not advise model retry after TOOL_ABORTED (cooperative)', async () => {
    const tool = {
      definition: {
        name: 'coop',
        description: 'aborts cooperatively',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_args: Record<string, unknown>, ctx?: { abortSignal?: AbortSignal }) => {
        await new Promise<void>((_resolve, reject) => {
          const signal = ctx?.abortSignal;
          if (!signal) {
            reject(new Error('missing abortSignal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return 'never';
      },
    };

    const parent = new AbortController();
    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 5_000,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c5b', name: 'coop', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    const execPromise = orchestrator.execute(plan, new Map([['coop', tool as any]]), {
      runId: 'run-5b',
      agentId: 'agent-1',
      stepNumber: 1,
      abortSignal: parent.signal,
    });
    parent.abort();
    const result = await execPromise;
    const msg = result.results[0]?.error ?? result.results[0]?.output ?? '';
    expect(msg).toContain('TOOL_ABORTED');
    expect(msg).not.toContain('(non-cooperative)');
    expect(msg).toContain('Do not retry this call');
    expect(msg).not.toContain('If transient, retry the call');
  });

  it('does not count TOOL_TIMEOUT / TOOL_ABORTED toward circuit breaker', async () => {
    const deaf = {
      definition: {
        name: 'deaf-cb',
        description: 'ignores abort',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        await new Promise<void>(() => undefined);
        return 'never';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 30,
      circuitBreakerThreshold: 2,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'cb1', name: 'deaf-cb', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    // 连续 soft-timeout 不应开路
    for (let i = 0; i < 3; i++) {
      await orchestrator.execute(plan, new Map([['deaf-cb', deaf as any]]), {
        runId: `run-cb-to-${i}`,
        agentId: 'agent-1',
        stepNumber: 1,
      });
    }
    expect(orchestrator.getCircuitState('deaf-cb').isOpen).toBe(false);
    expect(orchestrator.getCircuitState('deaf-cb').failures).toBe(0);

    // 连续 parent abort 也不应开路
    for (let i = 0; i < 3; i++) {
      const parent = new AbortController();
      const coop = {
        definition: {
          name: 'coop-cb',
          description: 'coop abort',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async (_args: Record<string, unknown>, ctx?: { abortSignal?: AbortSignal }) => {
          await new Promise<void>((_resolve, reject) => {
            const signal = ctx?.abortSignal;
            if (!signal) {
              reject(new Error('missing abortSignal'));
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return 'never';
        },
      };
      const abortPlan = {
        concurrent: [],
        serial: [{ id: `cb-a-${i}`, name: 'coop-cb', arguments: {} }],
        skipped: [],
        circuitBroken: [],
      };
      const p = orchestrator.execute(abortPlan, new Map([['coop-cb', coop as any]]), {
        runId: `run-cb-ab-${i}`,
        agentId: 'agent-1',
        stepNumber: 1,
        abortSignal: parent.signal,
      });
      parent.abort();
      await p;
    }
    expect(orchestrator.getCircuitState('coop-cb').isOpen).toBe(false);
    expect(orchestrator.getCircuitState('coop-cb').failures).toBe(0);
  });

  it('forwards real agentContext fields when provided', async () => {
    let received: Record<string, unknown> | undefined;
    const tool = {
      definition: {
        name: 'inspect',
        description: 'inspects ctx',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
        received = ctx;
        return 'ok';
      },
    };

    const orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 1_000,
    });

    const plan = {
      concurrent: [],
      serial: [{ id: 'c6', name: 'inspect', arguments: {} }],
      skipped: [],
      circuitBroken: [],
    };

    await orchestrator.execute(plan, new Map([['inspect', tool as any]]), {
      runId: 'run-6',
      agentId: 'agent-1',
      stepNumber: 1,
      agentContext: {
        agentId: 'agent-1',
        projectId: 'proj-real',
        goal: 'ship the fix',
        contextData: {},
        availableTools: ['inspect', 'other'],
        maxSteps: 9,
        tokenBudget: 12_000,
        runId: 'run-6',
      },
    });

    expect(received?.goal).toBe('ship the fix');
    expect(received?.availableTools).toEqual(['inspect', 'other']);
    expect(received?.tokenBudget).toBe(12_000);
    expect(received?.projectId).toBe('proj-real');
    expect(received?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('dual-path abort/timeout advice (TES + Orchestrator)', () => {
  it('aligns TES StepTimeoutError text with formatError: no transient retry', async () => {
    const { formatAbortTimeoutAdviceLines, isAbortOrTimeoutToolError } =
      await import('../../src/runtime/toolResultShape');

    // TES StepTimeoutManager 文案（主路径不经 Orchestrator.execute）
    expect(isAbortOrTimeoutToolError('Step "call-1" exceeded timeout of 30ms')).toBe(true);
    expect(isAbortOrTimeoutToolError('network ECONNABORTED')).toBe(false);
    // 父取消 AbortError 标准文案（TES 不发 TOOL_ABORTED: 时仍须识别）
    expect(isAbortOrTimeoutToolError('This operation was aborted')).toBe(true);
    expect(isAbortOrTimeoutToolError('The operation was aborted.')).toBe(true);

    const advice = formatAbortTimeoutAdviceLines('Step "call-1" exceeded timeout of 30ms').join(
      '\n',
    );
    expect(advice).toContain('Do not retry this call');
    expect(advice).not.toContain('If transient');
    expect(advice).not.toContain('If this is a transient');
  });

  it('TES AbortError: no transient advice + StepErrorBoundary does not re-execute', async () => {
    const { ToolExecutionService } = await import('../../src/runtime/toolExecutionService');
    const { StepTimeoutManager } = await import('../../src/runtime/stepTimeoutManager');
    const { DeadLetterQueue } = await import('../../src/runtime/deadLetterQueue');
    const { ReflexionGenerator } = await import('../../src/runtime/reflexionGenerator');

    let executeCount = 0;
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';

    const tools = new Map([
      [
        'probe',
        {
          definition: { name: 'probe', description: 't', parameters: { type: 'object' } },
          execute: async () => {
            executeCount++;
            throw abortErr;
          },
        },
      ],
    ]);

    const dlq = new DeadLetterQueue(`/tmp/commander_dlq_tes_abort_${Date.now()}`);
    const svc = new ToolExecutionService({
      tools: tools as never,
      compensationService: {
        getRegistry: () => ({
          assessReversibility: () => 'reversible',
          compensate: async () => ({ success: true }),
          recordAction: () => undefined,
        }),
        handleMutationToolFailure: async () => undefined,
      } as never,
      cacheManager: { getToolCache: () => ({ get: () => null, set: () => {} }) } as never,
      dlq,
      getRunHandle: () => null,
      config: { timeoutMs: 5_000, retryDelayMs: 1, observationMaskWindow: 4 } as never,
      reflexionGenerator: new ReflexionGenerator(),
      stepTimeout: new StepTimeoutManager(),
      getPromotedTools: () => new Set(),
      generateActionId: () => `act-${Date.now()}`,
      getBreakerRegistry: () =>
        ({
          get: () => null,
          forceOpen: () => undefined,
        }) as never,
    });

    const result = await svc.execute(
      'run-abort',
      { id: 'call-abort', name: 'probe', arguments: {} },
      'agent-1',
    );

    expect(executeCount).toBe(1);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('TOOL_ABORTED');
    expect(result.error).toContain('Do not retry this call');
    expect(result.error).not.toContain('If this is a transient error, retry the call');
    expect(result.error).not.toContain('If transient');
  });

  it('TES StepTimeout: StepErrorBoundary does not re-execute', async () => {
    const { ToolExecutionService } = await import('../../src/runtime/toolExecutionService');
    const { StepTimeoutManager } = await import('../../src/runtime/stepTimeoutManager');
    const { DeadLetterQueue } = await import('../../src/runtime/deadLetterQueue');
    const { ReflexionGenerator } = await import('../../src/runtime/reflexionGenerator');

    let executeCount = 0;
    const tools = new Map([
      [
        'slow',
        {
          definition: { name: 'slow', description: 't', parameters: { type: 'object' } },
          timeout: 30,
          execute: async () => {
            executeCount++;
            await new Promise((r) => setTimeout(r, 200));
            return 'late';
          },
        },
      ],
    ]);

    const dlq = new DeadLetterQueue(`/tmp/commander_dlq_tes_timeout_${Date.now()}`);
    const svc = new ToolExecutionService({
      tools: tools as never,
      compensationService: {
        getRegistry: () => ({
          assessReversibility: () => 'reversible',
          compensate: async () => ({ success: true }),
          recordAction: () => undefined,
        }),
        handleMutationToolFailure: async () => undefined,
      } as never,
      cacheManager: { getToolCache: () => ({ get: () => null, set: () => {} }) } as never,
      dlq,
      getRunHandle: () => null,
      config: { timeoutMs: 30, retryDelayMs: 1, observationMaskWindow: 4 } as never,
      reflexionGenerator: new ReflexionGenerator(),
      stepTimeout: new StepTimeoutManager(),
      getPromotedTools: () => new Set(),
      generateActionId: () => `act-${Date.now()}`,
      getBreakerRegistry: () =>
        ({
          get: () => null,
          forceOpen: () => undefined,
        }) as never,
    });

    const result = await svc.execute(
      'run-timeout',
      { id: 'call-timeout', name: 'slow', arguments: {} },
      'agent-1',
    );

    expect(executeCount).toBe(1);
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/exceeded timeout|TOOL_TIMEOUT/);
    expect(result.error).toContain('Do not retry this call');
    expect(result.error).not.toContain('If this is a transient error, retry the call');
  });
});
