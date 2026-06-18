"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPClient = exports.StreamableHTTPClientTransport = exports.StdioClientTransport = void 0;
exports.createMCPClient = createMCPClient;
const logging_1 = require("../logging");
function uuid() {
    return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
// ============================================================================
// Stdio Transport — spawn a subprocess and communicate via stdin/stdout
// ============================================================================
class StdioClientTransport {
    constructor(config) {
        this.process = null;
        this.pending = new Map();
        this.buf = '';
        this.msgId = 0;
        this.config = config;
    }
    async start() {
        var _a;
        const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
        // GAP-16: Filter environment to avoid leaking secrets to MCP subprocess.
        // Only pass safe variables + explicitly configured env vars.
        const safeEnv = this.filterEnvironment();
        this.process = spawn(this.config.command, (_a = this.config.args) !== null && _a !== void 0 ? _a : [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...safeEnv, ...this.config.env },
        });
        const stdout = this.process.stdout;
        if (!stdout)
            return;
        stdout.on('data', (data) => {
            var _a;
            this.buf += data.toString();
            const lines = this.buf.split('\n');
            this.buf = (_a = lines.pop()) !== null && _a !== void 0 ? _a : '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const parsed = JSON.parse(line);
                    const id = parsed.id;
                    if (id !== null && this.pending.has(id)) {
                        const p = this.pending.get(id);
                        p.resolve(parsed);
                        this.pending.delete(id);
                    }
                }
                catch {
                    (0, logging_1.getGlobalLogger)().debug('MCPClient', 'Ignoring parse error in stdio response');
                }
            }
        });
        const stderr = this.process.stderr;
        if (!stderr)
            return;
        stderr.on('data', (_data) => {
            // MCP servers log to stderr — ignore in production, log in debug
        });
        const process = this.process;
        if (!process)
            return;
        process.on('exit', () => {
            for (const [, p] of this.pending) {
                p.reject(new Error('MCP process exited'));
            }
            this.pending.clear();
        });
    }
    async send(request) {
        const stdin = this.process.stdin;
        if (!stdin)
            throw new Error('MCP process stdin not available');
        return new Promise((resolve, reject) => {
            var _a;
            const id = (_a = request.id) !== null && _a !== void 0 ? _a : ++this.msgId;
            const req = { ...request, id, jsonrpc: '2.0' };
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request timed out after 30s (id: ${id})`));
            }, 30000);
            timeout.unref();
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timeout);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timeout);
                    reject(e);
                },
            });
            stdin.write(JSON.stringify(req) + '\n');
        });
    }
    async close() {
        var _a;
        (_a = this.process) === null || _a === void 0 ? void 0 : _a.kill();
        this.process = null;
    }
    /**
     * GAP-16: Filter environment variables to avoid leaking secrets.
     * Only passes safe system variables. Secrets (API_KEY, TOKEN, SECRET, etc.) are excluded.
     */
    filterEnvironment() {
        const safeVars = new Set([
            'PATH',
            'HOME',
            'USER',
            'SHELL',
            'TERM',
            'LANG',
            'LC_ALL',
            'TMPDIR',
            'NODE_PATH',
            'PYTHONPATH',
        ]);
        const denyPatterns = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'AUTH', 'PRIVATE'];
        const env = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (v === undefined)
                continue;
            if (safeVars.has(k)) {
                env[k] = v;
                continue;
            }
            const upper = k.toUpperCase();
            if (denyPatterns.some((p) => upper.includes(p)))
                continue;
            env[k] = v;
        }
        return env;
    }
}
exports.StdioClientTransport = StdioClientTransport;
// ============================================================================
// Streamable HTTP Transport — HTTP POST with SSE response
// ============================================================================
class StreamableHTTPClientTransport {
    constructor(config) {
        this.msgId = 0;
        this.url = config.url;
        this.headers = { 'Content-Type': 'application/json', ...config.headers };
    }
    async start() {
        // HTTP transport is stateless — no start needed
    }
    async send(request) {
        var _a;
        const id = (_a = request.id) !== null && _a !== void 0 ? _a : ++this.msgId;
        const body = JSON.stringify({ ...request, id, jsonrpc: '2.0' });
        const res = await fetch(this.url, {
            method: 'POST',
            headers: this.headers,
            body,
        });
        const text = await res.text();
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error(`MCP HTTP server returned invalid JSON (status ${res.status}): ${text.slice(0, 200)}`);
        }
    }
    async close() {
        // No persistent connection
    }
}
exports.StreamableHTTPClientTransport = StreamableHTTPClientTransport;
// ============================================================================
// MCP Client — High-level interface for calling MCP servers
// ============================================================================
class MCPClient {
    constructor(config) {
        this.initialized = false;
        this.capabilities = {};
        this.serverInfo = { name: '', version: '' };
        this.toolCache = null;
        this.config = config;
        this.transport =
            config.transport === 'stdio'
                ? new StdioClientTransport(config)
                : new StreamableHTTPClientTransport(config);
    }
    async connect() {
        await this.transport.start();
        await this.initialize();
    }
    async initialize() {
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
        if (resp.error)
            throw new Error(`MCP init failed: ${resp.error.message}`);
        const result = resp.result;
        this.capabilities = result.capabilities;
        this.serverInfo = result.serverInfo;
        this.initialized = true;
    }
    async listTools() {
        if (this.toolCache)
            return this.toolCache;
        if (!this.capabilities.tools)
            return [];
        const resp = await this.transport.send({
            jsonrpc: '2.0',
            id: uuid(),
            method: 'tools/list',
        });
        if (resp.error)
            throw new Error(`listTools failed: ${resp.error.message}`);
        const result = resp.result;
        this.toolCache = result.tools;
        return result.tools;
    }
    async callTool(name, args) {
        const resp = await this.transport.send({
            jsonrpc: '2.0',
            id: uuid(),
            method: 'tools/call',
            params: { name, arguments: args },
        });
        if (resp.error) {
            return { content: [{ type: 'text', text: `Error: ${resp.error.message}` }], isError: true };
        }
        return resp.result;
    }
    async listResources() {
        if (!this.capabilities.resources)
            return [];
        const resp = await this.transport.send({
            jsonrpc: '2.0',
            id: uuid(),
            method: 'resources/list',
        });
        if (resp.error)
            throw new Error(`listResources failed: ${resp.error.message}`);
        const result = resp.result;
        return result.resources;
    }
    async readResource(uri) {
        const resp = await this.transport.send({
            jsonrpc: '2.0',
            id: uuid(),
            method: 'resources/read',
            params: { uri },
        });
        if (resp.error)
            throw new Error(`readResource failed: ${resp.error.message}`);
        const result = resp.result;
        return result.contents;
    }
    async listPrompts() {
        if (!this.capabilities.prompts)
            return [];
        const resp = await this.transport.send({
            jsonrpc: '2.0',
            id: uuid(),
            method: 'prompts/list',
        });
        if (resp.error)
            throw new Error(`listPrompts failed: ${resp.error.message}`);
        const result = resp.result;
        return result.prompts;
    }
    async getPrompt(name, args) {
        const resp = await this.transport.send({
            jsonrpc: '2.0',
            id: uuid(),
            method: 'prompts/get',
            params: { name, arguments: args },
        });
        if (resp.error)
            throw new Error(`getPrompt failed: ${resp.error.message}`);
        return resp.result;
    }
    invalidateCache() {
        this.toolCache = null;
    }
    getServerInfo() {
        return { ...this.serverInfo };
    }
    getCapabilities() {
        return { ...this.capabilities };
    }
    async disconnect() {
        await this.transport.close();
        this.initialized = false;
        this.toolCache = null;
    }
}
exports.MCPClient = MCPClient;
function createMCPClient(config) {
    return new MCPClient(config);
}
