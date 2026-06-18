export interface JSONRPCRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: unknown;
}
export interface JSONRPCResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: JSONRPCError;
}
export interface JSONRPCError {
    code: number;
    message: string;
    data?: unknown;
}
export declare const MCP_ERROR_CODES: {
    readonly PARSE_ERROR: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
};
export interface MCPTool {
    name: string;
    description: string;
    inputSchema: MCPJsonSchema;
    outputSchema?: MCPJsonSchema;
}
export interface MCPResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}
export interface MCPResourceContents {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}
export interface MCPPrompt {
    name: string;
    description: string;
    arguments?: MCPPromptArgument[];
}
export interface MCPPromptArgument {
    name: string;
    description?: string;
    required?: boolean;
}
export interface MCPJsonSchema {
    type: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null';
    properties?: Record<string, MCPJsonSchema>;
    items?: MCPJsonSchema;
    required?: string[];
    description?: string;
    enum?: string[];
}
export type MCPContentItem = MCPTextContent | MCPImageContent | MCPResourceContent;
export interface MCPTextContent {
    type: 'text';
    text: string;
}
export interface MCPImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}
export interface MCPResourceContent {
    type: 'resource';
    resource: MCPResourceContents;
}
export interface MCPToolResult {
    content: MCPContentItem[];
    isError?: boolean;
}
export interface MCPTransport {
    send(request: JSONRPCRequest): Promise<JSONRPCResponse>;
    start(): Promise<void>;
    close(): Promise<void>;
}
export interface ListToolsRequest {
    method: 'tools/list';
    params?: {
        cursor?: string;
    };
}
export interface ListToolsResult {
    tools: MCPTool[];
    nextCursor?: string;
}
export interface CallToolRequest {
    method: 'tools/call';
    params: {
        name: string;
        arguments?: Record<string, unknown>;
        onbehalfOf?: string;
    };
}
export interface CallToolResult {
    content: MCPContentItem[];
    isError?: boolean;
}
export interface ListResourcesRequest {
    method: 'resources/list';
    params?: {
        cursor?: string;
    };
}
export interface ListResourcesResult {
    resources: MCPResource[];
    nextCursor?: string;
}
export interface ReadResourceRequest {
    method: 'resources/read';
    params: {
        uri: string;
    };
}
export interface ReadResourceResult {
    contents: MCPResourceContents[];
}
export interface ListPromptsRequest {
    method: 'prompts/list';
    params?: {
        cursor?: string;
    };
}
export interface ListPromptsResult {
    prompts: MCPPrompt[];
    nextCursor?: string;
}
export interface GetPromptRequest {
    method: 'prompts/get';
    params: {
        name: string;
        arguments?: Record<string, string>;
    };
}
export interface GetPromptResult {
    messages: Array<{
        role: 'user' | 'assistant';
        content: MCPContentItem;
    }>;
    description?: string;
}
export interface MCPServerCapabilities {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
}
export interface MCPInitializeResult {
    protocolVersion: string;
    capabilities: MCPServerCapabilities;
    serverInfo: {
        name: string;
        version: string;
    };
}
export type MCPTransportType = 'stdio' | 'streamable-http';
export interface MCPClientConfig {
    transport: MCPTransportType;
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
}
//# sourceMappingURL=types.d.ts.map