import {
  reportSilentFailure,
  createRagPlugin,
  createEvalPlugin,
  createReportingPlugin,
  createConsensusPlugin,
  getHookManager,
  getMetricsCollector,
  HealthCollector,
  buildHealthSources,
  getPluginLoader,
  getWebhookDispatcher,
  zeroTrustMiddleware,
  ShadowProxy,
  loadShadowConfig,
  type ShadowConfig,
} from '@commander/core';
import express from 'express';
import { createWarRoomStore, apiStore } from './store';
import { ProjectMemoryStore } from './memoryStore';
import { AgentStateStore } from './agentStateStore';
import { MemoryIndexManager, DEFAULT_DOMAINS } from './memoryIndexManager';
import { EpisodicMemoryStore } from './episodicMemoryStore';
import { ActionRationaleStore } from './actionRationale';
import { ConfidenceReporter } from './confidenceReporter';
import { createProjectRouter } from './projectEndpoints';
import { createConflictRouter } from './conflictEndpoints';
import { createSecurityRouter } from './securityEndpoints';
import { createQualityRouter } from './qualityEndpoints';
import { createMemoryIndexRouter } from './memoryIndexEndpoints';
import { createConfidenceRouter } from './confidenceEndpoints';
import { createNamespacedMemoryRouter } from './namespacedMemoryEndpoints';
import { createPipelineRouter } from './pipelineEndpoints';
import { createEvaluationRouter, createProductionLLMCall } from './evaluationEndpoints';
import { LLMEvaluator, ScoreSmoother } from './evaluation';
import { CheckpointManager } from './governanceCheckpoint';
import { createGovernanceRouter } from './governanceEndpoints';
import stateMachineRouter from './stateMachineEndpoints';
import { AgentCardRegistry } from './agentCard';
import { createA2ARouter } from './a2aEndpoints';
import { TaskManager, ArtifactManager } from './a2aTask';
import { createA2AV2Router } from './a2aV2Endpoints';
import { createMCPRouter, createMCPClientRouter } from './mcpEndpoints';
import { createRuntimeRouter } from './runtimeEndpoints';
import { createCostRouter } from './costEndpoints';
import { createPauseRouter } from './pauseEndpoints';
import { createReplayRouter } from './replayEndpoints';
import { createTeamRouter } from './teamEndpoints';
import { createSelfAssessmentRouter } from './selfAssessmentEndpoints';
import { createAgentCardRouter } from './agentCardEndpoints';
import { createReasoningConfigRouter } from './reasoningConfigEndpoints';
import {
  requestIdMiddleware,
  securityHeaders,
  rateLimitMiddleware,
  errorHandler,
  initRateLimitStore,
  closeRateLimitStore,
} from './securityMiddleware';
import { authMiddleware } from './authMiddleware';
import { jwtMiddleware } from './jwtMiddleware';
import { createUserAuthRouter } from './userAuthEndpoints';
import { createOIDCAuthRouter } from './oidcAuthEndpoints';
import { createEvaluationRunnerRouter } from './evaluationRunnerEndpoints';
import { createOrchestratorRouter } from './orchestratorEndpoints';
import { createObservabilityRouter } from './observabilityEndpoints';
import { createStreamRouter } from './streamEndpoints';
import { createChatRouter } from './chatEndpoints';
import { createDlqRouter } from './dlqEndpoints';
import { createApprovalConfigRouter } from './approvalConfigEndpoints';
import { createHallucinationRouter } from './hallucinationEndpoints';
import { createLineageRouter } from './lineageEndpoints';
import { createSecurityPostureRouter } from './securityPostureEndpoints';
import { createWebhookRouter } from './webhookEndpoints';
import { createApiKeyRouter } from './apiKeyEndpoints';
import { createSettingsRouter } from './settingsEndpoints';
import { createOutgoingWebhookRouter } from './outgoingWebhookEndpoints';
import { createCostDashboardRouter } from './costDashboardEndpoints';
import { createKnowledgeBaseRouter } from './knowledgeBaseEndpoints';
import { createEvalRouter } from './evalEndpoints';
import { createReportingRouter } from './reportingEndpoints';
import { createConsensusRouter } from './consensusEndpoints';
import { createOnboardingRouter } from './onboardingEndpoints';
import { createWorkflowRouter } from './workflowEndpoints';
import { createAuditLogRouter } from './auditLogEndpoints';
import { createAuditMiddleware } from './auditMiddleware';
import { createSagaRouter } from './sagaEndpoints';
import { createHubCorrelationsRouter } from './hubCorrelationsEndpoints';
import { getUnifiedAuditLog, dlpResponseMiddleware } from '@commander/core/security';
import { registerRouter, mountRegisteredRouters } from './routerRegistry';

const PROJECT_ID = process.env.COMMANDER_PROJECT_ID ?? 'project-war-room';
const app = express();

let API_VERSION = '0.0.0';
try {
  API_VERSION = require('../package.json').version;
} catch (err) {
  reportSilentFailure(err, 'index:56');
  /* use default */
}

// ── Shared state ────────────────────────────────────────────────────────────
const store = createWarRoomStore();
// Wired when API_STORE_BACKEND=postgres (or sqlite/memory fallback)
const apiStoreInstance = apiStore;
const memoryStore = new ProjectMemoryStore();
const agentStateStore = new AgentStateStore();
const memoryIndexManager = new MemoryIndexManager(PROJECT_ID);
const episodicMemoryStore = new EpisodicMemoryStore();
const actionRationaleStore = new ActionRationaleStore();
const confidenceReporter = new ConfidenceReporter(actionRationaleStore);
const agentCardRegistry = new AgentCardRegistry();
const evaluator = new LLMEvaluator();
const smoother = new ScoreSmoother();
// Security: Use real LLM provider for LLM-as-Judge evaluation.
// Mock is only used when COMMANDER_EVAL_MOCK=true is explicitly set.
const productionLLMCall = createProductionLLMCall();
const evaluationRouter = createEvaluationRouter(evaluator, smoother, productionLLMCall);
const checkpointManager = new CheckpointManager();
const governanceRouter = createGovernanceRouter(checkpointManager);
const a2aTaskManager = new TaskManager();
const a2aArtifactManager = new ArtifactManager();
const a2aRouter = createA2ARouter(a2aTaskManager, a2aArtifactManager, agentCardRegistry);

// ── Security middleware stack ────────────────────────────────────────────────
// Security: Disable X-Powered-By header to reduce fingerprinting.
// Per Express production security best practices: hide framework identity.
app.disable('x-powered-by');

// Security: Configure trust proxy for reverse proxy deployments.
// Per Express behind-proxies docs: set to hop count or trusted IP range.
// '1' trusts the first proxy (typical Nginx/ALB setup). Set via env for flexibility.
app.set('trust proxy', process.env.TRUST_PROXY_HOPS ?? '1');

// 1. Request ID tracking
app.use(requestIdMiddleware);

// 2. Security headers
app.use(securityHeaders);

// 3. API version header
app.use((_req, res, next) => {
  res.header('X-API-Version', '1.0.0');
  next();
});

// 4. JWT parsing (non-blocking) — must run before rate limiting so
// per-user / per-tenant buckets can be derived from the authenticated
// identity. Public paths (health, login, register) are skipped.
app.use(jwtMiddleware);

// 5. Rate limiting — now aware of tenant → user → IP identity.
app.use(rateLimitMiddleware);

// 6. CORS whitelist (not wildcard)
const API_PORT = parseInt(process.env.PORT ?? '4000', 10);
const WEB_PORT = parseInt(process.env.WEB_PORT ?? '5173', 10);

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${WEB_PORT}`,
  `http://localhost:${API_PORT}`,
  `http://127.0.0.1:${WEB_PORT}`,
  ...(process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) ?? []),
]);

// Local-first default: only localhost origins are allowed when CORS_ORIGINS
// is unset. Surface this at startup so production deployments know to set it.
if (!process.env.CORS_ORIGINS) {
  console.warn(
    `[commander] CORS_ORIGINS not set — only localhost origins are allowed. ` +
      `For production/browser access from other hosts, set CORS_ORIGINS=https://your-ui-host.example.com`,
  );
}

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Security: Per OWASP CORS guidance — only set Allow-Credentials when origin
  // matches the allowlist. Never combine wildcard origin with credentials.
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Request-ID, X-API-Key, X-Tenant-ID',
  );
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// 7. Authentication (skipped when AUTH_DISABLED=true or no API_KEYS configured)
// JWT was already parsed in step 4 for rate-limit identity. API-key auth runs
// here and skips requests already authenticated via JWT (req.user set).
app.use(authMiddleware);

// 7b. Zero-trust request-signature validation. When no keys are registered it
// passes through (skipIfNoKeys), so existing deployments keep working. Once
// keys are registered via the security endpoints, every mutating request must
// carry a valid X-Signature header.
app.use(
  zeroTrustMiddleware({
    skipPaths: ['/health', '/ready', '/metrics', '/openapi.json'],
    skipIfNoKeys: true,
  }),
);

// 8. Audit middleware — records all mutating (POST/PUT/PATCH/DELETE) requests
// to the unified audit trail (.commander/audit/user-actions.ndjson). Mounted
// after auth so req.user / req.apiKeyId are populated, and before routers so
// the response `finish` listener is attached before handlers run. Sensitive
// body fields are stripped by createAuditMiddleware before persistence.
app.use(createAuditMiddleware(getUnifiedAuditLog()));

// 9. DLP response middleware — scans all HTTP responses (JSON/text/HTML/XML)
// for sensitive data (API keys, private keys, JWTs, etc.) and redacts/masks
// before sending to client. Excludes event-stream to avoid buffering SSE.
// If DLP is disabled, the middleware passes through with zero overhead.
// blockOnCritical returns 403 for critical-severity data leakage.
app.use(
  dlpResponseMiddleware({
    contentTypes: ['json', 'text', 'xml', 'html'],
    blockOnCritical: true,
  }),
);

// 9b. Shadow traffic mirroring. Loads config from .commander/shadow-config.json;
// disabled by default. When enabled, a sampled subset of requests is scrubbed
// (PII/auth headers removed) and sent to the shadow endpoint for drift detection.
const shadowConfig: ShadowConfig = loadShadowConfig();
const shadowProxy = new ShadowProxy(shadowConfig);
app.use(shadowProxy.expressMiddleware());

// Initialize default memory domains on startup
DEFAULT_DOMAINS.forEach(({ domain, description }) => {
  try {
    memoryIndexManager.addDomain(domain, description);
  } catch (e) {
    process.stderr.write(`[MemoryIndex] Domain already exists: ${domain}\n`);
  }
});

// ── System ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.floor(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.floor(memUsage.heapTotal / 1024 / 1024);

  // Degraded if heap usage > 80%
  const heapHealthy = heapUsedMB / heapTotalMB < 0.8;
  const status = heapHealthy ? 'healthy' : 'degraded';

  res.status(heapHealthy ? 200 : 503).json({
    status,
    projectId: PROJECT_ID,
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsed: `${heapUsedMB}MB`,
      heapTotal: `${heapTotalMB}MB`,
      heapPercent: Math.round((heapUsedMB / heapTotalMB) * 100),
    },
    version: API_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// Readiness probe — checks if the server is ready to accept traffic
// (all critical stores initialized)
app.get('/ready', (_req, res) => {
  const checks: Record<string, 'ok' | 'fail'> = {
    warRoom: store ? 'ok' : 'fail',
    apiStore: apiStoreInstance ? 'ok' : 'fail',
    memoryStore: memoryStore ? 'ok' : 'fail',
    agentStateStore: agentStateStore ? 'ok' : 'fail',
    episodicMemoryStore: episodicMemoryStore ? 'ok' : 'fail',
    memoryIndexManager: memoryIndexManager ? 'ok' : 'fail',
    confidenceReporter: confidenceReporter ? 'ok' : 'fail',
  };

  const allOk = Object.values(checks).every((v) => v === 'ok');
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Detailed health — delegates component-level diagnostics to the shared core
// HealthCollector (memory / disk / circuit-breaker / DLQ / …) so the API layer
// does not dual-track the same checks that CommanderHttpServer already runs.
// API-specific module availability is layered on top.
//
// Audit-fix (C-P0-2): previously `new HealthCollector()` was constructed
// without sources, so 5 of the 8 internal checks (circuit breaker, DLQ,
// compensation, event bus, providers) silently returned
// `{ status: 'healthy', message: '... not wired' }` regardless of the
// underlying component state. This made the probe unverifiable: a DLQ that
// had crashed OR a toppled circuit breaker would still report green, and
// k8s/PaaS readiness gates would keep forwarding traffic to a doomed node.
// Fixed: all unwired checks now return 'degraded' (fail-closed). The
// shared buildHealthSources() wires event bus, DLQ, and compensation queue
// from global singletons. Circuit-breaker and provider checks require an
// active AgentRuntime session (see CommanderHttpServer.buildHealthSources).
app.get('/health/detailed', async (_req, res) => {
  const collector = new HealthCollector({ sources: buildHealthSources() });
  const result = await collector.collect();
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.floor(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.floor(memUsage.heapTotal / 1024 / 1024);
  const rssMB = Math.floor(memUsage.rss / 1024 / 1024);

  res.status(result.status === 'unhealthy' ? 503 : 200).json({
    status: result.status,
    projectId: PROJECT_ID,
    uptime: Math.floor(process.uptime()),
    version: API_VERSION,
    memory: {
      rss: `${rssMB}MB`,
      heapUsed: `${heapUsedMB}MB`,
      heapTotal: `${heapTotalMB}MB`,
      heapPercent: Math.round((heapUsedMB / heapTotalMB) * 100),
    },
    components: result.checks,
    modules: {
      warRoom: store ? 'active' : 'inactive',
      apiStore: apiStoreInstance ? 'active' : 'inactive',
      memoryStore: memoryStore ? 'active' : 'inactive',
      agentStateStore: agentStateStore ? 'active' : 'inactive',
      episodicMemoryStore: episodicMemoryStore ? 'active' : 'inactive',
      memoryIndexManager: memoryIndexManager ? 'active' : 'inactive',
      confidenceReporter: confidenceReporter ? 'active' : 'inactive',
      governance: checkpointManager
        ? checkpointManager.getStats().expired > 0
          ? 'degraded'
          : 'active'
        : 'inactive',
      checkpointManager: checkpointManager ? 'active' : 'inactive',
    },
    timestamp: new Date().toISOString(),
  });
});

// Prometheus metrics endpoint — exports all business metrics via the unified
// MetricsCollector (counters/gauges/histograms) plus supplementary process-level
// gauges (heap/rss/uptime/event-loop-lag) that the business collector does not
// track. Prometheus scrapes both in a single pull.
app.get('/metrics', (_req, res) => {
  const memUsage = process.memoryUsage();
  const heapUsed = memUsage.heapUsed;
  const heapTotal = memUsage.heapTotal;
  const rss = memUsage.rss;
  const uptime = process.uptime();

  const businessMetrics = getMetricsCollector().exportOpenMetrics();

  const processMetrics = [
    '# HELP commander_heap_used_bytes Heap memory used in bytes',
    '# TYPE commander_heap_used_bytes gauge',
    `commander_heap_used_bytes ${heapUsed}`,
    '',
    '# HELP commander_heap_total_bytes Total heap size in bytes',
    '# TYPE commander_heap_total_bytes gauge',
    `commander_heap_total_bytes ${heapTotal}`,
    '',
    '# HELP commander_rss_bytes Resident set size in bytes',
    '# TYPE commander_rss_bytes gauge',
    `commander_rss_bytes ${rss}`,
    '',
    '# HELP commander_uptime_seconds Server uptime in seconds',
    '# TYPE commander_uptime_seconds gauge',
    `commander_uptime_seconds ${uptime}`,
    '',
    '# HELP commander_heap_percent Heap usage percentage',
    '# TYPE commander_heap_percent gauge',
    `commander_heap_percent ${Math.round((heapUsed / heapTotal) * 100)}`,
    '',
  ].join('\n');

  res.type('text/plain; version=0.0.4').send(businessMetrics + processMetrics);
});

app.get('/system/status', (_req, res) => {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(uptime),
    memory: {
      rss: Math.floor(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.floor(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.floor(memUsage.heapTotal / 1024 / 1024) + 'MB',
    },
    modules: {
      core: 'loaded',
      warRoom: store ? 'active' : 'inactive',
      apiStore: apiStoreInstance ? 'active' : 'inactive',
      memoryStore: memoryStore ? 'active' : 'inactive',
      agentStateStore: agentStateStore ? 'active' : 'inactive',
      episodicMemoryStore: episodicMemoryStore ? 'active' : 'inactive',
      memoryIndexManager: memoryIndexManager ? 'active' : 'inactive',
      confidenceReporter: confidenceReporter ? 'active' : 'inactive',
    },
    timestamp: new Date().toISOString(),
  });
});

// ── Routers ─────────────────────────────────────────────────────────────────
// All routers are registered via the endpoint registry (routerRegistry.ts) as a
// single declarative manifest. Adding an endpoint is now ONE registerRouter()
// line here — no separate import+app.use scattered across the file. Factories
// capture shared state (store/memoryStore/etc.) via closure. Registration order
// = mount order, which preserves the auth-before-routers invariant.
//
// User authentication (register/login/me/refresh/users) is mounted first so the
// auth endpoints are available before any feature routers.
registerRouter({ name: 'user-auth', mountPath: '/', factory: () => createUserAuthRouter() });
registerRouter({ name: 'oidc-auth', mountPath: '/', factory: () => createOIDCAuthRouter() });

registerRouter({
  name: 'project',
  mountPath: '/',
  factory: () => createProjectRouter(store, memoryStore, agentStateStore),
});
registerRouter({
  name: 'memory-index',
  mountPath: '/',
  factory: () => createMemoryIndexRouter(memoryIndexManager),
});
registerRouter({ name: 'conflict', mountPath: '/', factory: () => createConflictRouter(store) });
registerRouter({ name: 'security', mountPath: '/', factory: () => createSecurityRouter() });
registerRouter({
  name: 'confidence',
  mountPath: '/',
  factory: () => createConfidenceRouter(store, confidenceReporter),
});
registerRouter({ name: 'quality', mountPath: '/', factory: () => createQualityRouter() });
registerRouter({
  name: 'self-assessment',
  mountPath: '/api',
  factory: () => createSelfAssessmentRouter(),
});
registerRouter({
  name: 'evaluation',
  mountPath: '/api/evaluation',
  factory: () => evaluationRouter,
});
registerRouter({
  name: 'governance',
  mountPath: '/api/governance',
  factory: () => governanceRouter,
});
registerRouter({
  name: 'state-machine',
  mountPath: '/api/state-machine',
  factory: () => stateMachineRouter,
});
registerRouter({
  name: 'agent-card',
  mountPath: '/api',
  factory: () => createAgentCardRouter(agentCardRegistry),
});
registerRouter({
  name: 'reasoning-config',
  mountPath: '/api',
  factory: () => createReasoningConfigRouter(),
});
registerRouter({
  name: 'evaluation-runner',
  mountPath: '/api',
  factory: () => createEvaluationRunnerRouter(),
});
registerRouter({ name: 'pipeline', mountPath: '/', factory: () => createPipelineRouter() });
registerRouter({
  name: 'workflow',
  mountPath: '/',
  factory: () => createWorkflowRouter(),
});
registerRouter({
  name: 'namespaced-memory',
  mountPath: '/',
  factory: () => createNamespacedMemoryRouter(),
});
registerRouter({ name: 'a2a', mountPath: '/a2a', factory: () => a2aRouter });
registerRouter({ name: 'a2a-v2', mountPath: '/a2a/v2', factory: () => createA2AV2Router() });
registerRouter({ name: 'mcp', mountPath: '/mcp', factory: () => createMCPRouter() });
registerRouter({
  name: 'mcp-client',
  mountPath: '/mcp/client',
  factory: () => createMCPClientRouter(),
});
registerRouter({ name: 'stream', mountPath: '/', factory: () => createStreamRouter() });
registerRouter({
  name: 'runtime',
  mountPath: '/api/runtime',
  factory: () => createRuntimeRouter(),
});
registerRouter({ name: 'cost', mountPath: '/', factory: () => createCostRouter() });
registerRouter({ name: 'pause', mountPath: '/', factory: () => createPauseRouter() });
registerRouter({ name: 'replay', mountPath: '/', factory: () => createReplayRouter() });
registerRouter({
  name: 'orchestrator',
  mountPath: '/api',
  factory: () => createOrchestratorRouter(),
});
registerRouter({ name: 'team', mountPath: '/api', factory: () => createTeamRouter() });

// ── UX gap-fix routers ─────────────────────────────────────────────────────
registerRouter({ name: 'chat', mountPath: '/', factory: () => createChatRouter() });
registerRouter({ name: 'dlq', mountPath: '/', factory: () => createDlqRouter() });
registerRouter({
  name: 'approval-config',
  mountPath: '/',
  factory: () => createApprovalConfigRouter(),
});
registerRouter({
  name: 'hallucination',
  mountPath: '/',
  factory: () => createHallucinationRouter(),
});
registerRouter({ name: 'lineage', mountPath: '/', factory: () => createLineageRouter() });
registerRouter({
  name: 'security-posture',
  mountPath: '/',
  factory: () => createSecurityPostureRouter(),
});
registerRouter({ name: 'webhook', mountPath: '/', factory: () => createWebhookRouter() });

// ── API Key management (admin only) ─────────────────────────────────────────
registerRouter({ name: 'api-keys', mountPath: '/', factory: () => createApiKeyRouter() });

// ── Global settings (model / feature flags / notifications) ─────────────────
registerRouter({ name: 'settings', mountPath: '/', factory: () => createSettingsRouter() });

// ── Outgoing webhook dispatcher (delivery tracking + retry) ─────────────────
registerRouter({
  name: 'outgoing-webhooks',
  mountPath: '/',
  factory: () => createOutgoingWebhookRouter(),
});

// ── Cost Dashboard (enterprise cost analytics) ─────────────────────────────
registerRouter({
  name: 'cost-dashboard',
  mountPath: '/',
  factory: () => createCostDashboardRouter(),
});

// ── Knowledge Base / RAG (enterprise document retrieval) ───────────────────
// Register the built-in RAG CommanderPlugin (default disabled). Enabling it
// activates the beforeLLMCall auto-inject hook + the `knowledge_search` tool.
// The data plane (upload/list/delete/search) works regardless of enable state
// via the shared KnowledgeBaseStore.
const ragPlugin = createRagPlugin();
getHookManager()
  .register(ragPlugin)
  .then(() => {
    // Default to disabled so RAG is opt-in (enterprise deployments enable it
    // explicitly via POST /api/knowledge-base/enable).
    getHookManager().disable('builtin-rag');
  })
  .catch((err: unknown) => console.error('RAG plugin registration failed:', err));

// ── External plugin discovery ──────────────────────────────────────────────
// Discover and load externally-installed plugins from .commander/plugins/
// (project-local) and ~/.commander/plugins/ (user-global). Disabled plugins
// are skipped per the persisted enabled-state map. Failures are non-fatal —
// a broken third-party plugin must never block API startup.
getPluginLoader()
  .loadAll()
  .then((loaded) => {
    if (loaded.length > 0) {
      console.log(`[commander] Loaded ${loaded.length} external plugin(s)`);
    }
  })
  .catch((err: unknown) => reportSilentFailure(err, 'index:pluginLoader.loadAll'));

registerRouter({
  name: 'knowledge-base',
  mountPath: '/',
  factory: () => createKnowledgeBaseRouter(),
});

// ── Eval / Reporting / Consensus plugin routers (control + data plane) ────
registerRouter({ name: 'eval', mountPath: '/', factory: () => createEvalRouter() });
registerRouter({ name: 'reporting', mountPath: '/', factory: () => createReportingRouter() });
registerRouter({ name: 'consensus', mountPath: '/', factory: () => createConsensusRouter() });

// ── Unified Audit Log (cross-source query/export/stats) ────────────────────
registerRouter({ name: 'audit-log', mountPath: '/', factory: () => createAuditLogRouter() });

// ── Onboarding Wizard (Web 端上手引导) ──────────────────────────────────────
// 解决 POC→生产鸿沟：为新用户提供首次登录后的多步骤引导向导后端能力。
registerRouter({ name: 'onboarding', mountPath: '/', factory: () => createOnboardingRouter() });

// ── Saga Compensation (分布式事务补偿) ───────────────────────────────────────
// Saga 模式长运行事务的管理与补偿：列出运行中事务、查看时间线、
// 恢复中断事务、分叉新执行路径、实时流传输状态变更。
registerRouter({ name: 'saga', mountPath: '/', factory: () => createSagaRouter() });

// ── Hub Correlations (Tier-0 关联事件可观测性) ──────────────────────────────
// 跨运行时关联事件的管理员观测端点：循环检测关联、重试阻断关联、
// 语义断路器关联。支持 REST 摘要查询和 SSE 实时流。
registerRouter({
  name: 'hub-correlations',
  mountPath: '/api/v1/hub/correlations',
  factory: () => createHubCorrelationsRouter(),
});

// ── API v1 versioned aliases (backward-compatible) ──────────────────────────
// All routes are accessible under /api/v1/ prefix in addition to their original paths.
// This provides explicit API versioning without breaking existing clients.
registerRouter({
  name: 'v1-evaluation',
  mountPath: '/api/v1/evaluation',
  factory: () => evaluationRouter,
});
registerRouter({
  name: 'v1-governance',
  mountPath: '/api/v1/governance',
  factory: () => governanceRouter,
});
registerRouter({
  name: 'v1-state-machine',
  mountPath: '/api/v1/state-machine',
  factory: () => stateMachineRouter,
});
registerRouter({
  name: 'v1-self-assessment',
  mountPath: '/api/v1',
  factory: () => createSelfAssessmentRouter(),
});
registerRouter({
  name: 'v1-agent-card',
  mountPath: '/api/v1',
  factory: () => createAgentCardRouter(agentCardRegistry),
});
registerRouter({
  name: 'v1-reasoning-config',
  mountPath: '/api/v1',
  factory: () => createReasoningConfigRouter(),
});
registerRouter({
  name: 'v1-evaluation-runner',
  mountPath: '/api/v1',
  factory: () => createEvaluationRunnerRouter(),
});
registerRouter({
  name: 'v1-runtime',
  mountPath: '/api/v1/runtime',
  factory: () => createRuntimeRouter(),
});
registerRouter({
  name: 'v1-orchestrator',
  mountPath: '/api/v1',
  factory: () => createOrchestratorRouter(),
});

// ── Mount all registered routers in registration order ─────────────────────
// A single call replaces ~40 scattered app.use() statements. Order is preserved
// (auth routers first, then features, then v1 aliases).
registerRouter({
  name: 'v1-observability',
  mountPath: '/api/v1/observability',
  factory: () => createObservabilityRouter(),
});
mountRegisteredRouters(app);

// ── OpenAPI ─────────────────────────────────────────────────────────────────
app.get('/api/openapi.json', (_req, res) => {
  res.json({
    openapi: '3.1.0',
    info: {
      title: 'Commander Multi-Agent Framework API',
      version: API_VERSION,
      description:
        'Production-grade multi-agent orchestration with governance, quality gates, and memory management.',
    },
    servers: [{ url: `http://localhost:${API_PORT}`, description: 'Local development' }],
    tags: [
      { name: 'Projects', description: 'Project and agent management' },
      { name: 'Missions', description: 'Mission lifecycle' },
      { name: 'Memory', description: 'Memory stores (standard, namespaced, RBAC)' },
      { name: 'Quality', description: 'Quality gates: hallucination, consensus, handoff' },
      { name: 'Governance', description: 'Governance monitoring and alerts' },
      { name: 'Evaluation', description: 'Agent evaluation and grading' },
      { name: 'A2A', description: 'Google Agent-to-Agent protocol' },
      { name: 'System', description: 'Health and status' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health check',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/system/status': {
        get: {
          tags: ['System'],
          summary: 'Module health status',
          responses: { '200': { description: 'Status of all modules' } },
        },
      },
      '/projects': {
        get: {
          tags: ['Projects'],
          summary: 'List all projects',
          responses: { '200': { description: 'Project list' } },
        },
      },
      '/projects/{projectId}/war-room': {
        get: {
          tags: ['Projects'],
          summary: 'War room snapshot',
          parameters: [
            { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'War room data' } },
        },
      },
      '/projects/{projectId}/missions': {
        post: {
          tags: ['Missions'],
          summary: 'Create mission',
          responses: { '201': { description: 'Created' } },
        },
      },
      '/missions/{missionId}': {
        patch: {
          tags: ['Missions'],
          summary: 'Update mission',
          responses: { '200': { description: 'Updated' } },
        },
      },
      '/missions/{missionId}/logs': {
        post: {
          tags: ['Missions'],
          summary: 'Add mission log',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/projects/{projectId}/memory': {
        get: { tags: ['Memory'], summary: 'List memories' },
        post: { tags: ['Memory'], summary: 'Create memory' },
      },
      '/projects/{projectId}/memory/search': {
        get: { tags: ['Memory'], summary: 'Search memories' },
      },
      '/api/quality/check': {
        post: {
          tags: ['Quality'],
          summary: 'Run all quality gates',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    input: { type: 'string' },
                    output: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Quality gate results' } },
        },
      },
      '/api/quality/hallucination-check': {
        post: {
          tags: ['Quality'],
          summary: 'Hallucination detection',
          responses: { '200': { description: 'Hallucination report' } },
        },
      },
      '/api/memory/assess-credibility': {
        post: {
          tags: ['Memory'],
          summary: 'Source credibility assessment',
          responses: { '200': { description: 'Credibility score' } },
        },
      },
      '/api/memory/detect-poisoning': {
        post: {
          tags: ['Memory'],
          summary: 'Batch poisoning detection',
          responses: { '200': { description: 'Poisoning indicators' } },
        },
      },
      '/api/agents/{agentId}/self-assess': {
        post: {
          tags: ['Governance'],
          summary: 'Agent self-assessment',
          responses: { '200': { description: 'Assessment result' } },
        },
      },
      '/api/agents/{agentId}/self-model': {
        get: {
          tags: ['Governance'],
          summary: 'Agent self-model',
          responses: { '200': { description: 'Self model' } },
        },
      },
      '/projects/{projectId}/governance/stats': {
        get: {
          tags: ['Governance'],
          summary: 'Governance statistics',
          responses: { '200': { description: 'Stats' } },
        },
      },
      '/projects/{projectId}/governance/alerts': {
        get: {
          tags: ['Governance'],
          summary: 'Governance alerts',
          responses: { '200': { description: 'Alerts' } },
        },
      },
      '/projects/{projectId}/governance/weekly-report': {
        get: {
          tags: ['Governance'],
          summary: 'Weekly governance report',
          responses: { '200': { description: 'Report' } },
        },
      },
      '/api/namespaced-memory/{namespace}/write': {
        post: {
          tags: ['Memory'],
          summary: 'RBAC memory write',
          responses: {
            '200': { description: 'Written' },
            '403': { description: 'Permission denied' },
          },
        },
      },
      '/api/namespaced-memory/{namespace}/read/{id}': {
        get: {
          tags: ['Memory'],
          summary: 'RBAC memory read',
          responses: {
            '200': { description: 'Memory item' },
            '403': { description: 'Permission denied' },
          },
        },
      },
      '/api/namespaced-memory/{namespace}/search': {
        get: {
          tags: ['Memory'],
          summary: 'RBAC memory search',
          responses: { '200': { description: 'Search results' } },
        },
      },
      '/api/namespaced-memory/{namespace}/stats': {
        get: {
          tags: ['Memory'],
          summary: 'Namespace stats',
          responses: { '200': { description: 'Stats' } },
        },
      },
      '/api/namespaced-memory/{namespace}/audit': {
        get: {
          tags: ['Memory'],
          summary: 'Audit log',
          responses: { '200': { description: 'Audit entries' } },
        },
      },
      '/api/namespaced-memory/acl': {
        get: {
          tags: ['Memory'],
          summary: 'ACL rules',
          responses: { '200': { description: 'Rules' } },
        },
      },
      '/a2a/.well-known/agent-card': {
        get: {
          tags: ['A2A'],
          summary: 'Agent card (A2A protocol)',
          responses: { '200': { description: 'Agent card' } },
        },
      },
      '/a2a/agent-cards': {
        get: {
          tags: ['A2A'],
          summary: 'List agent cards',
          responses: { '200': { description: 'Cards' } },
        },
      },
      '/a2a/tasks': {
        post: {
          tags: ['A2A'],
          summary: 'Create A2A task',
          responses: { '201': { description: 'Task created' } },
        },
      },
    },
  });
});

// ── Error handler (must be last middleware) ──────────────────────────────────
app.use(errorHandler);

// ── Startup + Graceful Shutdown ──────────────────────────────────────────────
const port = Number(process.env.PORT || 4000);

// initRateLimitStore() opens the persistent SQLite store and hydrates the
// in-memory Map BEFORE listen() so the first request after boot doesn't see
// an empty rate-limit cache (which would defeat the auth-reset bypass
// mitigation this persistence layer was added for). Server reference is
// captured so gracefulShutdown can drain it.
let httpServer: { close: (cb?: () => void) => void } | null = null;

async function startServer(): Promise<void> {
  await initRateLimitStore();
  // Start the outgoing webhook dispatcher so registered webhooks receive
  // system events as soon as the server is ready.
  getWebhookDispatcher().start();
  httpServer = app.listen(port, () => {
    process.stdout.write(`API listening on http://localhost:${port}\n`);
    process.stdout.write(`War room project ready at GET /projects/${PROJECT_ID}/war-room\n`);
  });
}

startServer().catch((err: Error) => {
  process.stderr.write(`[startup] Failed to start API server: ${err.message}\n`);
  process.exit(1);
});

// P1: Graceful shutdown — drain connections, flush state, then exit
let shuttingDown = false;
function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n[${signal}] Shutting down gracefully...\n`);

  // Stop accepting new connections.
  httpServer?.close(async () => {
    process.stdout.write('[shutdown] HTTP server closed\n');

    // Stop the outgoing webhook dispatcher to prevent in-flight retries
    // from keeping the process alive after shutdown is requested.
    try {
      getWebhookDispatcher().stop();
    } catch (dispatcherErr) {
      process.stderr.write(`[shutdown] Failed to stop webhook dispatcher: ${dispatcherErr}\n`);
    }

    // Flush any pending state
    try {
      episodicMemoryStore['doPersist']?.();
    } catch (persistErr) {
      process.stderr.write(`[shutdown] Failed to persist episodic memory: ${persistErr}\n`);
    }

    // Close database connections (no-op for JSON store)
    try {
      store.close();
    } catch (closeErr) {
      process.stderr.write(`[shutdown] Failed to close store: ${closeErr}\n`);
    }

    // Close the A2A API store (PostgresPool-backed when API_STORE_BACKEND=postgres)
    try {
      await apiStoreInstance.close();
    } catch (closeErr) {
      process.stderr.write(`[shutdown] Failed to close API store: ${closeErr}\n`);
    }

    // Close the rate-limit persistent store (audit MED item 3 follow-up).
    // Idempotent — safe even if init failed.
    closeRateLimitStore();

    process.stdout.write('[shutdown] Complete\n');
    process.exit(0);
  });

  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    process.stderr.write('[shutdown] Force exit after 10s timeout\n');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
