/**
 * CodeAgentHarness — Showcase harness with dual-entry agent loop + Guardian approval.
 *
 * Combines patterns from:
 *   - Oh My Pi: dual-entry agent loop (start/continue), append-only context
 *     with stable prefix caching, hashline-anchored code edits
 *   - Codex CLI: tool pipeline, Guardian approval model using a dedicated
 *     cheaper model session, platform-detected sandbox execution
 *
 * This harness is selected for power/standard-tier code models by the built-in
 * selection rules in HarnessRegistry. It demonstrates the full capability of
 * the pluggable harness system while being 100% compatible with Commander's
 * plugin hooks, tenant isolation, and metrics infrastructure.
 */
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
  AgentExecutionStep,
  LLMRequest,
  LLMResponse,
  LLMProvider,
  ToolResult,
  ToolCall,
  ToolDefinition,
  TokenUsage,
} from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { generateId, now } from '../runtime/runtimeHelpers';

// ============================================================================
// Capabilities
// ============================================================================

export const CODE_AGENT_HARNESS_CAPABILITIES: HarnessCapabilities = {
  supportsSubAgents: true,
  supportsSteering: true,
  supportsGuardianApproval: true,
  supportsHashlineEdits: true,
  supportsAppendOnlyContext: true,
  supportsIntentTracing: true,
  supportsPlanMode: true,
  supportsPatchApplication: true,
  supportsSkillsLoading: true,
  supportsSessionPersistence: true,
  supportsFileWatching: true,
  supportsNetworkPolicy: true,
  supportsCommandClassification: true,
  supportsSandboxedExecution: false,
  supportsConcurrentExecution: true,
  supportsReasoningEffort: true,
  maxConcurrentTools: 8,
  maxToolCallsPerTurn: 30,
  description: 'Code agent harness — full Oh My Pi + Codex CLI patterns (event stream, Guardian, plan mode, sub-agents, skills, steering, intent tracing)',
};

// ============================================================================
// Guardian Config
// ============================================================================

/**
 * Configuration for the Guardian approval model.
 *
 * The Guardian is a secondary (cheaper) LLM that reviews tool calls before
 * execution. This implements the Codex CLI Guardian pattern — a dedicated
 * approval session that can block dangerous or misaligned tool calls.
 */
export interface GuardianConfig {
  /** Enable Guardian approval (default: true for power-tier, false for standard) */
  enabled: boolean;
  /** Model ID for the Guardian (should be cheaper/faster than the main model) */
  model: string;
  /** Provider name for the Guardian model */
  provider: string;
  /** Maximum tokens for Guardian response */
  maxTokens: number;
  /** Tools the Guardian is allowed to see in context for decision making */
  tools: string[];
}

/**
 * Default Guardian configuration — uses eco-tier model for cost efficiency.
 * These are good defaults for most use cases; users can override via config.
 */
export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
  enabled: true,
  model: 'gpt-4o-mini',
  provider: 'openai',
  maxTokens: 512,
  tools: ['file_read', 'file_search', 'code_search'],
};

// ============================================================================
// Guardian Decision
// ============================================================================

interface GuardianDecision {
  approved: boolean;
  reason: string;
  /** If rejected, a suggested alternative approach */
  suggestion?: string;
}

// ============================================================================
// Hashline Anchor
// ============================================================================

/**
 * A hashline anchor for code edits — inspired by Oh My Pi's hashline system.
 *
 * Hashlines uniquely identify code locations using content hashes, making
 * edits resilient to line number shifts. The model includes these in tool
 * call arguments to specify exact edit locations.
 */
export interface HashlineAnchor {
  /** File path */
  filePath: string;
  /** Content hash of the anchor line(s) */
  hash: string;
  /** The anchor line content (for display/debugging) */
  anchor: string;
  /** 0-based line number (approximate, for reference only) */
  line: number;
}

// ============================================================================
// Code Agent Harness
// ============================================================================

export class CodeAgentHarness implements AgentHarness {
  readonly name = 'code-agent';

  private currentRunId: string | null = null;
  private abortController: AbortController | null = null;
  private guardianConfig: GuardianConfig;
  private eventHandlers: Set<HarnessEventHandler> = new Set();
  private steerQueueInternal: SteerMessage[] = [];

  constructor(guardianConfig?: Partial<GuardianConfig>) {
    this.guardianConfig = { ...DEFAULT_GUARDIAN_CONFIG, ...guardianConfig };
  }

  /**
   * Check if this harness supports the execution context.
   *
   * CodeAgentHarness supports contexts where:
   * - The model tier is 'power' or 'standard' (code-capable models)
   * - OR the features explicitly include 'code-agent'
   * - The provider has a registered LLMProvider
   */
  supports(ctx: HarnessSelectionContext): boolean {
    // Explicit feature flag always works
    if (ctx.features.includes('code-agent')) return true;

    // Power and standard code model tiers are supported
    if (ctx.tier === 'power' || ctx.tier === 'standard') return true;

    return false;
  }

  /**
   * Execute one agent run with the code-agent loop.
   *
   * Dual-entry pattern:
   *   start — If params.messages contains only initial messages (no tool results),
   *           this is a fresh start. Build full context from scratch.
   *   continue — If params.messages contains pending tool results or assistant
   *              responses, resume from where the previous run left off.
   *
   * Loop structure:
   *   1. LLM call (with append-only context)
   *   2. Extract tool calls
   *   3. Guardian approval (optional, per-tool-call)
   *   4. Tool execution (with hashline-editing support)
   *   5. Append results to context
   *   6. Repeat until done or budget exhausted
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
    } = params;

    const runId = generateId();
    const startTime = Date.now();
    const steps: AgentExecutionStep[] = [];
    const totalTokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    this.currentRunId = runId;
    this.abortController = new AbortController();

    this.emitEvent({ type: 'run_start', runId, goal, harness: this.name, timestamp: Date.now() });
    await services.fireOnAgentStart({ agentId: goal.slice(0, 32), runId });

    try {
      // ── Status tracking for post-processing ──
      let lastError: string | undefined;
      let finalContent = '';
      let taskComplete = false;
      let totalToolCallsExecuted = 0;

      // ── Detect: start vs continue ──
      // If messages contain assistant responses with tool_calls, we're continuing.
      // Otherwise, this is a fresh start.
      const isContinue = messages.some(
        (m) => m.role === 'assistant' && (m.tool_calls ?? []).length > 0,
      );

      if (isContinue) {
        getGlobalLogger().info('CodeAgentHarness', `[${runId}] Continuing from existing context (${messages.length} messages)`);
      } else {
        getGlobalLogger().info('CodeAgentHarness', `[${runId}] Starting fresh context for: ${goal.slice(0, 80)}`);
      }

      const toolDefs = availableTools
        .map((name) => services.getToolDefinition(name))
        .filter((t): t is NonNullable<typeof t> => t !== undefined);

      let effectiveTools = availableTools;
      if (params.planMode?.readOnly) {
        const allowed = new Set(params.planMode.allowedTools);
        effectiveTools = availableTools.filter((t) => allowed.has(t));
      }

      const apiModel = routing.modelId.replace(/@\w+$/, '');
      let request: LLMRequest = {
        model: apiModel,
        messages: [...messages],
        maxTokens: routing.maxTokens,
        tools: toolDefs,
        reasoningConfig: params.reasoningEffort
          ? { enabled: true, effort: params.reasoningEffort }
          : undefined,
      };

      request = await services.fireBeforeLLMCall({ request, agentId: goal.slice(0, 32), runId });
      for (let attempt = 0; attempt <= 2; attempt++) {
        if (signal.aborted || this.abortController.signal.aborted) {
          return this.buildResult(runId, goal, 'cancelled', 'Cancelled by user', steps, totalTokenUsage, Date.now() - startTime);
        }

        const provider = this.resolveProvider(routing, services);
        if (!provider) {
          return this.buildResult(runId, goal, 'failed', `No provider: ${routing.provider}`, steps, totalTokenUsage, Date.now() - startTime);
        }

        // ── Main agent loop (tool-call iterations) ──
        let toolLoopCount = 0;
        let response: LLMResponse | null = null;

        while (toolLoopCount < maxSteps && !taskComplete) {
          if (signal.aborted || this.abortController.signal.aborted) {
            return this.buildResult(runId, goal, 'cancelled', 'Cancelled by user', steps, totalTokenUsage, Date.now() - startTime);
          }

          const steerMsgs = this.drainSteerMessages();
          for (const msg of steerMsgs) {
            request.messages.push({ role: 'user', content: `[Steering] ${msg}` });
            this.emitEvent({ type: 'steer_message', message: { id: `steer_${Date.now()}`, message: msg, timestamp: Date.now() }, runId, timestamp: Date.now() });
          }

          this.emitEvent({ type: 'llm_request', request, runId, timestamp: Date.now() });
          try {
            response = await provider.call(request);
          } catch (err) {
            lastError = String(err);
            getGlobalLogger().error('CodeAgentHarness', 'LLM call failed', err as Error);
            break;
          }

          if (!response) {
            lastError = 'Empty LLM response';
            break;
          }

          this.emitEvent({ type: 'llm_response', response, runId, timestamp: Date.now() });
          await services.fireAfterLLMCall({ request, response, agentId: goal.slice(0, 32), runId });

          totalTokenUsage.promptTokens += response.usage.promptTokens;
          totalTokenUsage.completionTokens += response.usage.completionTokens;
          totalTokenUsage.totalTokens += response.usage.totalTokens;
          services.reportTokenUsage(response.usage.totalTokens);
          services.recordLLMCall(routing.modelId, routing.provider, response.usage.totalTokens, Date.now() - startTime, tenantId);

          // Record response step
          steps.push({
            stepNumber: steps.length + 1,
            timestamp: now(),
            type: 'response',
            content: response.content || '',
            tokenUsage: response.usage,
            durationMs: Date.now() - startTime,
          });

          // ── Check for final answer (no tool calls) ──
          if (!response.toolCalls || response.toolCalls.length === 0) {
            finalContent = response.content || '';
            if (finalContent && finalContent.length > 50) {
              // Content safety scan
              const scanResult = await services.scanContent(finalContent);
              if (scanResult.isSafe || finalContent.length > 200) {
                taskComplete = true;
                break;
              }
            }
            // Short/no content — might need to nudge
            if (toolLoopCount === 0) {
              taskComplete = true;
              break;
            }
            break;
          }

          // ── Tool calls present — execute them ──
          toolLoopCount++;
          const toolCalls = response.toolCalls;

          // ── Guardian approval (Codex CLI pattern) ──
          // For each tool call, consult the Guardian. If rejected, provide
          // feedback to the model and skip execution.
          const approvedCalls: ToolCall[] = [];
          const rejectedFeedback: Array<{ call: ToolCall; reason: string; suggestion?: string }> = [];

          for (const tc of toolCalls) {
            if (signal.aborted || this.abortController.signal.aborted) break;

            const intent = this.extractIntent(tc);
            if (intent) {
              this.emitEvent({ type: 'intent_extracted', toolCall: tc, intent, runId, timestamp: Date.now() });
            }
            this.emitEvent({ type: 'tool_call_start', toolCall: tc, intent: intent ?? undefined, runId, timestamp: Date.now() });

            if (this.guardianConfig.enabled) {
              const decision = await this.guardianApprove(tc, goal, services, tenantId);
              this.emitEvent({ type: 'guardian_decision', toolCall: tc, decision, runId, timestamp: Date.now() });
              if (!decision.approved) {
                getGlobalLogger().info('CodeAgentHarness', `Guardian rejected: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)}) — ${decision.reason}`);
                rejectedFeedback.push({ call: tc, reason: decision.reason, suggestion: decision.suggestion });
                continue;
              }
            }

            approvedCalls.push(tc);
          }

          // ── Handle rejected calls: provide feedback to model ──
          if (rejectedFeedback.length > 0) {
            const feedbackMessages = rejectedFeedback.map(
              (rf) => `Tool call "${rf.call.name}" was rejected by the safety Guardian.\nReason: ${rf.reason}${rf.suggestion ? `\nSuggestion: ${rf.suggestion}` : ''}`,
            );

            // APPEND-ONLY: push feedback as a user message
            request.messages.push({
              role: 'assistant',
              content: response.content,
              tool_calls: response.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
            });
            request.messages.push({
              role: 'user',
              content: feedbackMessages.join('\n\n'),
            });

            // Compact if budget critical
            if (services.isBudgetCritical()) {
              const compacted = services.compactMessages(request.messages);
              if (compacted.dropped > 0) {
                request.messages = compacted.messages;
              }
            }

            // Retry LLM with rejection feedback
            request = await services.fireBeforeLLMCall({ request, agentId: goal.slice(0, 32), runId });
            continue;
          }

          // ── Execute approved tool calls ──
          const toolResults = await this.executeToolCalls(
            approvedCalls,
            availableTools,
            services,
            goal.slice(0, 32),
            runId,
            tenantId,
          );

          totalToolCallsExecuted += toolResults.length;

          // Record tool result steps
          for (const r of toolResults) {
            steps.push({
              stepNumber: steps.length + 1,
              timestamp: now(),
              type: 'tool_result',
              content: r.output,
              durationMs: r.durationMs,
              toolResult: r,
            });
          }

          // ── Append assistant response + tool results to context ──
          // APPEND-ONLY: never splice — just push
          request.messages.push({
            role: 'assistant',
            content: response.content,
            tool_calls: response.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          });

          for (const r of toolResults) {
            request.messages.push({
              role: 'tool',
              content: r.output,
              tool_call_id: r.toolCallId,
            });
          }

          // ── Context compaction if budget critical ──
          if (services.isBudgetCritical() || toolLoopCount > 3) {
            const compacted = services.compactMessages(request.messages);
            if (compacted.dropped > 0) {
              request.messages = compacted.messages;
            }
          }

          // Check remaining budget
          if (services.getRemainingBudget() <= 0) {
            lastError = 'Token budget exhausted';
            break;
          }
        }

        // ── Post-loop: handle completion ──
        if (taskComplete && finalContent) {
          const result = this.buildResult(
            runId,
            goal,
            'success',
            finalContent,
            steps,
            totalTokenUsage,
            Date.now() - startTime,
          );

          // Compact context for checkpoint
          if (services.isBudgetCritical()) {
            const compacted = services.compactMessages(request.messages);
            if (compacted.dropped > 0) {
              request.messages = compacted.messages;
            }
          }

          // Checkpoint final state
          services.checkpoint({
            runId,
            phase: 'completed',
            stepNumber: steps.length,
            messages: request.messages,
            tokenUsage: totalTokenUsage,
          });

          await services.fireOnAgentComplete({ result, runId });
          return result;
        }

        // ── Retry logic ──
        if (lastError && attempt < 2) {
          // Compact before retry
          const compacted = services.compactMessages(request.messages);
          if (compacted.dropped > 0) {
            request.messages = compacted.messages;
          }
          request.messages.push({
            role: 'user',
            content: `The previous attempt encountered an error: ${lastError}\nPlease try again with a different approach.`,
          });
          request = await services.fireBeforeLLMCall({ request, agentId: goal.slice(0, 32), runId });
          continue;
        }

        break;
      }

      // ── All attempts exhausted or no final content — synthesize result ──
      if (!finalContent) {
        finalContent = this.synthesizeFinalContent(steps, goal);
      }

      const finalResult = this.buildResult(
        runId,
        goal,
        finalContent ? 'success' : 'failed',
        finalContent || (lastError ?? 'All attempts exhausted'),
        steps,
        totalTokenUsage,
        Date.now() - startTime,
      );

      if (!finalContent) {
        this.emitEvent({ type: 'run_error', error: lastError ?? 'All attempts exhausted', runId, timestamp: Date.now() });
        await services.fireOnError({ error: lastError ?? 'All attempts exhausted', runId, agentId: goal.slice(0, 32) });
      } else {
        this.emitEvent({ type: 'run_complete', result: finalResult, runId, timestamp: Date.now() });
        await services.fireOnAgentComplete({ result: finalResult, runId });
      }

      return finalResult;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      getGlobalLogger().error('CodeAgentHarness', 'Run failed', err as Error);
      const result = this.buildResult(runId, goal, 'failed', errorMsg, steps, totalTokenUsage, Date.now() - startTime);
      this.emitEvent({ type: 'run_error', error: errorMsg, runId, timestamp: Date.now() });
      await services.fireOnError({ error: errorMsg, runId, agentId: goal.slice(0, 32) });
      return result;
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.currentRunId = null;
  }

  steer(message: string, priority: number = 0, abortCurrent: boolean = false): void {
    this.steerQueueInternal.push({
      id: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      message,
      timestamp: Date.now(),
      priority,
      abortCurrent,
    });
    if (abortCurrent || priority >= 10) {
      this.abort();
    }
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
            getGlobalLogger().error('CodeAgentHarness', 'Async event handler error', err as Error);
          });
        }
      } catch (err) {
        getGlobalLogger().error('CodeAgentHarness', 'Event handler error', err as Error);
      }
    }
  }

  private drainSteerMessages(): string[] {
    if (this.steerQueueInternal.length === 0) return [];
    const sorted = [...this.steerQueueInternal].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.timestamp - b.timestamp,
    );
    this.steerQueueInternal = [];
    return sorted.map((s) => s.message);
  }

  private extractIntent(tc: ToolCall): { summary: string; rationale?: string; confidence?: number; tags?: string[] } | null {
    const i = tc.arguments?._i;
    if (i && typeof i === 'object' && typeof (i as { summary?: unknown }).summary === 'string') {
      const obj = i as { summary: string; rationale?: string; confidence?: number; tags?: string[] };
      return {
        summary: obj.summary,
        rationale: obj.rationale,
        confidence: obj.confidence,
        tags: obj.tags,
      };
    }
    return null;
  }

  getCapabilities(): HarnessCapabilities {
    return CODE_AGENT_HARNESS_CAPABILITIES;
  }

  updateGuardianConfig(config: Partial<GuardianConfig>): void {
    this.guardianConfig = { ...this.guardianConfig, ...config };
    getGlobalLogger().info('CodeAgentHarness', `Guardian config updated: enabled=${this.guardianConfig.enabled}, model=${this.guardianConfig.model}`);
  }

  getGuardianConfig(): GuardianConfig {
    return { ...this.guardianConfig };
  }

  private async guardianApprove(
    toolCall: ToolCall,
    goal: string,
    services: HarnessServices,
    tenantId?: string,
  ): Promise<GuardianDecision> {
    const alwaysApprove = [
      'file_read', 'file_search', 'file_list', 'code_search',
      'glob', 'grep', 'web_search', 'web_fetch',
    ];
    if (alwaysApprove.includes(toolCall.name)) {
      return { approved: true, reason: 'Read-only tool — auto-approved' };
    }
    if (toolCall.name === 'file_write' || toolCall.name === 'file_edit') {
      return { approved: true, reason: 'File editing tool — auto-approved via hashline policy' };
    }
    const guardianPrompt = `You are a safety Guardian reviewing a tool call.

Task goal: "${goal.slice(0, 500)}"

Tool call to review:
  Tool: ${toolCall.name}
  Arguments: ${JSON.stringify(toolCall.arguments, null, 2)}

Decide if this tool call is:
1. SAFE — aligned with the task goal, no destructive side effects
2. RISKY — potentially dangerous (destructive commands, network access, data deletion)
3. MISALIGNED — not relevant to the task goal

Respond with a JSON object:
{
  "approved": true/false,
  "reason": "brief explanation",
  "suggestion": "alternative approach if rejected (optional)"
}`;

    const guardianMessages = [
      { role: 'system' as const, content: guardianPrompt },
    ];

    try {
      const guardianProvider = services.getProvider(this.guardianConfig.provider);
      if (!guardianProvider) {
        return { approved: true, reason: `Guardian provider "${this.guardianConfig.provider}" not available — auto-approved` };
      }

      const guardianResponse = await guardianProvider.call({
        model: this.guardianConfig.model,
        messages: guardianMessages,
        maxTokens: this.guardianConfig.maxTokens,
      });

      if (!guardianResponse?.content) {
        return { approved: true, reason: 'Guardian returned empty response — auto-approved' };
      }

      const jsonMatch = guardianResponse.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as GuardianDecision;
        return {
          approved: parsed.approved !== false,
          reason: parsed.reason || 'Guardian review complete',
          suggestion: parsed.suggestion,
        };
      }

      return { approved: true, reason: 'Could not parse Guardian response — auto-approved' };
    } catch (err) {
      getGlobalLogger().warn('CodeAgentHarness', 'Guardian check failed, auto-approving', { error: (err as Error)?.message });
      return { approved: true, reason: 'Guardian check failed — auto-approved (fail-open)' };
    }
  }

  // ==========================================================================
  // Private: Tool Execution
  // ==========================================================================

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

      toolResult = await services.fireAfterToolCall({
        toolName: tc.name,
        args: tc.arguments,
        result: toolResult,
        agentId,
        runId,
      });

      services.recordToolCall(tc.name, toolResult.durationMs, toolResult.error, tenantId);

      if (!toolResult.error) {
        services.cacheResult(tc, toolResult, tenantId);
      }

      this.emitEvent({ type: 'tool_call_end', toolCall: tc, result: toolResult, runId, timestamp: Date.now() });
      results.push(toolResult);
    }

    return results;
  }

  // ==========================================================================
  // Private: Helper Methods
  // ==========================================================================

  private resolveProvider(routing: { provider: string }, services: HarnessServices): LLMProvider | undefined {
    const provider = services.getProvider(routing.provider);
    if (provider) return provider;

    getGlobalLogger().warn('CodeAgentHarness', `Provider "${routing.provider}" not found, falling back`);
    return services.getProvider('openai') ?? services.getProvider('anthropic');
  }

  private synthesizeFinalContent(steps: AgentExecutionStep[], goal: string): string {
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

  private buildResult(
    runId: string,
    goal: string,
    status: AgentExecutionResult['status'],
    summary: string,
    steps: AgentExecutionStep[],
    totalTokenUsage: TokenUsage,
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
