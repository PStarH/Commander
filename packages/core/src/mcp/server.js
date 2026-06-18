"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServer = void 0;
const types_1 = require("./types");
// ============================================================================
// MCP Server — handle JSON-RPC requests for tools, resources, prompts
// ============================================================================
class MCPServer {
    constructor(name, version = '1.0.0') {
        this.tools = new Map();
        this.resources = new Map();
        this.prompts = new Map();
        this.initialized = false;
        this.serverName = name;
        this.serverVersion = version;
    }
    registerTool(tool, handler) {
        this.tools.set(tool.name, { definition: tool, handler });
    }
    registerResource(resource, handler) {
        this.resources.set(resource.uri, { resource, handler });
    }
    registerPrompt(prompt, handler) {
        this.prompts.set(prompt.name, { prompt, handler });
    }
    getCapabilities() {
        const caps = {};
        if (this.tools.size > 0)
            caps.tools = {};
        if (this.resources.size > 0)
            caps.resources = {};
        if (this.prompts.size > 0)
            caps.prompts = {};
        return caps;
    }
    /**
     * Handle a single JSON-RPC request. Returns the response.
     * This is the main entry point for both HTTP and stdio transports.
     */
    async handleRequest(request) {
        var _a;
        try {
            return await this.dispatch(request);
        }
        catch (err) {
            return {
                jsonrpc: '2.0',
                id: (_a = request.id) !== null && _a !== void 0 ? _a : null,
                error: {
                    code: types_1.MCP_ERROR_CODES.INTERNAL_ERROR,
                    message: err instanceof Error ? err.message : 'Internal error',
                },
            };
        }
    }
    async dispatch(request) {
        var _a, _b;
        const { id, method, params } = request;
        switch (method) {
            case 'initialize':
                this.initialized = true;
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: '0.1.0',
                        capabilities: this.getCapabilities(),
                        serverInfo: { name: this.serverName, version: this.serverVersion },
                    },
                };
            case 'tools/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        tools: Array.from(this.tools.values()).map((t) => t.definition),
                    },
                };
            case 'tools/call': {
                const p = params;
                if (!p || typeof p.name !== 'string' || !p.name) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        error: {
                            code: types_1.MCP_ERROR_CODES.INVALID_PARAMS,
                            message: 'Missing or invalid "name" parameter for tools/call',
                        },
                    };
                }
                const reg = this.tools.get(p.name);
                if (!reg) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        error: { code: types_1.MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Tool not found: ${p.name}` },
                    };
                }
                const result = await reg.handler((_a = p.arguments) !== null && _a !== void 0 ? _a : {});
                if (Array.isArray(result)) {
                    return { jsonrpc: '2.0', id, result: { content: result } };
                }
                return { jsonrpc: '2.0', id, result };
            }
            case 'resources/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        resources: Array.from(this.resources.values()).map((r) => r.resource),
                    },
                };
            case 'resources/read': {
                const rp = params;
                if (!rp || typeof rp.uri !== 'string' || !rp.uri) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        error: {
                            code: types_1.MCP_ERROR_CODES.INVALID_PARAMS,
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
                            code: types_1.MCP_ERROR_CODES.METHOD_NOT_FOUND,
                            message: `Resource not found: ${rp.uri}`,
                        },
                    };
                }
                const contents = await rreg.handler(rp.uri);
                return { jsonrpc: '2.0', id, result: { contents } };
            }
            case 'prompts/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        prompts: Array.from(this.prompts.values()).map((p) => p.prompt),
                    },
                };
            case 'prompts/get': {
                const pp = params;
                if (!pp || typeof pp.name !== 'string' || !pp.name) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        error: {
                            code: types_1.MCP_ERROR_CODES.INVALID_PARAMS,
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
                            code: types_1.MCP_ERROR_CODES.METHOD_NOT_FOUND,
                            message: `Prompt not found: ${pp.name}`,
                        },
                    };
                }
                return { jsonrpc: '2.0', id, result: await preg.handler((_b = pp.arguments) !== null && _b !== void 0 ? _b : {}) };
            }
            default:
                return {
                    jsonrpc: '2.0',
                    id,
                    error: { code: types_1.MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Unknown method: ${method}` },
                };
        }
    }
    /**
     * Convert TELOS ToolDefinition to MCP tool schema.
     */
    static toolFromDefinition(def) {
        return {
            name: def.name,
            description: def.description,
            inputSchema: def.inputSchema,
        };
    }
    /**
     * Register the standard "run_agent" distributed execution tool on this server.
     * This is what MCPRemoteRuntime calls to execute agents remotely.
     */
    registerAgentExecutor(handler) {
        this.registerTool({
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
        }, handler);
    }
    /**
     * Auto-register all Commander tools as MCP tools.
     * Enables external MCP clients (Claude Desktop, Cursor, etc.) to use Commander's tool ecosystem.
     */
    registerCommanderTools(tools) {
        for (const [name, tool] of tools) {
            const def = tool.definition;
            this.registerTool({
                name: def.name,
                description: def.description,
                inputSchema: def.inputSchema,
            }, async (args) => {
                try {
                    const result = await tool.execute(args);
                    // Return as text content for MCP compatibility
                    return {
                        content: [{ type: 'text', text: result }],
                    };
                }
                catch (err) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`,
                            },
                        ],
                    };
                }
            });
        }
    }
    /**
     * Register a resource that exposes tool execution results for monitoring.
     */
    registerExecutionResource() {
        this.registerResource({
            uri: 'command://execution/trace',
            name: 'Execution Trace',
            description: 'Access execution traces from the Commander agent runtime',
            mimeType: 'application/json',
        }, async (uri) => {
            var _a;
            // Parse query params from URI
            const url = new URL(uri, 'http://localhost');
            const runId = url.searchParams.get('runId');
            const format = (_a = url.searchParams.get('format')) !== null && _a !== void 0 ? _a : 'json';
            return [
                {
                    uri,
                    mimeType: format === 'text' ? 'text/plain' : 'application/json',
                    text: JSON.stringify({ runId, status: 'trace_available', data: [] }),
                },
            ];
        });
    }
}
exports.MCPServer = MCPServer;
