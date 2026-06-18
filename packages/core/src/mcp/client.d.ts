import type { MCPTransport, MCPClientConfig, MCPTool, MCPResource, MCPPrompt, MCPToolResult, MCPResourceContents, JSONRPCRequest, JSONRPCResponse, GetPromptResult, MCPServerCapabilities } from './types';
export declare class StdioClientTransport implements MCPTransport {
    private process;
    private config;
    private pending;
    private buf;
    private msgId;
    constructor(config: MCPClientConfig);
    start(): Promise<void>;
    send(request: JSONRPCRequest): Promise<JSONRPCResponse>;
    close(): Promise<void>;
    /**
     * GAP-16: Filter environment variables to avoid leaking secrets.
     * Only passes safe system variables. Secrets (API_KEY, TOKEN, SECRET, etc.) are excluded.
     */
    private filterEnvironment;
}
export declare class StreamableHTTPClientTransport implements MCPTransport {
    private url;
    private headers;
    private msgId;
    constructor(config: MCPClientConfig);
    start(): Promise<void>;
    send(request: JSONRPCRequest): Promise<JSONRPCResponse>;
    close(): Promise<void>;
}
export declare class MCPClient {
    private transport;
    private initialized;
    private capabilities;
    private serverInfo;
    private toolCache;
    private config;
    constructor(config: MCPClientConfig);
    connect(): Promise<void>;
    private initialize;
    listTools(): Promise<MCPTool[]>;
    callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult>;
    listResources(): Promise<MCPResource[]>;
    readResource(uri: string): Promise<MCPResourceContents[]>;
    listPrompts(): Promise<MCPPrompt[]>;
    getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult>;
    invalidateCache(): void;
    getServerInfo(): {
        name: string;
        version: string;
    };
    getCapabilities(): MCPServerCapabilities;
    disconnect(): Promise<void>;
}
export declare function createMCPClient(config: MCPClientConfig): MCPClient;
//# sourceMappingURL=client.d.ts.map