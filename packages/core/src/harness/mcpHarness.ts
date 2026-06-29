/**
 * McpHarness — Model Context Protocol server mode harness.
 *
 * Exposes Commander's tools and runtime via the MCP protocol so that MCP
 * clients (Claude Desktop, IDE plugins, etc.) can drive Commander.
 *
 * runAttempt executes a real agent loop using the HarnessServices facade:
 *   1. Resolve the LLM provider from the routing decision.
 *   2. Build tool definitions from the available-tools list.
 *   3. Call the LLM (firing standard plugin hooks before/after).
 *   4. Execute any returned tool calls via the services facade.
 *   5. Feed tool results back and loop until the LLM stops calling tools
 *      or maxSteps is reached.
 *   6. Return a real AgentExecutionResult with token usage and steps.
 *
 * The harness advertises conservative capabilities (single tool at a time,
 * no sub-agents) because MCP server mode is designed for external
 * orchestration, not autonomous multi-agent dispatch.
 */
import type {
  HarnessSelectionContext,
  HarnessRunParams,
  HarnessCapabilities,
} from './harnessTypes';
import type {
  AgentExecutionResult,
  AgentExecutionStep,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ToolCall,
  ToolResult,
  TokenUsage,
} from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { generateId } from '../runtime/runtimeHelpers';
import { sanitizeIfNeeded } from '../security/outputSanitizer';
import { scanToolOutputForInjection } from '../contentScanner';
import { BaseHarness } from './baseHarness';

export const MCP_HARNESS_CAPABILITIES: HarnessCapabilities = {
  supportsSubAgents: false,
  supportsSteering: true,
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
  maxConcurrentTools: 1,
  maxToolCallsPerTurn: 4,
  description: 'MCP server mode — exposes Commander via Model Context Protocol',
};

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function sanitizeHarnessOutput(output: string, source: string): string {
  let safe = output;
  try {
    const injectionScan = scanToolOutputForInjection(safe);
    if (injectionScan.blocked) {
      safe = `[Tool output filtered: ${injectionScan.reason}]`;
    }
  } catch {
    /* best-effort */
  }
  try {
    const sanitizeResult = sanitizeIfNeeded(safe, { source });
    if (sanitizeResult.wasRedacted) {
      safe = sanitizeResult.output;
    }
  } catch {
    /* best-effort */
  }
  return safe;
}

// @experimental — MCP server-mode delegation is not yet fully implemented.
// The runAttempt loop below is functional but the broader MCP server-mode
// integration (transport, tool exposure, external orchestration) is still
// evolving. Treat this harness as experimental until the MCP surface stabilizes.
export class McpHarness extends BaseHarness {
  readonly name = 'mcp';

  private aborted = false;

  // @experimental — only advertise support when the caller explicitly
  // requests MCP server mode via the 'mcp-server' feature flag.
  supports(ctx: HarnessSelectionContext): boolean {
    return ctx.features.includes('mcp-server');
  }

  async runAttempt(params: HarnessRunParams): Promise<AgentExecutionResult> {
    const runId = generateId();
    const startTime = Date.now();
    this.aborted = false;

    // Defensive self-selection guard: this harness only serves MCP server
    // mode. If the caller supplied feature flags and 'mcp-server' is absent,
    // fail fast rather than silently running an unrelated workload through
    // an experimental harness.
    if (params.features && !params.features.includes('mcp-server')) {
      const result: AgentExecutionResult = {
        runId,
        agentId: params.routing.modelId.slice(0, 32),
        status: 'failed',
        summary: 'MCP harness: "mcp-server" feature not requested',
        steps: [],
        totalTokenUsage: { ...ZERO_USAGE },
        totalDurationMs: Date.now() - startTime,
        error: 'MCP harness selected without mcp-server feature',
      };
      this.emitEvent({
        type: 'run_error',
        error: result.error ?? 'unknown',
        runId,
        timestamp: Date.now(),
      });
      return result;
    }

    this.emitEvent({
      type: 'run_start',
      runId,
      goal: params.goal,
      harness: this.name,
      timestamp: Date.now(),
    });

    const agentId = params.routing.modelId.slice(0, 32);
    const steps: AgentExecutionStep[] = [];
    let totalUsage: TokenUsage = { ...ZERO_USAGE };

    // Resolve the LLM provider from the routing decision.
    const provider = params.services.getProvider(params.routing.provider);
    if (!provider) {
      const result: AgentExecutionResult = {
        runId,
        agentId,
        status: 'failed',
        summary: `MCP harness: provider "${params.routing.provider}" not registered`,
        steps,
        totalTokenUsage: totalUsage,
        totalDurationMs: Date.now() - startTime,
        error: `Provider not found: ${params.routing.provider}`,
      };
      this.emitEvent({
        type: 'run_error',
        error: result.error ?? 'unknown',
        runId,
        timestamp: Date.now(),
      });
      return result;
    }

    // Build tool definitions for the LLM request.
    const toolDefs = params.availableTools
      .map((name) => params.services.getToolDefinition(name))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);

    // Working message list — appended to as the loop progresses.
    const messages: LLMMessage[] = [...params.messages];

    // Process any queued steering messages before starting.
    this.drainSteerQueue(messages);

    let lastContent = '';
    let stepNumber = 0;
    const maxSteps = params.maxSteps > 0 ? params.maxSteps : 10;

    for (let iteration = 0; iteration < maxSteps; iteration++) {
      if (this.aborted || params.signal.aborted) {
        break;
      }

      stepNumber = iteration + 1;
      const llmStart = Date.now();

      // Build the LLM request.
      const request: LLMRequest = {
        model: params.routing.modelId,
        messages,
        maxTokens: params.routing.maxTokens,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      };

      // Fire before-LLM plugin hook.
      let finalRequest = request;
      try {
        finalRequest = await params.services.fireBeforeLLMCall({
          request,
          agentId,
          runId,
        });
      } catch (err) {
        getGlobalLogger().warn('McpHarness', 'fireBeforeLLMCall failed', {
          error: (err as Error).message,
        });
      }

      // Call the provider.
      let response: LLMResponse;
      try {
        response = await provider.call(finalRequest);
      } catch (err) {
        const errorMsg = (err as Error).message;
        steps.push({
          stepNumber,
          timestamp: new Date().toISOString(),
          type: 'response',
          content: `LLM call failed: ${errorMsg}`,
          durationMs: Date.now() - llmStart,
        });
        const result: AgentExecutionResult = {
          runId,
          agentId,
          status: 'failed',
          summary: `MCP harness: LLM call failed — ${errorMsg}`,
          steps,
          totalTokenUsage: totalUsage,
          totalDurationMs: Date.now() - startTime,
          error: errorMsg,
        };
        this.emitEvent({
          type: 'run_error',
          error: errorMsg,
          runId,
          timestamp: Date.now(),
        });
        return result;
      }

      // Fire after-LLM plugin hook.
      try {
        await params.services.fireAfterLLMCall({
          request: finalRequest,
          response,
          agentId,
          runId,
        });
      } catch (err) {
        getGlobalLogger().warn('McpHarness', 'fireAfterLLMCall failed', {
          error: (err as Error).message,
        });
      }

      // Accumulate token usage.
      if (response.usage) {
        totalUsage = {
          promptTokens: totalUsage.promptTokens + response.usage.promptTokens,
          completionTokens: totalUsage.completionTokens + response.usage.completionTokens,
          totalTokens: totalUsage.totalTokens + response.usage.totalTokens,
        };
      }

      lastContent = response.content;
      const llmDuration = Date.now() - llmStart;

      // Record the LLM response step.
      steps.push({
        stepNumber,
        timestamp: new Date().toISOString(),
        type: 'response',
        content: response.content,
        tokenUsage: response.usage,
        durationMs: llmDuration,
      });

      this.emitEvent({
        type: 'llm_response',
        response,
        runId,
        timestamp: Date.now(),
      });

      // If no tool calls, the agent is done.
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      // Add the assistant message (with tool calls) to the conversation.
      // LLMMessage uses OpenAI snake_case format for tool_calls.
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      // Execute each tool call sequentially (maxConcurrentTools = 1).
      for (const tc of response.toolCalls) {
        if (this.aborted || params.signal.aborted) break;

        this.emitEvent({
          type: 'tool_call_start',
          toolCall: tc,
          runId,
          timestamp: Date.now(),
        });

        const tool = params.services.getTool(tc.name);
        if (!tool) {
          const toolResult: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            output: '',
            error: `Tool "${tc.name}" not found`,
            durationMs: 0,
          };
          messages.push({
            role: 'tool',
            content: toolResult.error!,
            tool_call_id: tc.id,
          });
          steps.push({
            stepNumber,
            timestamp: new Date().toISOString(),
            type: 'tool_result',
            content: toolResult.error!,
            toolCall: tc,
            toolResult,
            durationMs: 0,
          });
          this.emitEvent({
            type: 'tool_call_end',
            toolCall: tc,
            result: toolResult,
            runId,
            timestamp: Date.now(),
          });
          continue;
        }

        // Fire before-tool plugin hook (may block).
        let blocked = false;
        let blockError: string | undefined;
        try {
          const gate = await params.services.fireBeforeToolCall({
            toolName: tc.name,
            args: tc.arguments,
            agentId,
            runId,
          });
          blocked = gate.blocked;
          blockError = gate.error;
        } catch (err) {
          getGlobalLogger().warn('McpHarness', 'fireBeforeToolCall failed', {
            error: (err as Error).message,
          });
        }

        if (blocked) {
          const toolResult: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            output: '',
            error: blockError ?? `Tool "${tc.name}" blocked by policy`,
            durationMs: 0,
          };
          messages.push({
            role: 'tool',
            content: toolResult.error!,
            tool_call_id: tc.id,
          });
          steps.push({
            stepNumber,
            timestamp: new Date().toISOString(),
            type: 'tool_result',
            content: toolResult.error!,
            toolCall: tc,
            toolResult,
            durationMs: 0,
          });
          this.emitEvent({
            type: 'tool_call_end',
            toolCall: tc,
            result: toolResult,
            runId,
            timestamp: Date.now(),
          });
          continue;
        }

        // Execute the tool.
        const toolStart = Date.now();
        let toolOutput = '';
        let toolError: string | undefined;
        try {
          toolOutput = await tool.execute(tc.arguments);
        } catch (err) {
          toolError = (err as Error).message;
          toolOutput = toolError;
        }
        const toolDuration = Date.now() - toolStart;

        const toolResult: ToolResult = {
          toolCallId: tc.id,
          name: tc.name,
          output: toolOutput,
          error: toolError,
          durationMs: toolDuration,
        };

        // Fire after-tool plugin hook.
        try {
          await params.services.fireAfterToolCall({
            toolName: tc.name,
            args: tc.arguments,
            result: toolResult,
            agentId,
            runId,
          });
        } catch (err) {
          getGlobalLogger().warn('McpHarness', 'fireAfterToolCall failed', {
            error: (err as Error).message,
          });
        }

        // Add tool result to conversation (OpenAI snake_case format).
        const safeToolOutput = sanitizeHarnessOutput(toolOutput, `harness:${tc.name}`);
        messages.push({
          role: 'tool',
          content: safeToolOutput,
          tool_call_id: tc.id,
        });

        steps.push({
          stepNumber,
          timestamp: new Date().toISOString(),
          type: 'tool_result',
          content: toolOutput,
          toolCall: tc,
          toolResult,
          durationMs: toolDuration,
        });

        this.emitEvent({
          type: 'tool_call_end',
          toolCall: tc,
          result: toolResult,
          runId,
          timestamp: Date.now(),
        });
      }

      // Drain any steering messages injected mid-loop.
      this.drainSteerQueue(messages);

      // Check token budget.
      if (params.tokenBudget > 0 && totalUsage.totalTokens >= params.tokenBudget) {
        getGlobalLogger().info(
          'McpHarness',
          `Token budget ${params.tokenBudget} reached, stopping`,
        );
        break;
      }
    }

    const status: AgentExecutionResult['status'] = this.aborted ? 'cancelled' : 'success';
    const result: AgentExecutionResult = {
      runId,
      agentId,
      status,
      summary: lastContent || `MCP harness completed ${steps.length} step(s)`,
      steps,
      totalTokenUsage: totalUsage,
      totalDurationMs: Date.now() - startTime,
    };

    if (status === 'success') {
      this.emitEvent({
        type: 'run_complete',
        result,
        runId,
        timestamp: Date.now(),
      });
    } else {
      this.emitEvent({
        type: 'run_error',
        error: 'Run cancelled',
        runId,
        timestamp: Date.now(),
      });
    }

    return result;
  }

  // abort(), steer(), subscribe(), emitEvent() are inherited from BaseHarness.
  // McpHarness overrides abort() to also reset its local `aborted` flag.
  abort(): void {
    this.aborted = true;
    super.abort();
  }

  getCapabilities(): HarnessCapabilities {
    return MCP_HARNESS_CAPABILITIES;
  }

  /**
   * Drain queued steering messages into the conversation as user messages
   * so the LLM sees them on the next iteration.
   */
  private drainSteerQueue(messages: LLMMessage[]): void {
    const steered = this.drainSteer();
    if (steered.length === 0) return;
    const combined = steered.map((s) => s.message).join('\n');
    messages.push({ role: 'user', content: `[Steering] ${combined}` });
  }
}
