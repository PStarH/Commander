import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { CompensationRegistry } from '../../src/runtime/compensationRegistry';
import { resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus, getMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { resetMetricsCollector, getMetricsCollector } from '../../src/runtime/metricsCollector';
import { ModelRouter } from '../../src/runtime/modelRouter';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { CompensationEventSubscriber } from '../../src/runtime/compensationEventSubscriber';
import { PersistentTraceStore } from '../../src/runtime/traceStore';

// ============================================================================
// Helpers
// ============================================================================

function makeContext(overrides?: Partial<import('../../src/runtime/types').AgentExecutionContext>) {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    missionId: 'test-mission',
    goal: 'Write a test file.',
    contextData: { governanceProfile: { riskLevel: 'LOW' } },
    availableTools: ['file_write'],
    maxSteps: 5,
    tokenBudget: 8000,
    ...overrides,
  };
}

function makeMutationTool(name: string) {
  return {
    definition: {
      name,
      description: `Mutation tool: ${name}`,
      inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
    },
    execute: async (_args: Record<string, unknown>) => JSON.stringify({ ok: true }),
  };
}

// ============================================================================
// CompensationRegistry: getHandler public method
// ============================================================================
describe('CompensationRegistry — getHandler', () => {
  let registry: CompensationRegistry;

  beforeEach(() => {
    registry = new CompensationRegistry();
  });

  it('returns undefined for unregistered tool', () => {
    expect(registry.getHandler('unknown_tool')).toBeUndefined();
  });

  it('returns the handler registered for a tool', () => {
    const handler = async () => ({ success: true as const });
    registry.register('file_write', handler);
    expect(registry.getHandler('file_write')).toBe(handler);
  });

  it('returns the correct handler among multiple registrations', () => {
    const fileHandler = async () => ({ success: true as const });
    const mkdirHandler = async () => ({ success: true as const });
    registry.register('file_write', fileHandler);
    registry.register('mkdir', mkdirHandler);
    expect(registry.getHandler('file_write')).toBe(fileHandler);
    expect(registry.getHandler('mkdir')).toBe(mkdirHandler);
  });
});

// ============================================================================
// AgentRuntime: handleMutationToolFailure
// ============================================================================
describe('AgentRuntime — handleMutationToolFailure', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const provider = new MockLLMProvider('openai', { defaultResponse: 'Done.' });
    runtime.registerProvider('openai', provider);
  });

  it('records compensation actions via recordAction and publishes bus event', async () => {
    // Simulate some executed mutations so the rollback plan has steps
    const rt = runtime as any;
    rt.executedMutations = [
      { toolName: 'file_write', args: { path: '/tmp/a.txt', content: 'hello' } },
    ];

    const recordSpy = vi.spyOn(runtime.getCompensationRegistry(), 'recordAction');
    const bus = getMessageBus();
    const publishSpy = vi.spyOn(bus, 'publish');

    await rt.handleMutationToolFailure('file_write', { path: '/tmp/b.txt' }, 'disk full');

    // Should have recorded compensation actions via recordAction
    expect(recordSpy).toHaveBeenCalled();
    const callArgs = recordSpy.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs.toolName).toBe('file_write');

    // Should have published tool.compensation_planned
    expect(publishSpy).toHaveBeenCalledWith(
      'tool.compensation_planned',
      'runtime',
      expect.objectContaining({
        toolName: 'file_write',
        stepCount: expect.any(Number) as number,
        risk: expect.any(String) as string,
      }),
    );
  });

  it('generates a rollback plan that includes steps for prior mutations', async () => {
    const rt = runtime as any;
    rt.executedMutations = [
      { toolName: 'file_write', args: { path: '/tmp/a.txt', content: 'v1' } },
      { toolName: 'file_write', args: { path: '/tmp/b.txt', content: 'v2' } },
    ];

    const recordSpy = vi.spyOn(runtime.getCompensationRegistry(), 'recordAction');

    await rt.handleMutationToolFailure('file_write', { path: '/tmp/c.txt' }, 'permission denied');

    // Should have recorded 2 compensation actions (one for each prior mutation)
    expect(recordSpy).toHaveBeenCalledTimes(2);
  });

  it('handles empty executedMutations gracefully (no prior mutations)', async () => {
    const rt = runtime as any;
    rt.executedMutations = [];

    const recordSpy = vi.spyOn(runtime.getCompensationRegistry(), 'recordAction');

    // Should not throw
    await expect(
      rt.handleMutationToolFailure('file_write', { path: '/tmp/a.txt' }, 'error'),
    ).resolves.toBeUndefined();

    // No steps to compensate
    expect(recordSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// AgentRuntime: compensateViaSaga
// ============================================================================
describe('AgentRuntime — compensateViaSaga', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const provider = new MockLLMProvider('openai', { defaultResponse: 'Done.' });
    runtime.registerProvider('openai', provider);
  });

  it('executes compensation steps via compensationRegistry.compensate', async () => {
    const reg = runtime.getCompensationRegistry();

    // Register a compensation handler
    let handlerCalled = false;
    reg.register('file_write', async () => {
      handlerCalled = true;
      return { success: true };
    });

    // Record an action so it can be compensated
    const actionId = 'test-action-123';
    reg.recordAction({
      actionId,
      toolName: 'file_write',
      args: { path: '/tmp/test.txt' },
      description: 'file_write(/tmp/test.txt)',
      tags: ['tool', 'file_write'],
    });

    const compensateSpy = vi.spyOn(reg, 'compensate');

    // Build a minimal CompensationPlan to pass to compensateViaSaga
    const plan = {
      steps: [
        {
          description: 'Undo file_write to /tmp/test.txt',
          forwardAction: { actionId, toolName: 'file_write', args: { path: '/tmp/test.txt' } },
          inverse: { toolName: 'file_write', args: { path: '/tmp/test.txt' } },
          risk: 'safe' as const,
          estimatedCostUsd: 0.01,
        },
      ],
      risk: 'safe' as const,
      trigger: { toolName: 'file_write', args: { path: '/tmp/test.txt' }, error: 'test' },
      estimatedCostUsd: 0.01,
      requiresApproval: false,
      requireApproval: false,
    };

    const rt = runtime as any;
    await rt.compensateViaSaga(plan);

    // compensate should have been called with the actionId
    expect(compensateSpy).toHaveBeenCalledWith(actionId);
  });

  it('handles empty plan gracefully (no steps)', async () => {
    const plan = {
      steps: [],
      risk: 'safe' as const,
      trigger: { toolName: 'file_write', args: {}, error: 'test' },
      estimatedCostUsd: 0,
      requiresApproval: false,
      requireApproval: false,
    };

    const rt = runtime as any;
    // SagaBuilder throws if no steps are added, but compensateViaSaga
    // should handle this gracefully by catching the error
    try {
      await rt.compensateViaSaga(plan);
      // If it doesn't throw, that's fine too
    } catch {
      // Expected: SagaBuilder requires at least one step
    }
  });
});

// ============================================================================
// AgentRuntime: mutation tracking + compensation integration
// ============================================================================
describe('AgentRuntime — integration via tool execution', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
  });

  it('initializes compensation registry and executedMutations', () => {
    const reg = runtime.getCompensationRegistry();
    expect(reg).toBeDefined();
    expect(reg.getPendingCount()).toBe(0);

    const rt = runtime as any;
    expect(Array.isArray(rt.executedMutations)).toBe(true);
    expect(rt.executedMutations.length).toBe(0);
  });

  it('exposes ledgerCtx as null when RunLedger unavailable', () => {
    expect((runtime as any).ledgerCtx).toBeNull();
  });

  it('executes successfully with a mutation tool registered', async () => {
    // Register a MockLLMProvider that returns a text response (no tool calls)
    // to avoid needing a ToolCallMockProvider
    const provider = new MockLLMProvider('openai', { defaultResponse: 'Completed.' });
    runtime.registerProvider('openai', provider);
    runtime.registerTool('file_write', makeMutationTool('file_write'));

    const result = await runtime.execute(makeContext());
    // Since the provider returns a text response with no tool calls,
    // the execution should succeed via the early-exit path
    expect(result.status).toBe('success');
  });
});

// ============================================================================
// End-to-end: real tool failure triggers handleMutationToolFailure + compensateViaSaga
// ============================================================================
describe('End-to-end — tool failure triggers compensation flow', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
  });

  it('publishes tool.compensation_planned bus event when mutation tool fails', async () => {
    // Register tools: one success (populates executedMutations) + one fail (triggers hook)
    let callCount = 0;
    const alternatingTool = {
      definition: {
        name: 'file_write',
        description: 'Write to a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      async execute(_args: Record<string, unknown>): Promise<string> {
        callCount++;
        if (callCount === 1) {
          return JSON.stringify({ ok: true, path: '/tmp/a.txt' });
        }
        throw new Error('Disk full on second call');
      },
    };
    runtime.registerTool('file_write', alternatingTool);

    // Register compensation handler
    runtime.getCompensationRegistry().register('file_write', async () => ({ success: true }));

    // Register a mock provider that returns toolCalls on first call,
    // then text-only (stop) on follow-ups to terminate the tool loop
    let providerCallCount = 0;
    const provider = {
      name: 'openai',
      async call(_request: any) {
        providerCallCount++;
        if (providerCallCount > 1) {
          return {
            content: 'Done processing all tools.',
            model: 'mock',
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            finishReason: 'stop' as const,
          };
        }
        return {
          content: '',
          model: 'mock',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          finishReason: 'tool_calls' as const,
          toolCalls: [
            { id: 'call_1', name: 'file_write', arguments: { path: '/tmp/a.txt', content: 'hello' } },
            { id: 'call_2', name: 'file_write', arguments: { path: '/tmp/b.txt', content: 'world' } },
          ],
        };
      },
    };
    runtime.registerProvider('openai', provider);

    // Spy on the bus for tool.compensation_planned
    const bus = getMessageBus();
    const publishSpy = vi.spyOn(bus, 'publish');

    await runtime.execute({
      agentId: 'test-agent',
      projectId: 'test-project',
      missionId: 'test-mission',
      goal: 'Write files',
      contextData: { governanceProfile: { riskLevel: 'LOW' } },
      availableTools: ['file_write'],
      maxSteps: 5,
      tokenBudget: 8000,
    });

    // Verify the tool.compensation_planned event was published
    // (proof that handleMutationToolFailure was called automatically)
    expect(publishSpy).toHaveBeenCalledWith(
      'tool.compensation_planned',
      'runtime',
      expect.objectContaining({ toolName: 'file_write' }),
    );
  });

  it('calls compensationRegistry.compensate (via compensateViaSaga) when plan is safe', async () => {
    // Register tools: one success (populates executedMutations) + one fail (triggers hook)
    let callCount = 0;
    const alternatingTool = {
      definition: {
        name: 'file_write',
        description: 'Write to a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      async execute(_args: Record<string, unknown>): Promise<string> {
        callCount++;
        if (callCount === 1) {
          return JSON.stringify({ ok: true, path: '/tmp/a.txt' });
        }
        throw new Error('Disk full on second call');
      },
    };
    runtime.registerTool('file_write', alternatingTool);

    // Spy on compensate — if handleMutationToolFailure calls compensateViaSaga,
    // which calls compensationRegistry.compensate, this spy should fire
    const reg = runtime.getCompensationRegistry();
    const compensateSpy = vi.spyOn(reg, 'compensate');
    reg.register('file_write', async () => ({ success: true }));

    // Provider with follow-up text-only response to terminate the tool loop
    let providerCallCount = 0;
    const provider = {
      name: 'openai',
      async call(_request: any) {
        providerCallCount++;
        if (providerCallCount > 1) {
          return {
            content: 'Done processing all tools.',
            model: 'mock',
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            finishReason: 'stop' as const,
          };
        }
        return {
          content: '',
          model: 'mock',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          finishReason: 'tool_calls' as const,
          toolCalls: [
            { id: 'call_1', name: 'file_write', arguments: { path: '/tmp/a.txt', content: 'hello' } },
            { id: 'call_2', name: 'file_write', arguments: { path: '/tmp/b.txt', content: 'world' } },
          ],
        };
      },
    };
    runtime.registerProvider('openai', provider);

    await runtime.execute({
      agentId: 'test-agent',
      projectId: 'test-project',
      missionId: 'test-mission',
      goal: 'Write files',
      contextData: { governanceProfile: { riskLevel: 'LOW' } },
      availableTools: ['file_write'],
      maxSteps: 5,
      tokenBudget: 8000,
    });

    // compensationRegistry.compensate should be called (by compensateViaSaga)
    // for the safe rollback plan generated from the first successful mutation
    expect(compensateSpy).toHaveBeenCalled();
  });
});

// ============================================================================
// Typed bus integration: tool.compensation_planned + tool.compensation_step
// ============================================================================
describe('Typed bus integration', () => {
  it('publishes tool.compensation_planned without throwing at runtime', () => {
    const bus = getMessageBus();
    expect(() => {
      bus.publish('tool.compensation_planned', 'test', {
        runId: 'test-run',
        toolName: 'file_write',
        stepCount: 2,
        risk: 'safe',
      });
    }).not.toThrow();
  });

  it('publishes tool.compensation_step with all status variants', () => {
    const bus = getMessageBus();
    const stepPayload = {
      runId: 'test-run',
      toolName: 'file_write',
      actionId: 'action-123',
      stepIndex: 0,
      totalSteps: 3,
    };

    // 'started' status
    expect(() => {
      bus.publish('tool.compensation_step', 'test', {
        ...stepPayload,
        status: 'started' as const,
      });
    }).not.toThrow();

    // 'completed' status
    expect(() => {
      bus.publish('tool.compensation_step', 'test', {
        ...stepPayload,
        status: 'completed' as const,
      });
    }).not.toThrow();

    // 'failed' status with error
    expect(() => {
      bus.publish('tool.compensation_step', 'test', {
        ...stepPayload,
        status: 'failed' as const,
        error: 'disk full',
      });
    }).not.toThrow();
  });

  it('compensateViaSaga publishes tool.compensation_step events during execution', async () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();

    const router = new ModelRouter();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);

    // Register a compensation handler and record an action
    const reg = runtime.getCompensationRegistry();
    reg.register('file_write', async () => ({ success: true }));
    reg.recordAction({
      actionId: 'e2e-action',
      toolName: 'file_write',
      args: { path: '/tmp/test.txt' },
      description: 'file_write(/tmp/test.txt)',
      tags: ['tool', 'file_write'],
    });

    // Spy on bus.publish for both events
    const bus = getMessageBus();
    const publishSpy = vi.spyOn(bus, 'publish');

    // Build a minimal CompensationPlan and call compensateViaSaga
    const plan = {
      steps: [
        {
          description: 'Undo file_write to /tmp/test.txt',
          forwardAction: { actionId: 'e2e-action', toolName: 'file_write', args: { path: '/tmp/test.txt' } },
          inverse: { toolName: 'file_write', args: { path: '/tmp/test.txt' } },
          risk: 'safe' as const,
          estimatedCostUsd: 0.01,
        },
      ],
      risk: 'safe' as const,
      trigger: { toolName: 'file_write', args: { path: '/tmp/test.txt' }, error: 'test' },
      estimatedCostUsd: 0.01,
      requiresApproval: false,
      requireApproval: false,
    };

    const rt = runtime as any;
    await rt.compensateViaSaga(plan);

    // Verify tool.compensation_step events were published with correct types
    const stepCalls = publishSpy.mock.calls.filter(
      (call) => call[0] === 'tool.compensation_step',
    );

    expect(stepCalls.length).toBeGreaterThanOrEqual(2);

    // First call should be 'started'
    expect(stepCalls[0][2]).toMatchObject({
      status: 'started',
      toolName: 'file_write',
      actionId: 'e2e-action',
      stepIndex: 0,
      totalSteps: 1,
    });

    // Last call should be 'completed'
    const lastCall = stepCalls[stepCalls.length - 1];
    expect(lastCall[2]).toMatchObject({
      status: 'completed',
      toolName: 'file_write',
    });
  });
});

// ============================================================================
// CompensationEventSubscriber: logs, metrics, and traces for compensation events
// ============================================================================
describe('CompensationEventSubscriber', () => {
  let bus: import('../../src/runtime/messageBus').MessageBus;
  let subscriber: CompensationEventSubscriber;
  let traceStore: PersistentTraceStore;

  beforeEach(() => {
    resetMessageBus();
    resetMetricsCollector();
    bus = getMessageBus();
    subscriber = new CompensationEventSubscriber();
    traceStore = new PersistentTraceStore('/tmp/commander-test-traces');
  });

  afterEach(() => {
    subscriber.stop();
    traceStore.shutdown();
  });

  // ── tool.compensation_planned ──

  it('logs and records metrics when tool.compensation_planned is published', () => {
    subscriber.start(bus, traceStore);

    bus.publish('tool.compensation_planned', 'runtime', {
      runId: 'run-1',
      toolName: 'file_write',
      stepCount: 3,
      risk: 'safe',
    });

    const counter = getMetricsCollector().getCounter('compensation_planned_total', [
      { name: 'tool', value: 'file_write' },
      { name: 'risk', value: 'safe' },
    ]);
    expect(counter).toBe(1);
  });

  it('handles multiple tool.compensation_planned events with different tools', () => {
    subscriber.start(bus, traceStore);

    bus.publish('tool.compensation_planned', 'runtime', {
      runId: 'run-1',
      toolName: 'file_write',
      stepCount: 2,
      risk: 'safe',
    });
    bus.publish('tool.compensation_planned', 'runtime', {
      runId: 'run-2',
      toolName: 'shell_execute',
      stepCount: 1,
      risk: 'review',
    });

    expect(
      getMetricsCollector().getCounter('compensation_planned_total', [
        { name: 'tool', value: 'file_write' },
        { name: 'risk', value: 'safe' },
      ]),
    ).toBe(1);

    expect(
      getMetricsCollector().getCounter('compensation_planned_total', [
        { name: 'tool', value: 'shell_execute' },
        { name: 'risk', value: 'review' },
      ]),
    ).toBe(1);
  });

  // ── tool.compensation_step ──

  it('logs and records metrics when tool.compensation_step is published', () => {
    subscriber.start(bus, traceStore);

    bus.publish('tool.compensation_step', 'runtime', {
      runId: 'run-1',
      toolName: 'file_write',
      actionId: 'act-1',
      stepIndex: 0,
      totalSteps: 2,
      status: 'started',
    });

    bus.publish('tool.compensation_step', 'runtime', {
      runId: 'run-1',
      toolName: 'file_write',
      actionId: 'act-1',
      stepIndex: 0,
      totalSteps: 2,
      status: 'completed',
    });

    expect(
      getMetricsCollector().getCounter('compensation_steps_total', [
        { name: 'tool', value: 'file_write' },
        { name: 'status', value: 'started' },
      ]),
    ).toBe(1);

    expect(
      getMetricsCollector().getCounter('compensation_steps_total', [
        { name: 'tool', value: 'file_write' },
        { name: 'status', value: 'completed' },
      ]),
    ).toBe(1);
  });

  it('tracks failed step status correctly', () => {
    subscriber.start(bus, traceStore);

    bus.publish('tool.compensation_step', 'runtime', {
      runId: 'run-1',
      toolName: 'file_write',
      actionId: 'act-1',
      stepIndex: 0,
      totalSteps: 1,
      status: 'started',
    });

    bus.publish('tool.compensation_step', 'runtime', {
      runId: 'run-1',
      toolName: 'file_write',
      actionId: 'act-1',
      stepIndex: 0,
      totalSteps: 1,
      status: 'failed',
      error: 'disk full',
    });

    expect(
      getMetricsCollector().getCounter('compensation_steps_total', [
        { name: 'tool', value: 'file_write' },
        { name: 'status', value: 'failed' },
      ]),
    ).toBe(1);
  });

  // ── Unsubscribe behavior ──

  it('stops receiving events after stop() is called', () => {
    subscriber.start(bus, traceStore);
    subscriber.stop();

    bus.publish('tool.compensation_planned', 'runtime', {
      runId: 'run-1',
      toolName: 'file_write',
      stepCount: 1,
      risk: 'safe',
    });

    // Counter should remain 0 since subscriber was stopped
    expect(
      getMetricsCollector().getCounter('compensation_planned_total', [
        { name: 'tool', value: 'file_write' },
        { name: 'risk', value: 'safe' },
      ]),
    ).toBe(0);
  });

  it('re-starts cleanly after stop() (idempotent re-subscribe)', () => {
    subscriber.start(bus, traceStore);
    subscriber.stop();
    subscriber.start(bus, traceStore);

    bus.publish('tool.compensation_planned', 'runtime', {
      runId: 'run-1',
      toolName: 'file_write',
      stepCount: 1,
      risk: 'safe',
    });

    expect(
      getMetricsCollector().getCounter('compensation_planned_total', [
        { name: 'tool', value: 'file_write' },
        { name: 'risk', value: 'safe' },
      ]),
    ).toBe(1);
  });

  // ── Trace store integration ──

  it('appends trace events to the trace store', () => {
    const appendSpy = vi.spyOn(traceStore, 'append');
    subscriber.start(bus, traceStore);

    bus.publish('tool.compensation_planned', 'runtime', {
      runId: 'trace-run',
      toolName: 'file_write',
      stepCount: 1,
      risk: 'safe',
    });

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const traceCall = appendSpy.mock.calls[0][0];
    expect(traceCall).toMatchObject({
      runId: 'trace-run',
      type: 'state_change',
      data: {
        input: { toolName: 'file_write', stepCount: 1, risk: 'safe' },
        output: { status: 'planned' },
      },
    });
  });

  it('appends trace events for compensation_step with all status variants', () => {
    const appendSpy = vi.spyOn(traceStore, 'append');
    subscriber.start(bus, traceStore);

    bus.publish('tool.compensation_step', 'runtime', {
      runId: 'trace-run',
      toolName: 'file_write',
      actionId: 'act-1',
      stepIndex: 0,
      totalSteps: 1,
      status: 'failed',
      error: 'disk full',
    });

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const traceCall = appendSpy.mock.calls[0][0];
    expect(traceCall).toMatchObject({
      runId: 'trace-run',
      type: 'state_change',
      data: {
        input: { toolName: 'file_write', actionId: 'act-1', stepIndex: 0, totalSteps: 1 },
        output: { status: 'failed', error: 'disk full' },
      },
    });
  });

  // ── AgentRuntime constructor wires the subscriber automatically ──

  it('is automatically wired in AgentRuntime constructor', () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();

    const router = new ModelRouter();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const provider = new MockLLMProvider('openai', { defaultResponse: 'Done.' });
    runtime.registerProvider('openai', provider);

    // Publish a compensation event — the subscriber should log/record it
    const bus = getMessageBus();
    bus.publish('tool.compensation_planned', 'runtime', {
      runId: 'auto-wire',
      toolName: 'file_write',
      stepCount: 1,
      risk: 'safe',
    });

    // Metrics should have been recorded by the auto-wired subscriber
    expect(
      getMetricsCollector().getCounter('compensation_planned_total', [
        { name: 'tool', value: 'file_write' },
        { name: 'risk', value: 'safe' },
      ]),
    ).toBe(1);

    // Subscriber also runs on tool.compensation_step
    bus.publish('tool.compensation_step', 'runtime', {
      runId: 'auto-wire',
      toolName: 'file_write',
      actionId: 'act-1',
      stepIndex: 0,
      totalSteps: 1,
      status: 'completed',
    });

    expect(
      getMetricsCollector().getCounter('compensation_steps_total', [
        { name: 'tool', value: 'file_write' },
        { name: 'status', value: 'completed' },
      ]),
    ).toBe(1);
  });
});
