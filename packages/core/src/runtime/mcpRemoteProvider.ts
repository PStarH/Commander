/**
 * MCP Remote Provider — adapter that exposes MCPRemoteRuntime as an LLMProvider.
 *
 * When registered via `runtime.registerProvider('mcp:serverName', new MCPRemoteProvider(remoteRuntime))`,
 * routing decisions pointing to `mcp:serverName` will dispatch the LLM call
 * to the remote MCP server's `run_agent` tool. This enables distributed
 * multi-agent execution via MCP without requiring shared process boundaries.
 */
import type { LLMProvider, LLMRequest, LLMResponse } from './types';
import type { AgentExecutionContext } from './types';
import { MCPRemoteRuntime } from './mcpRemoteRuntime';

export class MCPRemoteProvider implements LLMProvider {
  readonly name: string;

  constructor(public readonly remoteRuntime: MCPRemoteRuntime) {
    this.name = `mcp:${remoteRuntime.name}`;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const lastMsg = request.messages[request.messages.length - 1];
    const goal = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

    const ctx: AgentExecutionContext = {
      agentId: request.model ?? 'mcp-agent',
      projectId: 'mcp-dispatch',
      goal,
      contextData: {},
      availableTools: [],
      maxSteps: 1,
      tokenBudget: request.maxTokens ?? 4000,
    };

    const result = await this.remoteRuntime.execute(ctx);

    return {
      content: result.summary,
      model: request.model,
      usage: result.totalTokenUsage,
      finishReason: 'stop',
    };
  }
}
