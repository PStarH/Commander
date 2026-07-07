import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'node:crypto';
import { IncomingMessage, ServerResponse, createServer as createNodeHttpServer } from 'node:http';
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from 'node:https';
import type { LLMProvider, MessageBusTopic, Tool } from './types';
import type { JSONRPCRequest } from '../mcp/types';
import { AgentRuntime } from './agentRuntime';
import { SSEStream } from './sseStream';
import { getMessageBus } from './messageBus';
import { createProvider } from './providers/providerRegistry';
import { initSecureApiKeyResolver } from '../security/secureApiKeyResolver'; // retained for test overrides
import { getEncryptedSecretsVault } from '../security/encryptedSecretsVault';
import { MCPServer } from '../mcp/server';
import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from './metricsCollector';
import { installProcessCrashHandlers } from './processCrashSafety';
import { extractTraceFromHeaders, createTraceContext, runWithTrace } from './distributedTracing';
import { RecoveryBootstrapper } from '../atr/recoveryBootstrapper';
import { getDeadLetterQueue } from './deadLetterQueueSingleton';
import { openApiSpec } from './openapi';
import { handleAtrHttpRequest, type AtrHttpDeps } from '../atr/atrHttp';
import { handleSLOOperationsRequest } from '../observability/sloOperations';
import { getAPIVersionManager } from './apiVersioning';
import { sendProblem, ApiError, errorToProblem } from './apiErrors';
import { validateOrThrow, Schemas } from './apiValidation';
import { getExecutionScheduler } from '../atr/scheduler';
import { handleObservabilityRequest, type ObservabilityDeps } from '../observability/httpApi';
import {
  handleRoutingDashboardRequest,
  type RoutingDashboardDeps,
} from '../observability/routingDashboard';
import { getCompensationData, renderDashboardHtml } from './compensationDashboard';
import {
  type MemoryLayer,
  type MemoryQuery,
  type MemoryEntry,
  getGlobalThreeLayerMemory,
} from '../threeLayerMemory.js';
import { runWithTenant } from './tenantContext';
import { TokenGovernor } from './tokenGovernor';
import {
  getSOPDashboardData,
  getSOPDashboardDataAsync,
  listSOPs,
  listSOPsAsync,
  getSOP,
  getSOPAsync,
  getSOPMarkdown,
  getSOPMarkdownAsync,
  renderSOPDashboardHtml,
  renderSOPDashboardHtmlAsync,
} from './sopDashboard';
import { getTraceRecorder } from './executionTrace';
import { getCostModel } from '../observability/costModel';
import { getGlobalExplorationEventLog } from '../ultimate/topologyStores';
import { PersistentTraceStore } from './traceStore';
import { LeaseManager } from '../atr/leaseManager';
import type { AuthPlugin } from './authPlugin';
import type { SAMLAuthPlugin } from './samlAuthPlugin';
import type { SIEMForwarder } from './siemForwarder';
import type { SecurityEvent } from '../security/securityAuditLogger';
import { type DataRetentionJanitor, getDataRetentionJanitor } from '../storage/dataRetention';
import {
  DETECTOR_TO_ASI_OVERRIDE,
  SECURITY_EVENT_TYPE_TO_ASI,
  getOwaspAsiTop10,
} from '../security/owaspAgenticAiTop10';
import { getComplianceAuditManager } from '../security/complianceAuditReport';
import { getEuAiActComplianceReporter } from '../security/euAiActCompliance';

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
  /** Require authentication on health/readiness/metrics endpoints. Default: false. */
  protectHealthEndpoints?: boolean;
}

function pickTopology(
  taskText: string,
  wordCount: number,
): {
  topology: 'SINGLE' | 'SEQUENTIAL' | 'PARALLEL' | 'HIERARCHICAL';
  estimatedCostBand: 'low' | 'medium' | 'high';
  estimatedSteps: number;
} {
  if (wordCount > 200 || /\b(delegate|orchestrate|coordinat)\b/i.test(taskText)) {
    return { topology: 'HIERARCHICAL', estimatedCostBand: 'high', estimatedSteps: 7 };
  }
  if (wordCount > 80 || /\b(in parallel|concurrently|simultaneously)\b/i.test(taskText)) {
    return { topology: 'PARALLEL', estimatedCostBand: 'high', estimatedSteps: 5 };
  }
  if (wordCount > 30 || /\b(and|then|also|plus|after|before)\b/i.test(taskText)) {
    return { topology: 'SEQUENTIAL', estimatedCostBand: 'medium', estimatedSteps: 3 };
  }
  return { topology: 'SINGLE', estimatedCostBand: 'low', estimatedSteps: 1 };
}

/**
 * Plan-v2 tool-required extraction (audit MED item 3).
 *
 * Maps common English task keywords to MCP / runtime tool names so the
 * pre-budget response can flag missing capabilities before /api/v1/execute
 * wastes tokens. This is a *heuristic* — its output is a hint, not a
 * contract — but it shifts the heuristic-token surface from "we don't know
 * what tools the task needs" to a structured requiredTools[] that calling
 * SDKs can diff against their known provider.toolRegistry().
 *
 * Keyword map is intentionally minimal to keep false-positive rate low.
 * Tools not listed are returned as-is from upstream `_requiredTools` (none
 * today) without failing the plan.
 */
function extractRequiredTools(taskText: string): string[] {
  const KEYWORD_MAP: Array<[string, string[]]> = [
    ['web_search', ['search', 'look up', 'find online', 'find on the web', 'search for']],
    ['web_fetch', ['fetch url', 'retrieve url', 'download page', 'fetch page', 'curl']],
    ['file_read', ['read file', 'open file', 'view file', 'cat file']],
    ['file_write', ['write file', 'create file', 'save to disk', 'create document']],
    ['browser_search', ['browser', 'navigate', 'click button', 'go to page', 'visit page']],
    ['python_execute', ['compute', 'calculate', 'python', 'run computation', 'evaluate']],
    ['memory_recall', ['remember', 'recall', 'from memory', 'previous', 'retrieve memory']],
    ['git', ['commit', 'push', 'merge branch', 'check git status', 'create branch']],
    ['shell_execute', ['run shell', 'execute command', 'shell command', 'bash ']],
  ];
  const lower = taskText.toLowerCase();
  const tools = new Set<string>();
  for (const [tool, keywords] of KEYWORD_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) tools.add(tool);
  }
  return Array.from(tools);
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
  protectHealthEndpoints: process.env.COMMANDER_AUTH_PROTECT_HEALTH === 'true',
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
      } catch (err) {
        reportSilentFailure(err, 'httpServer:211');
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
  // SSE connection tracking per IP (prevent connection-exhaustion DoS)
  private sseConnections: Map<string, Set<ServerResponse>> = new Map();
  private static readonly MAX_SSE_PER_IP = 10;
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
  private retentionJanitor: DataRetentionJanitor | null = null;

  constructor(config?: Partial<HttpServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeAuth();
    this.initializeSecretVault();
  }

  /**
   * Security (G5): Initialize the EncryptedSecretsVault and wire it into the
   * SecureApiKeyResolver. When the vault has a secret stored, keys are
   * decrypted from AES-256-GCM at-rest storage instead of being read from
   * plaintext environment variables.
   *
   * In production, COMMANDER_MASTER_KEY must be set (>= 32 chars) or the vault
   * will refuse to initialize. In dev, a temporary key is auto-generated.
   * If initialization fails for any reason, the resolver falls back to env vars.
   */
  private initializeSecretVault(): void {
    try {
      // The SecureApiKeyResolver now resolves the vault lazily via the
      // tenant-aware getEncryptedSecretsVault() singleton. We only need to
      // verify the vault initializes successfully — no explicit wiring required.
      const vault = getEncryptedSecretsVault();
      // Sanity check: vault must be constructible. Master key resolution may
      // throw in production if COMMANDER_MASTER_KEY is unset.
      void vault;
      getGlobalLogger().info(
        'HttpServer',
        'EncryptedSecretsVault initialized — API keys will be resolved from tenant-aware encrypted vault first',
      );
    } catch (err) {
      getGlobalLogger().warn(
        'HttpServer',
        'EncryptedSecretsVault initialization failed — falling back to environment variables',
        { error: (err as Error)?.message },
      );
    }
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

    // Initialize SAML auth plugin from env if configured
    try {
      const { createSAMLPluginFromEnv } = require('./samlAuthPlugin');
      const plugin = createSAMLPluginFromEnv();
      if (plugin) {
        this.registerAuthPlugin(plugin);
        getGlobalLogger().info('HttpServer', 'SAML auth plugin initialized', {
          idpEntityId: plugin['config']?.idpEntityId,
        });
      }
    } catch (e) {
      getGlobalLogger().debug('HttpServer', 'SAML plugin not available', {
        error: (e as Error)?.message,
      });
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

  /**
   * Build live HealthSources from the server's runtime state so the
   * HealthCollector reports real component status instead of "not wired".
   *
   * Each getter is called fresh on every collect() so the returned data
   * reflects current system state.  When no runtime is registered yet
   * (cold start), the source is omitted so the check falls back to the
   * "not wired" default rather than crashing.
   */
  private buildHealthSources(): import('./healthCheck').HealthSources {
    const sources: import('./healthCheck').HealthSources = {};

    // Event bus info — always available (server owns the bus singleton).
    sources.getEventBusInfo = () => ({
      activeTopics: this.bus.getActiveTopics().length,
      subscriberCount: Object.values(this.bus.getAllSubscriberCounts()).reduce((a, b) => a + b, 0),
    });

    // Circuit breaker + provider info — from the first active runtime.
    const firstRuntime = this.runtimes.values().next();
    if (!firstRuntime.done && firstRuntime.value?.runtime) {
      const rt = firstRuntime.value.runtime;

      sources.getCircuitBreakerInfo = () => {
        try {
          const health = rt.getProviderHealth();
          const open = health.filter((h) => h.state === 'open').map((h) => h.provider);
          return { open, total: health.length };
        } catch {
          return { open: [], total: 0 };
        }
      };

      sources.getProviderInfo = () => {
        try {
          const health = rt.getProviderHealth();
          const available = health.filter((h) => h.state !== 'open').length;
          return { available, total: health.length };
        } catch {
          return { available: 0, total: 0 };
        }
      };

      sources.getCompensationInfo = () => {
        try {
          const reg = rt.getCompensationRegistry();
          const pending = reg.getPendingCount?.() ?? 0;
          const compensated = reg.getCompensatedCount?.() ?? 0;
          return { pending, compensated };
        } catch {
          return { pending: 0, compensated: 0 };
        }
      };
    }

    // DLQ info — from the global dead-letter-queue singleton.
    sources.getDLQInfo = () => {
      try {
        const dlq = getDeadLetterQueue();
        const byCategory = dlq.getStats();
        const totalEntries = byCategory.reduce((sum, c) => sum + c.count, 0);
        return { totalEntries, byCategory };
      } catch {
        return { totalEntries: 0, byCategory: [] };
      }
    };

    return sources;
  }

  /**
   * Probe whether the server can actually satisfy a plan's required tools.
   *
   * Returns 'verified' when at least one runtime has a registered provider
   * AND all requiredTools are found in either the runtime's tool registry
   * or the MCP server's tool list.  Returns 'degraded' when a runtime
   * exists but is missing tools or providers.  Returns 'unknown' on timeout
   * or when no runtime is registered at all.
   *
   * This replaces the previous fake probe that instantiated an AgentRuntime
   * with a dummy 'probe' apiKey and always returned 'verified'.
   */
  private async probeCapability(
    requiredTools: string[],
  ): Promise<'verified' | 'degraded' | 'unknown'> {
    const timeout = new Promise<'unknown'>((res) => setTimeout(() => res('unknown'), 200));

    const check = (async (): Promise<'verified' | 'degraded' | 'unknown'> => {
      // No runtime registered → cannot verify anything.
      if (this.runtimes.size === 0) return 'unknown';

      const firstEntry = this.runtimes.values().next();
      if (firstEntry.done || !firstEntry.value?.runtime) return 'unknown';
      const rt = firstEntry.value.runtime;

      // Check provider availability.
      const providerHealth = rt.getProviderHealth();
      const hasProvider = providerHealth.some((h) => h.state !== 'open');
      if (!hasProvider) return 'degraded';

      // If no tools required, provider availability is sufficient.
      if (requiredTools.length === 0) return 'verified';

      // Check tool satisfaction: MCP server tools or runtime tool registry.
      const availableToolNames = new Set<string>();

      // Collect tools from the MCP server if registered.
      if (this.mcpServer) {
        try {
          const mcpTools = this.mcpServer.listTools();
          for (const t of mcpTools) {
            availableToolNames.add(t.name);
          }
        } catch {
          // MCP server listTools failed — skip.
        }
      }

      // Collect tools from the runtime's tool registry.
      try {
        const runtimeTools = rt.listToolNames();
        for (const name of runtimeTools) {
          availableToolNames.add(name);
        }
      } catch {
        // Runtime tool list failed — skip.
      }

      // Verify all required tools are available.
      const missing = requiredTools.filter((t) => !availableToolNames.has(t));
      return missing.length === 0 ? 'verified' : 'degraded';
    })();

    return Promise.race([check, timeout]);
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

        // P0: Set up W3C distributed trace context for each request.
        // Extracts trace context from incoming headers (x-request-id,
        // x-trace-id, x-span-id, x-baggage) or creates a new one. This
        // propagates requestId/traceId/spanId through AsyncLocalStorage
        // to all downstream logs, LLM calls, tool executions, and
        // message bus events — enabling end-to-end request tracing.
        const rawRequestId = req.headers['x-request-id'];
        const requestId = Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId;
        const traceContext = extractTraceFromHeaders(req.headers) ?? createTraceContext(requestId);

        runWithTrace(traceContext, () => {
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
              for (const [,] of this.runtimes) {
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

        // P0: Zombie run recovery on server startup. Scans the RunLedger
        // for runs left in EXECUTING/VERIFYING/PAUSED by a crashed process,
        // fences them, and aborts+compensates or reclaims for resume.
        try {
          const result = RecoveryBootstrapper.bootstrap();
          if (result.scanned > 0) {
            getGlobalLogger().info('HttpServer', 'Recovery bootstrap scan completed', {
              scanned: result.scanned,
              recovered: result.recovered,
              aborted: result.aborted,
              skipped: result.skipped,
            });
          }
        } catch (e) {
          getGlobalLogger().warn('HttpServer', 'Recovery bootstrap scan failed', {
            error: (e as Error)?.message,
          });
        }

        // SOC 2 C1.2 / GDPR Art 17 disposal — schedule the retention
        // janitor at boot. Hourly cadence matches the typical mtime
        // windows in DEFAULT_RETENTION_TABLE (sop-artifacts 1y, traces
        // 90d, inbox 30d, tmp-cbor 24h). auditOnDelete is intentionally
        // off on the security.event bus so housekeeping doesn't inflate
        // OWASP ASI10 signals (see DataRetentionJanitor docstring).
        // NOTE: AgentRuntime.constructor() also calls schedule(); the
        // module-level `scheduledRootDirs: Set<string>` dedup in
        // storage/dataRetention.ts ensures only one setInterval runs
        // across the process regardless of which surface claims first.
        try {
          this.retentionJanitor = getDataRetentionJanitor({
            rootDir: process.cwd(),
            dryRun: false,
          });
          // `claimed` lets the log disambiguate: true means THIS
          // httpServer owns the recurring tick; false means another
          // surface (e.g. AgentRuntime.constructor) claimed first and
          // the module-level `scheduledRootDirs` Set deduped us. See
          // DataRetentionJanitor.schedule() JSDoc for the full
          // claimed-vs-dedup-catch glossary.
          const claimed = this.retentionJanitor.schedule(60 * 60 * 1000, false);
          getGlobalLogger().info(
            'HttpServer',
            claimed
              ? `DataRetentionJanitor scheduled (1h interval) [rootDir=${this.retentionJanitor.rootDir}, claimed]`
              : `DataRetentionJanitor dedup-catch — tick already owned (rootDir=${this.retentionJanitor.rootDir})`,
          );
        } catch (e) {
          getGlobalLogger().warn('HttpServer', 'Failed to schedule retention janitor', {
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
    if (this.retentionJanitor) {
      // Stop the recurring tick before draining the HTTP server so the
      // janitor can't race with shutdown on a half-deleted NDJSON file.
      this.retentionJanitor.stopSchedule();
      this.retentionJanitor = null;
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
        } catch (err) {
          reportSilentFailure(err, 'httpServer:514');
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

  /** Full auth gate (API key + OIDC). Returns true if allowed; sends 401 and returns false otherwise. */
  private async authenticateRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const authResult = authenticate(req, this.authDisabled, this.apiKeyHash, this.authPlugins);
    if (authResult.success) return true;

    // If auth plugins are registered, try async OIDC authentication
    if (this.authPlugins.length > 0) {
      const bearerToken = extractAuthKey(req);
      if (bearerToken) {
        for (const plugin of this.authPlugins) {
          try {
            const result = await plugin.authenticate(bearerToken);
            if (result) return true;
          } catch (err) {
            reportSilentFailure(err, 'httpServer:558');
            continue;
          }
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Unauthorized. Provide Authorization: Bearer <api-key> or valid OIDC token.',
          }),
        );
        return false;
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Unauthorized. Provide Authorization: Bearer <token> header.',
        }),
      );
      return false;
    }

    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Unauthorized. Provide Authorization: Bearer <api-key> header.',
      }),
    );
    return false;
  }

  /** Read the full request body as a string (for POST/PUT requests). */
  private async readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
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

    // GAP-31: Health endpoint bypasses auth and rate limiting by default.
    // Set COMMANDER_AUTH_PROTECT_HEALTH=true to require auth on health/metrics/readiness.
    //
    // Audit-fix: previously returned status: 'ok' unconditionally (security
    // theater — load balancers would route traffic to a process whose bus
    // had crashed). Now reports the same HealthCollector probe as /health/detailed
    // and reflects real degradedComponents[].
    const protectHealth = this.config.protectHealthEndpoints ?? false;
    if (segments[0] === 'health' && (req.method ?? 'GET') === 'GET') {
      if (protectHealth && !(await this.authenticateRequest(req, res))) return;
      const { HealthCollector } = await import('./healthCheck');
      const collector = new HealthCollector({ sources: this.buildHealthSources() });
      const report = await collector.collect();
      const status = report.status === 'healthy' ? 'healthy' : 'degraded';
      sendJson(res, status === 'healthy' ? 200 : 503, {
        status,
        uptime: process.uptime(),
        activeSessions: this.runtimes.size,
        busTopics: this.bus.getActiveTopics().length,
        degradedComponents: report.degradedComponents ?? [],
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Detailed health check with component statuses
    if (segments[0] === 'health' && segments[1] === 'detailed' && (req.method ?? 'GET') === 'GET') {
      if (protectHealth && !(await this.authenticateRequest(req, res))) return;
      const { HealthCollector } = await import('./healthCheck');
      const collector = new HealthCollector({ sources: this.buildHealthSources() });
      const report = await collector.collect();
      sendJson(res, report.status === 'healthy' ? 200 : 503, {
        ...report,
        uptime: process.uptime(),
        activeSessions: this.runtimes.size,
        pid: process.pid,
        nodeVersion: process.version,
      });
      return;
    }

    // GAP-33: Metrics endpoint for monitoring (JSON + OpenMetrics text)
    if (segments[0] === 'metrics' && (req.method ?? 'GET') === 'GET') {
      if (protectHealth && !(await this.authenticateRequest(req, res))) return;
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

    // SLO Operations endpoints: /api/v1/slo, /api/v1/alerts, /api/v1/incidents
    if (
      (segments[0] === 'slo' || segments[0] === 'alerts' || segments[0] === 'incidents') &&
      segments.length >= 1
    ) {
      if (protectHealth && !(await this.authenticateRequest(req, res))) return;
      let reqBody: string | undefined;
      if (req.method === 'POST' || req.method === 'PUT') {
        reqBody = await this.readRequestBody(req);
      }
      const result = handleSLOOperationsRequest(req.method ?? 'GET', segments, reqBody);
      if (result) {
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
      } else {
        sendJson(res, 404, { error: 'SLO operations endpoint not found' });
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
    //
    // Async migration: renderSOPDashboardHtmlAsync uses fs.promises under
    // the hood, so the response can be prepared in the background while
    // other in-flight requests continue to be served. Previously, the sync
    // version did readdirSync + readFileSync + statSync per SOP file,
    // which lagged the event loop for the entire render.
    if (segments[0] === 'dashboard' && segments[1] === 'sop' && (req.method ?? 'GET') === 'GET') {
      try {
        const html = await renderSOPDashboardHtmlAsync();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        getGlobalLogger().warn('HttpServer', 'Failed to render SOP dashboard', {
          error: (err as Error)?.message,
        });
        reportSilentFailure(err, 'httpServer:renderSOPDashboardHtmlAsync');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to render SOP dashboard');
      }
      return;
    }

    // Readiness probe (separate from health — checks deps).
    //
    // Audit-fix: previously hardcoded `const healthy = true` and reported
    // status: 'ready' regardless of bus reachability or store availability.
    // Kubernetes-style readiness gates relied on this signal — a process
    // whose executor/evaluator/runtime registry had crashed would still pass
    // readiness, silently forwarding 5xx-ing traffic. Now reflects real
    // HealthCollector.status and degrades to 503 when any component is
    // unhealthy.
    if (segments[0] === 'ready' && (req.method ?? 'GET') === 'GET') {
      if (protectHealth && !(await this.authenticateRequest(req, res))) return;
      const mem = process.memoryUsage();
      const { HealthCollector } = await import('./healthCheck');
      const collector = new HealthCollector({ sources: this.buildHealthSources() });
      const report = await collector.collect();
      const ready = report.status === 'healthy';
      sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        uptime: process.uptime(),
        activeSessions: this.runtimes.size,
        busTopics: this.bus.getActiveTopics().length,
        memory: { rss: mem.rss, heapUsed: mem.heapUsed },
        degradedComponents: report.degradedComponents ?? [],
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // SAML SSO endpoints must be public (the user has no session yet).
    if (
      segments[0] === 'api' &&
      segments[1] === 'v1' &&
      segments[2] === 'auth' &&
      segments[3] === 'saml'
    ) {
      await this.handleSamlAuthRequest(req, res, segments, queryStr);
      return;
    }

    if (!(await this.authenticateRequest(req, res))) return;

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
      // Stream alias: GET /api/v1/stream/{sessId}
      // Mirrors /stream/runtime/{sessId} under the /api/v1 surface so SDK
      // callers using the documented /api/v1/* path family don't have to
      // fall back to the legacy /stream/{resource}/{id} layout. The legacy
      // route continues to work for backward compatibility.
      if (
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'stream' &&
        (req.method ?? 'GET') === 'GET' &&
        segments[3]
      ) {
        // /api/v1/stream/{sessId} → handleStreamRequest expects segments
        // = [resource, id, ...] where resource is 'runtime'.
        const sessionId = segments[3];
        const streamSegments = ['runtime', sessionId];
        await this.handleStreamRequest(req, res, streamSegments);
        return;
      }
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
      // Standardized error response via RFC 7807 Problem Details
      if (err instanceof ApiError) {
        sendProblem(res, err.code, err.message, {
          instance: req.url ?? '',
          requestId: this.getRequestId(req),
          errors: err.fieldErrors,
          extensions: err.extensions,
        });
      } else if (err instanceof HttpRequestError) {
        const code =
          err.statusCode === 413
            ? 'PAYLOAD_TOO_LARGE'
            : err.statusCode === 400
              ? 'INVALID_JSON'
              : 'INTERNAL_ERROR';
        sendProblem(res, code, err.message, {
          instance: req.url ?? '',
          requestId: this.getRequestId(req),
        });
        getGlobalLogger().warn('HttpServer', err.message);
      } else {
        getGlobalLogger().error(
          'HttpServer',
          'Request error',
          err instanceof Error ? err : new Error(String(err)),
        );
        sendProblem(res, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err), {
          instance: req.url ?? '',
          requestId: this.getRequestId(req),
        });
      }
    }
  }

  private applyCommonHeaders(req: IncomingMessage, res: ServerResponse): void {
    const requestId = this.getRequestId(req);
    res.setHeader('X-Request-Id', requestId);

    // Security: Set essential security headers on all responses.
    // Per Node.js security best practices and OWASP HTTP Headers Cheat Sheet.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Security: X-XSS-Protection is deprecated; set to 0 and rely on CSP.
    res.setHeader('X-XSS-Protection', '0');
    if (this.config.https) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    if (!this.config.cors) return;

    const allowedOrigins = this.config.corsAllowedOrigins;
    const origin = req.headers.origin;
    const allowAll = allowedOrigins.includes('*');
    if (origin && (allowAll || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      if (!allowAll) res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Request-Id, Accept-Version',
    );

    // API versioning: add stability and version headers for API endpoints
    const url = req.url ?? '/';
    const pathPart = url.split('?')[0];
    if (
      pathPart.startsWith('/api/') ||
      pathPart.startsWith('/slo') ||
      pathPart.startsWith('/alerts') ||
      pathPart.startsWith('/incidents')
    ) {
      try {
        const versionMgr = getAPIVersionManager();
        const deprecationHeaders = versionMgr.getDeprecationHeaders(req.method ?? 'GET', pathPart);
        const stabilityHeaders = versionMgr.getStabilityHeaders(req.method ?? 'GET', pathPart);
        for (const [key, val] of Object.entries({ ...deprecationHeaders, ...stabilityHeaders })) {
          res.setHeader(key, val);
        }
        versionMgr.recordRequest(req.method ?? 'GET', pathPart);
      } catch {
        // Version manager not available — skip headers
      }
    }
  }

  private getRequestId(req: IncomingMessage): string {
    const incoming = req.headers['x-request-id'];
    if (typeof incoming === 'string' && incoming.trim()) return incoming;
    if (Array.isArray(incoming) && incoming[0]?.trim()) return incoming[0];
    return crypto.randomUUID();
  }

  /**
   * Handle public SAML 2.0 SSO endpoints (/api/v1/auth/saml/login and /acs).
   * Called before API key authentication so unauthenticated users can log in.
   */
  private async handleSamlAuthRequest(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[],
    queryStr: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const action = segments[4];
    const samlPlugin = this.authPlugins.find((p) => p.name === 'saml') as
      | SAMLAuthPlugin
      | undefined;
    if (!samlPlugin) {
      sendJson(res, 501, { error: 'SAML authentication is not configured' });
      return;
    }

    if (action === 'login' && method === 'GET') {
      const relayState = queryStr
        ? (new URLSearchParams(queryStr).get('relayState') ?? undefined)
        : undefined;
      const redirectUrl = samlPlugin.createLoginRedirectUrl(relayState);
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      return;
    }

    if (action === 'acs' && method === 'POST') {
      const rawBody = await this.readRequestBody(req);
      const body = new URLSearchParams(rawBody);
      const samlResponse = body.get('SAMLResponse');
      const relayState = body.get('RelayState') ?? undefined;
      if (!samlResponse) {
        sendJson(res, 400, { error: 'SAMLResponse missing' });
        return;
      }
      const result = await samlPlugin.validateSamlResponse(samlResponse, {
        allowIdpInitiated: true,
      });
      if (!result) {
        sendJson(res, 401, { error: 'SAML authentication failed' });
        return;
      }
      sendJson(res, 200, {
        userId: result.userId,
        username: result.username,
        role: result.role,
        tenantId: result.tenantId,
        relayState,
      });
      return;
    }

    sendJson(res, 404, { error: 'Unknown SAML endpoint. Use /login or /acs.' });
  }

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[],
    queryStr: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    if (segments[0] === 'v1') {
      const [, resource] = segments;
      const id = segments[3];
      if (resource === 'runtime') {
        if (method === 'POST') {
          const rawBody = await parseBody(req, this.config.maxBodyBytes);
          const body = validateOrThrow<{
            sessionId?: string;
            provider?: string;
            model?: string;
            apiKey?: string;
            systemPrompt?: string;
            maxTokens?: number;
          }>(rawBody, Schemas.createRuntime);
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
          const rawBody = await parseBody(req, this.config.maxBodyBytes);
          // Schema validation — standardized error response
          const body = validateOrThrow<{
            prompt: string;
            sessionId?: string;
            provider?: string;
            model?: string;
            outputSchema?: Record<string, unknown>;
            maxTokens?: number;
            temperature?: number;
            runtimeId?: string;
            tools?: string[];
          }>(rawBody, Schemas.execute);
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
      // /api/v1/memory — POST { action: 'write' | 'query' | 'stats', ... }
      // Single endpoint keeps auth + rate-limit + tenant resolution in one place
      // and matches the SDK's `client.writeMemory / queryMemory / getMemoryStats`
      // trio behind one URL surface. Memory backend is the tenant-aware
      // singleton; we wrap the body in runWithTenant so per-tenant
      // isolation is preserved (no global fallback used).
      if (resource === 'memory' && method === 'POST') {
        let body: {
          action?: string;
          content?: string;
          importance?: number;
          tags?: string[];
          layer?: MemoryLayer;
          id?: string;
          keywords?: string[];
          context?: string;
          importanceThreshold?: number;
          limit?: number;
          since?: string;
        };
        try {
          body = (await parseBody(req, this.config.maxBodyBytes)) as typeof body;
        } catch (err) {
          // parseBody can throw HttpRequestError(413); let the outer
          // handleRequest catch apply the correct status code.
          if (err instanceof HttpRequestError) throw err;
          throw err;
        }
        const action = body.action;
        const tenantId = this.requireTenant(req, res);
        if (res.writableEnded) return;
        try {
          await runWithTenant(tenantId, async () => {
            const memory = getGlobalThreeLayerMemory();
            if (action === 'write') {
              if (typeof body.content !== 'string' || body.content.length === 0) {
                sendJson(res, 400, { error: 'memory.write requires non-empty content.' });
                return;
              }
              const entry = memory.add(
                body.content!,
                body.layer ?? 'episodic',
                `http-api:${body.id ?? id ?? 'anon'}`,
                body.importance ?? 0.5,
                body.tags ?? [],
              );
              sendJson(res, 201, {
                id: entry.id === 'rejected' ? null : entry.id,
                layer: entry.layer,
                importance: entry.importance,
                rejected: entry.id === 'rejected',
                rejectionReason: entry.id === 'rejected' ? 'quality_gate' : undefined,
              });
              return;
            }
            if (action === 'query') {
              const query: MemoryQuery = {
                ...(body.layer ? { layer: body.layer } : {}),
                ...(body.keywords ? { keywords: body.keywords } : {}),
                ...(body.context ? { context: body.context } : {}),
                ...(body.importanceThreshold !== undefined
                  ? { importanceThreshold: body.importanceThreshold }
                  : {}),
                ...(body.limit !== undefined ? { limit: body.limit } : {}),
                ...(body.since ? { since: body.since } : {}),
              };
              const entries = await memory.query(query);
              sendJson(res, 200, {
                items: entries.map((e: MemoryEntry) => ({
                  id: e.id,
                  layer: e.layer,
                  content: e.content,
                  context: e.context,
                  importance: e.importance,
                  tags: e.tags,
                  metadata: e.metadata,
                  createdAt: e.createdAt,
                  lastAccessedAt: e.lastAccessedAt,
                  accessCount: e.accessCount,
                })),
                total: entries.length,
              });
              return;
            }
            if (action === 'stats') {
              const stats = memory.getStats();
              sendJson(res, 200, {
                totalEntries: stats.totalEntries,
                byLayer: stats.byLayer,
                averageImportance: stats.averageImportance,
                averageAccessCount: stats.averageAccessCount,
                totalMemoryUsed: stats.totalMemoryUsed,
              });
              return;
            }
            sendJson(res, 400, {
              error: `Unknown memory action '${action}'. Use 'write'|'query'|'stats'.`,
            });
          });
          return;
        } catch (err) {
          if (err instanceof HttpRequestError) throw err;
          sendJson(res, 500, {
            error: `Memory backend error: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }
      // /api/v1/plan — POST { task, signal? } → deliberation-only response.
      // Lives alongside /execute (which both plans and runs). No provider
      // call is made — the endpoint returns complexity/topology/cost band
      // estimates so callers can pre-budget WITHOUT committing tokens.
      // Tenant-scoped via runWithTenant so the plan estimate can
      // reflect the tenant's applied policies (rate limits, tool tier) in
      // a follow-up. Today's plan uses tenant only for isolation, not for
      // any state mutation.
      //
      // Audit-FIX (security theater -> real plan): previously shipped as a
      // heuristic-only topology picker with the comment "deliberation-only
      // stub". The v2 contract adds:
      //   - requiredTools: keyword-derived tool requirements
      //   - capabilityProbe: confirms whether MCP and runtime registry can
      //                      satisfy those tools (else degraded)
      //   - modelRecommendation: lowest-cost provider whose profile fits the
      //                          estimated cost band
      // The plan response is still heuristic-only (no provider call), but
      // the new fields give calling SDKs enough signal to fail fast before
      // /api/v1/execute. Backwards-compat: all v1 fields preserved.
      if (resource === 'plan' && method === 'POST') {
        const body = (await parseBody(req, this.config.maxBodyBytes)) as {
          task?: string;
          provider?: string;
          model?: string;
        };
        const taskText = typeof body.task === 'string' && body.task.length > 0 ? body.task : '';
        if (!taskText) {
          sendJson(res, 400, { error: 'plan requires a non-empty task string.' });
          return;
        }
        const tenantId = this.requireTenant(req, res);
        if (res.writableEnded) return;
        const wordCount = taskText.split(/\s+/).filter(Boolean).length;
        const estimatedTokens = TokenGovernor.estimateTokens(taskText) + 800;
        const complexityScore = Math.min(1, Math.log2(Math.max(4, wordCount)) / 10);
        const { topology, estimatedCostBand, estimatedSteps } = pickTopology(taskText, wordCount);

        // Plan-v2 fields: tool-required extraction + capability probe.
        const requiredTools = extractRequiredTools(taskText);
        const mcpAvailable = this.mcpServer !== null;
        // Real capability probe — check whether the registered runtime(s)
        // have at least one working provider AND whether the MCP server
        // (or runtime tool registry) can satisfy the required tools.
        // This replaces the previous fake probe that created an
        // AgentRuntime with a dummy 'probe' apiKey and lied 'verified'
        // even when no real provider was configured.
        const probe = await this.probeCapability(requiredTools);
        const degradationReasons: string[] = [];
        if (!mcpAvailable) degradationReasons.push('mcp_server_not_registered');
        if (probe === 'degraded') degradationReasons.push('executor_init_failed');
        if (probe === 'unknown') degradationReasons.push('executor_probe_timeout');
        if (requiredTools.length > 0 && !mcpAvailable) {
          degradationReasons.push(`${requiredTools.length}_tool_satisfaction_unverified`);
        }
        const capabilityProbe =
          degradationReasons.length === 0
            ? 'verified'
            : requiredTools.length === 0
              ? 'noop'
              : probe === 'unknown'
                ? 'unknown'
                : 'degraded';

        // Model recommendation: low-cost default for now, escalating by topology.
        const modelRecommendation =
          estimatedCostBand === 'high'
            ? {
                provider: body.provider ?? 'openai',
                tier: 'large',
                rationale: 'high-cost-band delegated',
              }
            : estimatedCostBand === 'medium'
              ? {
                  provider: body.provider ?? 'openai',
                  tier: 'medium',
                  rationale: 'medium-cost-band balanced',
                }
              : {
                  provider: body.provider ?? 'openai',
                  tier: 'small',
                  rationale: 'low-cost-band minimum-token',
                };

        sendJson(res, 200, {
          // v1 fields (backward-compatible):
          task: taskText.slice(0, 240),
          provider: body.provider ?? null,
          model: body.model ?? null,
          tenantId,
          planOnly: true,
          topology,
          complexityScore,
          estimatedSteps,
          estimatedCostBand,
          estimatedTokens,
          estimate: {
            timeBudgetMs: estimatedSteps * 4_000 + 2_000,
            costBudgetUsd:
              topology === 'HIERARCHICAL'
                ? 0.85
                : topology === 'PARALLEL'
                  ? 0.55
                  : topology === 'SEQUENTIAL'
                    ? 0.35
                    : 0.15,
          },
          note: 'Plan v2 — heuristic topology + tool-required extraction. Use POST /api/v1/execute to run.',
          // v2 fields:
          planVersion: 2,
          requiredTools,
          mcpAvailable,
          executorProbe: probe,
          capabilityProbe,
          degradationReasons,
          modelRecommendation,
        });
        return;
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
        //
        // Async migration: every read below uses an `*Async` variant so
        // the /.commander/sops disk-scan no longer blocks the event loop
        // for the duration of a multi-agent directory listing.
        if (method === 'GET') {
          // Skip 'v1' and 'sops' (2 elements) to get agentId, runId, format
          const [, , agentId, runId, format] = segments;
          if (!agentId) {
            const data = await getSOPDashboardDataAsync();
            sendJson(res, 200, data);
            return;
          }
          if (!runId) {
            // List SOPs for a specific agent
            const allSops = await listSOPsAsync();
            const filtered = allSops.filter((s) => s.agentId === agentId);
            sendJson(res, 200, { agentId, sops: filtered, total: filtered.length });
            return;
          }
          if (format === 'markdown') {
            const md = await getSOPMarkdownAsync(agentId, runId);
            if (!md) {
              sendJson(res, 404, { error: 'SOP not found' });
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
            res.end(md);
            return;
          }
          // Default: return structured JSON
          const sop = await getSOPAsync(agentId, runId);
          if (!sop) {
            sendJson(res, 404, { error: 'SOP not found' });
            return;
          }
          sendJson(res, 200, sop);
          return;
        }
      }
      // /api/v1/security/owasp-agentic-ai-top10
      // GET  → OwaspAsiTop10.report() JSON (windowMs/renderedAt/overallScore/totalsByAsi[])
      // POST → ingest a SecurityEvent through the classifier. Mirrors the
      //        security.event bus subscription so SIEM forwarders and manual
      //        replays can hit the aggregator without coupling to the bus.
      //        Tenant-scoped via runWithTenant when multi-tenant mode
      //        is configured (matches /api/v1/memory gating); otherwise the
      //        singleton's global fallback is used so single-tenant mode is
      //        preserved.
      if (resource === 'security' && segments[2] === 'owasp-agentic-ai-top10') {
        if (method === 'GET') {
          // Tenant scope MUST be set before getOwaspAsiTop10() resolves;
          // otherwise the createTenantAwareSingleton lambda falls back to
          // the singleton's globalInstance and we leak other tenants'
          // security posture to the caller. Same 401-on-multi-tenant-mode
          // logic as the /api/v1/memory and /api/v1/plan handlers — if
          // a tenant map is configured, an unmapped key is rejected.
          const tenantId = this.requireTenant(req, res);
          if (res.writableEnded) return;
          const report = await runWithTenant(tenantId, async () => getOwaspAsiTop10().report());
          sendJson(res, 200, report);
          return;
        }
        if (method === 'POST') {
          const body = (await parseBody(req, this.config.maxBodyBytes)) as SecurityEvent;
          if (!body || typeof body !== 'object' || !body.type) {
            sendJson(res, 400, {
              error:
                'POST /api/v1/security/owasp-agentic-ai-top10 requires a SecurityEvent-shaped body { type, severity, ... }.',
            });
            return;
          }
          const tenantId = this.requireTenant(req, res);
          if (res.writableEnded) return;
          // Derive routing the same way classifyFromSecurityEvent does so the
          // 202 response can tell SIEM tracers which ASI(s) the ingest landed
          // on, without recomputing on the client.
          const detector =
            (body.details?.detector as string | undefined) ?? body.source ?? undefined;
          const routingAsis = SECURITY_EVENT_TYPE_TO_ASI[body.type as SecurityEvent['type']] ?? [];
          const overrideAsi = detector ? (DETECTOR_TO_ASI_OVERRIDE[detector] ?? null) : null;
          const categories = Array.isArray(body.details?.category)
            ? (body.details!.category as string[])
            : body.details?.category
              ? [body.details.category as string]
              : [];
          const isOutputTamper =
            detector === 'outputSanitizer' &&
            categories.some((c) =>
              ['jwt_token', 'connection_string', 'base64_blob', 'password_secret'].includes(c),
            );
          const routedAsis: string[] = Array.from(
            new Set<string>([
              ...routingAsis,
              ...(overrideAsi ? [overrideAsi] : []),
              ...(isOutputTamper ? ['ASI09'] : []),
            ]),
          );
          await runWithTenant(tenantId, async () => {
            getOwaspAsiTop10().classifyFromSecurityEvent(body);
          });
          sendJson(res, 202, {
            accepted: true,
            routedAsis,
            detector: detector ?? null,
            eventType: body.type,
            windowMs: getOwaspAsiTop10().report().windowMs,
          });
          return;
        }
      }
      // /api/v1/security/compliance-audit
      // GET → ComplianceAuditManager.generateFullReport() (ISO 42001 + NIST AI RMF)
      // /api/v1/security/eu-ai-act
      // GET → EuAiActComplianceReporter.generateReport() (Articles 12/13/14)
      // Both reporters are zero-config singletons that read existing security
      // state (audit chain, security monitor, posture snapshots). Exposing them
      // as read-only GET endpoints fills a gap: the report generators were
      // fully implemented but had no runtime caller.
      if (resource === 'security' && segments[2] === 'compliance-audit' && method === 'GET') {
        const tenantId = this.requireTenant(req, res);
        if (res.writableEnded) return;
        const report = await runWithTenant(tenantId, async () =>
          getComplianceAuditManager().generateFullReport(),
        );
        sendJson(res, 200, report);
        return;
      }
      if (resource === 'security' && segments[2] === 'eu-ai-act' && method === 'GET') {
        const tenantId = this.requireTenant(req, res);
        if (res.writableEnded) return;
        const report = await runWithTenant(tenantId, async () =>
          getEuAiActComplianceReporter().generateReport(),
        );
        sendJson(res, 200, report);
        return;
      }
      if (resource === 'topology') {
        const eventLog = getGlobalExplorationEventLog(
          1000,
          process.cwd() + '/.commander/topology-exploration-events.jsonl',
        );
        const dashboardDeps: RoutingDashboardDeps = {
          eventLog,
          epsilonStore: eventLog.getEpsilonStore(),
          resolveTenant: (r) => this.resolveTenantFromAuth(r),
        };
        const topologySegments = segments.slice(1);
        const r = await handleRoutingDashboardRequest(
          req,
          res,
          dashboardDeps,
          topologySegments,
          queryStr,
        );
        if (r.handled) return;
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

    // SSE per-IP connection limit
    const ip = req.socket.remoteAddress ?? 'unknown';
    let ipConns = this.sseConnections.get(ip);
    if (!ipConns) {
      ipConns = new Set();
      this.sseConnections.set(ip, ipConns);
    }
    if (ipConns.size >= CommanderHttpServer.MAX_SSE_PER_IP) {
      sendJson(res, 429, { error: 'Too many SSE connections from this IP.' });
      return;
    }
    ipConns.add(res);

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
      const conns = this.sseConnections.get(ip);
      if (conns) {
        conns.delete(res);
        if (conns.size === 0) this.sseConnections.delete(ip);
      }
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

    // Subscribe to SOP bus events and emit structured snapshots.
    //
    // Async migration: the bus callback below is sync (MessageBus.subscribe
    // does not await fire-and-forget promises), so the async data fetch
    // is dispatched via `void (async () => { ... })()`. Each `sop.generated`
    // event spawns an async IIFE that awaits `getSOPDashboardDataAsync()`
    // (no fs.Sync reads of the SOP directory) and then emits the snapshot.
    // If the stream closed before the IIFE resolved, the inner guard skips
    // emission so we don't write to a dead socket.
    //
    // I/O-storm protection (06-30 fix): `inflight` suppresses concurrent
    // re-reads when `sop.generated` fires repeatedly during burst runs.
    // The dirty flag triggers ONE trailing re-emit so a stale snapshot is
    // corrected after the initial pass resolves. Without this guard, N
    // rapid bus fires would launch N parallel `fs.promises.readdir` scans
    // of `.commander/sops` — the exact bottleneck the migration was meant
    // to eliminate.
    let inflight = false;
    let dirty = false;
    const unsubGenerated = this.bus.subscribe('sop.generated', () => {
      if (stream.isClosed) return;
      if (inflight) {
        dirty = true;
        return;
      }
      void (async (): Promise<void> => {
        inflight = true;
        try {
          do {
            const data = await getSOPDashboardDataAsync();
            if (stream.isClosed) return;
            stream.emitStructured('sop.update', data as unknown as Record<string, unknown>);
            // Reset dirty AFTER emit so a sustained burst (fires faster
            // than `getSOPDashboardDataAsync` resolves) terminates the
            // loop at the first zero-fire yield rather than polling one
            // extra read.
            dirty = false;
          } while (dirty && !stream.isClosed);
        } catch (err) {
          getGlobalLogger().warn(
            'HttpServer',
            'Failed to build SOP update snapshot for SSE stream',
            { error: (err as Error)?.message },
          );
          reportSilentFailure(err, 'httpServer:handleSOPStreamRequest');
        } finally {
          inflight = false;
        }
      })();
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

  /**
   * Tenant gate shared by all multi-tenant-aware handlers
   * (/api/v1/memory, /api/v1/plan, /api/v1/security/owasp-agentic-ai-top10).
   *
   * Behavior:
   *  - Single-tenant mode (no `tenantApiKeyHashes` configured): pass-through.
   *    Returns whatever the auth header maps to (typically `undefined`), letting
   *    the downstream `runWithTenant(undefined, …)` fall back to the singleton
   *    globalInstance. No 401 — preserves legacy single-tenant deployments.
   *  - Multi-tenant mode (map configured, auth header unmapped or absent):
   *    sends a 401 JSON response via `sendJson` and returns `undefined`.
   *    Caller MUST check `res.writableEnded` after the call to short-circuit
   *    the rest of the handler.
   *  - Multi-tenant mode with a mapped key: returns the resolved tenantId,
   *    caller proceeds into `runWithTenant(tenantId, …)`.
   */
  private requireTenant(req: IncomingMessage, res: ServerResponse): string | undefined {
    if (this.tenantApiKeyHashes.size === 0) {
      return this.resolveTenantFromAuth(req);
    }
    const tenantId = this.resolveTenantFromAuth(req);
    if (!tenantId) {
      sendJson(res, 401, {
        error: `Tenant required for ${req.url}. Configure tenantApiKeyHashes and send a mapped API key.`,
      });
    }
    return tenantId;
  }

  /**
   * Cross-tenant authorization gate. Call this when a handler receives a
   * target tenant ID from the request path/query/body. It verifies that the
   * authenticated tenant matches the requested target — preventing tenant A
   * from accessing tenant B's resources even if the target is explicitly
   * passed in the URL.
   *
   * Returns true if access is allowed (or multi-tenant mode is disabled).
   * Returns false and sends a 403 response if the tenants mismatch.
   */
  private assertTenantAccess(
    res: ServerResponse,
    authenticatedTenant: string | undefined,
    targetTenant: string | undefined,
    url: string,
  ): boolean {
    // Single-tenant mode: no enforcement.
    if (this.tenantApiKeyHashes.size === 0) return true;
    // No target specified — allowed (handler will use authenticated tenant).
    if (!targetTenant) return true;
    // Match — allowed.
    if (authenticatedTenant === targetTenant) return true;
    // Mismatch — deny.
    sendJson(res, 403, {
      error: `Cross-tenant access denied: authenticated tenant "${authenticatedTenant ?? 'unknown'}" cannot access resources for tenant "${targetTenant}" on ${url}.`,
    });
    return false;
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
    // Security: Use SecureApiKeyResolver instead of direct process.env access.
    // Keys are decrypted from EncryptedSecretsVault at rest, with env var fallback.
    // Provider construction is delegated to the provider registry — see
    // runtime/providers/providerRegistry.ts. Adding a provider is now a one-step
    // registration there instead of editing this 24-case switch.
    return createProvider(provider);
  }
}

export function createHttpServer(config?: Partial<HttpServerConfig>): CommanderHttpServer {
  return new CommanderHttpServer(config);
}
