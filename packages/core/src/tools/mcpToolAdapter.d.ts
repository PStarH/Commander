/**
 * MCPToolAdapter — Wrap remote MCP tools as Commander Tool interface.
 *
 * This bridge enables Commander agents to discover and call tools exposed
 * by any MCP-compatible server (Claude Desktop, Cursor, custom MCP servers).
 *
 * Flow:
 *   Agent LLM → Commander ToolRegistry → MCPToolAdapter → MCPClient → MCP Server
 *
 * Usage in agentLoop.ts:
 *   const mcpManager = new MCPIntegrationManager();
 *   await mcpManager.connect(configs);
 *   for (const tool of mcpManager.getTools()) {
 *     runtime.registerTool(tool.definition.name, tool);
 *   }
 */
import type { Tool, ToolDefinition } from '../runtime/types';
import { MCPClient } from '../mcp/client';
import type { MCPTool } from '../mcp/types';
export declare class MCPToolAdapter implements Tool {
    readonly definition: ToolDefinition;
    readonly isConcurrencySafe = true;
    readonly isReadOnly = false;
    readonly timeout = 300000;
    readonly maxOutputSize = 100000;
    private client;
    private mcpToolName;
    private serverLabel;
    constructor(client: MCPClient, mcpTool: MCPTool, serverLabel: string);
    execute(args: Record<string, unknown>): Promise<string>;
}
export interface MCPIntegrationConfig {
    servers: MCPIntegrationServerConfig[];
}
export interface MCPIntegrationServerConfig {
    /** Label used in tool name prefix: mcp_{label}_{toolName} */
    label: string;
    /** MCP transport type */
    transport: 'stdio' | 'streamable-http';
    /** For stdio: command to spawn */
    command?: string;
    /** For stdio: command arguments */
    args?: string[];
    /** For HTTP: server URL */
    url?: string;
    /** HTTP headers */
    headers?: Record<string, string>;
    /** Environment variables for stdio subprocess */
    env?: Record<string, string>;
    /** Auto-reconnect on disconnect? */
    autoReconnect?: boolean;
}
export declare class MCPIntegrationManager {
    private adapters;
    private clients;
    private connected;
    /**
     * Connect to all configured MCP servers and discover their tools.
     * Call this once at startup.
     */
    connect(configs: MCPIntegrationServerConfig[]): Promise<void>;
    /**
     * Get all discovered MCP tools as Commander Tool instances.
     */
    getTools(): MCPToolAdapter[];
    /**
     * Register all MCP tools into a Commander AgentRuntime.
     * Call this after runtime.registerTool() for built-in tools.
     */
    registerIntoRuntime(runtime: {
        registerTool: (name: string, tool: Tool) => void;
    }): void;
    /**
     * Disconnect from all MCP servers.
     */
    disconnect(): Promise<void>;
    isConnected(): boolean;
    getToolCount(): number;
    getServerCount(): number;
}
/**
 * Read MCP server configuration from COMMANDER_MCP_SERVERS env var (JSON array)
 * or from .commander.json's "mcpServers" field.
 *
 * Env var format:
 *   COMMANDER_MCP_SERVERS='[{"label":"filesystem","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/path"]}]'
 */
export declare function readMCPConfig(configFile?: {
    mcpServers?: MCPIntegrationServerConfig[];
}): MCPIntegrationServerConfig[];
/**
 * Read A2A agent discovery config from environment or config file.
 */
export declare function readA2ADiscoveryConfig(configFile?: {
    a2aAgents?: string[];
}): string[];
//# sourceMappingURL=mcpToolAdapter.d.ts.map