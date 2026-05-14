import type {
  MCPTransport,
  MCPClientConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPToolResult,
  MCPContentItem,
  MCPResourceContents,
  JSONRPCRequest,
  JSONRPCResponse,
  ListToolsResult,
  ListResourcesResult,
  ListPromptsResult,
  GetPromptResult,
  ReadResourceResult,
  MCPInitializeResult,
  MCPServerCapabilities,
} from './types';
import { MCP_ERROR_CODES } from './types';

function uuid(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================================
// Stdio Transport — spawn a subprocess and communicate via stdin/stdout
// ============================================================================

export class StdioClientTransport implements MCPTransport {
  private process: any = null;
  private config: MCPClientConfig;
  private pending = new Map<string | number, { resolve: (v: JSONRPCResponse) => void; reject: (e: Error) => void }>();
  private buf = '';
  private msgId = 0;

  constructor(config: MCPClientConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const { spawn } = await import('child_process');
    this.process = spawn(this.config.command!, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
    });

    this.process.stdout.on('data', (data: Buffer) => {
      this.buf += data.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as JSONRPCResponse;
          const id = parsed.id;
          if (id !== null && this.pending.has(id)) {
            const p = this.pending.get(id)!;
            p.resolve(parsed);
            this.pending.delete(id);
          }
        } catch { /* ignore parse errors */ }
      }
    });

    this.process.stderr.on('data', (_data: Buffer) => {
      // MCP servers log to stderr — ignore in production, log in debug
    });

    this.process.on('exit', () => {
      for (const [, p] of this.pending) {
        p.reject(new Error('MCP process exited'));
      }
      this.pending.clear();
    });
  }

  async send(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    return new Promise((resolve, reject) => {
      const id = request.id ?? ++this.msgId;
      const req = { ...request, id, jsonrpc: '2.0' as const };
      this.pending.set(id, { resolve, reject });
      this.process!.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  async close(): Promise<void> {
    this.process?.kill();
    this.process = null;
  }
}

// ============================================================================
// Streamable HTTP Transport — HTTP POST with SSE response
// ============================================================================

export class StreamableHTTPClientTransport implements MCPTransport {
  private url: string;
  private headers: Record<string, string>;
  private msgId = 0;

  constructor(config: MCPClientConfig) {
    this.url = config.url!;
    this.headers = { 'Content-Type': 'application/json', ...config.headers };
  }

  async start(): Promise<void> {
    // HTTP transport is stateless — no start needed
  }

  async send(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const id = request.id ?? ++this.msgId;
    const body = JSON.stringify({ ...request, id, jsonrpc: '2.0' });

    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body,
    });

    const text = await res.text();
    return JSON.parse(text) as JSONRPCResponse;
  }

  async close(): Promise<void> {
    // No persistent connection
  }
}

// ============================================================================
// MCP Client — High-level interface for calling MCP servers
// ============================================================================

export class MCPClient {
  private transport: MCPTransport;
  private initialized = false;
  private capabilities: MCPServerCapabilities = {};
  private serverInfo: { name: string; version: string } = { name: '', version: '' };
  private toolCache: MCPTool[] | null = null;
  private config: MCPClientConfig;

  constructor(config: MCPClientConfig) {
    this.config = config;
    this.transport = config.transport === 'stdio'
      ? new StdioClientTransport(config)
      : new StreamableHTTPClientTransport(config);
  }

  async connect(): Promise<void> {
    await this.transport.start();
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '0.1.0',
        capabilities: {},
        clientInfo: { name: 'telos-mcp-client', version: '1.0.0' },
      },
    });

    if (resp.error) throw new Error(`MCP init failed: ${resp.error.message}`);
    const result = resp.result as MCPInitializeResult;
    this.capabilities = result.capabilities;
    this.serverInfo = result.serverInfo;
    this.initialized = true;
  }

  async listTools(): Promise<MCPTool[]> {
    if (this.toolCache) return this.toolCache;
    if (!this.capabilities.tools) return [];

    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'tools/list',
    });

    if (resp.error) throw new Error(`listTools failed: ${resp.error.message}`);
    const result = resp.result as ListToolsResult;
    this.toolCache = result.tools;
    return result.tools;
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult> {
    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'tools/call',
      params: { name, arguments: args },
    });

    if (resp.error) {
      return { content: [{ type: 'text', text: `Error: ${resp.error.message}` }], isError: true };
    }

    return resp.result as MCPToolResult;
  }

  async listResources(): Promise<MCPResource[]> {
    if (!this.capabilities.resources) return [];

    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'resources/list',
    });

    if (resp.error) throw new Error(`listResources failed: ${resp.error.message}`);
    const result = resp.result as ListResourcesResult;
    return result.resources;
  }

  async readResource(uri: string): Promise<MCPResourceContents[]> {
    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'resources/read',
      params: { uri },
    });

    if (resp.error) throw new Error(`readResource failed: ${resp.error.message}`);
    const result = resp.result as ReadResourceResult;
    return result.contents;
  }

  async listPrompts(): Promise<MCPPrompt[]> {
    if (!this.capabilities.prompts) return [];

    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'prompts/list',
    });

    if (resp.error) throw new Error(`listPrompts failed: ${resp.error.message}`);
    const result = resp.result as ListPromptsResult;
    return result.prompts;
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'prompts/get',
      params: { name, arguments: args },
    });

    if (resp.error) throw new Error(`getPrompt failed: ${resp.error.message}`);
    return resp.result as GetPromptResult;
  }

  invalidateCache(): void {
    this.toolCache = null;
  }

  getServerInfo(): { name: string; version: string } {
    return { ...this.serverInfo };
  }

  getCapabilities(): MCPServerCapabilities {
    return { ...this.capabilities };
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.initialized = false;
  }
}

export function createMCPClient(config: MCPClientConfig): MCPClient {
  return new MCPClient(config);
}
