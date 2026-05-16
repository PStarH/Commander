import type {
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPContentItem,
  MCPTextContent,
  MCPToolResult,
  MCPResourceContents,
  MCPJsonSchema,
  JSONRPCRequest,
  JSONRPCResponse,
  MCPServerCapabilities,
  MCPInitializeResult,
  ListToolsResult,
  ListResourcesResult,
  ListPromptsResult,
  ReadResourceResult,
  GetPromptResult,
} from './types';
import { MCP_ERROR_CODES } from './types';

type ToolHandler = (args: Record<string, unknown>) => Promise<MCPToolResult | MCPContentItem[]>;
type ResourceReader = (uri: string) => Promise<MCPResourceContents[]>;
type PromptHandler = (args: Record<string, string>) => Promise<GetPromptResult>;

import type { Tool, ToolDefinition } from '../runtime/types';

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

// ============================================================================
// MCP Server — handle JSON-RPC requests for tools, resources, prompts
// ============================================================================

export class MCPServer {
  private tools: Map<string, MCPToolRegistration> = new Map();
  private resources: Map<string, MCPResourceRegistration> = new Map();
  private prompts: Map<string, MCPPromptRegistration> = new Map();
  private serverName: string;
  private serverVersion: string;
  private initialized = false;

  constructor(name: string, version = '1.0.0') {
    this.serverName = name;
    this.serverVersion = version;
  }

  registerTool(tool: MCPTool, handler: ToolHandler): void {
    this.tools.set(tool.name, { definition: tool, handler });
  }

  registerResource(resource: MCPResource, handler: ResourceReader): void {
    this.resources.set(resource.uri, { resource, handler });
  }

  registerPrompt(prompt: MCPPrompt, handler: PromptHandler): void {
    this.prompts.set(prompt.name, { prompt, handler });
  }

  getCapabilities(): MCPServerCapabilities {
    const caps: MCPServerCapabilities = {};
    if (this.tools.size > 0) caps.tools = {};
    if (this.resources.size > 0) caps.resources = {};
    if (this.prompts.size > 0) caps.prompts = {};
    return caps;
  }

  /**
   * Handle a single JSON-RPC request. Returns the response.
   * This is the main entry point for both HTTP and stdio transports.
   */
  async handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    try {
      return await this.dispatch(request);
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: MCP_ERROR_CODES.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : 'Internal error',
        },
      };
    }
  }

  private async dispatch(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const { id, method, params } = request;

    switch (method) {
      case 'initialize':
        this.initialized = true;
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '0.1.0',
            capabilities: this.getCapabilities(),
            serverInfo: { name: this.serverName, version: this.serverVersion },
          } satisfies MCPInitializeResult,
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0', id,
          result: {
            tools: Array.from(this.tools.values()).map(t => t.definition),
          } satisfies ListToolsResult,
        };

      case 'tools/call': {
        const p = params as { name: string; arguments?: Record<string, unknown> };
        const reg = this.tools.get(p.name);
        if (!reg) {
          return { jsonrpc: '2.0', id, error: { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Tool not found: ${p.name}` } };
        }
        const result = await reg.handler(p.arguments ?? {});
        if (Array.isArray(result)) {
          return { jsonrpc: '2.0', id, result: { content: result } satisfies MCPToolResult };
        }
        return { jsonrpc: '2.0', id, result };
      }

      case 'resources/list':
        return {
          jsonrpc: '2.0', id,
          result: {
            resources: Array.from(this.resources.values()).map(r => r.resource),
          } satisfies ListResourcesResult,
        };

      case 'resources/read': {
        const rp = params as { uri: string };
        const rreg = this.resources.get(rp.uri);
        if (!rreg) {
          return { jsonrpc: '2.0', id, error: { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Resource not found: ${rp.uri}` } };
        }
        const contents = await rreg.handler(rp.uri);
        return { jsonrpc: '2.0', id, result: { contents } satisfies ReadResourceResult };
      }

      case 'prompts/list':
        return {
          jsonrpc: '2.0', id,
          result: {
            prompts: Array.from(this.prompts.values()).map(p => p.prompt),
          } satisfies ListPromptsResult,
        };

      case 'prompts/get': {
        const pp = params as { name: string; arguments?: Record<string, string> };
        const preg = this.prompts.get(pp.name);
        if (!preg) {
          return { jsonrpc: '2.0', id, error: { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Prompt not found: ${pp.name}` } };
        }
        return { jsonrpc: '2.0', id, result: await preg.handler(pp.arguments ?? {}) };
      }

      default:
        return { jsonrpc: '2.0', id, error: { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Unknown method: ${method}` } };
    }
  }

  /**
   * Convert TELOS ToolDefinition to MCP tool schema.
   */
  static toolFromDefinition(def: { name: string; description: string; inputSchema: Record<string, unknown> }): MCPTool {
    return {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema as unknown as MCPJsonSchema,
    };
  }

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
   }) => Promise<MCPToolResult>): void {
     this.registerTool(
       {
         name: 'run_agent',
         description: 'Execute an agent task on this remote server and return results',
         inputSchema: {
           type: 'object',
           properties: {
             agentId: { type: 'string', description: 'Agent identifier' },
             projectId: { type: 'string', description: 'Project identifier' },
             goal: { type: 'string', description: 'Task goal/description' },
             availableTools: { type: 'array', items: { type: 'string' }, description: 'Available tool names' },
             maxSteps: { type: 'number', description: 'Maximum execution steps' },
             tokenBudget: { type: 'number', description: 'Token budget' },
             contextData: { type: 'object', description: 'Additional context' },
           },
           required: ['agentId', 'projectId', 'goal'],
         },
       },
       handler as unknown as ToolHandler,
     );
   }

   /**
    * Auto-register all Commander tools as MCP tools.
    * Enables external MCP clients (Claude Desktop, Cursor, etc.) to use Commander's tool ecosystem.
    */
  registerCommanderTools(tools: Map<string, Tool>): void {
    for (const [name, tool] of tools) {
      const def = tool.definition;
      this.registerTool(
        {
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema as unknown as MCPJsonSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const result = await tool.execute(args);
            // Return as text content for MCP compatibility
            return {
              content: [{ type: 'text' as const, text: result }],
            } satisfies MCPToolResult;
          } catch (err) {
            return {
              content: [{
                type: 'text' as const,
                text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`,
              }] as MCPTextContent[],
            };
          }
        },
      );
    }
  }

  /**
    * Register a resource that exposes tool execution results for monitoring.
    */
  registerExecutionResource(): void {
    this.registerResource(
      {
        uri: 'command://execution/trace',
        name: 'Execution Trace',
        description: 'Access execution traces from the Commander agent runtime',
        mimeType: 'application/json',
      },
      async (uri: string) => {
        // Parse query params from URI
        const url = new URL(uri, 'http://localhost');
        const runId = url.searchParams.get('runId');
        const format = url.searchParams.get('format') ?? 'json';

        return [{
          uri,
          mimeType: format === 'text' ? 'text/plain' : 'application/json',
          text: JSON.stringify({ runId, status: 'trace_available', data: [] }),
        }];
      },
    );
  }
}
