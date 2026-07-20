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
import { MCP_ERROR_CODES, MCP_PROTOCOL_VERSION } from './types';

type ToolHandler = (args: Record<string, unknown>) => Promise<MCPToolResult | MCPContentItem[]>;
type ResourceReader = (uri: string) => Promise<MCPResourceContents[]>;
type PromptHandler = (args: Record<string, string>) => Promise<GetPromptResult>;

import type { Tool } from '../runtime/types';
import { getGuardianAgent, type GuardianAction } from '../security/guardianAgent';
import { getExecPolicyEngine } from '../sandbox/execPolicy';
import { reportSilentFailure } from '../silentFailureReporter';
import { createHash } from 'node:crypto';

/** Pure-local MCP tools that never require Action Gateway (read/router only). */
export const LOCAL_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(['list_models', 'route_task']);

export interface ActionGatewayProposeInput {
  source: string;
  package: string;
  model: string;
  tool: string;
  destination: string;
  effectType: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ActionGatewayProposeResult {
  action: Record<string, unknown>;
  idempotentReplay: boolean;
}

export class ActionGatewayPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ActionGatewayPolicyError';
  }
}

export interface ActionGatewayExecutor {
  proposeAction(input: ActionGatewayProposeInput): Promise<ActionGatewayProposeResult>;
}

export function buildMcpActionEnvelope(
  tool: Tool,
  args: Record<string, unknown>,
  model = process.env.COMMANDER_MCP_MODEL ?? 'mcp-default',
): ActionGatewayProposeInput {
  const toolName = tool.definition.name;
  let destination = tool.externalSystem
    ? `${tool.externalSystem}://default`
    : `mcp://commander/${toolName}`;
  let effectType = `mcp.tool.${toolName}`;
  if (toolName === 'ticket.create') {
    effectType = 'demo.ticket.create';
    destination = args.requireApproval === true ? 'demo://tickets/approval' : 'demo://tickets';
  } else if (toolName === 'ticket.compensate') {
    effectType = 'compensate.demo.ticket.create';
    destination = 'demo://tickets';
  }
  const idempotencyKey = `mcp-${createHash('sha256')
    .update(JSON.stringify({ toolName, args }))
    .digest('hex')
    .slice(0, 32)}`;
  return {
    source: 'mcp',
    package: 'commander.mcp',
    model,
    tool: toolName,
    destination,
    effectType,
    args,
    idempotencyKey,
  };
}

export function createFetchActionGatewayExecutor(options: {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}): ActionGatewayExecutor {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('A fetch implementation is required for the Action Gateway executor');
  }
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  return {
    async proposeAction(input) {
      const headers = new Headers({
        accept: 'application/json',
        'content-type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      });
      if (options.apiKey) {
        headers.set('authorization', `Bearer ${options.apiKey}`);
      }
      const response = await fetchImpl(`${baseUrl}/v1/actions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      const body = await response.text();
      if (!response.ok) {
        let parsed: { error?: { code?: string; message?: string } } | null = null;
        try {
          parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
        } catch {
          parsed = null;
        }
        const code = parsed?.error?.code;
        if (
          response.status === 403 &&
          (code === 'ACTION_POLICY_DENIED' || code === 'KILL_SWITCH_ACTIVE')
        ) {
          throw new ActionGatewayPolicyError(
            code,
            parsed?.error?.message ?? 'Action Gateway policy denied the request.',
            (parsed ?? { raw: body }) as Record<string, unknown>,
          );
        }
        throw new Error(`Action Gateway request failed (${response.status}): ${body}`);
      }
      const json = JSON.parse(body) as {
        action: Record<string, unknown>;
        idempotentReplay: boolean;
      };
      return { action: json.action, idempotentReplay: json.idempotentReplay };
    },
  };
}

/** Non-local, non-read-only tools must go through Action Gateway (fail-closed). */
export function toolRequiresActionGateway(tool: Tool): boolean {
  if (LOCAL_MCP_TOOL_NAMES.has(tool.definition.name)) return false;
  return tool.isReadOnly !== true;
}

export function shouldRouteToolThroughActionGateway(
  tool: Tool,
  executor?: ActionGatewayExecutor,
): executor is ActionGatewayExecutor {
  return Boolean(executor) && toolRequiresActionGateway(tool);
}

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

/**
 * Tools too dangerous to expose to external MCP clients (Claude Desktop,
 * Cursor, etc.) by default. These give unsandboxed shell / file destructive
 * access and are filtered out in registerCommanderTools unless the caller
 * explicitly opts in via { allowDangerousTools: true }.
 */
const DANGEROUS_MCP_TOOLS: ReadonlySet<string> = new Set([
  'shell_execute',
  'file_delete',
  'file_write',
  'python_execute',
]);

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

  /** Return all registered tool definitions. */
  listTools(): MCPTool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  registerResource(resource: MCPResource, handler: ResourceReader): void {
    this.resources.set(resource.uri, { resource, handler });
  }

  registerPrompt(prompt: MCPPrompt, handler: PromptHandler): void {
    this.prompts.set(prompt.name, { prompt, handler });
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  getCapabilities(): MCPServerCapabilities {
    const caps: MCPServerCapabilities = {};
    if (this.tools.size > 0) caps.tools = {};
    if (this.resources.size > 0) caps.resources = {};
    if (this.prompts.size > 0) caps.prompts = {};
    return caps;
  }

  /** Return current server status for health/observability endpoints. */
  getStatus(): {
    initialized: boolean;
    name: string;
    version: string;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    capabilities: MCPServerCapabilities;
  } {
    return {
      initialized: this.initialized,
      name: this.serverName,
      version: this.serverVersion,
      toolCount: this.tools.size,
      resourceCount: this.resources.size,
      promptCount: this.prompts.size,
      capabilities: this.getCapabilities(),
    };
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
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: this.getCapabilities(),
            serverInfo: { name: this.serverName, version: this.serverVersion },
          } satisfies MCPInitializeResult,
        };

      case 'tools/list': {
        const p = params as { cursor?: string; limit?: number } | undefined;
        const allTools = Array.from(this.tools.values()).map((t) => t.definition);
        const limit = p?.limit && p.limit > 0 ? p.limit : allTools.length;
        const startIdx = p?.cursor ? parseInt(p.cursor, 10) : 0;
        const page = allTools.slice(startIdx, startIdx + limit);
        const nextCursor =
          startIdx + limit < allTools.length ? String(startIdx + limit) : undefined;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: page,
            nextCursor,
          } satisfies ListToolsResult,
        };
      }

      case 'tools/call': {
        const p = params as { name: string; arguments?: Record<string, unknown> };
        if (!p || typeof p.name !== 'string' || !p.name) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCP_ERROR_CODES.INVALID_PARAMS,
              message: 'Missing or invalid "name" parameter for tools/call',
            },
          };
        }
        const reg = this.tools.get(p.name);
        if (!reg) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Tool not found: ${p.name}` },
          };
        }
        const toolArgs = p.arguments ?? {};
        // ── Security gate ──────────────────────────────────────────────────
        // External MCP clients must not bypass GuardianAgent / ExecPolicyEngine.
        // Every tools/call is monitored before execution. Fail-closed on internal
        // errors so a broken security hook cannot silently bypass the gate.
        try {
          const guardianAgent = getGuardianAgent();
          const action: GuardianAction = {
            agentId: 'mcp-external-client',
            timestamp: Date.now(),
            type: 'tool_call',
            content: `${p.name}(${JSON.stringify(toolArgs)})`,
            metadata: { toolName: p.name, args: toolArgs },
          };
          const intervention = guardianAgent.monitor(action);
          if (intervention) {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: MCP_ERROR_CODES.INTERNAL_ERROR,
                message: `Tool "${p.name}" blocked by GuardianAgent (${intervention})`,
              },
            };
          }

          // ExecPolicy: evaluate shell/python payloads for forbidden commands.
          if (p.name === 'shell_execute' || p.name === 'python_execute') {
            const execPolicyEngine = getExecPolicyEngine();
            const payload =
              typeof toolArgs.command === 'string'
                ? toolArgs.command
                : typeof toolArgs.code === 'string'
                  ? toolArgs.code
                  : '';
            if (payload) {
              const policyResult = execPolicyEngine.evaluate(payload);
              if (policyResult.decision === 'forbidden') {
                return {
                  jsonrpc: '2.0',
                  id,
                  error: {
                    code: MCP_ERROR_CODES.INTERNAL_ERROR,
                    message: `Tool "${p.name}" blocked by ExecPolicyEngine (${policyResult.rule?.id ?? 'forbidden'}): ${policyResult.rule?.justification ?? 'forbidden command'}`,
                  },
                };
              }
            }
          }
        } catch (err) {
          reportSilentFailure(err, 'mcpServer:tools/call:securityGate');
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCP_ERROR_CODES.INTERNAL_ERROR,
              message: `Tool "${p.name}" rejected: security gate unavailable`,
            },
          };
        }
        const MCP_TOOL_TIMEOUT_MS = 60000;
        const result = await this.withTimeout(
          reg.handler(toolArgs),
          MCP_TOOL_TIMEOUT_MS,
          'Tool execution',
        );
        if (Array.isArray(result)) {
          return { jsonrpc: '2.0', id, result: { content: result } satisfies MCPToolResult };
        }
        return { jsonrpc: '2.0', id, result };
      }

      case 'resources/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: Array.from(this.resources.values()).map((r) => r.resource),
          } satisfies ListResourcesResult,
        };

      case 'resources/read': {
        const rp = params as { uri: string };
        if (!rp || typeof rp.uri !== 'string' || !rp.uri) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCP_ERROR_CODES.INVALID_PARAMS,
              message: 'Missing or invalid "uri" parameter for resources/read',
            },
          };
        }
        const rreg = this.resources.get(rp.uri);
        if (!rreg) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
              message: `Resource not found: ${rp.uri}`,
            },
          };
        }
        const contents = await rreg.handler(rp.uri);
        return { jsonrpc: '2.0', id, result: { contents } satisfies ReadResourceResult };
      }

      case 'prompts/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            prompts: Array.from(this.prompts.values()).map((p) => p.prompt),
          } satisfies ListPromptsResult,
        };

      case 'prompts/get': {
        const pp = params as { name: string; arguments?: Record<string, string> };
        if (!pp || typeof pp.name !== 'string' || !pp.name) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCP_ERROR_CODES.INVALID_PARAMS,
              message: 'Missing or invalid "name" parameter for prompts/get',
            },
          };
        }
        const preg = this.prompts.get(pp.name);
        if (!preg) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
              message: `Prompt not found: ${pp.name}`,
            },
          };
        }
        return { jsonrpc: '2.0', id, result: await preg.handler(pp.arguments ?? {}) };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Unknown method: ${method}` },
        };
    }
  }

  /**
   * Convert TELOS ToolDefinition to MCP tool schema.
   */
  static toolFromDefinition(def: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }): MCPTool {
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
  registerAgentExecutor(handler: ToolHandler): void {
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
            availableTools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Available tool names',
            },
            maxSteps: { type: 'number', description: 'Maximum execution steps' },
            tokenBudget: { type: 'number', description: 'Token budget' },
            contextData: { type: 'object', description: 'Additional context' },
          },
          required: ['agentId', 'projectId', 'goal'],
        },
      },
      handler,
    );
  }

  /**
   * Auto-register all Commander tools as MCP tools.
   * Enables external MCP clients (Claude Desktop, Cursor, etc.) to use Commander's tool ecosystem.
   *
   * @param tools - All registered Commander tools
   * @param filter - Optional filter to restrict which tools are exposed to MCP clients.
   *   Use this to prevent exposing destructive tools (shell_execute, git, etc.) to untrusted clients.
   */
  registerCommanderTools(
    tools: Map<string, Tool>,
    filter?: (name: string, tool: Tool) => boolean,
    options?: { allowDangerousTools?: boolean; actionGatewayExecutor?: ActionGatewayExecutor },
  ): void {
    const allowDangerous = options?.allowDangerousTools === true;
    const actionGatewayExecutor = options?.actionGatewayExecutor;
    for (const [name, tool] of tools) {
      // Default security filter: never expose destructive tools to external
      // MCP clients unless the caller explicitly opts in via allowDangerousTools.
      if (!allowDangerous && DANGEROUS_MCP_TOOLS.has(name)) continue;
      if (filter && !filter(name, tool)) continue;
      const def = tool.definition;
      this.registerTool(
        {
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema as unknown as MCPJsonSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            if (toolRequiresActionGateway(tool)) {
              if (!actionGatewayExecutor) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text:
                        `Error executing ${name}: ACTION_GATEWAY_REQUIRED — ` +
                        'non-read-only MCP tools cannot execute locally; ' +
                        'configure COMMANDER_ACTION_GATEWAY_URL and propose via /v1/actions.',
                    },
                  ] as MCPTextContent[],
                };
              }
              const envelope = buildMcpActionEnvelope(tool, args);
              const result = await actionGatewayExecutor.proposeAction(envelope);
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(
                      {
                        action: result.action,
                        idempotentReplay: result.idempotentReplay,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              } satisfies MCPToolResult;
            }
            const result = await tool.execute(args);
            // Return as text content for MCP compatibility
            return {
              content: [{ type: 'text' as const, text: result }],
            } satisfies MCPToolResult;
          } catch (err) {
            if (err instanceof ActionGatewayPolicyError) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Action Gateway policy denied (${err.code}): ${err.message}`,
                  },
                ] as MCPTextContent[],
              };
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`,
                },
              ] as MCPTextContent[],
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

        return [
          {
            uri,
            mimeType: format === 'text' ? 'text/plain' : 'application/json',
            text: JSON.stringify({ runId, status: 'trace_available', data: [] }),
          },
        ];
      },
    );
  }
}
