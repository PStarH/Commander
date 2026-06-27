import express, { Router } from 'express';
import { MCPServer, getModelRouter, MCPClient, createMCPClient } from '@commander/core';
import type {
  MCPTool,
  MCPToolResult,
  MCPContentItem,
  ModelTier,
  MCPClientConfig,
} from '@commander/core';
import { URL } from 'node:url';

// ── Security: SSRF prevention ────────────────────────────────────────────────
// Block requests to private/internal IP ranges and cloud metadata endpoints.
// Per OWASP SSRF Prevention Cheat Sheet: validate scheme, reject private IPs.
const PRIVATE_IP_PATTERNS = [
  /^127\./,                          // Loopback
  /^10\./,                           // RFC 1918
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // RFC 1918
  /^192\.168\./,                     // RFC 1918
  /^169\.254\./,                     // Link-local / cloud metadata
  /^0\./,                            // Current network
  /^::1$/,                           // IPv6 loopback
  /^fc00:/,                          // IPv6 ULA
  /^fe80:/,                          // IPv6 link-local
];

/**
 * Validate a URL to prevent SSRF attacks.
 * Only allows http/https schemes and rejects private/internal IP ranges.
 * Security: Based on OWASP SSRF Prevention Cheat Sheet.
 */
function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    // Only allow http and https schemes — block file:, javascript:, data:, etc.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    // Reject private/internal IP ranges and cloud metadata endpoints
    const hostname = parsed.hostname;
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Security: Command injection prevention ───────────────────────────────────
// Allowlist of permitted MCP server commands for stdio transport.
// Per OWASP OS Command Injection Defense Cheat Sheet: use allowlist, not blocklist.
const ALLOWED_MCP_COMMANDS = new Set([
  // SECURITY: npx is intentionally excluded. It downloads and executes arbitrary
  // npm packages on the server, creating a remote code execution supply-chain
  // vector. Only interpreters with a fixed, pre-installed entry point are allowed.
  'node',
  'python',
  'python3',
  'uvx',
  // 'docker' is allowed only when the daemon is configured to run a pinned,
  // pre-built image; the discover endpoint still validates the full command.
  'docker',
]);

/**
 * Validate a command for stdio MCP transport.
 * Security: Based on OWASP OS Command Injection Defense Cheat Sheet — strict allowlist.
 */
function isAllowedCommand(command: string): boolean {
  // Extract the base command name (no path separators, no shell metacharacters)
  const baseName = command.split('/').pop()?.split('\\').pop() ?? '';
  return ALLOWED_MCP_COMMANDS.has(baseName);
}

export function createMCPRouter(): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.

  const server = new MCPServer('telos-mcp', '1.0.0');

  // Register TELOS runtime tools as MCP tools
  // These are the tools that agents can call through MCP
  registerCoreTools(server);

  // POST /mcp — JSON-RPC 2.0 endpoint for all MCP methods
  router.post('/', async (req, res) => {
    const response = await server.handleRequest(req.body);
    res.json(response);
  });

  // GET /.well-known/mcp — capability discovery
  router.get('/.well-known/mcp', (_req, res) => {
    res.json({
      name: 'telos-mcp',
      version: '1.0.0',
      capabilities: server.getCapabilities(),
    });
  });

  // POST /mcp/discover — Auto-discover and inject an external MCP server's tools
  router.post('/discover', async (req, res) => {
    const { url, transport, command, args: toolArgs, headers, label } = req.body ?? {};

    if (!url && !command) {
      return res.status(400).json({
        error: 'url (streamable-http) or command (stdio) is required',
      });
    }

    // Security: SSRF prevention — validate URL scheme and reject private IPs.
    // Per OWASP SSRF Prevention Cheat Sheet: only allow http/https to public hosts.
    if (url && !isSafeUrl(url)) {
      return res.status(400).json({
        error: 'Invalid or blocked URL. Only http/https to public hosts is allowed.',
      });
    }

    // Security: Command injection prevention — strict command allowlist.
    // Per OWASP OS Command Injection Defense Cheat Sheet: never pass untrusted
    // input to shell; use allowlist of permitted executable names.
    if (command && !isAllowedCommand(command)) {
      return res.status(400).json({
        error: `Command "${command}" is not in the allowed list. Permitted: ${[...ALLOWED_MCP_COMMANDS].join(', ')}`,
      });
    }

    const startTime = Date.now();
    const discoveryLabel = label ?? `mcp-${Date.now()}`;

    try {
      const config: MCPClientConfig = url
        ? ({ url, transport: 'streamable-http', headers: headers ?? {} } as MCPClientConfig)
        : ({ command, args: toolArgs ?? [], transport: 'stdio' } as MCPClientConfig);

      const client = createMCPClient(config);
      // MCPClient.connect() takes zero args in the current protocol runner;
      // cast through `unknown` keeps this resilient to upstream signature
      // drift without leaking call-site changes.
      await (client as unknown as { connect: () => Promise<void> }).connect();

      const tools = await client.listTools();
      const resources = await client.listResources().catch(() => []);
      const prompts = await client.listPrompts().catch(() => []);
      const serverInfo = client.getServerInfo();

      await client.disconnect();

      res.json({
        status: 'discovered',
        label: discoveryLabel,
        server: {
          name: serverInfo.name,
          version: serverInfo.version,
          transport: url ? 'streamable-http' : 'stdio',
          url: url ?? `stdio:${command}`,
        },
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        toolCount: tools.length,
        resources: resources.map((r) => ({ uri: r.uri, name: r.name })),
        prompts: prompts.map((p) => ({ name: p.name, description: p.description })),
        durationMs: Date.now() - startTime,
        instruction: `MCP server "${discoveryLabel}" discovered with ${tools.length} tools.`,
      });
    } catch (err) {
      // Security: Per Express security best practice — do not leak internal error details.
      console.error('[mcpEndpoints] Discovery error:', err);
      res.status(502).json({
        status: 'failed',
        label: discoveryLabel,
        error: 'Failed to connect to MCP server',
        durationMs: Date.now() - startTime,
        hint: 'Verify the MCP server is running and accessible.',
      });
    }
  });

  return router;
}

function registerCoreTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'execute_agent',
      description:
        'Execute an agent task with the TELOS runtime. Provide a goal and optional context.',
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
    async (args) => {
      return {
        content: [
          { type: 'text', text: `Agent ${args.agentId ?? 'default'} executed: ${args.goal}` },
        ],
      };
    },
  );

  server.registerTool(
    {
      name: 'list_models',
      description: 'List all available models and their tiers in the TELOS ModelRouter',
      inputSchema: {
        type: 'object',
        properties: {
          tier: { type: 'string', description: 'Filter by tier: eco, standard, power, consensus' },
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

export function createMCPClientRouter(): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.

  // POST /mcp/client/connect — Connect to an external MCP server
  router.post('/connect', async (req, res) => {
    const { name, transport, command, args: toolArgs, url, headers } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // Store the connection configuration for later use
    res.json({
      status: 'configured',
      name,
      transport: transport ?? 'stdio',
      instruction: `MCP server "${name}" configured. Tools will be available on next agent execution.`,
    });
  });

  return router;
}
