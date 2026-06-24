/**
 * DefaultHarness — Backward-compatible wrapper around existing AgentRuntime logic.
 *
 * This harness delegates all execution to Commander's existing AgentRuntime
 * internals. It exists so that the harness system is always functional even
 * when no specialized harness matches the execution context.
 *
 * Capabilities: minimal (no sub-agents, no Guardian, no hashline edits)
 * but 100% backward compatible with existing Commander behavior.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import type {
  AgentHarness,
  HarnessSelectionContext,
  HarnessRunParams,
  HarnessCapabilities,
  HarnessServices,
  HarnessEvent,
  HarnessEventHandler,
  Unsubscribe,
  SteerMessage,
} from './harnessTypes';
import type {
  AgentExecutionResult,
  LLMMessage,
  LLMProvider,
  Tool,
  ToolCall,
  ToolResult,
  LLMRequest,
  LLMResponse,
} from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { generateId, now } from '../runtime/runtimeHelpers';

export const DEFAULT_HARNESS_CAPABILITIES: HarnessCapabilities = {
  supportsSubAgents: false,
  supportsSteering: false,
  supportsGuardianApproval: false,
  supportsHashlineEdits: false,
  supportsAppendOnlyContext: false,
  supportsIntentTracing: false,
  supportsPlanMode: false,
  supportsPatchApplication: false,
  supportsSkillsLoading: false,
  supportsSessionPersistence: false,
  supportsFileWatching: false,
  supportsNetworkPolicy: false,
  supportsCommandClassification: false,
  supportsSandboxedExecution: false,
  supportsConcurrentExecution: false,
  supportsReasoningEffort: false,
  maxConcurrentTools: 4,
  maxToolCallsPerTurn: 20,
  description: 'Backward-compatible default harness — wraps existing AgentRuntime',
};

export class DefaultHarness implements AgentHarness {
  readonly name = 'default';

  private eventHandlers: Set<HarnessEventHandler> = new Set();
  private steerQueueInternal: SteerMessage[] = [];

  supports(_ctx: HarnessSelectionContext): boolean {
    return true;
  }

  /**
   * Execute via the standard Commander agent loop.
   *
   * DefaultHarness delegates all calls to the provided services,
   * wrapping the existing AgentRuntime's LLM → Tools → Verification cycle.
   */
  async runAttempt(params: HarnessRunParams): Promise<AgentExecutionResult> {
    const {
      goal,
      messages,
      availableTools,
      tokenBudget,
      maxSteps,
      signal,
      tenantId,
      routing,
      services,
      outputSchema,
    } = params;

    const runId = generateId();
    const startTime = Date.now();
    const steps: AgentExecutionResult['steps'] = [];
    const totalTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    await services.fireOnAgentStart({ agentId: goal.slice(0, 32), runId });
    this.emitEvent({ type: 'run_start', runId, goal, harness: this.name, timestamp: Date.now() });

    try {
      // Build the request from messages
      const toolDefs = availableTools
        .map((name) => services.getToolDefinition(name))
        .filter((t): t is NonNullable<typeof t> => t !== undefined);

      let request: LLMRequest = {
        model: routing.modelId.replace(/@\w+$/, ''),
        messages,
        maxTokens: routing.maxTokens,
        tools: toolDefs,
      };

      // Pre-hook
      request = await services.fireBeforeLLMCall({ request, agentId: goal.slice(0, 32), runId });

      // Main execution loop
      let lastError: string | undefined;

      for (let attempt = 0; attempt <= 2; attempt++) {
        if (signal.aborted) {
          return this.buildResult(
            runId,
            goal,
            'cancelled',
            'Cancelled by user',
            steps,
            totalTokenUsage,
            Date.now() - startTime,
          );
        }

        // LLM call
        const provider = services.getProvider(routing.provider);
        if (!provider) {
          const res = this.buildResult(
            runId,
            goal,
            'failed',
            `No provider: ${routing.provider}`,
            steps,
            totalTokenUsage,
            Date.now() - startTime,
          );
          this.emitEvent({
            type: 'run_error',
            error: `No provider: ${routing.provider}`,
            runId,
            timestamp: Date.now(),
          });
          return res;
        }

        let response: LLMResponse | null = null;
        try {
          this.emitEvent({ type: 'llm_request', request, runId, timestamp: Date.now() });
          response = await provider.call(request);
        } catch (err) {
          lastError = String(err);
          getGlobalLogger().error('DefaultHarness', 'LLM call failed', err as Error);
          continue;
        }

        if (!response) {
          lastError = 'Empty LLM response';
          continue;
        }

        await services.fireAfterLLMCall({ request, response, agentId: goal.slice(0, 32), runId });

        // Accumulate token usage
        totalTokenUsage.promptTokens += response.usage.promptTokens;
        totalTokenUsage.completionTokens += response.usage.completionTokens;
        totalTokenUsage.totalTokens += response.usage.totalTokens;
        services.reportTokenUsage(response.usage.totalTokens);

        services.recordLLMCall(
          routing.modelId,
          routing.provider,
          response.usage.totalTokens,
          Date.now() - startTime,
          tenantId,
        );

        // Record response step
        steps.push({
          stepNumber: steps.length + 1,
          timestamp: now(),
          type: 'response',
          content: response.content,
          tokenUsage: response.usage,
          durationMs: Date.now() - startTime,
        });

        // Tool execution loop
        let toolLoopCount = 0;
        while (response.toolCalls && response.toolCalls.length > 0 && toolLoopCount < maxSteps) {
          toolLoopCount++;

          if (signal.aborted) {
            return this.buildResult(
              runId,
              goal,
              'cancelled',
              'Cancelled by user',
              steps,
              totalTokenUsage,
              Date.now() - startTime,
            );
          }

          // Execute tool calls (parallel if concurrency-safe)
          const results = await this.executeToolCalls(
            response.toolCalls,
            availableTools,
            services,
            goal.slice(0, 32),
            runId,
            tenantId,
          );

          // Record tool result steps
          for (const r of results) {
            steps.push({
              stepNumber: steps.length + 1,
              timestamp: now(),
              type: 'tool_result',
              content: r.output,
              durationMs: r.durationMs,
              toolResult: r,
            });
          }

          // Compact context if needed
          if (services.isBudgetCritical() || toolLoopCount > 3) {
            const compacted = services.compactMessages(request.messages);
            if (compacted.dropped > 0) {
              request.messages = compacted.messages;
            }
          }

          // Build follow-up request with tool results
          const followUpMessages: LLMMessage[] = [
            {
              role: 'assistant',
              content: response.content,
              tool_calls: response.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
            },
            ...results.map((r) => ({
              role: 'tool' as const,
              content: r.output,
              tool_call_id: r.toolCallId,
            })),
          ];

          request = {
            ...request,
            messages: [...request.messages, ...followUpMessages],
          };

          // Next LLM call
          request = await services.fireBeforeLLMCall({
            request,
            agentId: goal.slice(0, 32),
            runId,
          });
          try {
            response = await provider.call(request);
          } catch (err) {
            lastError = String(err);
            break;
          }

          if (!response) {
            lastError = 'Empty follow-up response';
            break;
          }

          await services.fireAfterLLMCall({ request, response, agentId: goal.slice(0, 32), runId });

          totalTokenUsage.promptTokens += response.usage.promptTokens;
          totalTokenUsage.completionTokens += response.usage.completionTokens;
          totalTokenUsage.totalTokens += response.usage.totalTokens;
          services.reportTokenUsage(response.usage.totalTokens);
          services.recordLLMCall(
            routing.modelId,
            routing.provider,
            response.usage.totalTokens,
            Date.now() - startTime,
            tenantId,
          );

          steps.push({
            stepNumber: steps.length + 1,
            timestamp: now(),
            type: 'response',
            content: response.content,
            tokenUsage: response.usage,
            durationMs: Date.now() - startTime,
          });
        }

        // Verification
        const safeContent = response?.content || '';
        if (safeContent.length > 0) {
          const contentScan = await services.scanContent(safeContent);
          if (contentScan.isSafe || safeContent.length > 100) {
            const result = this.buildResult(
              runId,
              goal,
              'success',
              safeContent,
              steps,
              totalTokenUsage,
              Date.now() - startTime,
            );
            if (outputSchema) {
              try {
                const parsed = JSON.parse(safeContent);
                result.outputData = parsed;
              } catch (err) {
                reportSilentFailure(err, 'defaultHarness:320');
                /* not JSON — leave unstructured */
              }
            }
            await services.fireOnAgentComplete({ result, runId });
            return result;
          }
        }

        lastError = 'Verification failed or empty response';
      }

      // All attempts exhausted
      const result = this.buildResult(
        runId,
        goal,
        'failed',
        lastError ?? 'All attempts failed',
        steps,
        totalTokenUsage,
        Date.now() - startTime,
      );
      await services.fireOnError({
        error: lastError ?? 'Unknown error',
        runId,
        agentId: goal.slice(0, 32),
      });
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      getGlobalLogger().error('DefaultHarness', 'Run failed', err as Error);
      const result = this.buildResult(
        runId,
        goal,
        'failed',
        errorMsg,
        steps,
        totalTokenUsage,
        Date.now() - startTime,
      );
      await services.fireOnError({ error: errorMsg, runId, agentId: goal.slice(0, 32) });
      return result;
    }
  }

  abort(): void {
    // DefaultHarness has no persistent state to abort
  }

  steer(message: string, priority: number = 0, abortCurrent: boolean = false): void {
    this.steerQueueInternal.push({
      id: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      message,
      timestamp: Date.now(),
      priority,
      abortCurrent,
    });
  }

  subscribe(handler: HarnessEventHandler): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private emitEvent(event: HarnessEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            getGlobalLogger().error('DefaultHarness', 'Async event handler error', err as Error);
          });
        }
      } catch (err) {
        getGlobalLogger().error('DefaultHarness', 'Event handler error', err as Error);
      }
    }
  }

  getCapabilities(): HarnessCapabilities {
    return DEFAULT_HARNESS_CAPABILITIES;
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    availableTools: string[],
    services: HarnessServices,
    agentId: string,
    runId: string,
    tenantId?: string,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const tc of toolCalls) {
      // Check cache
      const cached = services.getCachedResult(tc, tenantId);
      if (cached) {
        results.push(cached);
        continue;
      }

      if (!availableTools.includes(tc.name)) {
        results.push({
          toolCallId: tc.id,
          name: tc.name,
          output: '',
          error: `Tool "${tc.name}" not available`,
          durationMs: 0,
        });
        continue;
      }

      // Hook: beforeToolCall
      const hookResult = await services.fireBeforeToolCall({
        toolName: tc.name,
        args: tc.arguments,
        agentId,
        runId,
      });
      if (hookResult.blocked) {
        results.push({
          toolCallId: tc.id,
          name: tc.name,
          output: '',
          error: hookResult.error ?? 'Blocked by plugin',
          durationMs: 0,
        });
        continue;
      }

      // Execute
      const tool = services.getTool(tc.name);
      if (!tool) {
        results.push({
          toolCallId: tc.id,
          name: tc.name,
          output: '',
          error: `Tool "${tc.name}" not found`,
          durationMs: 0,
        });
        continue;
      }

      const toolStart = Date.now();
      let toolResult: ToolResult;

      try {
        const output = await tool.execute(tc.arguments);
        const durationMs = Date.now() - toolStart;
        toolResult = {
          toolCallId: tc.id,
          name: tc.name,
          output: typeof output === 'string' ? output : JSON.stringify(output),
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - toolStart;
        toolResult = {
          toolCallId: tc.id,
          name: tc.name,
          output: '',
          error: err instanceof Error ? err.message : String(err),
          durationMs,
        };
      }

      // Hook: afterToolCall
      toolResult = await services.fireAfterToolCall({
        toolName: tc.name,
        args: tc.arguments,
        result: toolResult,
        agentId,
        runId,
      });

      services.recordToolCall(tc.name, toolResult.durationMs, toolResult.error, tenantId);

      // Cache on success
      if (!toolResult.error) {
        services.cacheResult(tc, toolResult, tenantId);
      }

      results.push(toolResult);
    }

    return results;
  }

  private buildResult(
    runId: string,
    goal: string,
    status: AgentExecutionResult['status'],
    summary: string,
    steps: AgentExecutionResult['steps'],
    totalTokenUsage: AgentExecutionResult['totalTokenUsage'],
    totalDurationMs: number,
  ): AgentExecutionResult {
    return {
      runId,
      agentId: goal.slice(0, 32),
      status,
      summary,
      steps,
      totalTokenUsage,
      totalDurationMs,
      error: status === 'failed' || status === 'cancelled' ? summary : undefined,
    };
  }
}
