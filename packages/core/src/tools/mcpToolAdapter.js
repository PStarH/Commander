"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPIntegrationManager = exports.MCPToolAdapter = void 0;
exports.readMCPConfig = readMCPConfig;
exports.readA2ADiscoveryConfig = readA2ADiscoveryConfig;
const client_1 = require("../mcp/client");
const toolRegistry_1 = require("./toolRegistry");
const logging_1 = require("../logging");
// ============================================================================
// MCPToolAdapter — wraps an MCP tool as a Commander Tool
// ============================================================================
class MCPToolAdapter {
    constructor(client, mcpTool, serverLabel) {
        this.isConcurrencySafe = true;
        this.isReadOnly = false;
        this.timeout = 300000; // 5min default for external tools
        this.maxOutputSize = 100000;
        this.client = client;
        this.mcpToolName = mcpTool.name;
        this.serverLabel = serverLabel;
        const name = `mcp_${serverLabel}_${mcpTool.name}`;
        this.definition = {
            name,
            description: `[MCP:${serverLabel}] ${mcpTool.description}`,
            inputSchema: mcpTool.inputSchema,
            category: 'mcp',
        };
    }
    async execute(args) {
        const logger = (0, logging_1.getGlobalLogger)();
        logger.info('MCPToolAdapter', `Calling MCP tool ${this.serverLabel}/${this.mcpToolName}`);
        try {
            const result = await this.client.callTool(this.mcpToolName, args);
            if (result.isError) {
                const errText = result.content
                    .map((c) => {
                    if (c.type === 'text')
                        return c.text;
                    if (c.type === 'resource')
                        return `[Resource: ${c.resource.uri}]`;
                    return '[Image]';
                })
                    .join('\n');
                return `error: MCP tool "${this.serverLabel}/${this.mcpToolName}" returned an error:\n${errText}`;
            }
            return result.content
                .map((c) => {
                var _a;
                if (c.type === 'text')
                    return c.text;
                if (c.type === 'resource')
                    return `[Resource: ${c.resource.uri}]\n${(_a = c.resource.text) !== null && _a !== void 0 ? _a : ''}`;
                if (c.type === 'image')
                    return `[Image: ${c.mimeType} (${c.data.length} bytes base64)]`;
                return '';
            })
                .join('\n');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('MCPToolAdapter', `MCP tool ${this.serverLabel}/${this.mcpToolName} failed`, new Error(msg));
            return `error: MCP tool "${this.serverLabel}/${this.mcpToolName}" execution failed: ${msg}`;
        }
    }
}
exports.MCPToolAdapter = MCPToolAdapter;
class MCPIntegrationManager {
    constructor() {
        this.adapters = [];
        this.clients = [];
        this.connected = false;
    }
    /**
     * Connect to all configured MCP servers and discover their tools.
     * Call this once at startup.
     */
    async connect(configs) {
        const logger = (0, logging_1.getGlobalLogger)();
        for (const cfg of configs) {
            try {
                const mcpConfig = {
                    transport: cfg.transport,
                    command: cfg.command,
                    args: cfg.args,
                    url: cfg.url,
                    headers: cfg.headers,
                    env: cfg.env,
                };
                const client = (0, client_1.createMCPClient)(mcpConfig);
                await client.connect();
                this.clients.push(client);
                const tools = await client.listTools();
                for (const mcpTool of tools) {
                    const adapter = new MCPToolAdapter(client, mcpTool, cfg.label);
                    this.adapters.push(adapter);
                    // Auto-register in ToolRegistry so schema validation works
                    toolRegistry_1.ToolRegistry.register(adapter, 'mcp');
                }
                logger.info('MCPIntegration', `Connected to MCP server "${cfg.label}" — discovered ${tools.length} tools`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error('MCPIntegration', `Failed to connect to MCP server "${cfg.label}"`, new Error(msg));
                // Don't crash — other servers may still connect
            }
        }
        this.connected = true;
    }
    /**
     * Get all discovered MCP tools as Commander Tool instances.
     */
    getTools() {
        return [...this.adapters];
    }
    /**
     * Register all MCP tools into a Commander AgentRuntime.
     * Call this after runtime.registerTool() for built-in tools.
     */
    registerIntoRuntime(runtime) {
        for (const adapter of this.adapters) {
            runtime.registerTool(adapter.definition.name, adapter);
        }
    }
    /**
     * Disconnect from all MCP servers.
     */
    async disconnect() {
        for (const client of this.clients) {
            try {
                await client.disconnect();
            }
            catch {
                /* ignore disconnect errors */
            }
        }
        this.clients = [];
        this.adapters = [];
        this.connected = false;
    }
    isConnected() {
        return this.connected;
    }
    getToolCount() {
        return this.adapters.length;
    }
    getServerCount() {
        return this.clients.length;
    }
}
exports.MCPIntegrationManager = MCPIntegrationManager;
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
function readMCPConfig(configFile) {
    // 1. Try environment variable
    const envJson = process.env.COMMANDER_MCP_SERVERS;
    if (envJson) {
        try {
            const parsed = JSON.parse(envJson);
            if (Array.isArray(parsed))
                return parsed;
        }
        catch {
            (0, logging_1.getGlobalLogger)().warn('MCPConfig', 'Failed to parse COMMANDER_MCP_SERVERS env var');
        }
    }
    // 2. Try config file
    if ((configFile === null || configFile === void 0 ? void 0 : configFile.mcpServers) && Array.isArray(configFile.mcpServers)) {
        return configFile.mcpServers;
    }
    return [];
}
/**
 * Read A2A agent discovery config from environment or config file.
 */
function readA2ADiscoveryConfig(configFile) {
    const envJson = process.env.COMMANDER_A2A_AGENTS;
    if (envJson) {
        try {
            const parsed = JSON.parse(envJson);
            if (Array.isArray(parsed))
                return parsed;
        }
        catch {
            (0, logging_1.getGlobalLogger)().warn('A2AConfig', 'Failed to parse COMMANDER_A2A_AGENTS env var');
        }
    }
    if ((configFile === null || configFile === void 0 ? void 0 : configFile.a2aAgents) && Array.isArray(configFile.a2aAgents)) {
        return configFile.a2aAgents;
    }
    return [];
}
