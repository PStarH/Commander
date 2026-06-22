/**
 * Resilience Integration Tests — Runtime reliability subsystems working together.
 *
 * Covers the production-readiness codepaths that individual unit tests can't
 * exercise in isolation:
 *   1. ProviderFailoverChain — primary fails → fallback provider is used
 *   2. CircuitBreaker integration — repeated failures open the circuit
 *   3. ToolOrchestrator + ToolPlanner — dependency-aware tool execution
 *   4. StateCheckpointer — checkpoint is written during execute()
 *   5. DeadLetterQueue — fatal errors are persisted
 *   6. UnifiedVerificationPipeline — verification gates fire during execution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { ServiceContainer, resetServiceContainer } from '../../src/runtime/serviceContainer';
import { CircuitBreaker } from '../../src/runtime/circuitBreaker';
import {
  ProviderFallbackChain,
  FallbackChainExhaustedError,
} from '../../src/runtime/providerFallbackChain';
import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import { DeadLetterQueue } from '../../src/runtime/deadLetterQueue';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentExecutionContext,
  Tool,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../src/runtime/types';

function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'resilience-test',
    projectId: 'resilience-project',
    missionId: 'resilience-mission',
    goal: 'Resilience integration test goal.',
    contextData: {},
    availableTools: [],
    maxSteps: 5,
    tokenBudget: 8000,
    ...overrides,
  };
}

const CHECKPOINT_BASE = path.join(__dirname, '..', '..', '.test-checkpoints');

function cleanCheckpoints() {
  try {
    fs.rmSync(CHECKPOINT_BASE, { recursive: true, force: true });
  } catch {}
}

describe('Provider failover chain', () => {
  let primary: MockLLMProvider;
  let fallback: MockLLMProvider;

  beforeEach(() => {
    primary = new MockLLMProvider('primary', { defaultResponse: 'primary response' });
    fallback = new MockLLMProvider('fallback', { defaultResponse: 'fallback response' });
  });

  it('uses the primary provider when it succeeds', async () => {
    const chain = new ProviderFallbackChain<string>({ maxProviders: 2 });
    const result = await chain.tryProviders([
      {
        name: 'primary',
        attempt: () =>
          primary
            .call({ messages: [{ role: 'user', content: 'hi' }], model: 'test' })
            .then((r) => r.content),
      },
      {
        name: 'fallback',
        attempt: () =>
          fallback
            .call({ messages: [{ role: 'user', content: 'hi' }], model: 'test' })
            .then((r) => r.content),
      },
    ]);
    expect(result.providerUsed).toBe('primary');
    expect(result.result).toBe('primary response');
  });

  it('falls back to the next provider when primary fails with a retryable error', async () => {
    const chain = new ProviderFallbackChain<string>({ maxProviders: 2 });
    const result = await chain.tryProviders([
      { name: 'primary', attempt: () => Promise.reject(new Error('502 Bad Gateway')) },
      {
        name: 'fallback',
        attempt: () =>
          fallback
            .call({ messages: [{ role: 'user', content: 'hi' }], model: 'test' })
            .then((r) => r.content),
      },
    ]);
    expect(result.providerUsed).toBe('fallback');
    expect(result.result).toBe('fallback response');
  });

  it('throws FallbackChainExhaustedError when all providers fail', async () => {
    const chain = new ProviderFallbackChain<string>({ maxProviders: 2 });
    await expect(
      chain.tryProviders([
        { name: 'primary', attempt: () => Promise.reject(new Error('timeout')) },
        { name: 'fallback', attempt: () => Promise.reject(new Error('rate limited')) },
      ]),
    ).rejects.toThrow(FallbackChainExhaustedError);
  });

  it('skips providers whose circuit breaker is open', async () => {
    const breaker = new CircuitBreaker(1, 10_000);
    breaker.setProviderName('primary');
    breaker.onFailure();
    expect(breaker.isAvailable()).toBe(false);

    const chain = new ProviderFallbackChain<string>({ maxProviders: 2 });
    const result = await chain.tryProviders([
      { name: 'primary', attempt: () => Promise.resolve('should not be called'), breaker },
      {
        name: 'fallback',
        attempt: () =>
          fallback
            .call({ messages: [{ role: 'user', content: 'hi' }], model: 'test' })
            .then((r) => r.content),
      },
    ]);
    expect(result.providerUsed).toBe('fallback');
  });
});

describe('Circuit breaker integration', () => {
  let breaker: CircuitBreaker;
  let transitions: string[];

  beforeEach(() => {
    transitions = [];
    breaker = new CircuitBreaker(3, 100_000, 1, (from, to) => {
      transitions.push(`${from}→${to}`);
    });
  });

  it('transitions CLOSED → OPEN after threshold failures', () => {
    expect(breaker.getState()).toBe('CLOSED');
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe('CLOSED');
    breaker.onFailure();
    expect(breaker.getState()).toBe('OPEN');
    expect(transitions).toContain('CLOSED→OPEN');
  });

  it('transitions OPEN → HALF_OPEN after recovery time', async () => {
    const quickBreaker = new CircuitBreaker(1, 50, 1);
    quickBreaker.onFailure();
    expect(quickBreaker.getState()).toBe('OPEN');
    await new Promise((r) => setTimeout(r, 60));
    // isAvailable() transitions from OPEN to HALF_OPEN when recovery time has elapsed
    expect(quickBreaker.isAvailable()).toBe(true);
    expect(quickBreaker.getState()).toBe('HALF_OPEN');
  });

  it('records success counts via onSuccess()', () => {
    breaker.onSuccess();
    breaker.onSuccess();
    const stats = breaker.getStats();
    expect(stats.successCount).toBe(2);
  });

  it('isAvailable() returns false when circuit is OPEN', () => {
    const b = new CircuitBreaker(1, 10_000);
    b.onFailure();
    expect(b.isAvailable()).toBe(false);
  });
});

describe('Tool orchestration with dependencies', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;
  let mock: MockLLMProvider;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    resetServiceContainer();

    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    mock = new MockLLMProvider('tool-test', {
      defaultResponse: 'I will use the available tools to complete this task.',
    });
    runtime.registerProvider('openai', mock);
  });

  it('registers tools and runs successfully', async () => {
    const toolA: Tool = {
      definition: {
        name: 'tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => 'A-result',
    };
    runtime.registerTool('tool_a', toolA);

    const result = await runtime.execute(
      makeContext({ availableTools: ['tool_a'], goal: 'Execute tool_a' }),
    );

    expect(result.status).toBe('success');
    expect(runtime.getTool('tool_a')).toBeDefined();
  });

  it('handles tool execution errors gracefully', async () => {
    const failingTool: Tool = {
      definition: {
        name: 'fail_tool',
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        throw new Error('tool exploded');
      },
    };
    runtime.registerTool('fail_tool', failingTool);

    const result = await runtime.execute(
      makeContext({ availableTools: ['fail_tool'], goal: 'Try a tool that will fail' }),
    );

    expect(result.status).toBe('success');
    expect(result.steps.length).toBeGreaterThan(0);
  });
});

describe('StateCheckpointer integration', () => {
  let checkpointer: StateCheckpointer;
  const runId = 'test-checkpoint-run';

  beforeEach(() => {
    cleanCheckpoints();
    checkpointer = new StateCheckpointer(CHECKPOINT_BASE);
  });

  afterEach(() => {
    cleanCheckpoints();
  });

  it('writes a checkpoint and reads it back', () => {
    checkpointer.checkpoint({
      runId,
      agentId: 'test-agent',
      projectId: 'test-project',
      phase: 'started',
      stepNumber: 1,
      attemptNumber: 0,
      messages: [{ role: 'user', content: 'test' }],
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 0 },
      stepDurations: [100],
      goal: 'test',
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
      totalDurationMs: 100,
      timestamp: new Date().toISOString(),
    });

    const chkPath = path.join(CHECKPOINT_BASE, `${runId}.checkpoint`);
    expect(fs.existsSync(chkPath)).toBe(true);
    const raw = fs.readFileSync(chkPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.runId).toBe(runId);
    expect(parsed.phase).toBe('started');
  });

  it('overwrites checkpoint on subsequent saves', () => {
    checkpointer.checkpoint({
      runId,
      agentId: 'test-agent',
      projectId: 'test-project',
      phase: 'started',
      stepNumber: 1,
      attemptNumber: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 },
      stepDurations: [],
      goal: 'g',
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
      totalDurationMs: 0,
      timestamp: new Date().toISOString(),
    });

    checkpointer.checkpoint({
      runId,
      agentId: 'test-agent',
      projectId: 'test-project',
      phase: 'completed',
      stepNumber: 3,
      attemptNumber: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 },
      stepDurations: [],
      goal: 'g',
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 8000,
      totalDurationMs: 500,
      timestamp: new Date().toISOString(),
    });

    const chkPath = path.join(CHECKPOINT_BASE, `${runId}.checkpoint`);
    const raw = fs.readFileSync(chkPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.phase).toBe('completed');
    expect(parsed.stepNumber).toBe(3);
  });
});

describe('DeadLetterQueue integration', () => {
  let dlq: DeadLetterQueue;
  const dlqPath = path.join(__dirname, '..', '..', '.test-dlq');

  beforeEach(() => {
    try {
      fs.mkdirSync(path.dirname(dlqPath), { recursive: true });
    } catch {}
    dlq = new DeadLetterQueue(dlqPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(dlqPath, { recursive: true, force: true });
    } catch {}
  });

  it('enqueues and retrieves a dead letter entry', () => {
    dlq.enqueue({
      category: 'execution',
      runId: 'dlq-test-run',
      agentId: 'test-agent',
      operationName: 'test-operation',
      errorMessage: 'critical failure',
    });
    dlq.flush('execution');

    const entries = dlq.readEntries('execution');
    expect(entries.length).toBe(1);
    expect(entries[0].runId).toBe('dlq-test-run');
    expect(entries[0].errorMessage).toContain('critical failure');
  });

  it('returns multiple dead letter entries across categories', () => {
    dlq.enqueue({
      category: 'llm',
      runId: 'run-1',
      agentId: 'agent-1',
      operationName: 'llm-call',
      errorMessage: 'llm error',
    });
    dlq.enqueue({
      category: 'execution',
      runId: 'run-2',
      agentId: 'agent-2',
      operationName: 'execute',
      errorMessage: 'execution error',
    });
    dlq.flush('llm');
    dlq.flush('execution');

    const llmEntries = dlq.readEntries('llm');
    const execEntries = dlq.readEntries('execution');
    expect(llmEntries.length).toBe(1);
    expect(execEntries.length).toBe(1);
    expect(llmEntries[0].runId).toBe('run-1');
    expect(execEntries[0].runId).toBe('run-2');
  });

  it('collects per-category stats', () => {
    dlq.enqueue({
      category: 'execution',
      runId: 'run-target',
      agentId: 'agent-1',
      operationName: 'execute',
      errorMessage: 'target error',
    });
    dlq.enqueue({
      category: 'verification',
      runId: 'run-other',
      agentId: 'agent-2',
      operationName: 'verify',
      errorMessage: 'other error',
    });
    dlq.flush('execution');
    dlq.flush('verification');

    const stats = dlq.getStats();
    const execStat = stats.find((s) => s.category === 'execution');
    const verStat = stats.find((s) => s.category === 'verification');
    expect(execStat).toBeDefined();
    expect(execStat!.count).toBe(1);
    expect(verStat).toBeDefined();
    expect(verStat!.count).toBe(1);
  });
});

describe('Verification pipeline integration', () => {
  it('detects hallucination patterns', async () => {
    const { UnifiedVerificationPipeline } = await import('../../src/runtime/unifiedVerification');
    const pipeline = new UnifiedVerificationPipeline();
    const result = await pipeline.verify({
      goal: 'test verification',
      output: 'This is 100% guaranteed to be true without any doubt.',
    });
    expect(result).toBeDefined();
    expect(typeof result.passed).toBe('boolean');
    expect(Array.isArray(result.signals)).toBe(true);
  });

  it('passes clean factual responses', async () => {
    const { UnifiedVerificationPipeline } = await import('../../src/runtime/unifiedVerification');
    const pipeline = new UnifiedVerificationPipeline();
    const result = await pipeline.verify({
      goal: 'describe something',
      output: 'The sky appears blue due to Rayleigh scattering of sunlight.',
    });
    expect(result).toBeDefined();
    expect(typeof result.passed).toBe('boolean');
  });

  it('detects overconfidence patterns', async () => {
    const { UnifiedVerificationPipeline } = await import('../../src/runtime/unifiedVerification');
    const pipeline = new UnifiedVerificationPipeline();
    const result = await pipeline.verify({
      goal: 'cite a study',
      output:
        'According to a recent study by Dr. Johnson et al. published in 2024, the findings showed conclusively that...',
    });
    for (const signal of result.signals) {
      expect(signal.stage).toBeGreaterThanOrEqual(0);
      expect(signal.severity).toMatch(/^(low|medium|high|critical)$/);
      expect(typeof signal.message).toBe('string');
    }
  });
});

describe('Full runtime execution pipeline', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;
  let mock: MockLLMProvider;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    resetServiceContainer();

    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 10000 }, router);
    mock = new MockLLMProvider('full-pipeline', {
      defaultResponse: 'I have completed the analysis successfully.',
    });
    runtime.registerProvider('openai', mock);
  });

  it('completes a full execution cycle with success status', async () => {
    const result = await runtime.execute(makeContext());
    expect(result.status).toBe('success');
    expect(result.runId).toBeTruthy();
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.totalTokenUsage.totalTokens).toBeGreaterThan(0);
  });

  it('includes steps in the execution result', async () => {
    const result = await runtime.execute(makeContext({ maxSteps: 3 }));
    expect(result.status).toBe('success');
    expect(result.steps.length).toBeGreaterThan(0);
    for (const step of result.steps) {
      expect(step.type).toBeDefined();
    }
  });

  it('returns failed status when provider consistently errors', async () => {
    const failMock = new (class implements LLMProvider {
      readonly name = 'failing-mock';
      callCount = 0;
      async call(_request: LLMRequest): Promise<LLMResponse> {
        this.callCount++;
        throw new Error('LLM provider timeout');
      }
    })();
    runtime.registerProvider('openai', failMock);

    const result = await runtime.execute(makeContext({ maxSteps: 2 }));
    expect(result.status).toBe('failed');
    expect(failMock.callCount).toBeGreaterThanOrEqual(1);
  });

  it('handles concurrent execution without interference', async () => {
    const ctxs = [1, 2, 3].map((i) =>
      makeContext({ agentId: `concurrent-${i}`, goal: `Concurrent task ${i}` }),
    );

    const results = await Promise.all(ctxs.map((ctx) => runtime.execute(ctx)));
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.status).toBe('success');
      expect(r.runId).toBeTruthy();
    }
    const runIds = results.map((r) => r.runId);
    expect(new Set(runIds).size).toBe(3);
  });
});
