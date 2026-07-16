import { reportSilentFailure } from '../silentFailureReporter';
import {
  MCP_PROTOCOL_VERSION,
  type MCPTransport,
  type MCPClientConfig,
  type MCPTool,
  type MCPResource,
  type MCPPrompt,
  type MCPToolResult,
  type MCPResourceContents,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type ListToolsResult,
  type ListResourcesResult,
  type ListPromptsResult,
  type GetPromptResult,
  type ReadResourceResult,
  type MCPInitializeResult,
  type MCPServerCapabilities,
} from './types';
import { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { getSupplyChainScanner } from '../security/supplyChainScanner';

function uuid(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Validate an MCP stdio command against the runtime allowlist.
 * Returns an error message if the command is forbidden, otherwise undefined.
 *
 * Rules:
 *  - `npx` is always forbidden at runtime (download-on-execute is a supply-chain risk).
 *  - Only explicitly allowed base names or absolute paths may be spawned.
 *  - Override via COMMANDER_MCP_ALLOWED_COMMANDS comma-separated env var.
 *  - `uvx` is rejected unless COMMANDER_MCP_ALLOW_UVX=1.
 */
export function validateMcpCommand(command: string, args: readonly string[] = []): string | undefined {
  const base = path.basename(command).toLowerCase();

  if (base === 'npx' || command.toLowerCase().startsWith('npx ')) {
    return 'npx is not allowed for MCP stdio transport (download-on-execute supply-chain risk)';
  }

  // uvx downloads and executes arbitrary packages — fail-closed unless explicitly opted in.
  if (base === 'uvx' && process.env.COMMANDER_MCP_ALLOW_UVX !== '1') {
    return 'uvx is not allowed for MCP stdio transport (set COMMANDER_MCP_ALLOW_UVX=1 to override)';
  }

  // MCP-5: an allowlisted interpreter still becomes arbitrary code execution when
  // handed an inline-eval / module-loader flag. Treat args as part of the allowlist
  // decision and reject dangerous flags.
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
      return `MCP command arguments may not contain an inline-eval flag ("${arg}") — it permits arbitrary code execution.`;
    }
  }

  const defaultAllowed = ['node', 'nodejs', 'python', 'python3', 'bun', 'deno'];
  // uvx only joins the allowlist when explicitly opted in.
  if (process.env.COMMANDER_MCP_ALLOW_UVX === '1') {
    defaultAllowed.push('uvx');
  }
  const envAllowed =
    process.env.COMMANDER_MCP_ALLOWED_COMMANDS?.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean) ?? [];
  const allowed = new Set([...defaultAllowed, ...envAllowed]);

  // Absolute paths are allowed if their basename is in the allowlist.
  if (path.isAbsolute(command) && allowed.has(base)) {
    return undefined;
  }

  // Bare command names must be in the allowlist.
  if (allowed.has(base)) {
    return undefined;
  }

  return `MCP command "${command}" is not in the runtime allowlist. Allowed: ${[...allowed].join(', ')}`;
}

// ============================================================================
// Stdio Transport — spawn a subprocess and communicate via stdin/stdout
// ============================================================================

export class StdioClientTransport implements MCPTransport {
  private process: ChildProcess | null = null;
  private config: MCPClientConfig;
  private pending = new Map<
    string | number,
    { resolve: (v: JSONRPCResponse) => void; reject: (e: Error) => void }
  >();
  private buf = '';
  private msgId = 0;

  constructor(config: MCPClientConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const { spawn } = await import('child_process');
    const command = this.config.command;
    if (!command) {
      throw new Error('MCP stdio transport requires a command');
    }
    const validationError = validateMcpCommand(command, this.config.args ?? []);
    if (validationError) {
      throw new Error(`MCP command rejected: ${validationError}`);
    }

    // GAP-16: Filter environment to avoid leaking secrets to MCP subprocess.
    // Only pass safe variables + explicitly configured env vars.
    const safeEnv = this.filterEnvironment();
    this.process = spawn(command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...safeEnv, ...this.config.env },
    });

    const stdout = this.process.stdout;
    const stderr = this.process.stderr;

    if (stdout) {
      stdout.on('data', (data: Buffer) => {
        this.buf += data.toString();
        const lines = this.buf.split('\n');
        this.buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as JSONRPCResponse;
            const id = parsed.id;
            if (id !== null && this.pending.has(id)) {
              const p = this.pending.get(id)!;
              p.resolve(parsed);
              this.pending.delete(id);
            }
          } catch (err) {
            reportSilentFailure(err, 'client:75');
            getGlobalLogger().debug('MCPClient', 'Ignoring parse error in stdio response');
          }
        }
      });
    }

    if (stderr) {
      stderr.on('data', () => {
        // MCP servers log to stderr — ignore in production, log in debug
      });
    }

    this.process.on('exit', () => {
      for (const [, p] of this.pending) {
        p.reject(new Error('MCP process exited'));
      }
      this.pending.clear();
    });
  }

  async send(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const stdin = this.process!.stdin;
    if (!stdin) throw new Error('MCP process stdin not available');
    return new Promise((resolve, reject) => {
      const id = request.id ?? ++this.msgId;
      const req = { ...request, id, jsonrpc: '2.0' as const };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after 30s (id: ${id})`));
      }, 30_000);
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

  async close(): Promise<void> {
    this.process?.kill();
    this.process = null;
  }

  /**
   * GAP-16: Filter environment variables to avoid leaking secrets.
   * Only passes safe system variables. Secrets (API_KEY, TOKEN, SECRET, etc.) are excluded.
   */
  private filterEnvironment(): Record<string, string> {
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
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (safeVars.has(k)) {
        env[k] = v;
        continue;
      }
      const upper = k.toUpperCase();
      if (denyPatterns.some((p) => upper.includes(p))) continue;
      env[k] = v;
    }
    return env;
  }
}

// ============================================================================
// Streamable HTTP Transport — HTTP POST with SSE response
// ============================================================================

export class StreamableHTTPClientTransport implements MCPTransport {
  private url: string;
  private headers: Record<string, string>;
  private msgId = 0;

  constructor(config: MCPClientConfig) {
    this.url = config.url!;
    this.headers = { 'Content-Type': 'application/json', ...config.headers };
  }

  async start(): Promise<void> {
    // HTTP transport is stateless — no start needed
  }

  async send(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const id = request.id ?? ++this.msgId;
    const body = JSON.stringify({ ...request, id, jsonrpc: '2.0' });

    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body,
    });

    const text = await res.text();
    try {
      return JSON.parse(text) as JSONRPCResponse;
    } catch (err) {
      reportSilentFailure(err, 'client:191');
      throw new Error(
        `MCP HTTP server returned invalid JSON (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }

  async close(): Promise<void> {
    // No persistent connection
  }
}

// ============================================================================
// MCP Client — High-level interface for calling MCP servers
// ============================================================================

export class MCPClient {
  private transport: MCPTransport;
  private initialized = false;
  private capabilities: MCPServerCapabilities = {};
  private serverInfo: { name: string; version: string } = { name: '', version: '' };
  private toolCache: MCPTool[] | null = null;
  private config: MCPClientConfig;

  constructor(config: MCPClientConfig) {
    this.config = config;
    this.transport =
      config.transport === 'stdio'
        ? new StdioClientTransport(config)
        : new StreamableHTTPClientTransport(config);
  }

  async connect(): Promise<void> {
    // SECURITY: run a supply-chain scan before opening a connection to an
    // external MCP server. Block on critical/malicious findings.
    const scanInput =
      this.config.transport === 'stdio'
        ? `${this.config.command ?? ''} ${(this.config.args ?? []).join(' ')}`
        : (this.config.url ?? '');
    const scanResult = getSupplyChainScanner().scan({
      name: `mcp:${scanInput}`,
      content: scanInput,
      tools: [],
      provenance: {
        source: this.config.transport === 'stdio' ? 'local' : 'url',
        sourceUrl: this.config.url,
      },
    });
    if (!scanResult.passed) {
      throw new Error(
        `Supply chain scan blocked MCP connection to "${scanInput}": ${scanResult.recommendation} (risk=${scanResult.riskScore})`,
      );
    }

    await this.transport.start();
    await this.initialize();
    // Auto-fetch tools after connection so the cache is populated.
    // Without this, listTools() returns null on first call until explicitly
    // invoked, causing tools to appear to "vanish" after reconnection.
    if (this.capabilities.tools) {
      try {
        await this.listTools();
      } catch (err) {
        reportSilentFailure(err, 'client:233');
        // Non-critical: tools will be fetched on first explicit listTools() call
      }
    }
  }

  private async initialize(): Promise<void> {
    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'commander-mcp-client', version: '1.0.0' },
      },
    });

    if (resp.error) throw new Error(`MCP init failed: ${resp.error.message}`);
    const result = resp.result as MCPInitializeResult;
    this.capabilities = result.capabilities;
    this.serverInfo = result.serverInfo;
    this.initialized = true;
  }

  async listTools(): Promise<MCPTool[]> {
    if (this.toolCache) return this.toolCache;
    if (!this.capabilities.tools) return [];

    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'tools/list',
    });

    if (resp.error) throw new Error(`listTools failed: ${resp.error.message}`);
    const result = resp.result as ListToolsResult;
    this.toolCache = result.tools;
    return result.tools;
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult> {
    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'tools/call',
      params: { name, arguments: args },
    });

    if (resp.error) {
      return { content: [{ type: 'text', text: `Error: ${resp.error.message}` }], isError: true };
    }

    return resp.result as MCPToolResult;
  }

  async listResources(): Promise<MCPResource[]> {
    if (!this.capabilities.resources) return [];

    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'resources/list',
    });

    if (resp.error) throw new Error(`listResources failed: ${resp.error.message}`);
    const result = resp.result as ListResourcesResult;
    return result.resources;
  }

  async readResource(uri: string): Promise<MCPResourceContents[]> {
    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'resources/read',
      params: { uri },
    });

    if (resp.error) throw new Error(`readResource failed: ${resp.error.message}`);
    const result = resp.result as ReadResourceResult;
    return result.contents;
  }

  async listPrompts(): Promise<MCPPrompt[]> {
    if (!this.capabilities.prompts) return [];

    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'prompts/list',
    });

    if (resp.error) throw new Error(`listPrompts failed: ${resp.error.message}`);
    const result = resp.result as ListPromptsResult;
    return result.prompts;
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const resp = await this.transport.send({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'prompts/get',
      params: { name, arguments: args },
    });

    if (resp.error) throw new Error(`getPrompt failed: ${resp.error.message}`);
    return resp.result as GetPromptResult;
  }

  invalidateCache(): void {
    this.toolCache = null;
  }

  getServerInfo(): { name: string; version: string } {
    return { ...this.serverInfo };
  }

  getCapabilities(): MCPServerCapabilities {
    return { ...this.capabilities };
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.initialized = false;
    this.toolCache = null;
  }
}

export function createMCPClient(config: MCPClientConfig): MCPClient {
  return new MCPClient(config);
}
