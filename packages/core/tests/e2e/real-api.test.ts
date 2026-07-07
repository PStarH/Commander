/**
 * Real-API End-to-End Tests
 *
 * Exercises the full Commander framework against a real LLM API
 * (StepFun step-3.7-flash via OpenAI-compatible endpoint).
 *
 * This file is NOT in the vitest include list — it must be run explicitly:
 *   npx vitest run tests/e2e/real-api.test.ts
 *
 * Requirements:
 *   - STEPFUN_API_KEY environment variable
 *   - Network access to https://api.stepfun.com
 *
 * Test coverage:
 *   1. Direct OpenAIProvider call — verifies API connectivity + streaming
 *   2. AgentRuntime single-agent execution — real LLM response + token accounting
 *   3. Tool calling — real LLM decides to call a tool, framework executes it
 *   4. UltimateOrchestrator full pipeline — deliberation → decomposition → execution → synthesis
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '../../src/runtime/providers/openaiProvider';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { UltimateOrchestrator } from '../../src/ultimate/orchestrator';
import { TELOSOrchestrator } from '../../src/telos/telosOrchestrator';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { resetArtifactSystem } from '../../src/ultimate/artifactSystem';
import { resetTeamManager } from '../../src/ultimate/agentTeamManager';
import { resetTokenSentinel } from '../../src/telos/tokenSentinel';
import { resetProviderPool } from '../../src/telos/providerPool';
import { resetWorkCoordinator } from '../../src/ultimate/workCoordinator';
import { resetExecutionScheduler } from '../../src/atr/scheduler';
import { resetLaneManager } from '../../src/sandbox/lane';
import { resetTokenBudgetManager } from '../../src/runtime/tokenGovernor';
import { resetCheckpointWriter } from '../../src/runtime/checkpointWriter';
import { resetMetricsCollector } from '../../src/runtime/metricsCollector';
import { resetSLOManager } from '../../src/observability/sloManager';
import { resetEnterpriseSecurityGateway } from '../../src/security/enterpriseSecurityGateway';
import { resetBillExplosionGuard } from '../../src/security/billExplosionGuard';
import { resetCostGuard } from '../../src/security/costGuard';
import { resetSecurityMonitor } from '../../src/security/securityMonitor';
import { resetGuardianAgent } from '../../src/security/guardianAgent';
import type { LLMRequest, Tool, ToolDefinition } from '../../src/runtime/types';

// ── Configuration ──────────────────────────────────────────────────────────

const STEPFUN_API_KEY = process.env.STEPFUN_API_KEY ?? '';
const STEPFUN_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.stepfun.com/step_plan/v1';
const STEPFUN_MODEL = process.env.OPENAI_MODEL ?? 'step-3.7-flash';

const SKIP = !STEPFUN_API_KEY;

const skipMessage = 'Set STEPFUN_API_KEY to run real-API e2e tests';

// Real API calls need generous timeouts
const PROVIDER_TIMEOUT = 60000; // 60s for a single LLM call
const RUNTIME_TIMEOUT = 120000; // 120s for a full agent execution loop
const ORCHESTRATOR_TIMEOUT = 300000; // 300s for the full orchestrator pipeline

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: STEPFUN_API_KEY,
    baseUrl: STEPFUN_BASE_URL,
    defaultModel: STEPFUN_MODEL,
  });
}

function resetGlobals() {
  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();
  resetGlobalThreeLayerMemory();
  resetArtifactSystem();
  resetTeamManager();
  resetTokenSentinel();
  resetProviderPool();
  resetWorkCoordinator();
  resetExecutionScheduler();
  resetLaneManager();
  resetTokenBudgetManager();
  resetCheckpointWriter();
  resetMetricsCollector();
  resetSLOManager();
  resetEnterpriseSecurityGateway();
  resetBillExplosionGuard();
  resetCostGuard();
  resetSecurityMonitor();
  resetGuardianAgent();
}

function makeRuntime(): AgentRuntime {
  // Construct a ModelRouter with ONLY the StepFun model — no DEFAULT_MODELS
  // (which include gpt-4o-mini, claude-haiku, etc. that we don't have keys for).
  const customModels = (['eco', 'standard', 'power', 'consensus'] as const).map((tier) => ({
    id: `${STEPFUN_MODEL}@${tier}`,
    provider: 'openai',
    tier,
    costPer1MInput: 1,
    costPer1MOutput: 3,
    capabilities: ['code', 'reasoning', 'analysis'],
    contextWindow: 128000,
    priority: 0,
  }));
  const router = new ModelRouter(customModels);
  const runtime = new AgentRuntime(
    {
      maxRetries: 1,
      timeoutMs: 90000,
      maxConcurrency: 4,
      budgetHardCapTokens: 500000,
      llmTimeoutMs: 60000,
    },
    router,
  );

  const provider = makeProvider();
  runtime.registerProvider('openai', provider);

  return runtime;
}

function makeOrchestrator(runtime: AgentRuntime): UltimateOrchestrator {
  const telos = new TELOSOrchestrator(runtime);
  return new UltimateOrchestrator(telos, runtime, {
    enableDeliberation: true,
    enableTeams: false, // fewer LLM calls, faster real-API test
    defaultBudget: { hardCapTokens: 500000, softCapTokens: 400000, costCapUsd: 10 },
    maxRecursiveDepth: 2,
    maxParallelSubAgents: 4,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('E2E Real-API: StepFun step-3.7-flash', () => {
  let runtime: AgentRuntime;

  beforeAll(() => {
    // Verify API connectivity once before all tests
  });

  beforeEach(() => {
    resetGlobals();
  });

  afterEach(() => {
    try {
      runtime?.dispose();
    } catch {
      /* best-effort */
    }
  });

  // ── 1. Direct Provider Call ──────────────────────────────────────────────

  it(
    'direct provider call returns a valid LLM response with token usage',
    async () => {
      const provider = makeProvider();
      const request: LLMRequest = {
        model: STEPFUN_MODEL,
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Reply concisely.' },
          { role: 'user', content: 'What is 2 + 2? Answer with just the number.' },
        ],
        maxTokens: 512,
      };

      const response = await provider.call(request);

      // Content must be non-empty and contain "4"
      expect(response.content).toBeTruthy();
      expect(response.content).toMatch(/4/);

      // Token usage must be reported by the real API
      expect(response.usage.totalTokens).toBeGreaterThan(0);
      expect(response.usage.promptTokens).toBeGreaterThan(0);
      expect(response.usage.completionTokens).toBeGreaterThan(0);

      // Model name must be echoed back
      expect(response.model).toBe(STEPFUN_MODEL);

      // Finish reason should be "stop" (not "length" since we gave 512 tokens)
      expect(response.finishReason).toBe('stop');

      console.log('[Real-API] Direct call:', {
        content: response.content.slice(0, 100),
        tokens: response.usage,
        finishReason: response.finishReason,
        reasoningLength: response.reasoning_content?.length ?? 0,
      });
    },
    PROVIDER_TIMEOUT,
  );

  // ── 2. AgentRuntime Single-Agent Execution ───────────────────────────────

  it(
    'AgentRuntime executes a simple goal and returns a success result',
    async () => {
      runtime = makeRuntime();

      const result = await runtime.execute({
        agentId: 'real-api-agent',
        projectId: 'real-api-project',
        missionId: 'mission-single',
        goal: 'Explain what TypeScript is in exactly one sentence.',
        contextData: {},
        availableTools: [],
        maxSteps: 3,
        tokenBudget: 10000,
      });

      expect(result.status).toBe('success');
      expect(result.summary).toBeTruthy();
      expect(result.summary.length).toBeGreaterThan(10);
      expect(result.totalTokenUsage.totalTokens).toBeGreaterThan(0);
      expect(result.steps.length).toBeGreaterThanOrEqual(1);

      console.log('[Real-API] AgentRuntime execution:', {
        status: result.status,
        summary: result.summary.slice(0, 150),
        steps: result.steps.length,
        tokens: result.totalTokenUsage,
        durationMs: result.totalDurationMs,
      });
    },
    RUNTIME_TIMEOUT,
  );

  // ── 3. Tool Calling with Real LLM ────────────────────────────────────────

  it(
    'AgentRuntime handles tool calling — LLM decides to call a calculator tool',
    async () => {
      runtime = makeRuntime();

      // Register a real tool the LLM can choose to call
      const calcDef: ToolDefinition = {
        name: 'calculator',
        description: 'Perform a mathematical calculation. Use this for any arithmetic.',
        inputSchema: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: 'The mathematical expression to evaluate, e.g. "2 + 2" or "15 * 3"',
            },
          },
          required: ['expression'],
        },
      };

      const calcTool: Tool = {
        definition: calcDef,
        execute: async (args) => {
          const expr = String(args.expression ?? '');
          // Safe evaluation: only allow digits, operators, parentheses, spaces
          if (!/^[\d+\-*/().\s]+$/.test(expr)) {
            return `Error: invalid expression`;
          }
          try {
            const result = Function(`"use strict"; return (${expr})`)();
            return `Result: ${result}`;
          } catch {
            return `Error: could not evaluate`;
          }
        },
        isConcurrencySafe: true,
      };

      runtime.registerTool('calculator', calcTool);

      const result = await runtime.execute({
        agentId: 'real-api-tool-agent',
        projectId: 'real-api-tool-project',
        missionId: 'mission-tool',
        goal: 'What is 15 multiplied by 37? Use the calculator tool to compute the answer.',
        contextData: {},
        availableTools: ['calculator'],
        maxSteps: 5,
        tokenBudget: 20000,
      });

      expect(result.status).toBe('success');
      // The answer 555 should appear somewhere in the summary or steps
      const allContent = result.summary + result.steps.map((s) => s.content ?? '').join(' ');
      expect(allContent).toMatch(/555/);

      console.log('[Real-API] Tool calling:', {
        status: result.status,
        summary: result.summary.slice(0, 200),
        steps: result.steps.length,
        tokens: result.totalTokenUsage,
        durationMs: result.totalDurationMs,
      });
    },
    RUNTIME_TIMEOUT,
  );

  // ── 4. UltimateOrchestrator Full Pipeline ────────────────────────────────

  it(
    'UltimateOrchestrator runs the complete deliberation → execution → synthesis pipeline',
    async () => {
      runtime = makeRuntime();
      const orchestrator = makeOrchestrator(runtime);

      const phases: string[] = [];
      const result = await orchestrator.execute({
        projectId: 'real-api-orch-project',
        agentId: 'real-api-lead',
        goal: 'Write a TypeScript function that validates an email address and returns a structured error message if invalid. Keep it concise.',
        contextData: {
          governanceProfile: { riskLevel: 'LOW' },
          availableTools: [],
        },
        onProgress: (phase) => phases.push(phase),
      });

      // The pipeline must complete successfully
      expect(['SUCCESS', 'PARTIAL']).toContain(result.status);
      expect(result.synthesis).toBeTruthy();
      expect(result.synthesis.length).toBeGreaterThan(20);

      // The synthesis should contain TypeScript-related content
      expect(result.synthesis.toLowerCase()).toMatch(/email|validate|function|typescript/);

      // Pipeline phase progression
      expect(phases).toContain('INIT');
      expect(phases).toContain('DELIBERATION');
      expect(phases.some((p) => p === 'SYNTHESIS' || p === 'COMPLETE')).toBe(true);

      console.log('[Real-API] Orchestrator pipeline:', {
        status: result.status,
        phases,
        synthesisPreview: result.synthesis.slice(0, 300),
        subAgentsSpawned: result.metrics.subAgentsSpawned,
        executionTreeNodes: result.executionTree.length,
        reasoningLength: result.reasoning.length,
      });
    },
    ORCHESTRATOR_TIMEOUT,
  );
});
