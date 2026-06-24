/**
 * MCPToolAdapter — Wrap remote MCP tools as Commander Tool interface.
 *
 * This bridge enables Commander agents to discover and call tools exposed
 * by any MCP-compatible server (Claude Desktop, Cursor, custom MCP servers).
 *
 * Flow:
 *   Agent LLM → Commander ToolRegistry → MCPToolAdapter → MCPClient → MCP Server
 *
 * Usage in agentLoop.ts:
 *   const mcpManager = new MCPIntegrationManager();
 *   await mcpManager.connect(configs);
 *   for (const tool of mcpManager.getTools()) {
 *     runtime.registerTool(tool.definition.name, tool);
 *   }
 */
import type { Tool, ToolDefinition } from '../runtime/types';
import { MCPClient, createMCPClient } from '../mcp/client';
import type { MCPClientConfig, MCPTool, MCPToolResult } from '../mcp/types';
import { ToolRegistry } from './toolRegistry';
import { getGlobalLogger } from '../logging';

// ============================================================================
// MCPToolAdapter — wraps an MCP tool as a Commander Tool
// ============================================================================

export class MCPToolAdapter implements Tool {
  readonly definition: ToolDefinition;
  readonly isConcurrencySafe = true;
  readonly isReadOnly = false;
  readonly timeout = 300000; // 5min default for external tools
  readonly maxOutputSize = 100000;

  private client: MCPClient;
  private mcpToolName: string;
  private serverLabel: string;

  constructor(client: MCPClient, mcpTool: MCPTool, serverLabel: string) {
    this.client = client;
    this.mcpToolName = mcpTool.name;
    this.serverLabel = serverLabel;

    const name = `mcp_${serverLabel}_${mcpTool.name}`;
    this.definition = {
      name,
      description: `[MCP:${serverLabel}] ${mcpTool.description}`,
      inputSchema: mcpTool.inputSchema as unknown as Record<string, unknown>,
      category: 'mcp',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const logger = getGlobalLogger();
    logger.info('MCPToolAdapter', `Calling MCP tool ${this.serverLabel}/${this.mcpToolName}`);

    try {
      const result: MCPToolResult = await this.client.callTool(this.mcpToolName, args);

      if (result.isError) {
        const errText = result.content
          .map((c) => {
            if (c.type === 'text') return c.text;
            if (c.type === 'resource') return `[Resource: ${c.resource.uri}]`;
            return '[Image]';
          })
          .join('\n');
        return `error: MCP tool "${this.serverLabel}/${this.mcpToolName}" returned an error:\n${errText}`;
      }

      return result.content
        .map((c) => {
          if (c.type === 'text') return c.text;
          if (c.type === 'resource')
            return `[Resource: ${c.resource.uri}]\n${c.resource.text ?? ''}`;
          if (c.type === 'image') return `[Image: ${c.mimeType} (${c.data.length} bytes base64)]`;
          return '';
        })
        .join('\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        'MCPToolAdapter',
        `MCP tool ${this.serverLabel}/${this.mcpToolName} failed`,
        new Error(msg),
      );
      return `error: MCP tool "${this.serverLabel}/${this.mcpToolName}" execution failed: ${msg}`;
    }
  }
}

// ============================================================================
// MCPIntegrationManager — connects to MCP servers and provides Commander Tools
// ============================================================================

export interface MCPIntegrationConfig {
  servers: MCPIntegrationServerConfig[];
}

export interface MCPIntegrationServerConfig {
  /** Label used in tool name prefix: mcp_{label}_{toolName} */
  label: string;
  /** MCP transport type */
  transport: 'stdio' | 'streamable-http';
  /** For stdio: command to spawn */
  command?: string;
  /** For stdio: command arguments */
  args?: string[];
  /** For HTTP: server URL */
  url?: string;
  /** HTTP headers */
  headers?: Record<string, string>;
  /** Environment variables for stdio subprocess */
  env?: Record<string, string>;
  /** Auto-reconnect on disconnect? */
  autoReconnect?: boolean;
}

export class MCPIntegrationManager {
  private adapters: MCPToolAdapter[] = [];
  private clients: MCPClient[] = [];
  private connected = false;

  /**
   * Connect to all configured MCP servers and discover their tools.
   * Call this once at startup.
   */
  async connect(configs: MCPIntegrationServerConfig[]): Promise<void> {
    const logger = getGlobalLogger();

    for (const cfg of configs) {
      try {
        const mcpConfig: MCPClientConfig = {
          transport: cfg.transport,
          command: cfg.command,
          args: cfg.args,
          url: cfg.url,
          headers: cfg.headers,
          env: cfg.env,
        };

        const client = createMCPClient(mcpConfig);
        await client.connect();
        this.clients.push(client);

        const tools = await client.listTools();
        for (const mcpTool of tools) {
          const adapter = new MCPToolAdapter(client, mcpTool, cfg.label);
          this.adapters.push(adapter);
          // Auto-register in ToolRegistry so schema validation works
          ToolRegistry.register(adapter, 'mcp');
        }

        logger.info(
          'MCPIntegration',
          `Connected to MCP server "${cfg.label}" — discovered ${tools.length} tools`,
        );
        this.connected = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(
          'MCPIntegration',
          `Failed to connect to MCP server "${cfg.label}"`,
          new Error(msg),
        );
        // Don't crash — other servers may still connect
      }
    }
  }

  /**
   * Get all discovered MCP tools as Commander Tool instances.
   */
  getTools(): MCPToolAdapter[] {
    return [...this.adapters];
  }

  /**
   * Register all MCP tools into a Commander AgentRuntime.
   * Call this after runtime.registerTool() for built-in tools.
   */
  registerIntoRuntime(runtime: { registerTool: (name: string, tool: Tool) => void }): void {
    for (const adapter of this.adapters) {
      runtime.registerTool(adapter.definition.name, adapter);
    }
  }

  /**
   * Disconnect from all MCP servers.
   */
  async disconnect(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.disconnect();
      } catch (err) {
        console.warn('[Catch]', err);
        /* ignore disconnect errors */
      }
    }
    this.clients = [];
    this.adapters = [];
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getToolCount(): number {
    return this.adapters.length;
  }

  getServerCount(): number {
    return this.clients.length;
  }
}

// ============================================================================
// Config helper — read MCP server config from environment + config file
// ============================================================================

/**
 * Read MCP server configuration from COMMANDER_MCP_SERVERS env var (JSON array)
 * or from .commander.json's "mcpServers" field.
 *
 * Env var format:
 *   COMMANDER_MCP_SERVERS='[{"label":"filesystem","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/path"]}]'
 */
export function readMCPConfig(configFile?: {
  mcpServers?: MCPIntegrationServerConfig[];
}): MCPIntegrationServerConfig[] {
  // 1. Try environment variable
  const envJson = process.env.COMMANDER_MCP_SERVERS;
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson) as MCPIntegrationServerConfig[];
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      console.warn('[Catch]', err);
      getGlobalLogger().warn('MCPConfig', 'Failed to parse COMMANDER_MCP_SERVERS env var');
    }
  }

  // 2. Try config file
  if (configFile?.mcpServers && Array.isArray(configFile.mcpServers)) {
    return configFile.mcpServers;
  }

  return [];
}

/**
 * Read A2A agent discovery config from environment or config file.
 */
export function readA2ADiscoveryConfig(configFile?: { a2aAgents?: string[] }): string[] {
  const envJson = process.env.COMMANDER_A2A_AGENTS;
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson) as string[];
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      console.warn('[Catch]', err);
      getGlobalLogger().warn('A2AConfig', 'Failed to parse COMMANDER_A2A_AGENTS env var');
    }
  }

  if (configFile?.a2aAgents && Array.isArray(configFile.a2aAgents)) {
    return configFile.a2aAgents;
  }

  return [];
}
