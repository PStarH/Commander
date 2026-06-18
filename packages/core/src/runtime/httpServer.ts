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
import { installProcessCrashHandlers } from './processCrashSafety';
import { getDeadLetterQueue } from './deadLetterQueueSingleton';
import { openApiSpec } from './openapi';
import { handleAtrHttpRequest, type AtrHttpDeps } from '../atr/atrHttp';
import { getExecutionScheduler } from '../atr/scheduler';
import { handleObservabilityRequest, type ObservabilityDeps } from '../observability/httpApi';
import { getCompensationData, renderDashboardHtml } from './compensationDashboard';
import {
  getSOPDashboardData,
  listSOPs,
  getSOP,
  getSOPMarkdown,
  renderSOPDashboardHtml,
} from './sopDashboard';
import { getTraceRecorder } from './executionTrace';
import { getCostModel } from '../observability/costModel';
import { PersistentTraceStore } from './traceStore';
import { LeaseManager } from '../atr/leaseManager';
import type { AuthPlugin } from './oidcAuthPlugin';
import type { SIEMEvent, SIEMForwarder } from './siemForwarder';
import { type SecurityEvent, getSecurityAuditLogger } from '../security/securityAuditLogger';

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
  /** OIDC authentication plugin config (loaded from env if available) */
  oidcEnabled?: boolean;
  /** SIEM forwarder instance for log forwarding (loaded from env if available) */
  siemForwarder?: SIEMForwarder;
}

const DEFAULT_CONFIG: HttpServerConfig = {
  port: parseInt(process.env.COMMANDER_PORT ?? '3001', 10),
  host: '127.0.0.1',
  cors: true,
  corsAllowedOrigins: process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) ?? [
    `http://localhost:${process.env.WEB_PORT ?? '5173'}`,
    `http://127.0.0.1:${process.env.WEB_PORT ?? '5173'}`,
  ],
  maxBodyBytes: 1024 * 1024,
  rateLimitPerMinute: 120,
};

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
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
        bodyError = new HttpRequestError(
          413,
          `Request body too large. Limit is ${maxBytes} bytes.`,
        );
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

/** Extended authenticate that also tries registered auth plugins (OIDC). */
function authenticate(
  req: IncomingMessage,
  authDisabled: boolean,
  apiKeyHash?: string,
  authPlugins?: AuthPlugin[],
): { success: boolean; userId?: string; role?: string } {
  if (authDisabled) return { success: true };

  const key = extractAuthKey(req);
  if (!key) return { success: false };

  // 1. Try API key auth first
  if (apiKeyHash && timingSafeHexEqual(hashSecret(key), apiKeyHash)) {
    return { success: true };
  }

  // 2. Try registered auth plugins (OIDC, SAML, etc.)
  if (authPlugins && authPlugins.length > 0) {
    // Find the first plugin that accepts this token
    // Note: this is synchronous for API key auth; OIDC plugins are async
    // and handled via the async request handler path.
    return { success: false, userId: '__plugin_pending__' };
  }

  return { success: false };
}

export class CommanderHttpServer {
  private config: HttpServerConfig;
  private server:
    | ReturnType<typeof createNodeHttpServer>
    | ReturnType<typeof createHttpsServer>
    | null = null;
  private runtimes: Map<string, { runtime: AgentRuntime; lastAccessedAt: number }> = new Map();
  private bus = getMessageBus();
  private mcpServer: MCPServer | null = null;
  // Rate limiting: IP → { count, resetAt }
  private rateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();
  private static readonly SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly MAX_SESSIONS = 200;
  private sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;
  // Graceful shutdown: track open connections
  private connections: Set<import('net').Socket> = new Set();
  private isShuttingDown = false;
  private authDisabled = false;
  private apiKeyHash: string | undefined;
  private tenantApiKeyHashes: Map<string, string> = new Map();
  private authPlugins: AuthPlugin[] = [];
  private siemForwarder: SIEMForwarder | null = null;
  private securityEventUnsub: (() => void) | null = null;

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
      getGlobalLogger().info(
        'HttpServer',
        'Generated ephemeral API key hash; configure apiKeyHash for externally accessible deployments',
      );
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

    // Initialize OIDC auth plugin from env if enabled
    if (this.config.oidcEnabled !== false) {
      try {
        const { createOIDCPluginFromEnv } = require('./oidcAuthPlugin');
        const plugin = createOIDCPluginFromEnv();
        if (plugin) {
          this.registerAuthPlugin(plugin);
          getGlobalLogger().info('HttpServer', 'OIDC auth plugin initialized', {
            issuer: plugin['config']?.issuer,
          });
        }
      } catch (e) {
        getGlobalLogger().debug('HttpServer', 'OIDC plugin not available', {
          error: (e as Error)?.message,
        });
      }
    }

    // Initialize SIEM forwarder from env if configured
    if (this.config.siemForwarder) {
      this.registerSIEMForwarder(this.config.siemForwarder);
    } else {
      try {
        const { createSIEMForwarderFromEnv } = require('./siemForwarder');
        const forwarder = createSIEMForwarderFromEnv();
        if (forwarder) {
          this.registerSIEMForwarder(forwarder);
          getGlobalLogger().info('HttpServer', 'SIEM forwarder initialized', {
            type: forwarder['config']?.type,
            endpoint: forwarder['config']?.endpoint,
          });
        }
      } catch (e) {
        getGlobalLogger().debug('HttpServer', 'SIEM forwarder not available', {
          error: (e as Error)?.message,
        });
      }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      const handler = (req: IncomingMessage, res: ServerResponse) => {
        // Track connection for graceful shutdown
        const socket = req.socket;
        this.connections.add(socket);
        res.on('finish', () => {
          this.connections.delete(socket);
        });
        this.handleRequest(req, res).catch((err) => {
          getGlobalLogger().error(
            'HttpServer',
            'Unhandled error in request handler',
            err instanceof Error ? err : new Error(String(err)),
          );
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
          }
        });
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

        // Tier 1.1: Install process crash handlers for the HTTP server
        try {
          const dlq = getDeadLetterQueue();
          const leaseManager = new LeaseManager();
          installProcessCrashHandlers({
            dlq,
            leaseManager,
            activeRunIds: () => {
              const ids: string[] = [];
              for (const [, entry] of this.runtimes) {
                // Each runtime tracks its own activeRuns — aggregate them
              }
              return ids;
            },
            leaseTokenFor: () => undefined,
            fencingEpochFor: () => undefined,
            tenantIdFor: () => undefined,
          });
        } catch (e) {
          getGlobalLogger().warn('HttpServer', 'Failed to install crash handlers', {
            error: (e as Error)?.message,
          });
        }

        resolve();
      });
      // Periodic cleanup of stale sessions and rate limit entries
      this.sessionCleanupTimer = setInterval(() => this.evictStaleSessions(), 5 * 60_000);
      if (typeof this.sessionCleanupTimer.unref === 'function') this.sessionCleanupTimer.unref();
    });
  }

  /** Return the port the server is actually listening on (useful when port=0). */
  getPort(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.config.port;
  }

  private evictStaleSessions(): void {
    const now = Date.now();
    // Evict stale sessions
    for (const [id, entry] of this.runtimes) {
      if (now - entry.lastAccessedAt > CommanderHttpServer.SESSION_TTL_MS) {
        entry.runtime.dispose();
        this.runtimes.delete(id);
      }
    }
    // Evict stale rate limit entries
    for (const [ip, entry] of this.rateLimitMap) {
      if (now > entry.resetAt) this.rateLimitMap.delete(ip);
    }
  }

  async stop(forceTimeoutMs: number = 10_000): Promise<void> {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.isShuttingDown = true;

      // Cancel all in-flight tool executions across all active runtimes
      for (const [, entry] of this.runtimes) {
        try {
          const cancelled = entry.runtime.cancelAllSteps();
          if (cancelled > 0) {
            getGlobalLogger().info('HttpServer', 'Cancelled in-flight steps', { cancelled });
          }
        } catch {
          /* best-effort */
        }
      }

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
          getGlobalLogger().warn('HttpServer', 'Force closing remaining connections', {
            remaining: this.connections.size,
          });
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

    // Compensation dashboard (HTML page — bypasses auth for local dev, but not rate limiting)
    if (
      segments[0] === 'dashboard' &&
      segments[1] === 'compensation' &&
      (req.method ?? 'GET') === 'GET'
    ) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml(this.bus));
      return;
    }

    // SOP dashboard (HTML page — bypasses auth for local dev)
    if (segments[0] === 'dashboard' && segments[1] === 'sop' && (req.method ?? 'GET') === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSOPDashboardHtml());
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

    // Authenticate: try API key first, then registered auth plugins (OIDC)
    const authResult = authenticate(req, this.authDisabled, this.apiKeyHash, this.authPlugins);
    if (!authResult.success) {
      // If auth plugins are registered, try async OIDC authentication
      if (this.authPlugins.length > 0) {
        const bearerToken = extractAuthKey(req);
        if (bearerToken) {
          let oidcAuthenticated = false;
          for (const plugin of this.authPlugins) {
            try {
              const result = await plugin.authenticate(bearerToken);
              if (result) {
                oidcAuthenticated = true;
                break;
              }
            } catch {
              continue;
            }
          }
          if (!oidcAuthenticated) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Unauthorized. Provide Authorization: Bearer <api-key> or valid OIDC token.',
              }),
            );
            return;
          }
          // Passed OIDC auth — continue to request handling
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Unauthorized. Provide Authorization: Bearer <token> header.',
            }),
          );
          return;
        }
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Unauthorized. Provide Authorization: Bearer <api-key> header.',
          }),
        );
        return;
      }
    }

    // Reject new run requests during graceful shutdown to prevent new runtimes
    // from being created while we're cancelling in-flight steps and draining connections.
    if (this.isShuttingDown && (segments[0] === 'api' || segments[0] === 'stream')) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end(JSON.stringify({ error: 'Server is shutting down. Please retry shortly.' }));
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
        const streamSegments = segments.slice(1);
        if (streamSegments[0] === 'cost') {
          await this.handleCostStreamRequest(req, res);
        } else if (streamSegments[0] === 'compensation') {
          await this.handleCompensationStreamRequest(req, res);
        } else if (streamSegments[0] === 'sop') {
          await this.handleSOPStreamRequest(req, res);
        } else {
          await this.handleStreamRequest(req, res, streamSegments);
        }
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      const status = err instanceof HttpRequestError ? err.statusCode : 500;
      if (err instanceof HttpRequestError) {
        getGlobalLogger().warn('HttpServer', err.message);
      } else {
        getGlobalLogger().error(
          'HttpServer',
          'Request error',
          err instanceof Error ? err : new Error(String(err)),
        );
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

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[],
    queryStr: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    if (segments[0] === 'v1') {
      const [, resource, id] = segments;
      if (resource === 'runtime') {
        if (method === 'POST') {
          const body = (await parseBody(req, this.config.maxBodyBytes)) as {
            sessionId?: string;
            provider?: string;
            model?: string;
          };
          const sessionId = body.sessionId ?? `session_${Date.now()}`;
          const runtime = new AgentRuntime();
          runtime.registerProvider(
            body.provider ?? 'openai',
            this.getDefaultProvider(body.provider),
          );
          this.runtimes.set(sessionId, { runtime, lastAccessedAt: Date.now() });
          sendJson(res, 201, { sessionId, status: 'created' });
          return;
        }
        if (id) {
          const entry = this.runtimes.get(id);
          if (!entry) {
            sendJson(res, 404, { error: 'Session not found' });
            return;
          }
          entry.lastAccessedAt = Date.now();
          if (method === 'GET') {
            sendJson(res, 200, {
              sessionId: id,
              status: 'active',
              sessionCount: this.runtimes.size,
            });
            return;
          }
          if (method === 'DELETE') {
            this.runtimes.delete(id);
            sendJson(res, 200, { status: 'deleted' });
            return;
          }
        }
      }
      if (resource === 'execute') {
        if (method === 'POST') {
          const body = (await parseBody(req, this.config.maxBodyBytes)) as {
            prompt: string;
            sessionId?: string;
            provider?: string;
            model?: string;
            outputSchema?: Record<string, unknown>;
          };
          const sessionId = body.sessionId ?? `session_${Date.now()}`;
          // Derive tenantId from API key (never trust request body for tenant)
          const tenantId = this.resolveTenantFromAuth(req);
          let entry = this.runtimes.get(sessionId);
          if (!entry) {
            // Enforce max sessions cap
            if (this.runtimes.size >= CommanderHttpServer.MAX_SESSIONS) this.evictStaleSessions();
            if (this.runtimes.size >= CommanderHttpServer.MAX_SESSIONS) {
              sendJson(res, 429, {
                error: 'Maximum sessions reached. Please reuse an existing session.',
              });
              return;
            }
            const runtime = new AgentRuntime();
            runtime.registerProvider(
              body.provider ?? 'openai',
              this.getDefaultProvider(body.provider),
            );
            entry = { runtime, lastAccessedAt: Date.now() };
            this.runtimes.set(sessionId, entry);
          }
          entry.lastAccessedAt = Date.now();
          const result = await entry.runtime.execute({
            agentId: `http-${sessionId}`,
            projectId: 'http-api',
            goal: body.prompt,
            availableTools: [
              'web_search',
              'web_fetch',
              'file_read',
              'file_write',
              'file_edit',
              'file_search',
              'file_list',
              'python_execute',
              'shell_execute',
              'memory_store',
              'memory_recall',
              'memory_list',
              'git',
              'browser_search',
              'browser_fetch',
            ],
            maxSteps: 50,
            tokenBudget: 100000,
            outputSchema: body.outputSchema,
            contextData: {},
            tenantId,
          });
          sendJson(res, 200, {
            sessionId,
            status: result.status,
            summary: result.summary,
            steps: result.steps?.length,
          });
          return;
        }
      }
      if (resource === 'bus') {
        if (method === 'GET') {
          const topic = queryStr
            ? (new URLSearchParams(queryStr).get('topic') ?? undefined)
            : undefined;
          sendJson(res, 200, {
            topics: this.bus.getActiveTopics(),
            history: this.bus
              .getHistory(topic as MessageBusTopic | undefined, 50)
              .map((m) => ({ topic: m.topic, source: m.source, timestamp: m.timestamp })),
          });
          return;
        }
      }
      if (resource === 'status') {
        sendJson(res, 200, {
          activeSessions: this.runtimes.size,
          busTopics: this.bus.getActiveTopics(),
          subscriberCounts: this.bus.getAllSubscriberCounts(),
        });
        return;
      }
      if (resource === 'atr') {
        const atrDeps: AtrHttpDeps = {
          scheduler: getExecutionScheduler(),
          resolveTenant: (r) => this.resolveTenantFromAuth(r),
        };
        const atrSegments = segments.slice(2);
        const r = await handleAtrHttpRequest(req, res, atrDeps, atrSegments, queryStr, {
          maxBodyBytes: this.config.maxBodyBytes,
        });
        if (r.handled) return;
      }
      if (resource === 'compensation' && method === 'GET') {
        // GET /api/v1/compensation — JSON compensation metrics snapshot
        sendJson(res, 200, getCompensationData(this.bus));
        return;
      }
      if (resource === 'sops') {
        // GET /api/v1/sops — list all SOPs
        // GET /api/v1/sops/:agentId — list SOPs for an agent
        // GET /api/v1/sops/:agentId/:runId — retrieve specific SOP as JSON
        // GET /api/v1/sops/:agentId/:runId/markdown — retrieve SOP as Markdown
        if (method === 'GET') {
          // Skip 'v1' and 'sops' (2 elements) to get agentId, runId, format
          const [, , agentId, runId, format] = segments;
          if (!agentId) {
            sendJson(res, 200, getSOPDashboardData());
            return;
          }
          if (!runId) {
            // List SOPs for a specific agent
            const allSops = listSOPs();
            const filtered = allSops.filter((s) => s.agentId === agentId);
            sendJson(res, 200, { agentId, sops: filtered, total: filtered.length });
            return;
          }
          if (format === 'markdown') {
            const md = getSOPMarkdown(agentId, runId);
            if (!md) {
              sendJson(res, 404, { error: 'SOP not found' });
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
            res.end(md);
            return;
          }
          // Default: return structured JSON
          const sop = getSOP(agentId, runId);
          if (!sop) {
            sendJson(res, 404, { error: 'SOP not found' });
            return;
          }
          sendJson(res, 200, sop);
          return;
        }
      }
      if (resource === 'observability') {
        const traceStore = new PersistentTraceStore();
        const obsDeps: ObservabilityDeps = {
          recorder: getTraceRecorder(traceStore),
          traceStore,
          resolveTenant: (r) => this.resolveTenantFromAuth(r),
        };
        const obsSegments = segments.slice(1);
        const r = await handleObservabilityRequest(req, res, obsDeps, obsSegments, queryStr);
        if (r.handled) return;
      }
    }
    sendJson(res, 404, { error: 'Unknown endpoint' });
  }

  private async handleStreamRequest(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[],
  ): Promise<void> {
    const [, resource, id] = segments;
    if (resource !== 'runtime' || !id) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const entry = this.runtimes.get(id);
    if (!entry) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    entry.lastAccessedAt = Date.now();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const stream = new SSEStream();
    stream.pipe(res);
    stream.emitStatus('session.started', id);
    const unsubStart = this.bus.subscribe('agent.started', () => {
      stream.emitStatus('agent.started');
    });
    const unsubComplete = this.bus.subscribe('agent.completed', () => {
      stream.emitStatus('agent.completed');
    });
    const unsubError = this.bus.subscribe('agent.failed', () => {
      stream.emitStatus('agent.error');
    });
    req.on('close', () => {
      unsubStart();
      unsubComplete();
      unsubError();
      stream.close();
    });
  }

  private async handleCompensationStreamRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const stream = new SSEStream();
    // Write headers after pipe() so data path is fully wired (SSEStream dispatches
    // retry directive in constructor before subscribers exist — acceptable since the
    // browser default reconnect timing is sufficient)
    stream.pipe(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Subscribe to compensation bus events and emit structured snapshots
    const unsubPlanned = this.bus.subscribe('tool.compensation_planned', () => {
      if (stream.isClosed) return;
      stream.emitStructured(
        'compensation.update',
        getCompensationData(this.bus) as unknown as Record<string, unknown>,
      );
    });
    const unsubStep = this.bus.subscribe('tool.compensation_step', () => {
      if (stream.isClosed) return;
      stream.emitStructured(
        'compensation.update',
        getCompensationData(this.bus) as unknown as Record<string, unknown>,
      );
    });

    req.on('close', () => {
      unsubPlanned();
      unsubStep();
      stream.close();
    });
  }

  private async handleSOPStreamRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stream = new SSEStream();
    stream.pipe(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Subscribe to SOP bus events and emit structured snapshots
    const unsubGenerated = this.bus.subscribe('sop.generated', () => {
      if (stream.isClosed) return;
      stream.emitStructured(
        'sop.update',
        getSOPDashboardData() as unknown as Record<string, unknown>,
      );
    });

    req.on('close', () => {
      unsubGenerated();
      stream.close();
    });
  }

  private async handleCostStreamRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const stream = new SSEStream();
    stream.pipe(res);

    const costModel = getCostModel();
    const sessionCosts = new Map<
      string,
      {
        totalCost: number;
        totalTokens: number;
        byModel: Record<string, { cost: number; tokens: number; calls: number }>;
      }
    >();

    const unsubLlm = this.bus.subscribe('tool.executed', (msg) => {
      const payload = msg.payload as {
        model?: string;
        provider?: string;
        tokens?: number;
        runId?: string;
      };
      if (!payload.model || !payload.provider) return;
      const runId = payload.runId ?? 'unknown';
      const tokens = payload.tokens ?? 0;
      const cost = costModel.calculate(payload.provider, payload.model, {
        input: tokens,
        output: 0,
        cached: 0,
        reasoning: 0,
        total: tokens,
      });

      let session = sessionCosts.get(runId);
      if (!session) {
        session = { totalCost: 0, totalTokens: 0, byModel: {} };
        sessionCosts.set(runId, session);
      }
      session.totalCost += cost.totalCostUsd;
      session.totalTokens += tokens;

      const modelKey = `${payload.provider}:${payload.model}`;
      if (!session.byModel[modelKey]) {
        session.byModel[modelKey] = { cost: 0, tokens: 0, calls: 0 };
      }
      session.byModel[modelKey].cost += cost.totalCostUsd;
      session.byModel[modelKey].tokens += tokens;
      session.byModel[modelKey].calls++;

      stream.emitStructured('cost.update', {
        runId,
        totalCost: session.totalCost,
        totalTokens: session.totalTokens,
        byModel: session.byModel,
      });
    });

    req.on('close', () => {
      unsubLlm();
      stream.close();
    });
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
    getGlobalLogger().info(
      'HttpServer',
      `MCP Server "${name}" registered with ${tools.size} tools`,
    );
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
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }

  /**
   * Register an authentication plugin (e.g. OIDC, SAML).
   * Plugins are tried after the built-in API key auth.
   */
  registerAuthPlugin(plugin: AuthPlugin): void {
    this.authPlugins.push(plugin);
    getGlobalLogger().info('HttpServer', `Auth plugin registered: ${plugin.name}`);
  }

  /**
   * Register a SIEM forwarder for security log forwarding.
   * Wire security audit events from the bus to the forwarder.
   */
  registerSIEMForwarder(forwarder: SIEMForwarder): void {
    this.siemForwarder = forwarder;

    // Subscribe to security events on the message bus
    if (this.securityEventUnsub) {
      this.securityEventUnsub();
    }
    this.securityEventUnsub = this.bus.subscribe('security.event', (msg) => {
      if (!this.siemForwarder) return;
      const event = msg.payload as unknown as SecurityEvent;
      if (!event || !event.type) return;

      this.siemForwarder.forward({
        timestamp: event.timestamp,
        type: event.type,
        severity: event.severity,
        source: event.source,
        message: event.message,
        details: event.details,
        context: event.context,
        eventId: event.id,
      });
    });

    getGlobalLogger().info('HttpServer', `SIEM forwarder registered: ${forwarder['config']?.type}`);
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
      case 'openai':
        return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? '' });
      case 'anthropic':
        return new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
      case 'google':
        return new GoogleProvider({ apiKey: process.env.GOOGLE_API_KEY ?? '' });
      case 'openrouter':
        return new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY ?? '' });
      case 'deepseek':
        return new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY ?? '' });
      case 'glm':
        return new GLMProvider({ apiKey: process.env.ZHIPU_API_KEY ?? '' });
      case 'mimo':
        return new MiMoProvider({ apiKey: process.env.MIMO_API_KEY ?? '' });
      case 'xiaomi':
        return new XiaomiProvider({ apiKey: process.env.XIAOMI_API_KEY ?? '' });
      case 'ollama':
        return new OllamaProvider({});
      case 'vllm':
        return new VLLMProvider({});
      case 'cohere':
        return new CohereProvider({
          apiKey: (process.env.CO_API_KEY || process.env.COHERE_API_KEY) ?? '',
        });
      case 'mistral':
        return new MistralProvider({ apiKey: process.env.MISTRAL_API_KEY ?? '' });
      case 'groq':
        return new GroqProvider({ apiKey: process.env.GROQ_API_KEY ?? '' });
      case 'together':
        return new TogetherProvider({ apiKey: process.env.TOGETHER_API_KEY ?? '' });
      case 'perplexity':
        return new PerplexityProvider({
          apiKey: (process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY) ?? '',
        });
      case 'fireworks':
        return new FireworksProvider({ apiKey: process.env.FIREWORKS_API_KEY ?? '' });
      case 'replicate':
        return new ReplicateProvider({
          apiKey: (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY) ?? '',
        });
      case 'bedrock':
        return new BedrockProvider({});
      case 'xai':
        return new XAIProvider({ apiKey: process.env.XAI_API_KEY ?? '' });
      case 'anyscale':
        return new AnyscaleProvider({ apiKey: process.env.ANYSCALE_API_KEY ?? '' });
      case 'deepinfra':
        return new DeepInfraProvider({ apiKey: process.env.DEEPINFRA_API_KEY ?? '' });
      default:
        return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? '' });
    }
  }
}

export function createHttpServer(config?: Partial<HttpServerConfig>): CommanderHttpServer {
  return new CommanderHttpServer(config);
}
