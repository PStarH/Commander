import type { AgentExecutionContext, AgentExecutionResult } from './types';
export interface MCPRemoteRuntimeConfig {
    serverName: string;
    callTool: (name: string, args: Record<string, unknown>) => Promise<{
        content: Array<{
            type: string;
            text?: string;
        }>;
        isError?: boolean;
    }>;
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
export declare class MCPRemoteRuntime {
    readonly name: string;
    private config;
    constructor(config: MCPRemoteRuntimeConfig);
    execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult>;
}
//# sourceMappingURL=mcpRemoteRuntime.d.ts.map