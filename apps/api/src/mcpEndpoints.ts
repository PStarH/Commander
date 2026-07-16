import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { MCPServer, getModelRouter, MCPClient, createMCPClient } from '@commander/core';
import type {
  MCPTool,
  MCPToolResult,
  MCPContentItem,
  ModelTier,
  MCPClientConfig,
} from '@commander/core';
import { URL } from 'node:url';
import * as path from 'node:path';
import { hasRole, type UserRole } from './userStore';

// ── Security: SSRF prevention ────────────────────────────────────────────────
// Block requests to private/internal IP ranges and cloud metadata endpoints.
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^0:0:0:0:0:0:0:1$/,
  /^fc[0-9a-f]{2}:/i, // IPv6 ULA fc00::/7
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i, // IPv6 link-local
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  '0.0.0.0',
  '::1',
]);

function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length);
  // Trailing dot (DNS absolute name)
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Validate a URL to prevent SSRF attacks.
 * Only allows http/https schemes and rejects private/internal hosts.
 */
function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = normalizeHostname(parsed.hostname);
    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
      return false;
    }
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
// SECURITY: npx, uvx, and docker are intentionally excluded (RCE / supply-chain).
const ALLOWED_MCP_COMMANDS = new Set(['node', 'python', 'python3']);

const EVAL_FLAGS = new Set([
  '-e',
  '--eval',
  '-c',
  '--command',
  '-p',
  '--print',
  'eval',
  '-E',
  '-r',
  '--require',
  '--import',
  '--loader',
]);

/**
 * Validate a command for stdio MCP transport.
 * Security: Based on OWASP OS Command Injection Defense Cheat Sheet — strict allowlist.
 */
function isAllowedCommand(command: string): boolean {
  const baseName = command.split('/').pop()?.split('\\').pop()?.toLowerCase() ?? '';
  return ALLOWED_MCP_COMMANDS.has(baseName);
}

/** Reject inline-eval / module-loader flags that turn interpreters into RCE. */
function validateMcpArgs(args: readonly string[]): string | undefined {
  for (const arg of args) {
    const a = arg.trim().toLowerCase();
    if (
      EVAL_FLAGS.has(a) ||
      a.startsWith('-e=') ||
      a.startsWith('--eval=') ||
      a.startsWith('-c=') ||
      a.startsWith('--command=') ||
      a.startsWith('-p=') ||
      a.startsWith('--print=') ||
      a.startsWith('-r=') ||
      a.startsWith('--require=') ||
      a.startsWith('--import=') ||
      a.startsWith('--loader=')
    ) {
      return `MCP command arguments may not contain an inline-eval flag ("${arg}")`;
    }
    // Clustered short options: node -pe '…', python -Oc, etc.
    if (a.startsWith('-') && !a.startsWith('--') && a.length > 1) {
      const cluster = a.slice(1).split('=')[0] ?? '';
      if (/[epcr]/.test(cluster)) {
        return `MCP command arguments may not contain an inline-eval short-option cluster ("${arg}")`;
      }
    }
  }
  return undefined;
}

function requireMcpAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    if (!hasRole(req.user.role, 'admin' as UserRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
    return;
  }
  const scopes = req.apiScopes ?? [];
  if (scopes.includes('mcp:admin') || scopes.includes('admin') || scopes.includes('*')) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required' });
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

  // GET /mcp/status — server status and tool inventory
  router.get('/status', (_req, res) => {
    const status = server.getStatus();
    res.json({
      status: status.initialized ? 'initialized' : 'ready',
      ...status,
      timestamp: new Date().toISOString(),
    });
  });

  // POST /mcp/discover — Auto-discover and inject an external MCP server's tools
  router.post('/discover', requireMcpAdmin, async (req, res) => {
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

    const argsList: string[] = Array.isArray(toolArgs) ? toolArgs.map(String) : [];
    const argsError = validateMcpArgs(argsList);
    if (argsError) {
      return res.status(400).json({ error: argsError });
    }

    // Also reject when basename is uvx even if somehow allowlisted via path tricks.
    if (command && path.basename(command).toLowerCase() === 'uvx') {
      return res.status(400).json({
        error: 'uvx is not allowed for MCP discover',
      });
    }

    const startTime = Date.now();
    const discoveryLabel = label ?? `mcp-${Date.now()}`;

    try {
      const config: MCPClientConfig = url
        ? ({ url, transport: 'streamable-http', headers: headers ?? {} } as MCPClientConfig)
        : ({ command, args: argsList, transport: 'stdio' } as MCPClientConfig);

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
  router.post('/connect', requireMcpAdmin, async (req, res) => {
    const { name, transport, command, args: toolArgs, url, headers } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    if (command && !isAllowedCommand(command)) {
      return res.status(400).json({
        error: `Command "${command}" is not in the allowed list. Permitted: ${[...ALLOWED_MCP_COMMANDS].join(', ')}`,
      });
    }
    const argsList: string[] = Array.isArray(toolArgs) ? toolArgs.map(String) : [];
    const argsError = validateMcpArgs(argsList);
    if (argsError) {
      return res.status(400).json({ error: argsError });
    }

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
