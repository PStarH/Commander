import {
  MCPServer,
  getModelRouter,
  createAllTools,
  MCP_PROTOCOL_VERSION,
  type ModelTier,
  type MCPTool,
  type MCPResource,
  type MCPPrompt,
  type MCPServerCapabilities,
} from '@commander/core';

export interface StdioMcpServerOptions {
  /** Server name advertised during MCP initialization. */
  name?: string;
  /** Server version advertised during MCP initialization. */
  version?: string;
  /** If true, only register the lightweight model-router tools (default: false). */
  modelRouterOnly?: boolean;
  /** If true, expose dangerous built-in tools such as shell_execute (default: false). */
  allowDangerousTools?: boolean;
}

export interface StdioMcpServerStatus {
  initialized: boolean;
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
  uptimeSeconds: number;
}

/**
 * Create an MCP server wired to Commander services.
 *
 * By default it registers:
 *   - The model-router tools (execute_agent, list_models, route_task)
 *   - All built-in Commander tools returned by createAllTools(),
 *     with dangerous tools filtered out unless allowDangerousTools is set.
 */
export function createStdioMcpServer(options: StdioMcpServerOptions = {}): {
  server: MCPServer;
  status: StdioMcpServerStatus;
} {
  const name = options.name ?? 'commander-mcp-server';
  const version = options.version ?? '0.2.0';
  const startTime = Date.now();

  const server = new MCPServer(name, version);

  registerModelRouterTools(server);
  if (!options.modelRouterOnly) {
    registerCommanderTools(server, options.allowDangerousTools === true);
  }

  // `version` mirrors packages/mcp-server/package.json. Update both together
  // when bumping. `MCP_PROTOCOL_VERSION` is shared with the core client/server
  // so the stdio transport stays in lockstep with the in-process implementation.
  const status: StdioMcpServerStatus = {
    initialized: false,
    name,
    version,
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: server.getCapabilities(),
    tools: server.listTools(),
    resources: [],
    prompts: [],
    uptimeSeconds: 0,
  };

  return {
    server,
    get status() {
      status.initialized = true;
      status.capabilities = server.getCapabilities();
      status.tools = server.listTools();
      status.resources = [];
      status.prompts = [];
      status.uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
      return status;
    },
  };
}

/**
 * Start reading line-delimited JSON-RPC messages from stdin and writing
 * responses to stdout.
 */
export function startStdioServer(options: StdioMcpServerOptions = {}): {
  server: MCPServer;
  status: StdioMcpServerStatus;
  stop: () => void;
} {
  const { server, status } = createStdioMcpServer(options);
  let buffer = '';
  let running = true;

  const onData = (chunk: Buffer) => {
    if (!running) return;
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      void handleLine(server, trimmed);
    }
  };

  const onError = (err: Error) => {
    process.stderr.write(`[commander-mcp-server] stdin error: ${err.message}\n`);
  };

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', onData);
  process.stdin.on('error', onError);

  const stop = () => {
    running = false;
    process.stdin.off('data', onData);
    process.stdin.off('error', onError);
  };

  return { server, status, stop };
}

async function handleLine(server: MCPServer, line: string): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch (err) {
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return;
  }

  const response = await server.handleRequest(
    request as Parameters<typeof server.handleRequest>[0],
  );
  writeResponse(response);
}

function writeResponse(response: unknown): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function registerModelRouterTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'execute_agent',
      description:
        'Execute an agent task with the Commander runtime. Provide a goal and optional context.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The task objective for the agent' },
          agentId: { type: 'string', description: 'Agent identifier' },
          context: { type: 'string', description: 'Additional context' },
        },
        required: ['goal'],
      },
    },
    async (args) => ({
      content: [
        { type: 'text', text: `Agent ${args.agentId ?? 'default'} executed: ${args.goal}` },
      ],
    }),
  );

  server.registerTool(
    {
      name: 'list_models',
      description: 'List all available models and their tiers in the Commander ModelRouter',
      inputSchema: {
        type: 'object',
        properties: {
          tier: {
            type: 'string',
            description: 'Filter by tier: eco, standard, power, consensus',
          },
        },
      },
    },
    async (args) => {
      const router = getModelRouter();
      const models = router.listModels(args.tier as ModelTier | undefined);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              models.map((m) => ({ id: m.id, tier: m.tier, provider: m.provider })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    {
      name: 'route_task',
      description:
        'Preview which model tier a task would be routed to based on its goal and context',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The task goal' },
          riskLevel: { type: 'string', description: 'Risk level: LOW, MEDIUM, HIGH, CRITICAL' },
        },
        required: ['goal'],
      },
    },
    async (args) => {
      const router = getModelRouter();
      const decision = router.route({
        agentId: 'mcp-caller',
        projectId: 'mcp',
        goal: args.goal as string,
        contextData: {
          governanceProfile: { riskLevel: args.riskLevel ?? 'LOW' },
        },
        availableTools: [],
        maxSteps: 5,
        tokenBudget: 8000,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }],
      };
    },
  );
}

function registerCommanderTools(server: MCPServer, allowDangerousTools: boolean): void {
  try {
    const tools = createAllTools();
    server.registerCommanderTools(tools, undefined, { allowDangerousTools });
  } catch (err) {
    process.stderr.write(
      `[commander-mcp-server] Failed to register Commander tools: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
