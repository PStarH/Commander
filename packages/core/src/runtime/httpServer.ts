import * as crypto from 'crypto';
import { IncomingMessage, ServerResponse, createServer as createNodeHttpServer } from 'http';
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from 'https';
import type { LLMProvider, MessageBusTopic } from './types';
import type { Tool } from './types';
import type { JSONRPCRequest } from '../mcp/types';
import { AgentRuntime } from './agentRuntime';
import { SSEStream } from './sseStream';
import { getMessageBus } from './messageBus';
import { OpenAIProvider } from './providers/openaiProvider';
import { AnthropicProvider } from './providers/anthropicProvider';
import { GoogleProvider } from './providers/googleProvider';
import { OpenRouterProvider } from './providers/openRouterProvider';
import { DeepSeekProvider } from './providers/deepseekProvider';
import { GLMProvider } from './providers/glmProvider';
import { MiMoProvider } from './providers/mimoProvider';
import { XiaomiProvider } from './providers/xiaomiProvider';
import { OllamaProvider } from './providers/ollamaProvider';
import { VLLMProvider } from './providers/vllmProvider';
import { CohereProvider } from './providers/cohereProvider';
import { MistralProvider } from './providers/mistralProvider';
import { GroqProvider } from './providers/groqProvider';
import { TogetherProvider } from './providers/togetherProvider';
import { PerplexityProvider } from './providers/perplexityProvider';
import { FireworksProvider } from './providers/fireworksProvider';
import { ReplicateProvider } from './providers/replicateProvider';
import { BedrockProvider } from './providers/bedrockProvider';
import { XAIProvider } from './providers/xaiProvider';
import { AnyscaleProvider } from './providers/anyscaleProvider';
import { DeepInfraProvider } from './providers/deepinfraProvider';
import { MCPServer } from '../mcp/server';
import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from './metricsCollector';
import { openApiSpec } from './openapi';

export interface HttpServerConfig {
  port: number;
  host: string;
  cors: boolean;
  /** Allowed CORS origins. Use ['*'] only for trusted internal/dev deployments. */
  corsAllowedOrigins: string[];
  /** Maximum JSON request body size in bytes. Default: 1 MiB. */
  maxBodyBytes: number;
  /** Optional TLS options. When set, Commander serves HTTPS directly. */
  https?: HttpsServerOptions;
  /** API key for Bearer auth. If undefined, a random key is generated at startup. Set to '' to explicitly disable auth (NOT recommended). */
  apiKey?: string;
  /** SHA-256 hash of the API key. Prefer this over apiKey in production config. */
  apiKeyHash?: string;
  /** Max requests per minute per IP. 0 = no limit. Default: 120 */
  rateLimitPerMinute: number;
  /** Optional mapping of API key → tenant ID for multi-tenant deployments.
   *  Raw keys are hashed at startup and then discarded. Prefer tenantApiKeyHashes in production config. */
  tenantApiKeys?: Record<string, string>;
  /** Optional mapping of SHA-256 API key hash → tenant ID for multi-tenant deployments. */
  tenantApiKeyHashes?: Record<string, string>;
}

const DEFAULT_CONFIG: HttpServerConfig = {
  port: 3001,
  host: '127.0.0.1', // Localhost-only by default (was 0.0.0.0 — GAP-12)
  cors: true,
  corsAllowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  maxBodyBytes: 1024 * 1024,
  rateLimitPerMinute: 120,
};

class HttpRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function parseBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejected = false;
    let bodyError: HttpRequestError | null = null;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (rejected) return;
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        rejected = true;
        body = '';
        bodyError = new HttpRequestError(413, `Request body too large. Limit is ${maxBytes} bytes.`);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (bodyError) {
        reject(bodyError);
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        getGlobalLogger().warn('HttpServer', 'Invalid JSON');
        reject(new HttpRequestError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function extractAuthKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth) return undefined;
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function authenticate(req: IncomingMessage, authDisabled: boolean, apiKeyHash?: string): boolean {
  if (authDisabled) return true;
  if (!apiKeyHash) return false;
  const key = extractAuthKey(req);
  if (!key) return false;
  return timingSafeHexEqual(hashSecret(key), apiKeyHash);
}

export class CommanderHttpServer {
  private config: HttpServerConfig;
  private server: ReturnType<typeof createNodeHttpServer> | ReturnType<typeof createHttpsServer> | null = null;
  private runtimes: Map<string, AgentRuntime> = new Map();
  private bus = getMessageBus();
  private mcpServer: MCPServer | null = null;
  // Rate limiting: IP → { count, resetAt }
  private rateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();
  // Graceful shutdown: track open connections
  private connections: Set<import('net').Socket> = new Set();
  private isShuttingDown = false;
  private authDisabled = false;
  private apiKeyHash: string | undefined;
  private tenantApiKeyHashes: Map<string, string> = new Map();

  constructor(config?: Partial<HttpServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeAuth();
  }

  private initializeAuth(): void {
    if (this.config.apiKey === '') {
      this.authDisabled = true;
    } else if (this.config.apiKeyHash) {
      this.apiKeyHash = this.config.apiKeyHash;
    } else if (this.config.apiKey !== undefined) {
      this.apiKeyHash = hashSecret(this.config.apiKey);
    } else {
      this.apiKeyHash = hashSecret(crypto.randomBytes(24).toString('hex'));
      getGlobalLogger().info('HttpServer', 'Generated ephemeral API key hash; configure apiKeyHash for externally accessible deployments');
    }

    for (const [keyHash, tenantId] of Object.entries(this.config.tenantApiKeyHashes ?? {})) {
      this.tenantApiKeyHashes.set(keyHash, tenantId);
    }
    for (const [rawKey, tenantId] of Object.entries(this.config.tenantApiKeys ?? {})) {
      this.tenantApiKeyHashes.set(hashSecret(rawKey), tenantId);
    }

    // Drop raw secrets from retained server config after one-way hashing.
    this.config.apiKey = undefined;
    this.config.tenantApiKeys = undefined;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      const handler = (req: IncomingMessage, res: ServerResponse) => {
        // Track connection for graceful shutdown
        const socket = req.socket;
        this.connections.add(socket);
        res.on('finish', () => { this.connections.delete(socket); });
        this.handleRequest(req, res);
      };
      this.server = this.config.https
        ? createHttpsServer(this.config.https, handler)
        : createNodeHttpServer(handler);
      this.server.listen(this.config.port, this.config.host, () => {
        getGlobalLogger().info('HttpServer', 'Listening', {
          protocol: this.config.https ? 'https' : 'http',
          host: this.config.host,
          port: this.config.port,
          authEnabled: !this.authDisabled,
        });
        resolve();
      });
    });
  }

  /** Return the port the server is actually listening on (useful when port=0). */
  getPort(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.config.port;
  }

  async stop(forceTimeoutMs: number = 10_000): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.isShuttingDown = true;
      const remaining = this.connections.size;
      if (remaining > 0) {
        getGlobalLogger().info('HttpServer', 'Draining connections', { remaining });
      }
      // Stop accepting new connections, then resolve once drained
      this.server.close(() => {
        this.connections.clear();
        resolve();
      });
      // Force-close remaining connections after timeout
      if (remaining > 0) {
        const timer = setTimeout(() => {
          getGlobalLogger().warn('HttpServer', 'Force closing remaining connections', { remaining: this.connections.size });
          for (const socket of this.connections) {
            socket.destroy();
          }
          this.connections.clear();
        }, forceTimeoutMs);
        timer.unref();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCommonHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = req.url ?? '/';
    const [pathPart, queryStr] = url.split('?');
    const segments = pathPart.split('/').filter(Boolean);

    // GAP-31: Health endpoint bypasses auth and rate limiting
    if (segments[0] === 'health' && (req.method ?? 'GET') === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        activeSessions: this.runtimes.size,
        busTopics: this.bus.getActiveTopics().length,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // GAP-33: Metrics endpoint for monitoring (JSON + OpenMetrics text)
    if (segments[0] === 'metrics' && (req.method ?? 'GET') === 'GET') {
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/plain') || accept.includes('openmetrics')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(getMetricsCollector().exportOpenMetrics());
      } else {
        const mem = process.memoryUsage();
        sendJson(res, 200, {
          uptime: process.uptime(),
          activeSessions: this.runtimes.size,
          busTopics: this.bus.getActiveTopics(),
          subscriberCounts: this.bus.getAllSubscriberCounts(),
          rateLimitEntries: this.rateLimitMap.size,
          memory: {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
          },
          pid: process.pid,
          nodeVersion: process.version,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    // OpenAPI 3.0 specification
    if (segments[0] === 'openapi.json' && (req.method ?? 'GET') === 'GET') {
      sendJson(res, 200, openApiSpec);
      return;
    }

    // Readiness probe (separate from health — checks deps)
    if (segments[0] === 'ready' && (req.method ?? 'GET') === 'GET') {
      const mem = process.memoryUsage();
      const healthy = true;
      sendJson(res, healthy ? 200 : 503, {
        status: healthy ? 'ready' : 'not_ready',
        uptime: process.uptime(),
        activeSessions: this.runtimes.size,
        busTopics: this.bus.getActiveTopics().length,
        memory: { rss: mem.rss, heapUsed: mem.heapUsed },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!authenticate(req, this.authDisabled, this.apiKeyHash)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Provide Authorization: Bearer <api-key> header.' }));
      return;
    }
    // Rate limiting per IP
    if (this.config.rateLimitPerMinute > 0) {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!this.checkRateLimit(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }));
        return;
      }
    }
    try {
      // MCP endpoint: POST /api/v1/mcp — JSON-RPC 2.0 for tool discovery and execution
      if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'mcp') {
        await this.handleMCPRequest(req, res);
        return;
      }
      if (segments[0] === 'api') {
        await this.handleApiRequest(req, res, segments.slice(1), queryStr);
      } else if (segments[0] === 'stream') {
        await this.handleStreamRequest(req, res, segments.slice(1));
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      const status = err instanceof HttpRequestError ? err.statusCode : 500;
      if (err instanceof HttpRequestError) {
        getGlobalLogger().warn('HttpServer', err.message);
      } else {
        getGlobalLogger().error('HttpServer', 'Request error', err instanceof Error ? err : new Error(String(err)));
      }
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private applyCommonHeaders(req: IncomingMessage, res: ServerResponse): void {
    const requestId = this.getRequestId(req);
    res.setHeader('X-Request-Id', requestId);
    if (!this.config.cors) return;

    const allowedOrigins = this.config.corsAllowedOrigins;
    const origin = req.headers.origin;
    const allowAll = allowedOrigins.includes('*');
    if (origin && (allowAll || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      if (!allowAll) res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  }

  private getRequestId(req: IncomingMessage): string {
    const incoming = req.headers['x-request-id'];
    if (typeof incoming === 'string' && incoming.trim()) return incoming;
    if (Array.isArray(incoming) && incoming[0]?.trim()) return incoming[0];
    return crypto.randomUUID();
  }

  private async handleApiRequest(req: IncomingMessage, res: ServerResponse, segments: string[], queryStr: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (segments[0] === 'v1') {
      const [, resource, id] = segments;
      if (resource === 'runtime') {
        if (method === 'POST') {
          const body = await parseBody(req, this.config.maxBodyBytes) as { sessionId?: string; provider?: string; model?: string };
          const sessionId = body.sessionId ?? `session_${Date.now()}`;
          const runtime = new AgentRuntime();
          runtime.registerProvider(body.provider ?? 'openai', this.getDefaultProvider(body.provider));
          this.runtimes.set(sessionId, runtime);
          sendJson(res, 201, { sessionId, status: 'created' });
          return;
        }
        if (id) {
          const runtime = this.runtimes.get(id);
          if (!runtime) { sendJson(res, 404, { error: 'Session not found' }); return; }
          if (method === 'GET') { sendJson(res, 200, { sessionId: id, status: 'active', sessionCount: this.runtimes.size }); return; }
          if (method === 'DELETE') { this.runtimes.delete(id); sendJson(res, 200, { status: 'deleted' }); return; }
        }
      }
      if (resource === 'execute') {
        if (method === 'POST') {
          const body = await parseBody(req, this.config.maxBodyBytes) as { prompt: string; sessionId?: string; provider?: string; model?: string; outputSchema?: Record<string, unknown> };
          const sessionId = body.sessionId ?? `session_${Date.now()}`;
          // Derive tenantId from API key (never trust request body for tenant)
          const tenantId = this.resolveTenantFromAuth(req);
          let runtime = this.runtimes.get(sessionId);
          if (!runtime) {
            runtime = new AgentRuntime();
            runtime.registerProvider(body.provider ?? 'openai', this.getDefaultProvider(body.provider));
            this.runtimes.set(sessionId, runtime);
          }
          const result = await runtime.execute({
            agentId: `http-${sessionId}`,
            projectId: 'http-api',
            goal: body.prompt,
            availableTools: ['web_search', 'web_fetch', 'file_read', 'file_write', 'file_edit', 'file_search', 'file_list', 'python_execute', 'shell_execute', 'memory_store', 'memory_recall', 'memory_list', 'git', 'browser_search', 'browser_fetch'],
            maxSteps: 50,
            tokenBudget: 100000,
            outputSchema: body.outputSchema,
            contextData: {},
            tenantId,
          });
          sendJson(res, 200, { sessionId, status: result.status, summary: result.summary, steps: result.steps?.length });
          return;
        }
      }
      if (resource === 'bus') {
        if (method === 'GET') {
          const topic = queryStr ? new URLSearchParams(queryStr).get('topic') ?? undefined : undefined;
          sendJson(res, 200, {
            topics: this.bus.getActiveTopics(),
            history: this.bus.getHistory(topic as MessageBusTopic | undefined, 50).map(m => ({ topic: m.topic, source: m.source, timestamp: m.timestamp })),
          });
          return;
        }
      }
      if (resource === 'status') {
        sendJson(res, 200, { activeSessions: this.runtimes.size, busTopics: this.bus.getActiveTopics(), subscriberCounts: this.bus.getAllSubscriberCounts() });
        return;
      }
    }
    sendJson(res, 404, { error: 'Unknown endpoint' });
  }

  private async handleStreamRequest(req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> {
    const [, resource, id] = segments;
    if (resource !== 'runtime' || !id) { sendJson(res, 404, { error: 'Not found' }); return; }
    const runtime = this.runtimes.get(id);
    if (!runtime) { sendJson(res, 404, { error: 'Session not found' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const stream = new SSEStream();
    stream.pipe(res);
    stream.emitStatus('session.started', id);
    const unsubStart = this.bus.subscribe('agent.started', () => { stream.emitStatus('agent.started'); });
    const unsubComplete = this.bus.subscribe('agent.completed', () => { stream.emitStatus('agent.completed'); });
    const unsubError = this.bus.subscribe('agent.failed', () => { stream.emitStatus('agent.error'); });
    req.on('close', () => { unsubStart(); unsubComplete(); unsubError(); stream.close(); });
  }

  /**
   * Register Commander tools as MCP tools on an internal MCPServer.
   * External clients can call these tools via POST /api/v1/mcp with JSON-RPC 2.0 requests.
   */
  registerMCPServer(name: string, tools: Map<string, Tool>): void {
    const server = new MCPServer(name, '1.0.0');
    server.registerCommanderTools(tools);
    server.registerExecutionResource();
    this.mcpServer = server;
    getGlobalLogger().info('HttpServer', `MCP Server "${name}" registered with ${tools.size} tools`);
  }

  private async handleMCPRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed. Use POST for MCP requests.' });
      return;
    }
    if (!this.mcpServer) {
      sendJson(res, 503, { error: 'MCP Server not initialized. Call registerMCPServer first.' });
      return;
    }
    try {
      const body = (await parseBody(req, this.config.maxBodyBytes)) as JSONRPCRequest;
      const response = await this.mcpServer.handleRequest(body);
      sendJson(res, 200, response);
    } catch (err) {
      if (err instanceof HttpRequestError && err.statusCode === 413) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      sendJson(res, 400, {
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : String(err)}` },
      });
    }
  }

  /** Resolve tenant ID from the Authorization header using configured API key mapping. */
  private resolveTenantFromAuth(req: IncomingMessage): string | undefined {
    const key = extractAuthKey(req);
    if (!key) return undefined;
    return this.tenantApiKeyHashes.get(hashSecret(key));
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = this.rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      this.rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= this.config.rateLimitPerMinute) return false;
    entry.count++;
    return true;
  }

  private getDefaultProvider(provider: string = 'openai'): LLMProvider {
    switch (provider) {
      case 'openai': return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? '' });
      case 'anthropic': return new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
      case 'google': return new GoogleProvider({ apiKey: process.env.GOOGLE_API_KEY ?? '' });
      case 'openrouter': return new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY ?? '' });
      case 'deepseek': return new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY ?? '' });
      case 'glm': return new GLMProvider({ apiKey: process.env.ZHIPU_API_KEY ?? '' });
      case 'mimo': return new MiMoProvider({ apiKey: process.env.MIMO_API_KEY ?? '' });
      case 'xiaomi': return new XiaomiProvider({ apiKey: process.env.XIAOMI_API_KEY ?? '' });
      case 'ollama': return new OllamaProvider({});
      case 'vllm': return new VLLMProvider({});
      case 'cohere': return new CohereProvider({ apiKey: (process.env.CO_API_KEY || process.env.COHERE_API_KEY) ?? '' });
      case 'mistral': return new MistralProvider({ apiKey: process.env.MISTRAL_API_KEY ?? '' });
      case 'groq': return new GroqProvider({ apiKey: process.env.GROQ_API_KEY ?? '' });
      case 'together': return new TogetherProvider({ apiKey: process.env.TOGETHER_API_KEY ?? '' });
      case 'perplexity': return new PerplexityProvider({ apiKey: (process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY) ?? '' });
      case 'fireworks': return new FireworksProvider({ apiKey: process.env.FIREWORKS_API_KEY ?? '' });
      case 'replicate': return new ReplicateProvider({ apiKey: (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY) ?? '' });
      case 'bedrock': return new BedrockProvider({});
      case 'xai': return new XAIProvider({ apiKey: process.env.XAI_API_KEY ?? '' });
      case 'anyscale': return new AnyscaleProvider({ apiKey: process.env.ANYSCALE_API_KEY ?? '' });
      case 'deepinfra': return new DeepInfraProvider({ apiKey: process.env.DEEPINFRA_API_KEY ?? '' });
      default: return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? '' });
    }
  }
}

export function createHttpServer(config?: Partial<HttpServerConfig>): CommanderHttpServer {
  return new CommanderHttpServer(config);
}
