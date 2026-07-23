/**
 * CommanderMcpServer — opinionated MCP server wrapper around Commander services.
 *
 * Registers a single `execute_goal` tool that external MCP clients can call to
 * run a Commander goal against the configured provider and available tools.
 */
import { MCPServer } from './server';
import type { LLMMessage, LLMRequest, Tool, ToolDefinition, ToolResult } from '../runtime/types';
import type { HarnessServices } from '../harness/harnessTypes';
import { getGlobalLogger } from '../logging';
import { registerObservabilityTools } from '../observability/mcpObservability';
import type { ExecutionTraceRecorder } from '../runtime/executionTrace';
import type { TraceStore } from '../runtime/traceStore';
import {
  assertSameTenant,
  requireCurrentTenantId,
  validateTenantId,
} from '../runtime/tenantContext';

export interface CommanderMcpServerOptions {
  services: HarnessServices;
  tenantId: string;
  /** Server-authoritative capabilities available to nested tool calls. */
  allowedTools: readonly string[];
  providerName?: string;
  maxSteps?: number;
  timeoutMs?: number;
  /** Optional observability tools (timeline/summary/compare/tool-metrics). */
  observability?: {
    recorder: ExecutionTraceRecorder;
    traceStore: TraceStore;
  };
}

export interface ExecuteGoalArgs {
  goal: string;
  messages?: LLMMessage[];
  availableTools?: string[];
}

export interface ExecuteGoalResult {
  summary: string;
  status: 'success' | 'failed' | 'cancelled';
  steps: Array<{
    stepNumber: number;
    timestamp: string;
    type: 'thought' | 'tool_call' | 'tool_result' | 'response';
    content: string;
    tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    durationMs: number;
  }>;
  totalTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
}

export class CommanderMcpServer {
  private server: MCPServer;
  private readonly allowedTools: ReadonlySet<string>;

  constructor(private readonly options: CommanderMcpServerOptions) {
    validateTenantId(options.tenantId);
    this.allowedTools = new Set(options.allowedTools);
    this.server = new MCPServer('commander', '0.2.0');
    this.registerExecuteGoalTool();
    if (this.options.observability) {
      registerObservabilityTools(this.server, this.options.observability);
    }
  }

  async executeGoal(args: ExecuteGoalArgs & { signal?: AbortSignal }): Promise<ExecuteGoalResult> {
    return this.runAgentLoop({
      goal: args.goal,
      messages: args.messages ?? [],
      availableTools: args.availableTools ?? [...this.allowedTools],
    });
  }

  private registerExecuteGoalTool(): void {
    this.server.registerTool(
      {
        name: 'execute_goal',
        description: 'Execute a high-level goal using the Commander agent runtime.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'The goal to accomplish' },
            messages: {
              type: 'array',
              description: 'Optional conversation history',
              items: { type: 'object' },
            },
            availableTools: {
              type: 'array',
              description: 'Optional list of tool names to expose',
              items: { type: 'string' },
            },
          },
          required: ['goal'],
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await this.runAgentLoop({
            goal: String(args.goal ?? ''),
            messages: Array.isArray(args.messages) ? (args.messages as LLMMessage[]) : [],
            availableTools: Array.isArray(args.availableTools)
              ? (args.availableTools as string[])
              : [...this.allowedTools],
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          getGlobalLogger().error('CommanderMcpServer', 'execute_goal failed', err as Error);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  summary: `Execution failed: ${message}`,
                  status: 'failed',
                  steps: [],
                  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                  error: message,
                } satisfies ExecuteGoalResult),
              },
            ],
          };
        }
      },
    );
  }

  private async runAgentLoop(args: {
    goal: string;
    messages: LLMMessage[];
    availableTools: string[];
  }): Promise<ExecuteGoalResult> {
    const { services } = this.options;
    this.assertTenantBound();
    const { toolDefs, toolsByName, toolNames } = this.resolveTools(args.availableTools);
    const providerName = this.options.providerName ?? 'default';
    const provider = services.getProvider(providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" not found`);
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: `You are Commander. Goal: ${args.goal}` },
      ...args.messages,
    ];

    const steps: ExecuteGoalResult['steps'] = [];
    const totalTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const maxSteps = this.options.maxSteps ?? 10;
    let lastError: string | undefined;

    for (let step = 0; step < maxSteps; step++) {
      if (this.isAborted()) {
        return this.buildResult(args.goal, 'cancelled', steps, totalTokenUsage, 'Cancelled');
      }

      let request: LLMRequest = {
        model: provider.name ?? 'default',
        messages,
        tools: toolDefs,
      };
      request = await services.fireBeforeLLMCall({ request, agentId: 'mcp', runId: 'mcp-run' });

      const llmStart = Date.now();
      const response = await provider.call(request);
      const llmDuration = Date.now() - llmStart;

      await services.fireAfterLLMCall({ request, response, agentId: 'mcp', runId: 'mcp-run' });

      const usage = response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      totalTokenUsage.promptTokens += usage.promptTokens;
      totalTokenUsage.completionTokens += usage.completionTokens;
      totalTokenUsage.totalTokens += usage.totalTokens;

      steps.push({
        stepNumber: step + 1,
        timestamp: new Date().toISOString(),
        type: 'response',
        content: response.content?.slice(0, 200) ?? '',
        tokenUsage: usage,
        durationMs: llmDuration,
      });

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return this.buildResult(
          args.goal,
          'success',
          steps,
          totalTokenUsage,
          response.content ?? 'Done',
        );
      }

      for (const tc of toolCalls) {
        if (this.isAborted()) {
          return this.buildResult(args.goal, 'cancelled', steps, totalTokenUsage, 'Cancelled');
        }
        const tool = toolsByName.get(tc.name);
        if (!tool) {
          lastError = `Tool "${tc.name}" not found`;
          steps.push({
            stepNumber: step + 1,
            timestamp: new Date().toISOString(),
            type: 'thought',
            content: lastError,
            durationMs: 0,
          });
          continue;
        }

        const before = await services.fireBeforeToolCall({
          toolName: tc.name,
          args: tc.arguments,
          agentId: 'mcp',
          runId: 'mcp-run',
        });
        if (before.blocked) {
          lastError = before.error ?? `Tool "${tc.name}" blocked`;
          steps.push({
            stepNumber: step + 1,
            timestamp: new Date().toISOString(),
            type: 'thought',
            content: lastError,
            durationMs: 0,
          });
          continue;
        }

        this.assertTenantBound();
        if (!toolNames.has(tc.name) || !this.allowedTools.has(tc.name)) {
          throw new Error(`Tool "${tc.name}" is not allowed for this execution`);
        }
        const currentTool = services.getTool(tc.name);
        if (!currentTool) {
          throw new Error(`Unknown tool "${tc.name}"`);
        }

        steps.push({
          stepNumber: step + 1,
          timestamp: new Date().toISOString(),
          type: 'tool_call',
          content: `${tc.name}(${JSON.stringify(tc.arguments)})`,
          durationMs: 0,
        });

        const toolStart = Date.now();
        let output: string;
        try {
          output = await currentTool.execute(tc.arguments);
        } catch (err) {
          output = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        let result: ToolResult = {
          toolCallId: tc.id,
          name: tc.name,
          output,
          durationMs: Date.now() - toolStart,
        };
        result = await services.fireAfterToolCall({
          toolName: tc.name,
          args: tc.arguments,
          result,
          agentId: 'mcp',
          runId: 'mcp-run',
          tool: currentTool,
        });
        const toolDuration = Date.now() - toolStart;

        messages.push({ role: 'tool', content: result.output, tool_call_id: tc.id });
        steps.push({
          stepNumber: step + 1,
          timestamp: new Date().toISOString(),
          type: 'tool_result',
          content: result.output.slice(0, 200),
          durationMs: toolDuration,
        });
      }
    }

    return this.buildResult(
      args.goal,
      lastError ? 'failed' : 'success',
      steps,
      totalTokenUsage,
      lastError ?? 'Reached max steps',
      lastError,
    );
  }

  private buildResult(
    goal: string,
    status: ExecuteGoalResult['status'],
    steps: ExecuteGoalResult['steps'],
    totalTokenUsage: ExecuteGoalResult['totalTokenUsage'],
    summary: string,
    error?: string,
  ): ExecuteGoalResult {
    return { summary, status, steps, totalTokenUsage, error };
  }

  private assertTenantBound(): void {
    requireCurrentTenantId();
    assertSameTenant(this.options.tenantId);
  }

  private resolveTools(availableTools: string[]): {
    toolDefs: ToolDefinition[];
    toolsByName: Map<string, Tool>;
    toolNames: ReadonlySet<string>;
  } {
    const toolDefs: ToolDefinition[] = [];
    const toolsByName = new Map<string, Tool>();
    const toolNames = new Set<string>();

    for (const name of availableTools) {
      if (typeof name !== 'string' || !this.allowedTools.has(name)) {
        throw new Error(`Tool "${String(name)}" is not allowed by this server`);
      }
      if (toolNames.has(name)) continue;

      const definition = this.options.services.getToolDefinition(name);
      const tool = this.options.services.getTool(name);
      if (!definition || !tool) {
        throw new Error(`Unknown tool "${name}"`);
      }

      toolNames.add(name);
      toolDefs.push(definition);
      toolsByName.set(name, tool);
    }

    return { toolDefs, toolsByName, toolNames };
  }

  private isAborted(): boolean {
    // The MCP server execution currently does not receive an AbortSignal at the server layer;
    // abort is handled by the harness via timeout/abort of the executeGoal promise.
    return false;
  }
}
