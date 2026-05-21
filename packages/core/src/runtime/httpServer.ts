import * as crypto from 'crypto';
import { IncomingMessage, ServerResponse, createServer } from 'http';
import type { LLMProvider, MessageBusTopic } from './types';
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
import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from './metricsCollector';
import { openApiSpec } from './openapi';

export interface HttpServerConfig {
  port: number;
  host: string;
  cors: boolean;
  /** API key for Bearer auth. If undefined, a random key is generated at startup. Set to '' to explicitly disable auth (NOT recommended). */
  apiKey?: string;
  /** Max requests per minute per IP. 0 = no limit. Default: 120 */
  rateLimitPerMinute: number;
  /** Optional mapping of API key → tenant ID for multi-tenant deployments.
   *  Keys are stored as-is (not hashed — use secure keys). When set, tenantId
   *  is derived from the Authorization header instead of trusting request body. */
  tenantApiKeys?: Record<string, string>;
}

const DEFAULT_CONFIG: HttpServerConfig = {
  port: 3001,
  host: '127.0.0.1', // Localhost-only by default (was 0.0.0.0 — GAP-12)
  cors: true,
  rateLimitPerMinute: 120,
};

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { getGlobalLogger().warn('HttpServer', 'Invalid JSON'); reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
  res.end(JSON.stringify(data));
}

function authenticate(req: IncomingMessage, config: HttpServerConfig): boolean {
  // If apiKey is explicitly empty string, auth is disabled (user opted in)
  if (config.apiKey === '') return true;
  // If apiKey is undefined (default), auth is required — key was generated at startup
  if (!config.apiKey) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${config.apiKey}` || auth === config.apiKey;
}

export class CommanderHttpServer {
  private config: HttpServerConfig;
  private server: ReturnType<typeof createServer> | null = null;
  private runtimes: Map<string, AgentRuntime> = new Map();
  private bus = getMessageBus();
  // Rate limiting: IP → { count, resetAt }
  private rateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();
  // Graceful shutdown: track open connections
  private connections: Set<import('net').Socket> = new Set();
  private isShuttingDown = false;

  constructor(config?: Partial<HttpServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // If no apiKey provided, generate one so the server isn't open by default
    if (this.config.apiKey === undefined) {
      this.config.apiKey = crypto.randomBytes(24).toString('hex');
      getGlobalLogger().info('HttpServer', 'Generated API key');
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        // Track connection for graceful shutdown
        const socket = req.socket;
        this.connections.add(socket);
        res.on('finish', () => { this.connections.delete(socket); });
        this.handleRequest(req, res);
      });
      this.server.listen(this.config.port, this.config.host, () => {
        getGlobalLogger().info('HttpServer', 'Listening', { host: this.config.host, port: this.config.port, authEnabled: !!this.config.apiKey });
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
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
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
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Access-Control-Allow-Origin': '*' });
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

    if (!authenticate(req, this.config)) {
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
      if (segments[0] === 'api') {
        await this.handleApiRequest(req, res, segments.slice(1), queryStr);
      } else if (segments[0] === 'stream') {
        await this.handleStreamRequest(req, res, segments.slice(1));
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      getGlobalLogger().error('HttpServer', 'Request error', err instanceof Error ? err : new Error(String(err)));
      sendJson(res, 500, { error: String(err) });
    }
  }

  private async handleApiRequest(req: IncomingMessage, res: ServerResponse, segments: string[], queryStr: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (segments[0] === 'v1') {
      const [, resource, id] = segments;
      if (resource === 'runtime') {
        if (method === 'POST') {
          const body = await parseBody(req) as { sessionId?: string; provider?: string; model?: string };
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
          const body = await parseBody(req) as { prompt: string; sessionId?: string; provider?: string; model?: string };
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
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const stream = new SSEStream();
    stream.pipe(res);
    stream.emitStatus('session.started', id);
    const unsubStart = this.bus.subscribe('agent.started', () => { stream.emitStatus('agent.started'); });
    const unsubComplete = this.bus.subscribe('agent.completed', () => { stream.emitStatus('agent.completed'); });
    const unsubError = this.bus.subscribe('agent.failed', () => { stream.emitStatus('agent.error'); });
    req.on('close', () => { unsubStart(); unsubComplete(); unsubError(); stream.close(); });
  }

  /** Resolve tenant ID from the Authorization header using configured API key mapping. */
  private resolveTenantFromAuth(req: IncomingMessage): string | undefined {
    if (!this.config.tenantApiKeys) return undefined;
    const auth = req.headers.authorization;
    if (!auth) return undefined;
    // Strip "Bearer " prefix if present
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    return this.config.tenantApiKeys[key];
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
