import type { MCPTool, MCPResource, MCPPrompt, MCPContentItem, MCPToolResult, MCPResourceContents, JSONRPCRequest, JSONRPCResponse, MCPServerCapabilities, GetPromptResult } from './types';
type ToolHandler = (args: Record<string, unknown>) => Promise<MCPToolResult | MCPContentItem[]>;
type ResourceReader = (uri: string) => Promise<MCPResourceContents[]>;
type PromptHandler = (args: Record<string, string>) => Promise<GetPromptResult>;
import type { Tool } from '../runtime/types';
export interface MCPToolRegistration {
    definition: MCPTool;
    handler: ToolHandler;
}
export interface MCPResourceRegistration {
    resource: MCPResource;
    handler: ResourceReader;
}
export interface MCPPromptRegistration {
    prompt: MCPPrompt;
    handler: PromptHandler;
}
export declare class MCPServer {
    private tools;
    private resources;
    private prompts;
    private serverName;
    private serverVersion;
    private initialized;
    constructor(name: string, version?: string);
    registerTool(tool: MCPTool, handler: ToolHandler): void;
    registerResource(resource: MCPResource, handler: ResourceReader): void;
    registerPrompt(prompt: MCPPrompt, handler: PromptHandler): void;
    getCapabilities(): MCPServerCapabilities;
    /**
     * Handle a single JSON-RPC request. Returns the response.
     * This is the main entry point for both HTTP and stdio transports.
     */
    handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse>;
    private dispatch;
    /**
     * Convert TELOS ToolDefinition to MCP tool schema.
     */
    static toolFromDefinition(def: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    }): MCPTool;
    /**
     * Register the standard "run_agent" distributed execution tool on this server.
     * This is what MCPRemoteRuntime calls to execute agents remotely.
     */
    registerAgentExecutor(handler: (args: {
        agentId: string;
        projectId: string;
        goal: string;
        availableTools: string[];
        maxSteps: number;
        tokenBudget: number;
        contextData: Record<string, unknown>;
    }) => Promise<MCPToolResult>): void;
    /**
     * Auto-register all Commander tools as MCP tools.
     * Enables external MCP clients (Claude Desktop, Cursor, etc.) to use Commander's tool ecosystem.
     */
    registerCommanderTools(tools: Map<string, Tool>): void;
    /**
     * Register a resource that exposes tool execution results for monitoring.
     */
    registerExecutionResource(): void;
}
export {};
//# sourceMappingURL=server.d.ts.map