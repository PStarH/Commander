/**
 * H-03 regression — an unsafe final answer must never be reported as a
 * successful run, regardless of its length.
 *
 * Both DefaultHarness and CodeAgentHarness previously short-circuited the
 * content scan with `isSafe || content.length > N` (100 / 200), so any long
 * answer bypassed the safety check and was returned as success. These tests
 * pin the fail-closed behaviour: unsafe content of ANY length is not success.
 */
import { describe, it, expect, vi } from 'vitest';
import { DefaultHarness } from '../../src/harness/defaultHarness';
import { CodeAgentHarness } from '../../src/harness/codeAgentHarness';
import type { HarnessRunParams, HarnessServices } from '../../src/harness/harnessTypes';

// Comfortably longer than both bypass thresholds (100 and 200).
const LONG_ANSWER = 'A detailed final answer. '.repeat(30);

function makeServices(isSafe: boolean): HarnessServices {
  const services = {
    getProvider: vi.fn(() => ({
      call: vi.fn().mockResolvedValue({
        content: LONG_ANSWER,
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
        model: 'test-model',
        provider: 'test-provider',
      }),
    })),
    getTool: vi.fn(),
    getToolDefinition: vi.fn(),
    listTools: vi.fn(() => []),
    cacheResult: vi.fn(),
    getCachedResult: vi.fn(() => null),
    invalidateCache: vi.fn(),
    checkpoint: vi.fn(),
    fireBeforeLLMCall: vi.fn(async (ctx: { request: unknown }) => ctx.request),
    fireAfterLLMCall: vi.fn(async (ctx: unknown) => ctx),
    fireBeforeToolCall: vi.fn(async () => ({ blocked: false })),
    fireAfterToolCall: vi.fn(async (ctx: { result: unknown }) => ctx.result),
    fireOnAgentStart: vi.fn(),
    fireOnAgentComplete: vi.fn(),
    fireOnError: vi.fn(),
    recordLLMCall: vi.fn(),
    recordToolCall: vi.fn(),
    compactMessages: vi.fn((msgs: unknown) => ({ messages: msgs, dropped: 0, saved: 0 })),
    scanContent: vi.fn(async () => ({
      isSafe,
      threats: isSafe ? [] : [{ type: 'malware.generation', severity: 'high' }],
    })),
    reportTokenUsage: vi.fn(),
    getRemainingBudget: vi.fn(() => 100000),
    isBudgetCritical: vi.fn(() => false),
    publishEvent: vi.fn(),
    subscribeEvents: vi.fn(() => () => {}),
    loadSkills: vi.fn(async () => []),
    injectSkill: vi.fn(async (_: unknown, prompt: string) => prompt),
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
    applyPatch: vi.fn(async () => ({ success: true, added: 0, removed: 0 })),
    updatePlanItem: vi.fn(),
    getPlanItems: vi.fn(),
  };
  return services as unknown as HarnessServices;
}

function baseRunParams(services: HarnessServices): HarnessRunParams {
  return {
    goal: 'Test goal',
    messages: [{ role: 'user', content: 'Test' }],
    availableTools: [],
    tokenBudget: 100000,
    maxSteps: 5,
    signal: new AbortController().signal,
    routing: {
      modelId: 'test-model',
      tier: 'standard',
      provider: 'test-provider',
      maxTokens: 1024,
    },
    services,
  };
}

describe('H-03 — unsafe final content is never a success', () => {
  it('DefaultHarness: unsafe answer longer than 100 chars does not return success', async () => {
    const harness = new DefaultHarness();
    const result = await harness.runAttempt(baseRunParams(makeServices(false)));
    expect(result.status).not.toBe('success');
  });

  it('CodeAgentHarness: unsafe answer longer than 200 chars does not return success', async () => {
    const harness = new CodeAgentHarness();
    const result = await harness.runAttempt(baseRunParams(makeServices(false)));
    expect(result.status).not.toBe('success');
  });

  it('control: a safe long answer still returns success (DefaultHarness)', async () => {
    const harness = new DefaultHarness();
    const result = await harness.runAttempt(baseRunParams(makeServices(true)));
    expect(result.status).toBe('success');
  });

  it('control: a safe long answer still returns success (CodeAgentHarness)', async () => {
    const harness = new CodeAgentHarness();
    const result = await harness.runAttempt(baseRunParams(makeServices(true)));
    expect(result.status).toBe('success');
  });
});
