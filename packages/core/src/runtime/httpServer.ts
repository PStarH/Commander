import * as crypto from 'crypto';
import { IncomingMessage, ServerResponse, createServer } from 'http';
import { AgentRuntime } from './agentRuntime';
import { SSEStream } from './sseStream';
import { getMessageBus } from './messageBus';

export interface HttpServerConfig {
  port: number;
  host: string;
  cors: boolean;
  /** API key for Bearer auth. If undefined, a random key is generated at startup. Set to '' to explicitly disable auth (NOT recommended). */
  apiKey?: string;
  /** Max requests per minute per IP. 0 = no limit. Default: 120 */
  rateLimitPerMinute: number;
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
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
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

  constructor(config?: Partial<HttpServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // If no apiKey provided, generate one so the server isn't open by default
    if (this.config.apiKey === undefined) {
      this.config.apiKey = crypto.randomBytes(24).toString('hex');
      console.log(`[HttpServer] Generated API key: ${this.config.apiKey}`);
      console.log(`[HttpServer] Pass --api-key="" to disable auth (NOT recommended for production)`);
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => { this.handleRequest(req, res); });
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[HttpServer] Listening on http://${this.config.host}:${this.config.port}`);
        if (this.config.apiKey) {
          console.log(`[HttpServer] Authentication enabled (Bearer token required)`);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server?.close((err) => { err ? reject(err) : resolve(); });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      res.end();
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
    const url = req.url ?? '/';
    const [path, queryStr] = url.split('?');
    const segments = path.split('/').filter(Boolean);
    try {
      if (segments[0] === 'api') {
        await this.handleApiRequest(req, res, segments.slice(1), queryStr);
      } else if (segments[0] === 'stream') {
        await this.handleStreamRequest(req, res, segments.slice(1));
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      console.error('[HttpServer] Request error:', err);
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
            history: this.bus.getHistory(topic as any, 50).map(m => ({ topic: m.topic, source: m.source, timestamp: m.timestamp })),
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

  private getDefaultProvider(provider: string = 'openai'): any {
    switch (provider) {
      case 'openai': return new (require('./providers/openaiProvider').OpenAIProvider)({ apiKey: process.env.OPENAI_API_KEY });
      case 'anthropic': return new (require('./providers/anthropicProvider').AnthropicProvider)({ apiKey: process.env.ANTHROPIC_API_KEY });
      default: return new (require('./providers/openaiProvider').OpenAIProvider)({ apiKey: process.env.OPENAI_API_KEY });
    }
  }
}

export function createHttpServer(config?: Partial<HttpServerConfig>): CommanderHttpServer {
  return new CommanderHttpServer(config);
}
