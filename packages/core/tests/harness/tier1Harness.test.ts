/**
 * Tests for Tier1Harness — verifies harness selection, capability advertisement,
 * event emission, and integration with Tier1AgentLoop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Tier1Harness, TIER1_HARNESS_CAPABILITIES } from '../../src/harness/tier1Harness';
import type { HarnessSelectionContext, HarnessRunParams, HarnessServices } from '../../src/harness/harnessTypes';
import type { AgentExecutionResult } from '../../src/runtime/types';

// ============================================================================
// Test Fixtures
// ============================================================================

const createMockServices = (): HarnessServices => ({
  getProvider: vi.fn((name: string) => ({
    call: vi.fn().mockResolvedValue({
      content: 'Final answer',
      toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
      model: 'test-model',
      provider: 'test-provider',
    }),
  }) as any),
  getTool: vi.fn(),
  getToolDefinition: vi.fn(),
  listTools: vi.fn(() => []),
  cacheResult: vi.fn(),
  getCachedResult: vi.fn(() => null),
  invalidateCache: vi.fn(),
  checkpoint: vi.fn(),
  fireBeforeLLMCall: vi.fn(async (ctx: any) => ctx.request),
  fireAfterLLMCall: vi.fn(),
  fireBeforeToolCall: vi.fn(async () => ({ blocked: false })),
  fireAfterToolCall: vi.fn(async (ctx: any) => ctx.result),
  fireOnAgentStart: vi.fn(),
  fireOnAgentComplete: vi.fn(),
  fireOnError: vi.fn(),
  recordLLMCall: vi.fn(),
  recordToolCall: vi.fn(),
  compactMessages: vi.fn((msgs: any) => ({ messages: msgs, dropped: 0, saved: 0 })),
  scanContent: vi.fn(async () => ({ isSafe: true })),
  reportTokenUsage: vi.fn(),
  getRemainingBudget: vi.fn(() => 100000),
  isBudgetCritical: vi.fn(() => false),
  publishEvent: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
  loadSkills: vi.fn(async () => []),
  injectSkill: vi.fn(async (_, prompt) => prompt),
  spawnSubAgent: vi.fn(),
  waitForSubAgent: vi.fn(),
  watchFile: vi.fn(() => () => {}),
  saveSession: vi.fn(),
  loadSession: vi.fn(),
  listSessions: vi.fn(),
  checkNetworkPolicy: vi.fn(),
  classifyCommand: vi.fn(),
  pushSteer: vi.fn(),
  popSteer: vi.fn(),
  drainSteerQueue: vi.fn(),
  applyPatch: vi.fn(),
  updatePlanItem: vi.fn(),
  getPlanItems: vi.fn(),
});

const baseRunParams = (overrides: Partial<HarnessRunParams> = {}): HarnessRunParams => ({
  goal: 'Test goal',
  messages: [{ role: 'user', content: 'Test' }],
  availableTools: [],
  tokenBudget: 100000,
  maxSteps: 5,
  signal: new AbortController().signal,
  routing: { modelId: 'test-model', tier: 'standard', provider: 'test-provider', maxTokens: 1024 },
  services: createMockServices(),
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('Tier1Harness', () => {
  let harness: Tier1Harness;
  let events: any[];

  beforeEach(() => {
    harness = new Tier1Harness();
    events = [];
    harness.subscribe((event) => events.push(event));
  });

  it('advertises tier-1 capabilities', () => {
    const caps = harness.getCapabilities();
    expect(caps.supportsSubAgents).toBe(true);
    expect(caps.supportsSteering).toBe(true);
    expect(caps.supportsGuardianApproval).toBe(true);
    expect(caps.supportsConcurrentExecution).toBe(true);
    expect(caps.supportsSkillsLoading).toBe(true);
    expect(caps.maxConcurrentTools).toBe(8);
    expect(caps.maxToolCallsPerTurn).toBe(30);
  });

  it('supports all execution contexts', () => {
    const ctx: HarnessSelectionContext = {
      model: 'gpt-4o',
      tier: 'power',
      provider: 'openai',
      features: [],
    };
    expect(harness.supports(ctx)).toBe(true);
  });

  it('executes a simple run and returns AgentExecutionResult', async () => {
    const result = await harness.runAttempt(baseRunParams());
    expect(result).toBeDefined();
    expect(result.status).toBe('success');
    expect(result.summary).toBe('Final answer');
    expect(result.runId).toBeDefined();
    expect(result.agentId).toBe('Test goal');
  });

  it('emits run lifecycle events', async () => {
    await harness.runAttempt(baseRunParams());
    const types = events.map((e) => e.type);
    expect(types).toContain('run_start');
    expect(types).toContain('llm_request');
    expect(types).toContain('llm_response');
    expect(types).toContain('run_complete');
  });

  it('fires onAgentStart and onAgentComplete hooks', async () => {
    const services = baseRunParams().services;
    await harness.runAttempt(baseRunParams({ services }));
    expect(services.fireOnAgentStart).toHaveBeenCalledTimes(1);
    expect(services.fireOnAgentComplete).toHaveBeenCalledTimes(1);
  });

  it('aborts in-progress runs', async () => {
    let aborted = false;

    const slowProvider = {
      call: vi.fn().mockImplementation(async () => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          const check = () => {
            if (aborted) {
              clearTimeout(timer);
              reject(new Error('Aborted'));
            } else {
              setTimeout(check, 50);
            }
          };
          setTimeout(check, 50);
        });
        return baseResponse('late');
      }),
    };

    const params = baseRunParams({
      services: {
        ...createMockServices(),
        getProvider: vi.fn(() => slowProvider as any),
      },
    });

    const runPromise = harness.runAttempt(params);
    // Abort after 100ms
    setTimeout(() => {
      aborted = true;
      harness.abort();
    }, 100);
    const result = await runPromise;

    expect(result.status).toBe('cancelled');
  });

  it('supports steering messages', async () => {
    harness.steer('Please be more concise', 5, false);
    // Should not throw — steering is queued internally
    expect(harness.getCapabilities().supportsSteering).toBe(true);
  });

  it('injects skills into system prompt when provided', async () => {
    const injectSkill = vi.fn(async (_, prompt) => `${prompt}\n<skill>test</skill>`);
    const services = createMockServices();
    services.injectSkill = injectSkill;

    await harness.runAttempt(
      baseRunParams({
        services,
        skills: ['skill-1'],
      }),
    );

    expect(injectSkill).toHaveBeenCalledWith('skill-1', expect.any(String));
  });

  it('returns failure when provider is missing', async () => {
    const services = createMockServices();
    services.getProvider = vi.fn(() => undefined);

    const result = await harness.runAttempt(baseRunParams({ services }));
    expect(result.status).toBe('failed');
    expect(result.error).toContain('No provider');
  });
});
