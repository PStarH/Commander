/**
 * Tier1AgentLoop — Shared tier-1 agent loop implementation.
 *
 * Implements the best-practice ReAct loop:
 *  1. LLM call with tool definitions
 *  2. Extract + validate tool calls
 *  3. Guardian / permission pre-check
 *  4. Parallel tool execution via ToolOrchestrator
 *  5. Sanitize tool outputs before re-entering prompt
 *  6. Append-only context with compaction triggers
 *  7. Loop guards (max steps, repeated-step detection)
 *  8. Structured errors with call_id for LLM reasoning
 *
 * Both DefaultHarness and CodeAgentHarness delegate to this loop.
 */
import type {
  LLMRequest,
  LLMResponse,
  Tool,
  ToolCall,
  ToolResult,
  ToolDefinition,
  AgentExecutionResult,
} from '../runtime/types';
import type {
  HarnessServices,
  HarnessEvent,
  HarnessEventHandler,
} from './harnessTypes';
import { getGlobalLogger } from '../logging';
import { generateId, now } from '../runtime/runtimeHelpers';
import { scanToolOutputForInjection } from '../contentScanner';
import { ToolOrchestrator, type ToolExecutionPlan } from '../runtime/toolOrchestrator';

// ============================================================================
// Types
// ============================================================================

export interface Tier1LoopParams {
  goal: string;
  initialMessages: LLMRequest['messages'];
  availableTools: string[];
  tokenBudget: number;
  maxSteps: number;
  signal: AbortSignal;
  abortSignal?: AbortSignal;
  tenantId?: string;
  userId?: string;
  routing: { modelId: string; provider: string; maxTokens: number };
  services: HarnessServices;
  outputSchema?: Record<string, unknown>;
  approvalMode?: 'suggest' | 'auto-edit' | 'full-auto' | 'danger-full-access';
  reasoningEffort?: 'low' | 'medium' | 'high';
  planMode?: { readOnly: boolean; allowedTools: string[] };
  skills?: string[];
  sessionId?: string;
  networkPolicy?: { allowedDomains: string[]; blockedDomains: string[]; allowPrivateNetworks: boolean; allowLocalProtocols: boolean };
  eventHandler?: HarnessEventHandler;
}

export interface Tier1LoopResult {
  result: {
    runId: string;
    agentId: string;
    status: 'success' | 'failed' | 'cancelled';
    summary: string;
    steps: Array<{
      stepNumber: number;
      timestamp: string;
      type: 'response' | 'tool_result',
      content?: string;
      tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      durationMs?: number;
      toolResult?: ToolResult;
    }>;
    totalTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
    totalDurationMs: number;
    error?: string;
    outputData?: Record<string, unknown>;
  };
  totalToolCallsExecuted: number;
  loopCount: number;
}

// ============================================================================
// Tier1AgentLoop
// ============================================================================

export class Tier1AgentLoop {
  private readonly MAX_REPEATED_STEPS = 3;
  private readonly REPEATED_STEP_WINDOW = 5;
  private readonly CONTENT_SCAN_THRESHOLD = 200;
  private readonly MAX_OUTPUT_CHARS = 50_000;

  private eventHandler?: HarnessEventHandler;

  constructor(eventHandler?: HarnessEventHandler) {
    this.eventHandler = eventHandler;
  }

  async run(params: Tier1LoopParams): Promise<Tier1LoopResult> {
    const runId = generateId();
    const agentId = params.goal.slice(0, 32);
    const startTime = Date.now();
    const steps: Tier1LoopResult['result']['steps'] = [];
    const totalTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let totalToolCallsExecuted = 0;
    let loopCount = 0;
    let lastError: string | undefined;
    let finalContent = '';
    let taskComplete = false;

    const emit = (event: HarnessEvent) => {
      if (this.eventHandler) this.eventHandler(event);
      params.services.publishEvent(event);
    };

    const checkAbort = () => {
      if (params.signal.aborted || params.abortSignal?.aborted) return true;
      return false;
    };

    await params.services.fireOnAgentStart({ agentId, runId });
    emit({ type: 'run_start', runId, goal: params.goal, harness: 'tier1', timestamp: Date.now() });

    try {
      // Build tool definitions
      const toolDefs = this.resolveToolDefs(params.availableTools, params.services);
      const effectiveTools = this.applyPlanModeFilter(params.availableTools, params.planMode);

      // Build initial request
      let request: LLMRequest = {
        model: params.routing.modelId.replace(/@\w+$/, ''),
        messages: [...params.initialMessages],
        maxTokens: params.routing.maxTokens,
        tools: toolDefs,
        reasoningConfig: params.reasoningEffort ? { enabled: true, effort: params.reasoningEffort } : undefined,
      };

      request = await params.services.fireBeforeLLMCall({ request, agentId, runId });

      // Build tool map for orchestrator
      const toolMap = this.buildToolMap(effectiveTools, params.services);

      // Main agentic loop
      const recentStepHashes: string[] = [];
      let consecutiveNoOps = 0;

      while (loopCount < params.maxSteps && !taskComplete) {
        if (checkAbort()) {
          return this.buildCancelled(runId, agentId, steps, totalTokenUsage, startTime);
        }

        loopCount++;

        // LLM call
        const provider = params.services.getProvider(params.routing.provider);
        if (!provider) {
          lastError = `No provider: ${params.routing.provider}`;
          break;
        }

        emit({ type: 'llm_request', request, runId, timestamp: Date.now() });
        let response: LLMResponse | null = null;
        try {
          response = await provider.call(request);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          getGlobalLogger().error('Tier1AgentLoop', 'LLM call failed', err as Error);
          emit({ type: 'run_error', error: lastError, runId, timestamp: Date.now() });
          break;
        }

        if (!response) {
          lastError = 'Empty LLM response';
          break;
        }

        emit({ type: 'llm_response', response, runId, timestamp: Date.now() });
        await params.services.fireAfterLLMCall({ request, response, agentId, runId });

        totalTokenUsage.promptTokens += response.usage.promptTokens;
        totalTokenUsage.completionTokens += response.usage.completionTokens;
        totalTokenUsage.totalTokens += response.usage.totalTokens;
        params.services.reportTokenUsage(response.usage.totalTokens);
        params.services.recordLLMCall(
          params.routing.modelId,
          params.routing.provider,
          response.usage.totalTokens,
          Date.now() - startTime,
          params.tenantId,
        );

        steps.push({
          stepNumber: steps.length + 1,
          timestamp: now(),
          type: 'response',
          content: response.content || '',
          tokenUsage: response.usage,
          durationMs: Date.now() - startTime,
        });

        // ── Terminal: no tool calls ────────────────────────────────────────
        if (!response.toolCalls || response.toolCalls.length === 0) {
          finalContent = response.content || '';
          taskComplete = true;
          if (finalContent && finalContent.length > 50) {
            const scanResult = await params.services.scanContent(finalContent);
            if (!scanResult.isSafe && finalContent.length <= this.CONTENT_SCAN_THRESHOLD) {
              taskComplete = false;
            }
          }
          break;
        }

        // ── Repeated-step detection ───────────────────────────────────────
        const stepHash = this.hashToolCalls(response.toolCalls);
        if (recentStepHashes.includes(stepHash)) {
          consecutiveNoOps++;
          if (consecutiveNoOps >= this.MAX_REPEATED_STEPS) {
            lastError = 'Repeated tool call pattern detected — aborting to avoid infinite loop';
            getGlobalLogger().warn('Tier1AgentLoop', `[${runId}] Repeated steps: ${consecutiveNoOps}`);
            break;
          }
        } else {
          consecutiveNoOps = 0;
          recentStepHashes.push(stepHash);
          if (recentStepHashes.length > this.REPEATED_STEP_WINDOW) {
            recentStepHashes.shift();
          }
        }

        // ── Execute tool calls via orchestrator ────────────────────────────
        const orchestrated = await this.executeViaOrchestrator(
          response.toolCalls,
          toolMap,
          params,
          agentId,
          runId,
          emit,
        );

        totalToolCallsExecuted += orchestrated.results.length;

        for (const r of orchestrated.results) {
          steps.push({
            stepNumber: steps.length + 1,
            timestamp: now(),
            type: 'tool_result',
            content: r.output,
            durationMs: r.durationMs,
            toolResult: r,
          });
        }

        // ── Append assistant response + tool results ───────────────────────
        request.messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });

        for (const r of orchestrated.results) {
          request.messages.push({
            role: 'tool' as const,
            content: r.output,
            tool_call_id: r.toolCallId,
          });
        }

        // ── Context compaction ─────────────────────────────────────────────
        if (params.services.isBudgetCritical() || loopCount > 3) {
          const compacted = params.services.compactMessages(request.messages);
          if (compacted.dropped > 0) {
            request.messages = compacted.messages;
            emit({ type: 'compaction', dropped: compacted.dropped, saved: compacted.saved, runId, timestamp: Date.now() });
          }
        }

        if (params.services.getRemainingBudget() <= 0) {
          lastError = 'Token budget exhausted';
          break;
        }

        // Next LLM call
        request = await params.services.fireBeforeLLMCall({ request, agentId, runId });
      }

      // ── Post-loop: build result ──────────────────────────────────────────
      if (!finalContent) {
        finalContent = this.synthesizeFallbackContent(steps, params.goal);
      }

      const aborted = params.signal.aborted || params.abortSignal?.aborted;
      const status: Tier1LoopResult['result']['status'] = aborted
        ? 'cancelled'
        : taskComplete && finalContent
          ? 'success'
          : lastError
            ? 'failed'
            : 'cancelled';
      const loopResult = {
        runId,
        agentId,
        status,
        summary: finalContent || lastError || 'No content produced',
        steps,
        totalTokenUsage,
        totalDurationMs: Date.now() - startTime,
        error: status === 'failed' || status === 'cancelled' ? (lastError || finalContent || 'No content produced') : undefined,
      } as Tier1LoopResult['result'];

      if (status === 'success') {
        try {
          const parsed = JSON.parse(loopResult.summary);
          loopResult.outputData = parsed;
        } catch {
          // not JSON — leave unstructured
        }
        await params.services.fireOnAgentComplete({ result: loopResult as AgentExecutionResult, runId });
        emit({ type: 'run_complete', result: loopResult as AgentExecutionResult, runId, timestamp: Date.now() });
      } else {
        await params.services.fireOnError({ error: lastError ?? 'Loop exhausted', runId, agentId });
        emit({ type: 'run_error', error: lastError ?? 'Loop exhausted', runId, timestamp: Date.now() });
      }

      return { result: loopResult, totalToolCallsExecuted, loopCount };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      getGlobalLogger().error('Tier1AgentLoop', 'Run failed', err as Error);
      const loopResult = {
        runId,
        agentId,
        status: 'failed' as const,
        summary: errorMsg,
        steps,
        totalTokenUsage,
        totalDurationMs: Date.now() - startTime,
        error: errorMsg,
      } as Tier1LoopResult['result'];
      await params.services.fireOnError({ error: errorMsg, runId, agentId });
      emit({ type: 'run_error', error: errorMsg, runId, timestamp: Date.now() });
      return { result: loopResult, totalToolCallsExecuted, loopCount };
    }
  }

  // ============================================================================
  // Private: Tool Resolution
  // ============================================================================

  private resolveToolDefs(availableTools: string[], services: HarnessServices): ToolDefinition[] {
    return availableTools
      .map((name) => services.getToolDefinition(name))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
  }

  private applyPlanModeFilter(
    availableTools: string[],
    planMode?: { readOnly: boolean; allowedTools: string[] },
  ): string[] {
    if (!planMode?.readOnly) return availableTools;
    const allowed = new Set(planMode.allowedTools);
    return availableTools.filter((t) => allowed.has(t));
  }

  private buildToolMap(availableTools: string[], services: HarnessServices): Map<string, Tool> {
    const map = new Map<string, Tool>();
    for (const name of availableTools) {
      const tool = services.getTool(name);
      if (tool) map.set(name, tool);
    }
    return map;
  }

  // ============================================================================
  // Private: Orchestrator Integration
  // ============================================================================

  private async executeViaOrchestrator(
    toolCalls: ToolCall[],
    toolMap: Map<string, Tool>,
    params: Tier1LoopParams,
    agentId: string,
    runId: string,
    emit: (event: HarnessEvent) => void,
  ): Promise<{ results: ToolResult[]; plan: ToolExecutionPlan; totalDurationMs: number; retriedCount: number; approvalRejectedCount: number }> {
    const orchestrator = new ToolOrchestrator(
      {
        defaultToolTimeoutMs: 30_000,
        turnTimeoutMs: 180_000,
        maxRetries: 1,
        useApproval: params.approvalMode === 'suggest',
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 60_000,
      },
      undefined, // approval — handled at harness level
    );

    const plan = await orchestrator.planExecution(toolCalls, toolMap);
    const context = {
      runId,
      agentId,
      stepNumber: 0,
      tenantId: params.tenantId,
    };

    const orchestrated = await orchestrator.execute(plan, toolMap, context);

    // Post-process: sanitize outputs
    for (const result of orchestrated.results) {
      if (!result.error) {
        result.output = this.sanitizeToolOutput(result.output, result.name);
      }
    }

    return orchestrated;
  }

  // ============================================================================
  // Private: Sanitization
  // ============================================================================

  private sanitizeToolOutput(output: unknown, toolName: string): string {
    if (output === null || output === undefined) return '';

    const raw = typeof output === 'string' ? output : JSON.stringify(output);

    // Size limit
    const truncated = raw.length > this.MAX_OUTPUT_CHARS
      ? `${raw.slice(0, this.MAX_OUTPUT_CHARS)}\n...[truncated, total ${raw.length} chars]`
      : raw;

    // Scan for injection patterns
    try {
      const scanResult = scanToolOutputForInjection(truncated);
      if (scanResult.blocked) {
        getGlobalLogger().warn('Tier1AgentLoop', `Tool ${toolName} output blocked by content scan`, { reason: scanResult.reason ?? 'unknown' });
        return `[Content scan blocked output — potential injection detected]\nReason: ${scanResult.reason ?? 'unknown'}`;
      }
    } catch {
      // If scanner fails, continue with output — fail open for availability
    }

    return truncated;
  }

  // ============================================================================
  // Private: Loop Guards
  // ============================================================================

  private hashToolCalls(toolCalls: ToolCall[]): string {
    return toolCalls
      .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
      .join('|');
  }

  // ============================================================================
  // Private: Fallback Content
  // ============================================================================

  private synthesizeFallbackContent(
    steps: Tier1LoopResult['result']['steps'],
    goal: string,
  ): string {
    const responseTexts: string[] = [];
    const toolOutputs: string[] = [];

    for (const step of steps) {
      if (step.type === 'response' && step.content && step.content.length > 20) {
        responseTexts.push(step.content);
      }
      if (step.type === 'tool_result' && step.content && step.content.length > 100) {
        toolOutputs.push(step.content.slice(0, 2000));
      }
    }

    if (responseTexts.length > 0 || toolOutputs.length > 0) {
      const parts: string[] = [];
      if (responseTexts.length > 0) {
        parts.push(responseTexts.join('\n\n'));
      }
      if (toolOutputs.length > 0) {
        parts.push('\n\n## Execution Results\n');
        toolOutputs.forEach((output, i) => {
          parts.push(`### Result ${i + 1}\n${output}`);
        });
      }
      return parts.join('\n');
    }

    return `[Execution completed] Goal: ${goal.slice(0, 200)}`;
  }

  // ============================================================================
  // Private: Result Builders
  // ============================================================================

  private buildCancelled(
    runId: string,
    agentId: string,
    steps: Tier1LoopResult['result']['steps'],
    totalTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number },
    startTime: number,
  ): Tier1LoopResult {
    const result = {
      runId,
      agentId,
      status: 'cancelled' as const,
      summary: 'Cancelled by user',
      steps,
      totalTokenUsage,
      totalDurationMs: Date.now() - startTime,
      error: 'Cancelled by user',
    };
    return { result, totalToolCallsExecuted: 0, loopCount: 0 };
  }
}
