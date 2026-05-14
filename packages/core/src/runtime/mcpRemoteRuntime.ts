import type { AgentExecutionContext, AgentExecutionStep, AgentExecutionResult } from './types';
import { getMessageBus } from './messageBus';

export interface MCPRemoteRuntimeConfig {
  serverName: string;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  maxSteps?: number;
}

/**
 * MCP Remote Runtime — wraps a remote MCP server as an AgentRuntime-compatible executor.
 * 
 * This enables distributed multi-agent execution: sub-agents are dispatched to
 * remote MCP servers via the "run_agent" MCP tool. The remote server runs the
 * agent and returns results over JSON-RPC.
 * 
 * Usage:
 *   const remoteRuntime = new MCPRemoteRuntime({
 *     serverName: 'worker-1',
 *     callTool: mcpClient.callTool.bind(mcpClient),
 *   });
 *   const runtime = new AgentRuntime();
 *   // Route some tasks to remoteRuntime instead of local runtime
 */
export class MCPRemoteRuntime {
  readonly name: string;
  private config: MCPRemoteRuntimeConfig;

  constructor(config: MCPRemoteRuntimeConfig) {
    this.name = config.serverName;
    this.config = config;
  }

  async execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult> {
    const runId = `mcp-remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();
    const bus = getMessageBus();
    const steps: AgentExecutionStep[] = [];

    bus.publish('agent.started', `mcp:${this.name}`, {
      runId,
      agentId: ctx.agentId,
      goal: ctx.goal,
      server: this.name,
    });

    try {
      const result = await this.config.callTool('run_agent', {
        agentId: ctx.agentId,
        projectId: ctx.projectId,
        goal: ctx.goal,
        availableTools: ctx.availableTools,
        maxSteps: ctx.maxSteps,
        tokenBudget: ctx.tokenBudget,
        contextData: ctx.contextData,
      });

      const durationMs = Date.now() - startTime;

      if (result.isError) {
        const errorText = result.content.map(c => c.text ?? '').join('\n');
        steps.push({
          stepNumber: 1,
          timestamp: new Date().toISOString(),
          type: 'tool_result',
          content: errorText,
          durationMs,
        });

        bus.publish('agent.failed', `mcp:${this.name}`, { runId, agentId: ctx.agentId, error: errorText });

        return {
          runId,
          agentId: ctx.agentId,
          status: 'failed',
          summary: errorText.slice(0, 500),
          steps,
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          totalDurationMs: durationMs,
          error: errorText,
        };
      }

      const outputText = result.content.map(c => c.text ?? '').join('\n');
      steps.push({
        stepNumber: 1,
        timestamp: new Date().toISOString(),
        type: 'response',
        content: outputText,
        durationMs,
      });

      bus.publish('agent.completed', `mcp:${this.name}`, {
        runId,
        agentId: ctx.agentId,
        summary: outputText.slice(0, 500),
        durationMs,
      });

      return {
        runId,
        agentId: ctx.agentId,
        status: 'success',
        summary: outputText.slice(0, 500),
        steps,
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: outputText.length },
        totalDurationMs: durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      bus.publish('agent.failed', `mcp:${this.name}`, { runId, agentId: ctx.agentId, error: errorMsg });

      return {
        runId,
        agentId: ctx.agentId,
        status: 'failed',
        summary: errorMsg.slice(0, 500),
        steps,
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: durationMs,
        error: errorMsg,
      };
    }
  }
}
