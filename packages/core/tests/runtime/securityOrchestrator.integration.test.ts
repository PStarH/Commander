/**
 * SecurityOrchestrator Integration Tests — verify the wiring inside agentRuntime.ts.
 *
 * Covers:
 *   - onBeforeToolCall: AdaptiveHITL blocks high-risk tools in the execution loop
 *   - onAgentEvent: LLM calls, tool calls, and tool results feed the correlator
 *   - sanitizeMemoryShare: DP layer is invoked on memory.query() results
 *   - Event metadata correctness: fields populated correctly
 *   - Config-driven disabling
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory, getGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import {
  getSecurityOrchestrator,
  resetSecurityOrchestrator,
} from '../../src/runtime/securityOrchestrator';
import {
  getCrossAgentCorrelator,
  resetCrossAgentCorrelator,
  type CrossAgentEvent,
} from '../../src/security/crossAgentCorrelator';
import { getGuardianAgent } from '../../src/security/guardianAgent';
import {
  getDifferentialPrivacyLayer,
  resetDifferentialPrivacyLayer,
  type DPQueryOutcome,
} from '../../src/security/differentialPrivacyLayer';
import type { AgentExecutionContext, Tool } from '../../src/runtime/types';
import type { LLMRequest, LLMResponse } from '../../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    missionId: 'test-mission',
    goal: 'Analyze the system architecture and provide recommendations.',
    contextData: {},
    availableTools: [],
    maxSteps: 5,
    tokenBudget: 200000,
    ...overrides,
  };
}

/** A mock provider that can return tool calls natively. */
class ToolCallMockProvider extends MockLLMProvider {
  private _toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

  setToolCalls(tcs: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
    this._toolCalls = tcs;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const base = await super.call(request);
    const response: LLMResponse = {
      ...base,
      ...(this._toolCalls.length > 0 ? { toolCalls: this._toolCalls } : {}),
    };
    return response;
  }
}

/** Create a simple echo tool. */
function makeEchoTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `Echo tool: ${name}`,
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
    },
    execute: async (args) => `Echo from ${name}: ${args.msg}`,
    isConcurrencySafe: true,
  };
}

/** Seed the ThreeLayerMemory with entries for DP integration tests. */
function seedMemory(count: number): void {
  const memory = getGlobalThreeLayerMemory();
  for (let i = 0; i < count; i++) {
    memory.add(
      `Memory entry ${i}: important data about system architecture patterns for analysis and recommendations.`,
      'working',
      'test-context',
      0.3 + (i % 5) * 0.1,
      ['test', 'integration'],
      { seedIndex: i },
    );
  }
}

// ============================================================================
// Suite reset
// ============================================================================

function fullReset(): void {
  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();
  resetGlobalThreeLayerMemory();
  resetSecurityOrchestrator();
  resetCrossAgentCorrelator();
  resetDifferentialPrivacyLayer();
}

// ============================================================================
// Tests
// ============================================================================

describe('SecurityOrchestrator Integration — agentRuntime.ts wiring', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;

  beforeEach(() => {
    fullReset();
    router = new ModelRouter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── onBeforeToolCall: blocks high-risk tools ──────────────────────

  describe('onBeforeToolCall — high-risk tool blocking', () => {
    it('should block a high-risk tool during execution', async () => {
      const provider = new ToolCallMockProvider('openai', {
        defaultResponse: 'I will use a shell tool for this.',
      });
      provider.setToolCalls([{ id: 'shell1', name: 'shell', arguments: { cmd: 'rm -rf /' } }]);

      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
      runtime.registerProvider('openai', provider);
      runtime.registerTool('shell', {
        definition: {
          name: 'shell',
          description: 'Execute a shell command',
          inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
        execute: async (args) => `Ran: ${args.cmd}`,
        isConcurrencySafe: false,
      });

      // Spy on onBeforeToolCall to simulate the security orchestrator blocking the shell tool.
      // In production, AdaptiveHITL would decide this based on runtime signals;
      // for integration testing we verify the wiring: when the orchestrator says "blocked",
      // the agent loop propagates it correctly.
      const orch = getSecurityOrchestrator();
      const spy = vi.spyOn(orch, 'onBeforeToolCall').mockResolvedValue({
        allowed: false,
        hitlStrategy: 'deny',
        blockReason: 'AdaptiveHITL blocked: dangerous shell command',
        sources: ['AdaptiveHITL'],
      });

      const result = await runtime.execute(
        makeContext({
          availableTools: ['shell'],
          goal: 'Execute a shell command to clean up files',
        }),
      );

      // The spy should have been called at least once
      expect(spy).toHaveBeenCalled();

      // Verify the correlator received a blocked tool_call event AND a tool_result with hasError
      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();

      // tool_call event should show the tool was blocked
      const blockedToolEvents = events.filter(
        (e) => e.type === 'tool_call' && e.metadata.allowed === false,
      );
      expect(blockedToolEvents.length).toBeGreaterThan(0);
      expect(blockedToolEvents[0].severity).toBe('high');

      // tool_result event should indicate the tool had an error
      const resultEvents = events.filter((e) => e.type === 'tool_result');
      expect(resultEvents.length).toBeGreaterThan(0);
      expect(resultEvents[0].metadata.hasError).toBe(true);
    });

    it('should allow a low-risk tool to execute', async () => {
      const provider = new ToolCallMockProvider('openai', {
        defaultResponse: 'I will echo a message.',
      });
      provider.setToolCalls([{ id: 't1', name: 'echo', arguments: { msg: 'hello' } }]);

      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
      runtime.registerProvider('openai', provider);
      runtime.registerTool('echo', makeEchoTool('echo'));

      const result = await runtime.execute(
        makeContext({ availableTools: ['echo'], goal: 'Echo a message' }),
      );

      expect(result.status).toBe('success');
    });

    it('should produce tool_call events in the correlator', async () => {
      resetCrossAgentCorrelator();

      const provider = new ToolCallMockProvider('openai', {
        defaultResponse: 'I will echo for the correlator test.',
      });
      provider.setToolCalls([{ id: 'ct1', name: 'echo', arguments: { msg: 'correlator-test' } }]);

      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
      runtime.registerProvider('openai', provider);
      runtime.registerTool('echo', makeEchoTool('echo'));

      await runtime.execute(
        makeContext({ availableTools: ['echo'], goal: 'Call echo for correlator test' }),
      );

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();
      const toolCallEvents = events.filter((e) => e.type === 'tool_call');

      expect(toolCallEvents.length).toBeGreaterThan(0);
      expect(toolCallEvents[0].agentId).toBe('test-agent');
      expect(toolCallEvents[0].metadata.toolName).toBe('echo');
    });
  });

  // ── onAgentEvent: correlator feed ─────────────────────────────────

  describe('onAgentEvent — correlator event feed', () => {
    it('should feed llm_call events to the correlator', async () => {
      resetCrossAgentCorrelator();

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Analysis complete. No issues found.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
      runtime.registerProvider('openai', provider);

      await runtime.execute(makeContext());

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();
      const llmEvents = events.filter((e) => e.type === 'llm_call');

      expect(llmEvents.length).toBeGreaterThan(0);
      const llmEvent = llmEvents[0];
      expect(llmEvent.agentId).toBe('test-agent');
      expect(llmEvent.metadata).toHaveProperty('model');
      expect(llmEvent.metadata).toHaveProperty('provider');
      expect(llmEvent.metadata).toHaveProperty('tier');
      expect(llmEvent.metadata).toHaveProperty('tokenUsage');
      expect(llmEvent.metadata).toHaveProperty('hasToolCalls');
      expect(llmEvent.severity).toBe('low');
      expect(typeof llmEvent.timestamp).toBe('number');
    });

    it('should feed tool_result events to the correlator', async () => {
      resetCrossAgentCorrelator();

      const provider = new ToolCallMockProvider('openai', {
        defaultResponse: 'I will use the echo tool.',
      });
      provider.setToolCalls([{ id: 'tr1', name: 'echo', arguments: { msg: 'result-test' } }]);

      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
      runtime.registerProvider('openai', provider);
      runtime.registerTool('echo', makeEchoTool('echo'));

      await runtime.execute(
        makeContext({ availableTools: ['echo'], goal: 'Call echo for result test' }),
      );

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();
      const resultEvents = events.filter((e) => e.type === 'tool_result');

      expect(resultEvents.length).toBeGreaterThan(0);
      const resultEvent = resultEvents[0];
      expect(resultEvent.agentId).toBe('test-agent');
      expect(resultEvent.metadata).toHaveProperty('toolName', 'echo');
      expect(resultEvent.metadata).toHaveProperty('toolCallId');
      expect(resultEvent.metadata).toHaveProperty('outputLength');
      expect(resultEvent.metadata).toHaveProperty('hasError');
    });

    it('should feed unrecognized event types to the correlator (guardian early-return fix)', () => {
      // 'state_change' is a valid CrossAgentEvent type but NOT in guardian's
      // recognized set ['tool_call', 'tool_result', 'llm_call', 'agent_spawn'].
      // Before the fix, the guardian block used `if (!types.has(type)) return;`
      // which exited the entire onAgentEvent method, preventing the correlator
      // from seeing unrecognized event types.
      resetCrossAgentCorrelator();

      const orch = getSecurityOrchestrator();
      const guardianSpy = vi.spyOn(getGuardianAgent(), 'monitor');

      const event: CrossAgentEvent = {
        id: 'unrecognized-1',
        type: 'state_change',
        agentId: 'test-agent',
        runId: 'run-1',
        summary: 'Agent state changed to idle',
        timestamp: Date.now(),
        severity: 'low',
        metadata: { previousState: 'active', newState: 'idle' },
      };

      orch.onAgentEvent(event);

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('state_change');
      expect(events[0].agentId).toBe('test-agent');

      // Guardian should NOT have been called for unrecognized event types
      expect(guardianSpy).not.toHaveBeenCalled();
    });

    it('should feed all three event types per execution turn', async () => {
      resetCrossAgentCorrelator();

      const provider = new ToolCallMockProvider('openai', {
        defaultResponse: 'I will use echo.',
      });
      provider.setToolCalls([{ id: 'all1', name: 'echo', arguments: { msg: 'all-events' } }]);

      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
      runtime.registerProvider('openai', provider);
      runtime.registerTool('echo', makeEchoTool('echo'));

      await runtime.execute(
        makeContext({ availableTools: ['echo'], goal: 'All event types test' }),
      );

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();

      // Should have all three event types
      const types = new Set(events.map((e) => e.type));
      expect(types.has('llm_call')).toBe(true);
      expect(types.has('tool_call')).toBe(true);
      expect(types.has('tool_result')).toBe(true);
    });
  });

  // ── sanitizeMemoryShare: DP layer on memory queries ───────────────

  describe('sanitizeMemoryShare — DP layer on memory queries', () => {
    it('should invoke DP sanitization when memory is queried during execution', async () => {
      seedMemory(10);

      const orch = getSecurityOrchestrator();
      const spy = vi.spyOn(orch, 'sanitizeMemoryShare');

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Based on past experiences, here are my recommendations.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
      runtime.registerProvider('openai', provider);

      const result = await runtime.execute(
        makeContext({
          agentId: 'dp-test-agent',
          goal: 'Analyze the current system architecture and provide recommendations based on past experiences.',
        }),
      );

      expect(result.status).toBe('success');

      // Verify sanitizeMemoryShare was called
      expect(spy).toHaveBeenCalled();

      // Verify it was called with the right entries and agentId
      const [entries, agentId] = spy.mock.calls[0];
      expect(Array.isArray(entries)).toBe(true);
      expect((entries as unknown[]).length).toBeGreaterThan(0);
      expect(agentId).toBe('dp-test-agent');

      // Each entry should have the expected numeric fields
      const firstEntry = (entries as Array<Record<string, unknown>>)[0];
      expect(firstEntry).toHaveProperty('importance');
      expect(firstEntry).toHaveProperty('accessCount');
      expect(firstEntry).toHaveProperty('decayScore');

      // Verify DP privacy budget was actually consumed
      const dp = getDifferentialPrivacyLayer();
      const budget = dp.getBudget('dp-test-agent');
      expect(budget.consumedBudget).toBeGreaterThan(0);

      // Verify the spy return value: epsilonUsed > 0 and answerable
      const outcome = spy.mock.results[0]?.value as
        | DPQueryOutcome<Array<{ importance?: number; accessCount?: number; decayScore?: number }>>
        | undefined;
      expect(outcome).toBeDefined();
      expect(outcome!.epsilonUsed).toBeGreaterThan(0);
      expect(outcome!.answerable).toBe(true);
    });

    it('should handle empty memory gracefully', async () => {
      // No seed — memory is empty.
      // The goal has keywords >4 chars so the memory query still runs.
      const orch = getSecurityOrchestrator();
      const spy = vi.spyOn(orch, 'sanitizeMemoryShare');

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'No past experiences to draw from.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
      runtime.registerProvider('openai', provider);

      const result = await runtime.execute(
        makeContext({ goal: 'Do something completely novel that has never been tried.' }),
      );

      expect(result.status).toBe('success');

      // sanitizeMemoryShare should still be called — with an empty entries array
      expect(spy).toHaveBeenCalled();
      const [entries] = spy.mock.calls[0];
      expect((entries as unknown[]).length).toBe(0);
    });

    it('should not crash when DP module is disabled', async () => {
      fullReset();
      seedMemory(5);

      const orch = getSecurityOrchestrator();
      orch.updateConfig({ enableDifferentialPrivacy: false });
      const spy = vi.spyOn(orch, 'sanitizeMemoryShare');

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Analysis done.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, new ModelRouter());
      runtime.registerProvider('openai', provider);

      const result = await runtime.execute(
        makeContext({
          goal: 'Analyze the system architecture and provide recommendations.',
        }),
      );

      expect(result.status).toBe('success');

      // sanitizeMemoryShare should still be called even when DP is disabled
      // — it just passes through unsanitized entries.
      expect(spy).toHaveBeenCalled();
      const [entries] = spy.mock.calls[0];
      expect((entries as unknown[]).length).toBeGreaterThan(0);

      // Verify DP privacy budget was NOT consumed (pass-through path)
      const dp = getDifferentialPrivacyLayer();
      const budget = dp.getBudget('test-agent');
      expect(budget.consumedBudget).toBe(0);

      // Verify the spy return value: epsilonUsed === 0 on pass-through
      const outcome = spy.mock.results[0]?.value as
        | DPQueryOutcome<Array<{ importance?: number; accessCount?: number; decayScore?: number }>>
        | undefined;
      expect(outcome).toBeDefined();
      expect(outcome!.epsilonUsed).toBe(0);
      expect(outcome!.answerable).toBe(true);
    });

    it('should reject with too_few_items when fewer than minItemsForSanitization', async () => {
      // minItemsForSanitization defaults to 5 — seed only 3 entries
      seedMemory(3);

      const orch = getSecurityOrchestrator();
      const spy = vi.spyOn(orch, 'sanitizeMemoryShare');

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'I have limited context to work with.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
      runtime.registerProvider('openai', provider);

      const result = await runtime.execute(
        makeContext({
          agentId: 'few-items-agent',
          goal: 'Analyze the system architecture and provide recommendations based on past patterns.',
        }),
      );

      // Execution should still succeed (fail-open on DP rejection)
      expect(result.status).toBe('success');

      // sanitizeMemoryShare should have been called with 3 entries
      expect(spy).toHaveBeenCalled();
      const [entries] = spy.mock.calls[0];
      expect((entries as unknown[]).length).toBe(3);

      // Verify the rejection outcome: not answerable, reason too_few_items, no budget spent
      const outcome = spy.mock.results[0]?.value as
        | DPQueryOutcome<Array<{ importance?: number; accessCount?: number; decayScore?: number }>>
        | undefined;
      expect(outcome).toBeDefined();
      expect(outcome!.answerable).toBe(false);
      if (!outcome!.answerable) {
        expect((outcome as { reason: string }).reason).toBe('too_few_items');
      }
      expect(outcome!.epsilonUsed).toBe(0);
    });
  });

  // ── Event metadata correctness ────────────────────────────────────

  describe('Event metadata correctness', () => {
    it('should include runId in all correlator events', async () => {
      resetCrossAgentCorrelator();

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Task complete.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
      runtime.registerProvider('openai', provider);

      const result = await runtime.execute(makeContext());
      expect(result.status).toBe('success');

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();

      for (const event of events) {
        expect(event.runId).toBe(result.runId);
      }
    });

    it('should include agentId in all correlator events', async () => {
      resetCrossAgentCorrelator();

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Done.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
      runtime.registerProvider('openai', provider);

      await runtime.execute(makeContext({ agentId: 'integration-agent-42' }));

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();

      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.agentId).toBe('integration-agent-42');
      }
    });
  });

  // ── Config-driven disabling ───────────────────────────────────────

  describe('Config-driven disabling', () => {
    it('should skip correlator events when enableCrossAgentCorrelator is false', async () => {
      fullReset();
      resetCrossAgentCorrelator();

      const orch = getSecurityOrchestrator();
      orch.updateConfig({ enableCrossAgentCorrelator: false });

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Task complete.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, new ModelRouter());
      runtime.registerProvider('openai', provider);

      await runtime.execute(makeContext());

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();
      expect(events.length).toBe(0);
    });

    it('should skip event ingestion when enabled is false', async () => {
      fullReset();
      resetCrossAgentCorrelator();

      const orch = getSecurityOrchestrator();
      orch.updateConfig({ enabled: false });

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Task complete.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, new ModelRouter());
      runtime.registerProvider('openai', provider);

      const result = await runtime.execute(makeContext());

      // Execution should still succeed (security is best-effort)
      expect(result.status).toBe('success');

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();
      // When SecurityOrchestrator is disabled, no events should be ingested
      expect(events.length).toBe(0);
    });
  });

  // ── Multiple executions do not leak state ────────────────────────

  describe('Cross-run isolation', () => {
    it('should create separate events per execution', async () => {
      resetCrossAgentCorrelator();

      const provider = new MockLLMProvider('openai', {
        defaultResponse: 'Done.',
      });
      runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, new ModelRouter());
      runtime.registerProvider('openai', provider);

      const r1 = await runtime.execute(makeContext({ agentId: 'agent-a', goal: 'Task A' }));
      const r2 = await runtime.execute(makeContext({ agentId: 'agent-b', goal: 'Task B' }));

      expect(r1.status).toBe('success');
      expect(r2.status).toBe('success');

      const correlator = getCrossAgentCorrelator();
      const events = correlator.getEvents();

      // Events from both runs should exist with correct runIds
      const runIds = new Set(events.map((e) => e.runId).filter(Boolean));
      expect(runIds.has(r1.runId)).toBe(true);
      expect(runIds.has(r2.runId)).toBe(true);
    });
  });
});
