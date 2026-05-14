import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { MessageBus, getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import { ExecutionTraceRecorder, getTraceRecorder, resetTraceRecorder } from '../../src/runtime/executionTrace';
import { MetaLearner, getMetaLearner, resetMetaLearner } from '../../src/selfEvolution/metaLearner';
import { HTMLReportRenderer, createWarRoomHTMLReport } from '../../src/reporting/htmlReportRenderer';
import type { AgentExecutionContext, Tool, ExecutionExperience } from '../../src/runtime/types';

describe('Runtime E2E: Full Pipeline', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;
  let bus: MessageBus;
  let tracer: ExecutionTraceRecorder;
  let learner: MetaLearner;
  let provider: MockLLMProvider;

  before(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetMetaLearner();

    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    bus = getMessageBus();
    tracer = getTraceRecorder();
    learner = getMetaLearner();

    provider = new MockLLMProvider('e2e-openai', {
      defaultResponse: 'Analysis complete. Found 3 key issues: performance, security, and reliability.',
    });
    runtime.registerProvider('openai', provider);
  });

  function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
    return {
      agentId: 'agent-e2e',
      projectId: 'e2e-test-project',
      missionId: 'e2e-mission-1',
      goal: 'Analyze the system architecture for potential improvements.',
      contextData: { governanceProfile: { riskLevel: 'LOW' } },
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
      ...overrides,
    };
  }

  it('Scenario 1: Agent executes and publishes completion event on bus', async () => {
    const events: string[] = [];
    bus.subscribe('agent.completed', (msg) => {
      events.push('completed');
    });

    const result = await runtime.execute(makeContext());

    expect(result.status).toBe('success');
    expect(events).toContain('completed');
  });

  it('Scenario 2: Agent failure publishes failed event on bus', async () => {
    const badProvider = new MockLLMProvider('failing');
    const mockCall = async () => { throw new Error('API timeout'); };
    badProvider.call = mockCall;
    runtime.registerProvider('openai', badProvider);

    const events: string[] = [];
    bus.subscribe('agent.failed', (msg) => {
      events.push('failed');
    });

    const result = await runtime.execute(makeContext());
    expect(result.status).toBe('failed');
    expect(events).toContain('failed');
  });

  it('Scenario 3: Execution trace records all steps', async () => {
    const result = await runtime.execute(makeContext());

    const trace = tracer.getTrace(result.runId);
    expect(trace).toBeDefined();
    expect(trace!.runId).toBe(result.runId);
    expect(trace!.agentId).toBe('agent-e2e');
    expect(trace!.completedAt).toBeTruthy();
  });

  it('Scenario 4: Trace captures LLM call and decision events', async () => {
    const result = await runtime.execute(makeContext());
    const trace = tracer.getTrace(result.runId)!;

    expect(trace.summary.totalEvents).toBeGreaterThanOrEqual(2);
    expect(trace.summary.llmCalls).toBeGreaterThanOrEqual(1);
  });

  it('Scenario 5: Model router integrates with runtime', async () => {
    const simpleCtx = makeContext({ goal: 'simple task' });
    const routing = router.route(simpleCtx);
    expect(routing.tier).toBe('eco');

    const result = await runtime.execute(simpleCtx);
    expect(result.status).toBe('success');
  });

  it('Scenario 6: Runtime respects governance profile for routing', async () => {
    const criticalCtx = makeContext({
      goal: 'A'.repeat(600),
      tokenBudget: 64000,
      availableTools: ['a', 'b', 'c', 'd', 'e', 'f'],
      contextData: {
        governanceProfile: { riskLevel: 'HIGH' },
      },
    });
    const routing = router.route(criticalCtx);
    expect(routing.tier).toBe('power');

    const result = await runtime.execute(criticalCtx);
    expect(result.status).toBe('success');
  });

  it('Scenario 7: Meta-learner records execution as experience', async () => {
    const result = await runtime.execute(makeContext());

    learner.recordExperience({
      id: `exp-${result.runId}`,
      runId: result.runId,
      agentId: result.agentId,
      missionId: result.missionId,
      taskType: 'analysis',
      modelUsed: 'gpt-4o-mini',
      strategyUsed: 'SEQUENTIAL',
      success: result.status === 'success',
      durationMs: result.totalDurationMs,
      tokenCost: result.totalTokenUsage.totalTokens,
      lessons: result.status === 'success' ? ['Task completed efficiently'] : [],
      timestamp: new Date().toISOString(),
    });

    const stats = learner.getStats();
    expect(stats.totalExperiences).toBe(1);
    expect(stats.topStrategies.length).toBe(1);
  });

  it('Scenario 8: Multiple agents communicate via message bus', async () => {
    const agentA = new MockLLMProvider('agent-a', {
      defaultResponse: 'Analysis from Agent A.',
    });
    const agentB = new MockLLMProvider('agent-b', {
      defaultResponse: 'Analysis from Agent B.',
    });
    runtime.registerProvider('agent-a-provider', agentA);
    runtime.registerProvider('agent-b-provider', agentB);

    const messages: string[] = [];
    bus.subscribe('agent.completed', (msg) => {
      messages.push(`${msg.source} completed`);
    });

    const ctxA = makeContext({ agentId: 'agent-a' });
    const ctxB = makeContext({ agentId: 'agent-b' });

    const [resA, resB] = await Promise.all([
      runtime.execute(ctxA),
      runtime.execute(ctxB),
    ]);

    expect(resA.status).toBe('success');
    expect(resB.status).toBe('success');
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it('Scenario 9: Tool execution is traced and usable', async () => {
    const searchTool: Tool = {
      definition: {
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
      execute: async (args) => `Results for query: ${args.q}`,
    };
    runtime.registerTool('web_search', searchTool);

    const ctx = makeContext({ availableTools: ['web_search'] });
    const result = await runtime.execute(ctx);

    expect(result.status).toBe('success');
    expect(provider.lastRequest!.tools).toBeDefined();
    if (provider.lastRequest!.tools) {
      expect(provider.lastRequest!.tools.length).toBeGreaterThan(0);
    }
  });

  it('Scenario 10: HTML report can be generated from execution data', () => {
    const report = createWarRoomHTMLReport({
      projectName: 'E2E Test',
      operationCodename: 'Op E2E',
      health: 'GREEN',
      metrics: { 'Tasks': '10', 'Agents': '3' },
      narrative: 'E2E test completed successfully.',
      topAgents: [{ name: 'Agent-1', completed: 5 }],
      missionSummary: { 'Running': 2, 'Done': 5 },
      recentEvents: [
        { timestamp: new Date().toISOString(), level: 'INFO', message: 'E2E test ran' },
      ],
    });

    expect(report.title).toContain('Op E2E');
    expect(report.sections.length).toBeGreaterThanOrEqual(4);

    const renderer = new HTMLReportRenderer();
    const html = renderer.render(report);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Op E2E');
  });

  it('Scenario 11: Execution trace summary is accurate', async () => {
    const result = await runtime.execute(makeContext());
    const trace = tracer.getTrace(result.runId)!;

    expect(trace.summary.totalEvents).toBe(trace.events.length);
    expect(trace.summary.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(trace.summary.modelUsed).toBeTruthy();
  });

  it('Scenario 12: Message bus history captures agent events', async () => {
    await runtime.execute(makeContext());

    const agentMessages = bus.getHistory('agent.completed');
    expect(agentMessages.length).toBeGreaterThanOrEqual(1);
    expect(agentMessages[0].topic).toBe('agent.completed');
    expect(agentMessages[0].source).toBe('agent-e2e');
  });

  it('Scenario 13: Multiple tools can be registered and used', () => {
    const tool1: Tool = {
      definition: { name: 'read_file', description: 'Read a file', inputSchema: {} },
      execute: async () => 'file content',
    };
    const tool2: Tool = {
      definition: { name: 'write_file', description: 'Write a file', inputSchema: {} },
      execute: async () => 'written',
    };
    const tool3: Tool = {
      definition: { name: 'execute_command', description: 'Run a command', inputSchema: {} },
      execute: async () => 'command output',
    };

    runtime.registerTool('read_file', tool1);
    runtime.registerTool('write_file', tool2);
    runtime.registerTool('execute_command', tool3);

    expect(runtime.getTool('read_file')).toBeDefined();
    expect(runtime.getTool('write_file')).toBeDefined();
    expect(runtime.getTool('execute_command')).toBeDefined();
  });

  it('Scenario 14: Runtime handles concurrent execution', async () => {
    const ctxs = [1, 2, 3].map(i => makeContext({
      agentId: `agent-${i}`,
      goal: `Task ${i}: simple analysis`,
    }));

    const results = await Promise.all(ctxs.map(ctx => runtime.execute(ctx)));
    expect(results.length).toBe(3);
    results.forEach(r => {
      expect(r.status).toBe('success');
    });
  });
});
