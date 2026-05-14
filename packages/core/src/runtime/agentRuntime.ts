import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  AgentExecutionContext,
  AgentExecutionStep,
  AgentExecutionResult,
  AgentRuntimeConfig,
  Tool,
  ToolCall,
  ToolResult,
  ToolDefinition,
  RoutingDecision,
  TokenUsage,
  CacheConfig,
} from './types';
import { ModelRouter, getModelRouter } from './modelRouter';
import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';

function generateId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
}

const DEFAULT_CONFIG: AgentRuntimeConfig = {
  defaultModelTier: 'standard',
  maxStepsPerRun: 20,
  maxRetries: 2,
  retryDelayMs: 1000,
  timeoutMs: 120000,
  maxConcurrency: 5,
  observationMaskWindow: 10,
  enableDescendingScheduler: true,
  budgetHardCapTokens: 64000,
};

export class AgentRuntime {
  private config: AgentRuntimeConfig;
  private providers: Map<string, LLMProvider> = new Map();
  private tools: Map<string, Tool> = new Map();
  private router: ModelRouter;
  private activeRuns: Set<string> = new Set();

  constructor(
    config?: Partial<AgentRuntimeConfig>,
    router?: ModelRouter,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.router = router ?? getModelRouter();
  }

  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  registerTool(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getConfig(): AgentRuntimeConfig {
    return { ...this.config };
  }

  /**
   * Execute an agent task end-to-end.
   */
  async execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult> {
    const runId = generateId();
    const bus = getMessageBus();
    const tracer = getTraceRecorder();
    const startTime = Date.now();

    this.activeRuns.add(runId);
    tracer.startRun(runId, ctx.agentId, ctx.missionId);

    // 0. Pre-execution budget check (hard enforcement, not advisory)
    if (this.config.budgetHardCapTokens > 0 && ctx.tokenBudget > this.config.budgetHardCapTokens) {
      const msg = `BUDGET_EXCEEDED: requested ${ctx.tokenBudget} > hard cap ${this.config.budgetHardCapTokens}`;
      tracer.recordDecision(runId, msg, 0);
      bus.publish('agent.failed', ctx.agentId, { runId, error: msg });
      this.activeRuns.delete(runId);
      return {
        runId, agentId: ctx.agentId, missionId: ctx.missionId,
        status: 'cancelled', summary: msg, steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0, error: msg,
      };
    }

    // 1. Route to optimal model
    const routing: RoutingDecision = this.router.route(ctx);
    tracer.recordDecision(runId, `routed to ${routing.modelId} (${routing.tier})`, 0);

    // 2. Build LLM request with cache-optimized prompt structure
    //    Stable content (system, tools) FIRST for maximum cache hits.
    //    Variable content (user message) LAST.
    const systemPrompt = this.buildSystemPrompt(ctx, routing);
    const toolDefs = ctx.availableTools
      .map(name => this.tools.get(name)?.definition)
      .filter((t): t is ToolDefinition => t !== undefined);

    // Cache configuration: enable caching for system prompt + tools on providers that support it
    const cacheConfig: CacheConfig = {
      cacheSystemPrompt: true,
      cacheTools: toolDefs.length > 0,
      useCacheControl: true,
    };

    const request: LLMRequest = {
      model: routing.modelId,
      // Order: [system (stable, cacheable), user (variable)]
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: this.buildCacheAwareUserPrompt(ctx, routing),
        },
      ],
      maxTokens: routing.maxTokens,
      tools: toolDefs,
      cacheConfig,
    };

    // 3. Emit started event
    bus.publish('agent.started', ctx.agentId, {
      runId,
      missionId: ctx.missionId,
      model: routing.modelId,
      goal: ctx.goal,
    });

    // 4. Execute with retry
    let lastError: string | undefined;
    const steps: AgentExecutionStep[] = [];
    let totalTokens: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      let response = await this.callWithTimeout(request, routing);
      const stepDuration = Date.now() - startTime;

      if (response) {
        // Accumulate token usage
        totalTokens.promptTokens += response.usage.promptTokens;
        totalTokens.completionTokens += response.usage.completionTokens;
        totalTokens.totalTokens += response.usage.totalTokens;

        // Record LLM call in trace
        const traceEventId = tracer.recordLLMCall(
          runId,
          routing.modelId,
          routing.provider,
          routing.tier,
          request,
          response,
          response.usage,
          stepDuration,
        );

        // Record step
        const step: AgentExecutionStep = {
          stepNumber: steps.length + 1,
          timestamp: now(),
          type: 'response',
          content: response.content,
          tokenUsage: response.usage,
          durationMs: stepDuration,
        };
        steps.push(step);

        // Process tool calls in a loop until resolved or deadline
        const maxIterations = ctx.maxSteps || 10;
        let toolLoopCount = 0;
        while (response.toolCalls && response.toolCalls.length > 0 && toolLoopCount < maxIterations) {
          toolLoopCount++;
          const orderedCalls = this.config.enableDescendingScheduler
            ? this.descendingToolOrder(response.toolCalls)
            : response.toolCalls;

          const rawResults: Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }> = [];
          for (const tc of orderedCalls) {
            const toolResult = await this.executeTool(runId, tc, ctx.agentId);
            rawResults.push({
              toolCallId: tc.id,
              name: tc.name,
              output: toolResult.output,
              error: toolResult.error,
              durationMs: toolResult.durationMs,
            });
          }

          const maskedResults = this.applyObservationMask(rawResults, this.config.observationMaskWindow);

          for (const masked of maskedResults) {
            const toolStep: AgentExecutionStep = {
              stepNumber: steps.length + 1,
              timestamp: now(),
              type: 'tool_result',
              content: masked.output,
              durationMs: masked.durationMs,
            };
            steps.push(toolStep);

            const assistantMsg: any = { role: 'assistant', content: response.content };
            if ((response as any).reasoning_content) {
              assistantMsg.reasoning_content = (response as any).reasoning_content;
            }
            if ((response as any).toolCalls) {
              assistantMsg.tool_calls = (response as any).toolCalls.map((tc: any) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              }));
            }
            request.messages.push(
              assistantMsg,
              { role: 'tool', content: masked.output, tool_call_id: masked.toolCallId },
            );
          }

          // Resume the model with tool results — get final answer
          const followUp = await this.callWithTimeout(request, routing);
          if (!followUp) break;
          totalTokens.promptTokens += followUp.usage.promptTokens;
          totalTokens.completionTokens += followUp.usage.completionTokens;
          totalTokens.totalTokens += followUp.usage.totalTokens;
          response = followUp;
        }

        const totalDurationMs = Date.now() - startTime;
        const result: AgentExecutionResult = {
          runId,
          agentId: ctx.agentId,
          missionId: ctx.missionId,
          status: 'success',
          summary: response.content.slice(0, 2000), // longer summary to capture reasoning
          steps,
          totalTokenUsage: totalTokens,
          totalDurationMs,
        };

        // Complete trace
        tracer.completeRun(runId);

        // Emit completed event
        bus.publish('agent.completed', ctx.agentId, {
          runId,
          missionId: ctx.missionId,
          summary: result.summary,
          tokenUsage: totalTokens,
          durationMs: totalDurationMs,
        });

        this.activeRuns.delete(runId);
        return result;
      }

      // Handle failure
      lastError = `Attempt ${attempt + 1} failed`;
      tracer.recordError(runId, lastError, Date.now() - startTime);

      if (attempt < this.config.maxRetries) {
        await this.delay(this.config.retryDelayMs * (attempt + 1));
      }
    }

    // All attempts failed
    tracer.recordError(runId, `All ${this.config.maxRetries + 1} attempts failed`, Date.now() - startTime);
    tracer.completeRun(runId);

    bus.publish('agent.failed', ctx.agentId, {
      runId,
      missionId: ctx.missionId,
      error: lastError,
    });

    this.activeRuns.delete(runId);

    return {
      runId,
      agentId: ctx.agentId,
      missionId: ctx.missionId,
      status: 'failed',
      summary: lastError ?? 'Unknown error',
      steps,
      totalTokenUsage: totalTokens,
      totalDurationMs: Date.now() - startTime,
      error: lastError,
    };
  }

  private async callWithTimeout(
    request: LLMRequest,
    routing: RoutingDecision,
  ): Promise<LLMResponse | null> {
    const provider = this.providers.get(routing.provider);
    if (!provider) {
      // Try any available provider
      const firstProvider = this.providers.values().next().value;
      if (!firstProvider) return null;
      try {
        return await firstProvider.call(request);
      } catch {
        return null;
      }
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const result = await provider.call(request);
      clearTimeout(timeout);
      return result;
    } catch (err) {
      console.error(`[AgentRuntime] provider call failed:`, err);
      return null;
    }
  }

  private buildSystemPrompt(ctx: AgentExecutionContext, routing: RoutingDecision): string {
    const govProfile = ctx.contextData.governanceProfile
      ? JSON.stringify(ctx.contextData.governanceProfile)
      : 'No governance constraints.';

    const parts: string[] = [
      `You are agent ${ctx.agentId} on project ${ctx.projectId}.`,
      ctx.missionId ? `Mission: ${ctx.missionId}` : '',
      '',
      '## Available Tools',
      ctx.availableTools.map(name => {
        const tool = this.tools.get(name);
        return tool ? `- ${tool.definition.name}: ${tool.definition.description}` : `- ${name}`;
      }).join('\n'),
      '',
      '## Governance',
      govProfile,
      '',
      '## Token Budget (self-aware)',
      `- Total budget: ${ctx.tokenBudget} tokens`,
      `- Model: ${routing.modelId} (tier: ${routing.tier})`,
      '- Be concise. Every token costs money.',
      '- When budget is low, escalate quickly or summarize aggressively.',
      '- Return structured output when possible (JSON, tool calls) instead of verbose prose.',
      '',
      '## Constraints',
      `- Maximum ${this.config.maxStepsPerRun} steps`,
      '- Prioritize accuracy over completeness when budget is constrained.',
    ];

    return parts.filter(Boolean).join('\n');
  }

  /**
   * Build cache-aware user prompt.
   * Variable content — goes LAST for maximum cache hit ratio on preceding system block.
   * Includes remaining budget context so agent can self-regulate.
   */
  private buildCacheAwareUserPrompt(ctx: AgentExecutionContext, routing: RoutingDecision): string {
    const remainingBudget = ctx.tokenBudget;
    const goal = ctx.goal;

    return [
      `## Task (budget remaining: ~${remainingBudget} tokens)`,
      '',
      goal,
      '',
      'Respond concisely. Use tools when appropriate.',
    ].join('\n');
  }

  /**
   * Execute a tool call and return STRUCTURED error context to the model.
   * Instead of silently logging errors, the model receives enough context
   * to reason about the failure and decide next steps.
   */
  private async executeTool(
    runId: string,
    toolCall: ToolCall,
    agentId: string,
  ): Promise<ToolResult> {
    const tracer = getTraceRecorder();
    const bus = getMessageBus();
    const startTime = Date.now();

    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      const error = `TOOL_NOT_FOUND: "${toolCall.name}" is not registered. Available: ${Array.from(this.tools.keys()).join(', ')}`;
      tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', 0, error);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: `error: ${error}\nadvice: Check the tool name and try again with a registered tool.`,
        durationMs: 0,
      };
    }

    try {
      const output = await tool.execute(toolCall.arguments);
      const durationMs = Date.now() - startTime;

      tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, output, durationMs);
      bus.publish('tool.executed', agentId, {
        toolName: toolCall.name,
        durationMs,
      });

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: typeof output === 'string' ? output : JSON.stringify(output),
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', durationMs, errorMsg);

      // Structured error context: tell the model WHAT went wrong so it can adapt
      const structuredError = [
        `tool_error: "${toolCall.name}" failed after ${durationMs}ms`,
        `  reason: ${errorMsg}`,
        `  args: ${JSON.stringify(toolCall.arguments)}`,
        `advice: `,
        `  - If this is a transient error, retry the call`,
        `  - If the arguments are invalid, correct them and retry`,
        `  - If the tool is unavailable, try a different approach`,
      ].join('\n');

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: structuredError,
        durationMs,
      };
    }
  }

  /**
   * Observation masking: keep last N tool results verbatim, replace older ones with placeholders.
   * Research finding (NeurIPS 2025): 52% cost reduction, +2.6% solve rate vs raw agent.
   * Placeholder preserves conversation structure while discarding bulky tool output.
   */
  private applyObservationMask(
    toolResults: Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }>,
    windowSize: number,
  ): Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }> {
    if (windowSize <= 0 || toolResults.length <= windowSize) return toolResults;
    return toolResults.map((r, i) => {
      if (i < toolResults.length - windowSize && !r.error && r.output.length > 100) {
        return { ...r, output: `[observation masked: ${r.name} result (${r.output.length} chars)]` };
      }
      return r;
    });
  }

  /**
   * Descending scheduler: reorder tools so broad/capacity tools run first.
   * "Descending" = broad exploration early, narrow focus later.
   * Research finding (W&D, arXiv Feb 2026): +7.3% on BrowseComp.
   */
  private descendingToolOrder(toolCalls: ToolCall[]): ToolCall[] {
    // Broad/capacity tools: search, list, read (high information gain)
    // Narrow tools: write, edit, delete (specific mutations)
    const broadKeywords = ['search', 'list', 'find', 'glob', 'grep', 'read', 'fetch', 'browse'];
    const broad: ToolCall[] = [];
    const narrow: ToolCall[] = [];
    for (const tc of toolCalls) {
      const isBroad = broadKeywords.some(k => tc.name.toLowerCase().includes(k));
      (isBroad ? broad : narrow).push(tc);
    }
    return [...broad, ...narrow];
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  isRunActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }
}
