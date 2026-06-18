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
var _a, _b, _c, _d, _e;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommanderHttpServer = void 0;
exports.createHttpServer = createHttpServer;
const crypto = __importStar(require("crypto"));
const http_1 = require("http");
const https_1 = require("https");
const agentRuntime_1 = require("./agentRuntime");
const sseStream_1 = require("./sseStream");
const messageBus_1 = require("./messageBus");
const openaiProvider_1 = require("./providers/openaiProvider");
const anthropicProvider_1 = require("./providers/anthropicProvider");
const googleProvider_1 = require("./providers/googleProvider");
const openRouterProvider_1 = require("./providers/openRouterProvider");
const deepseekProvider_1 = require("./providers/deepseekProvider");
const glmProvider_1 = require("./providers/glmProvider");
const mimoProvider_1 = require("./providers/mimoProvider");
const xiaomiProvider_1 = require("./providers/xiaomiProvider");
const ollamaProvider_1 = require("./providers/ollamaProvider");
const vllmProvider_1 = require("./providers/vllmProvider");
const cohereProvider_1 = require("./providers/cohereProvider");
const mistralProvider_1 = require("./providers/mistralProvider");
const groqProvider_1 = require("./providers/groqProvider");
const togetherProvider_1 = require("./providers/togetherProvider");
const perplexityProvider_1 = require("./providers/perplexityProvider");
const fireworksProvider_1 = require("./providers/fireworksProvider");
const replicateProvider_1 = require("./providers/replicateProvider");
const bedrockProvider_1 = require("./providers/bedrockProvider");
const xaiProvider_1 = require("./providers/xaiProvider");
const anyscaleProvider_1 = require("./providers/anyscaleProvider");
const deepinfraProvider_1 = require("./providers/deepinfraProvider");
const server_1 = require("../mcp/server");
const logging_1 = require("../logging");
const metricsCollector_1 = require("./metricsCollector");
const processCrashSafety_1 = require("./processCrashSafety");
const deadLetterQueueSingleton_1 = require("./deadLetterQueueSingleton");
const openapi_1 = require("./openapi");
const atrHttp_1 = require("../atr/atrHttp");
const scheduler_1 = require("../atr/scheduler");
const httpApi_1 = require("../observability/httpApi");
const compensationDashboard_1 = require("./compensationDashboard");
const sopDashboard_1 = require("./sopDashboard");
const executionTrace_1 = require("./executionTrace");
const costModel_1 = require("../observability/costModel");
const traceStore_1 = require("./traceStore");
const leaseManager_1 = require("../atr/leaseManager");
const DEFAULT_CONFIG = {
    port: parseInt((_a = process.env.COMMANDER_PORT) !== null && _a !== void 0 ? _a : '3001', 10),
    host: '127.0.0.1',
    cors: true,
    corsAllowedOrigins: (_c = (_b = process.env.CORS_ORIGINS) === null || _b === void 0 ? void 0 : _b.split(',').map((s) => s.trim())) !== null && _c !== void 0 ? _c : [
        `http://localhost:${(_d = process.env.WEB_PORT) !== null && _d !== void 0 ? _d : '5173'}`,
        `http://127.0.0.1:${(_e = process.env.WEB_PORT) !== null && _e !== void 0 ? _e : '5173'}`,
    ],
    maxBodyBytes: 1024 * 1024,
    rateLimitPerMinute: 120,
};
class HttpRequestError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
function parseBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        let rejected = false;
        let bodyError = null;
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            if (rejected)
                return;
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
            }
            catch {
                (0, logging_1.getGlobalLogger)().warn('HttpServer', 'Invalid JSON');
                reject(new HttpRequestError(400, 'Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}
function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
function hashSecret(secret) {
    return crypto.createHash('sha256').update(secret).digest('hex');
}
function timingSafeHexEqual(a, b) {
    if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b))
        return false;
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function extractAuthKey(req) {
    const auth = req.headers.authorization;
    if (!auth)
        return undefined;
    return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}
/** Extended authenticate that also tries registered auth plugins (OIDC). */
function authenticate(req, authDisabled, apiKeyHash, authPlugins) {
    if (authDisabled)
        return { success: true };
    const key = extractAuthKey(req);
    if (!key)
        return { success: false };
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
class CommanderHttpServer {
    constructor(config) {
        this.server = null;
        this.runtimes = new Map();
        this.bus = (0, messageBus_1.getMessageBus)();
        this.mcpServer = null;
        // Rate limiting: IP → { count, resetAt }
        this.rateLimitMap = new Map();
        this.sessionCleanupTimer = null;
        // Graceful shutdown: track open connections
        this.connections = new Set();
        this.isShuttingDown = false;
        this.authDisabled = false;
        this.tenantApiKeyHashes = new Map();
        this.authPlugins = [];
        this.siemForwarder = null;
        this.securityEventUnsub = null;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.initializeAuth();
    }
    initializeAuth() {
        var _a, _b, _c, _d, _e;
        if (this.config.apiKey === '') {
            this.authDisabled = true;
        }
        else if (this.config.apiKeyHash) {
            this.apiKeyHash = this.config.apiKeyHash;
        }
        else if (this.config.apiKey !== undefined) {
            this.apiKeyHash = hashSecret(this.config.apiKey);
        }
        else {
            this.apiKeyHash = hashSecret(crypto.randomBytes(24).toString('hex'));
            (0, logging_1.getGlobalLogger)().info('HttpServer', 'Generated ephemeral API key hash; configure apiKeyHash for externally accessible deployments');
        }
        for (const [keyHash, tenantId] of Object.entries((_a = this.config.tenantApiKeyHashes) !== null && _a !== void 0 ? _a : {})) {
            this.tenantApiKeyHashes.set(keyHash, tenantId);
        }
        for (const [rawKey, tenantId] of Object.entries((_b = this.config.tenantApiKeys) !== null && _b !== void 0 ? _b : {})) {
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
                    (0, logging_1.getGlobalLogger)().info('HttpServer', 'OIDC auth plugin initialized', {
                        issuer: (_c = plugin['config']) === null || _c === void 0 ? void 0 : _c.issuer,
                    });
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().debug('HttpServer', 'OIDC plugin not available', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
        // Initialize SIEM forwarder from env if configured
        if (this.config.siemForwarder) {
            this.registerSIEMForwarder(this.config.siemForwarder);
        }
        else {
            try {
                const { createSIEMForwarderFromEnv } = require('./siemForwarder');
                const forwarder = createSIEMForwarderFromEnv();
                if (forwarder) {
                    this.registerSIEMForwarder(forwarder);
                    (0, logging_1.getGlobalLogger)().info('HttpServer', 'SIEM forwarder initialized', {
                        type: (_d = forwarder['config']) === null || _d === void 0 ? void 0 : _d.type,
                        endpoint: (_e = forwarder['config']) === null || _e === void 0 ? void 0 : _e.endpoint,
                    });
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().debug('HttpServer', 'SIEM forwarder not available', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
    }
    async start() {
        return new Promise((resolve) => {
            const handler = (req, res) => {
                // Track connection for graceful shutdown
                const socket = req.socket;
                this.connections.add(socket);
                res.on('finish', () => {
                    this.connections.delete(socket);
                });
                this.handleRequest(req, res).catch((err) => {
                    (0, logging_1.getGlobalLogger)().error('HttpServer', 'Unhandled error in request handler', err instanceof Error ? err : new Error(String(err)));
                    if (!res.headersSent) {
                        res.writeHead(500);
                        res.end('Internal Server Error');
                    }
                });
            };
            this.server = this.config.https
                ? (0, https_1.createServer)(this.config.https, handler)
                : (0, http_1.createServer)(handler);
            this.server.listen(this.config.port, this.config.host, () => {
                (0, logging_1.getGlobalLogger)().info('HttpServer', 'Listening', {
                    protocol: this.config.https ? 'https' : 'http',
                    host: this.config.host,
                    port: this.config.port,
                    authEnabled: !this.authDisabled,
                });
                // Tier 1.1: Install process crash handlers for the HTTP server
                try {
                    const dlq = (0, deadLetterQueueSingleton_1.getDeadLetterQueue)();
                    const leaseManager = new leaseManager_1.LeaseManager();
                    (0, processCrashSafety_1.installProcessCrashHandlers)({
                        dlq,
                        leaseManager,
                        activeRunIds: () => {
                            const ids = [];
                            for (const [, entry] of this.runtimes) {
                                // Each runtime tracks its own activeRuns — aggregate them
                            }
                            return ids;
                        },
                        leaseTokenFor: () => undefined,
                        fencingEpochFor: () => undefined,
                        tenantIdFor: () => undefined,
                    });
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('HttpServer', 'Failed to install crash handlers', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
                resolve();
            });
            // Periodic cleanup of stale sessions and rate limit entries
            this.sessionCleanupTimer = setInterval(() => this.evictStaleSessions(), 5 * 60000);
            if (typeof this.sessionCleanupTimer.unref === 'function')
                this.sessionCleanupTimer.unref();
        });
    }
    /** Return the port the server is actually listening on (useful when port=0). */
    getPort() {
        var _a;
        const addr = (_a = this.server) === null || _a === void 0 ? void 0 : _a.address();
        return addr && typeof addr === 'object' ? addr.port : this.config.port;
    }
    evictStaleSessions() {
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
            if (now > entry.resetAt)
                this.rateLimitMap.delete(ip);
        }
    }
    async stop(forceTimeoutMs = 10000) {
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
                        (0, logging_1.getGlobalLogger)().info('HttpServer', 'Cancelled in-flight steps', { cancelled });
                    }
                }
                catch {
                    /* best-effort */
                }
            }
            const remaining = this.connections.size;
            if (remaining > 0) {
                (0, logging_1.getGlobalLogger)().info('HttpServer', 'Draining connections', { remaining });
            }
            // Stop accepting new connections, then resolve once drained
            this.server.close(() => {
                this.connections.clear();
                resolve();
            });
            // Force-close remaining connections after timeout
            if (remaining > 0) {
                const timer = setTimeout(() => {
                    (0, logging_1.getGlobalLogger)().warn('HttpServer', 'Force closing remaining connections', {
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
    async handleRequest(req, res) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        this.applyCommonHeaders(req, res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = (_a = req.url) !== null && _a !== void 0 ? _a : '/';
        const [pathPart, queryStr] = url.split('?');
        const segments = pathPart.split('/').filter(Boolean);
        // GAP-31: Health endpoint bypasses auth and rate limiting
        if (segments[0] === 'health' && ((_b = req.method) !== null && _b !== void 0 ? _b : 'GET') === 'GET') {
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
        if (segments[0] === 'metrics' && ((_c = req.method) !== null && _c !== void 0 ? _c : 'GET') === 'GET') {
            const accept = (_d = req.headers.accept) !== null && _d !== void 0 ? _d : '';
            if (accept.includes('text/plain') || accept.includes('openmetrics')) {
                res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
                res.end((0, metricsCollector_1.getMetricsCollector)().exportOpenMetrics());
            }
            else {
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
        if (segments[0] === 'openapi.json' && ((_e = req.method) !== null && _e !== void 0 ? _e : 'GET') === 'GET') {
            sendJson(res, 200, openapi_1.openApiSpec);
            return;
        }
        // Compensation dashboard (HTML page — bypasses auth for local dev, but not rate limiting)
        if (segments[0] === 'dashboard' &&
            segments[1] === 'compensation' &&
            ((_f = req.method) !== null && _f !== void 0 ? _f : 'GET') === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end((0, compensationDashboard_1.renderDashboardHtml)(this.bus));
            return;
        }
        // SOP dashboard (HTML page — bypasses auth for local dev)
        if (segments[0] === 'dashboard' && segments[1] === 'sop' && ((_g = req.method) !== null && _g !== void 0 ? _g : 'GET') === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end((0, sopDashboard_1.renderSOPDashboardHtml)());
            return;
        }
        // Readiness probe (separate from health — checks deps)
        if (segments[0] === 'ready' && ((_h = req.method) !== null && _h !== void 0 ? _h : 'GET') === 'GET') {
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
                        }
                        catch {
                            continue;
                        }
                    }
                    if (!oidcAuthenticated) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: 'Unauthorized. Provide Authorization: Bearer <api-key> or valid OIDC token.',
                        }));
                        return;
                    }
                    // Passed OIDC auth — continue to request handling
                }
                else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Unauthorized. Provide Authorization: Bearer <token> header.',
                    }));
                    return;
                }
            }
            else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Unauthorized. Provide Authorization: Bearer <api-key> header.',
                }));
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
            const ip = (_j = req.socket.remoteAddress) !== null && _j !== void 0 ? _j : 'unknown';
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
            }
            else if (segments[0] === 'stream') {
                const streamSegments = segments.slice(1);
                if (streamSegments[0] === 'cost') {
                    await this.handleCostStreamRequest(req, res);
                }
                else if (streamSegments[0] === 'compensation') {
                    await this.handleCompensationStreamRequest(req, res);
                }
                else if (streamSegments[0] === 'sop') {
                    await this.handleSOPStreamRequest(req, res);
                }
                else {
                    await this.handleStreamRequest(req, res, streamSegments);
                }
            }
            else {
                sendJson(res, 404, { error: 'Not found' });
            }
        }
        catch (err) {
            const status = err instanceof HttpRequestError ? err.statusCode : 500;
            if (err instanceof HttpRequestError) {
                (0, logging_1.getGlobalLogger)().warn('HttpServer', err.message);
            }
            else {
                (0, logging_1.getGlobalLogger)().error('HttpServer', 'Request error', err instanceof Error ? err : new Error(String(err)));
            }
            sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    applyCommonHeaders(req, res) {
        const requestId = this.getRequestId(req);
        res.setHeader('X-Request-Id', requestId);
        if (!this.config.cors)
            return;
        const allowedOrigins = this.config.corsAllowedOrigins;
        const origin = req.headers.origin;
        const allowAll = allowedOrigins.includes('*');
        if (origin && (allowAll || allowedOrigins.includes(origin))) {
            res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
            if (!allowAll)
                res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    }
    getRequestId(req) {
        var _a;
        const incoming = req.headers['x-request-id'];
        if (typeof incoming === 'string' && incoming.trim())
            return incoming;
        if (Array.isArray(incoming) && ((_a = incoming[0]) === null || _a === void 0 ? void 0 : _a.trim()))
            return incoming[0];
        return crypto.randomUUID();
    }
    async handleApiRequest(req, res, segments, queryStr) {
        var _a, _b, _c, _d, _e, _f, _g;
        const method = (_a = req.method) !== null && _a !== void 0 ? _a : 'GET';
        if (segments[0] === 'v1') {
            const [, resource, id] = segments;
            if (resource === 'runtime') {
                if (method === 'POST') {
                    const body = (await parseBody(req, this.config.maxBodyBytes));
                    const sessionId = (_b = body.sessionId) !== null && _b !== void 0 ? _b : `session_${Date.now()}`;
                    const runtime = new agentRuntime_1.AgentRuntime();
                    runtime.registerProvider((_c = body.provider) !== null && _c !== void 0 ? _c : 'openai', this.getDefaultProvider(body.provider));
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
                    const body = (await parseBody(req, this.config.maxBodyBytes));
                    const sessionId = (_d = body.sessionId) !== null && _d !== void 0 ? _d : `session_${Date.now()}`;
                    // Derive tenantId from API key (never trust request body for tenant)
                    const tenantId = this.resolveTenantFromAuth(req);
                    let entry = this.runtimes.get(sessionId);
                    if (!entry) {
                        // Enforce max sessions cap
                        if (this.runtimes.size >= CommanderHttpServer.MAX_SESSIONS)
                            this.evictStaleSessions();
                        if (this.runtimes.size >= CommanderHttpServer.MAX_SESSIONS) {
                            sendJson(res, 429, {
                                error: 'Maximum sessions reached. Please reuse an existing session.',
                            });
                            return;
                        }
                        const runtime = new agentRuntime_1.AgentRuntime();
                        runtime.registerProvider((_e = body.provider) !== null && _e !== void 0 ? _e : 'openai', this.getDefaultProvider(body.provider));
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
                        steps: (_f = result.steps) === null || _f === void 0 ? void 0 : _f.length,
                    });
                    return;
                }
            }
            if (resource === 'bus') {
                if (method === 'GET') {
                    const topic = queryStr
                        ? ((_g = new URLSearchParams(queryStr).get('topic')) !== null && _g !== void 0 ? _g : undefined)
                        : undefined;
                    sendJson(res, 200, {
                        topics: this.bus.getActiveTopics(),
                        history: this.bus
                            .getHistory(topic, 50)
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
                const atrDeps = {
                    scheduler: (0, scheduler_1.getExecutionScheduler)(),
                    resolveTenant: (r) => this.resolveTenantFromAuth(r),
                };
                const atrSegments = segments.slice(2);
                const r = await (0, atrHttp_1.handleAtrHttpRequest)(req, res, atrDeps, atrSegments, queryStr, {
                    maxBodyBytes: this.config.maxBodyBytes,
                });
                if (r.handled)
                    return;
            }
            if (resource === 'compensation' && method === 'GET') {
                // GET /api/v1/compensation — JSON compensation metrics snapshot
                sendJson(res, 200, (0, compensationDashboard_1.getCompensationData)(this.bus));
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
                        sendJson(res, 200, (0, sopDashboard_1.getSOPDashboardData)());
                        return;
                    }
                    if (!runId) {
                        // List SOPs for a specific agent
                        const allSops = (0, sopDashboard_1.listSOPs)();
                        const filtered = allSops.filter((s) => s.agentId === agentId);
                        sendJson(res, 200, { agentId, sops: filtered, total: filtered.length });
                        return;
                    }
                    if (format === 'markdown') {
                        const md = (0, sopDashboard_1.getSOPMarkdown)(agentId, runId);
                        if (!md) {
                            sendJson(res, 404, { error: 'SOP not found' });
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
                        res.end(md);
                        return;
                    }
                    // Default: return structured JSON
                    const sop = (0, sopDashboard_1.getSOP)(agentId, runId);
                    if (!sop) {
                        sendJson(res, 404, { error: 'SOP not found' });
                        return;
                    }
                    sendJson(res, 200, sop);
                    return;
                }
            }
            if (resource === 'observability') {
                const traceStore = new traceStore_1.PersistentTraceStore();
                const obsDeps = {
                    recorder: (0, executionTrace_1.getTraceRecorder)(traceStore),
                    traceStore,
                    resolveTenant: (r) => this.resolveTenantFromAuth(r),
                };
                const obsSegments = segments.slice(1);
                const r = await (0, httpApi_1.handleObservabilityRequest)(req, res, obsDeps, obsSegments, queryStr);
                if (r.handled)
                    return;
            }
        }
        sendJson(res, 404, { error: 'Unknown endpoint' });
    }
    async handleStreamRequest(req, res, segments) {
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
        const stream = new sseStream_1.SSEStream();
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
    async handleCompensationStreamRequest(req, res) {
        const stream = new sseStream_1.SSEStream();
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
            if (stream.isClosed)
                return;
            stream.emitStructured('compensation.update', (0, compensationDashboard_1.getCompensationData)(this.bus));
        });
        const unsubStep = this.bus.subscribe('tool.compensation_step', () => {
            if (stream.isClosed)
                return;
            stream.emitStructured('compensation.update', (0, compensationDashboard_1.getCompensationData)(this.bus));
        });
        req.on('close', () => {
            unsubPlanned();
            unsubStep();
            stream.close();
        });
    }
    async handleSOPStreamRequest(req, res) {
        const stream = new sseStream_1.SSEStream();
        stream.pipe(res);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        // Subscribe to SOP bus events and emit structured snapshots
        const unsubGenerated = this.bus.subscribe('sop.generated', () => {
            if (stream.isClosed)
                return;
            stream.emitStructured('sop.update', (0, sopDashboard_1.getSOPDashboardData)());
        });
        req.on('close', () => {
            unsubGenerated();
            stream.close();
        });
    }
    async handleCostStreamRequest(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        const stream = new sseStream_1.SSEStream();
        stream.pipe(res);
        const costModel = (0, costModel_1.getCostModel)();
        const sessionCosts = new Map();
        const unsubLlm = this.bus.subscribe('tool.executed', (msg) => {
            var _a, _b;
            const payload = msg.payload;
            if (!payload.model || !payload.provider)
                return;
            const runId = (_a = payload.runId) !== null && _a !== void 0 ? _a : 'unknown';
            const tokens = (_b = payload.tokens) !== null && _b !== void 0 ? _b : 0;
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
    registerMCPServer(name, tools) {
        const server = new server_1.MCPServer(name, '1.0.0');
        server.registerCommanderTools(tools);
        server.registerExecutionResource();
        this.mcpServer = server;
        (0, logging_1.getGlobalLogger)().info('HttpServer', `MCP Server "${name}" registered with ${tools.size} tools`);
    }
    async handleMCPRequest(req, res) {
        var _a;
        if (((_a = req.method) !== null && _a !== void 0 ? _a : 'GET') !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed. Use POST for MCP requests.' });
            return;
        }
        if (!this.mcpServer) {
            sendJson(res, 503, { error: 'MCP Server not initialized. Call registerMCPServer first.' });
            return;
        }
        try {
            const body = (await parseBody(req, this.config.maxBodyBytes));
            const response = await this.mcpServer.handleRequest(body);
            sendJson(res, 200, response);
        }
        catch (err) {
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
    registerAuthPlugin(plugin) {
        this.authPlugins.push(plugin);
        (0, logging_1.getGlobalLogger)().info('HttpServer', `Auth plugin registered: ${plugin.name}`);
    }
    /**
     * Register a SIEM forwarder for security log forwarding.
     * Wire security audit events from the bus to the forwarder.
     */
    registerSIEMForwarder(forwarder) {
        var _a;
        this.siemForwarder = forwarder;
        // Subscribe to security events on the message bus
        if (this.securityEventUnsub) {
            this.securityEventUnsub();
        }
        this.securityEventUnsub = this.bus.subscribe('security.event', (msg) => {
            if (!this.siemForwarder)
                return;
            const event = msg.payload;
            if (!event || !event.type)
                return;
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
        (0, logging_1.getGlobalLogger)().info('HttpServer', `SIEM forwarder registered: ${(_a = forwarder['config']) === null || _a === void 0 ? void 0 : _a.type}`);
    }
    /** Resolve tenant ID from the Authorization header using configured API key mapping. */
    resolveTenantFromAuth(req) {
        const key = extractAuthKey(req);
        if (!key)
            return undefined;
        return this.tenantApiKeyHashes.get(hashSecret(key));
    }
    checkRateLimit(ip) {
        const now = Date.now();
        const entry = this.rateLimitMap.get(ip);
        if (!entry || now > entry.resetAt) {
            this.rateLimitMap.set(ip, { count: 1, resetAt: now + 60000 });
            return true;
        }
        if (entry.count >= this.config.rateLimitPerMinute)
            return false;
        entry.count++;
        return true;
    }
    getDefaultProvider(provider = 'openai') {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u;
        switch (provider) {
            case 'openai':
                return new openaiProvider_1.OpenAIProvider({ apiKey: (_a = process.env.OPENAI_API_KEY) !== null && _a !== void 0 ? _a : '' });
            case 'anthropic':
                return new anthropicProvider_1.AnthropicProvider({ apiKey: (_b = process.env.ANTHROPIC_API_KEY) !== null && _b !== void 0 ? _b : '' });
            case 'google':
                return new googleProvider_1.GoogleProvider({ apiKey: (_c = process.env.GOOGLE_API_KEY) !== null && _c !== void 0 ? _c : '' });
            case 'openrouter':
                return new openRouterProvider_1.OpenRouterProvider({ apiKey: (_d = process.env.OPENROUTER_API_KEY) !== null && _d !== void 0 ? _d : '' });
            case 'deepseek':
                return new deepseekProvider_1.DeepSeekProvider({ apiKey: (_e = process.env.DEEPSEEK_API_KEY) !== null && _e !== void 0 ? _e : '' });
            case 'glm':
                return new glmProvider_1.GLMProvider({ apiKey: (_f = process.env.ZHIPU_API_KEY) !== null && _f !== void 0 ? _f : '' });
            case 'mimo':
                return new mimoProvider_1.MiMoProvider({ apiKey: (_g = process.env.MIMO_API_KEY) !== null && _g !== void 0 ? _g : '' });
            case 'xiaomi':
                return new xiaomiProvider_1.XiaomiProvider({ apiKey: (_h = process.env.XIAOMI_API_KEY) !== null && _h !== void 0 ? _h : '' });
            case 'ollama':
                return new ollamaProvider_1.OllamaProvider({});
            case 'vllm':
                return new vllmProvider_1.VLLMProvider({});
            case 'cohere':
                return new cohereProvider_1.CohereProvider({
                    apiKey: (_j = (process.env.CO_API_KEY || process.env.COHERE_API_KEY)) !== null && _j !== void 0 ? _j : '',
                });
            case 'mistral':
                return new mistralProvider_1.MistralProvider({ apiKey: (_k = process.env.MISTRAL_API_KEY) !== null && _k !== void 0 ? _k : '' });
            case 'groq':
                return new groqProvider_1.GroqProvider({ apiKey: (_l = process.env.GROQ_API_KEY) !== null && _l !== void 0 ? _l : '' });
            case 'together':
                return new togetherProvider_1.TogetherProvider({ apiKey: (_m = process.env.TOGETHER_API_KEY) !== null && _m !== void 0 ? _m : '' });
            case 'perplexity':
                return new perplexityProvider_1.PerplexityProvider({
                    apiKey: (_o = (process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY)) !== null && _o !== void 0 ? _o : '',
                });
            case 'fireworks':
                return new fireworksProvider_1.FireworksProvider({ apiKey: (_p = process.env.FIREWORKS_API_KEY) !== null && _p !== void 0 ? _p : '' });
            case 'replicate':
                return new replicateProvider_1.ReplicateProvider({
                    apiKey: (_q = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY)) !== null && _q !== void 0 ? _q : '',
                });
            case 'bedrock':
                return new bedrockProvider_1.BedrockProvider({});
            case 'xai':
                return new xaiProvider_1.XAIProvider({ apiKey: (_r = process.env.XAI_API_KEY) !== null && _r !== void 0 ? _r : '' });
            case 'anyscale':
                return new anyscaleProvider_1.AnyscaleProvider({ apiKey: (_s = process.env.ANYSCALE_API_KEY) !== null && _s !== void 0 ? _s : '' });
            case 'deepinfra':
                return new deepinfraProvider_1.DeepInfraProvider({ apiKey: (_t = process.env.DEEPINFRA_API_KEY) !== null && _t !== void 0 ? _t : '' });
            default:
                return new openaiProvider_1.OpenAIProvider({ apiKey: (_u = process.env.OPENAI_API_KEY) !== null && _u !== void 0 ? _u : '' });
        }
    }
}
exports.CommanderHttpServer = CommanderHttpServer;
CommanderHttpServer.SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
CommanderHttpServer.MAX_SESSIONS = 200;
function createHttpServer(config) {
    return new CommanderHttpServer(config);
}
