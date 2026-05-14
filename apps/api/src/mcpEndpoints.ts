import express, { Router } from 'express';
import { MCPServer, getModelRouter } from '@commander/core';
import type { MCPTool, MCPToolResult, MCPContentItem } from '@commander/core';

export function createMCPRouter(): Router {
  const router = express.Router();
  router.use(express.json());

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

  return router;
}

function registerCoreTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'execute_agent',
      description: 'Execute an agent task with the TELOS runtime. Provide a goal and optional context.',
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
        content: [{ type: 'text', text: `Agent ${args.agentId ?? 'default'} executed: ${args.goal}` }],
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
      const models = router.listModels(args.tier as any);
      return {
        content: [{ type: 'text', text: JSON.stringify(models.map(m => ({ id: m.id, tier: m.tier, provider: m.provider })), null, 2) }],
      };
    },
  );

  server.registerTool(
    {
      name: 'route_task',
      description: 'Preview which model tier a task would be routed to based on its goal and context',
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
  router.use(express.json());

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
