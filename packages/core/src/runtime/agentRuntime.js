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
exports.AgentRuntime = void 0;
const modelRouter_1 = require("./modelRouter");
const smartModelRouter_1 = require("./smartModelRouter");
const messageBus_1 = require("./messageBus");
const executionTrace_1 = require("./executionTrace");
const anomalyDetector_1 = require("../observability/anomalyDetector");
const traceStore_1 = require("./traceStore");
const programmaticToolFormatter_1 = require("./programmaticToolFormatter");
const contextCompactor_1 = require("./contextCompactor");
const slidingWindowOrchestrator_1 = require("./slidingWindowOrchestrator");
const llmRetry_1 = require("./llmRetry");
const circuitBreaker_1 = require("./circuitBreaker");
const parameterController_1 = require("./parameterController");
const unifiedVerification_1 = require("./unifiedVerification");
const toolProvisioner_1 = require("./toolProvisioner");
const tokenGovernor_1 = require("./tokenGovernor");
const samplesStore_1 = require("./samplesStore");
const provenance_1 = require("./provenance");
const intentLog_1 = require("./intentLog");
const verificationReportStore_1 = require("./verificationReportStore");
const stateCheckpointer_1 = require("./stateCheckpointer");
const processCrashSafety_1 = require("./processCrashSafety");
const runRecovery_1 = require("./runRecovery");
const stepTimeoutManager_1 = require("./stepTimeoutManager");
const providerFallbackChain_1 = require("./providerFallbackChain");
const compensationQueue_1 = require("../atr/compensationQueue");
const reflexionInjector_1 = require("../memory/reflexionInjector");
const deadLetterQueue_1 = require("./deadLetterQueue");
const stepErrorBoundary_1 = require("./stepErrorBoundary");
const metricsCollector_1 = require("./metricsCollector");
const compensationRegistry_1 = require("./compensationRegistry");
const agentInbox_1 = require("./agentInbox");
const teamRegistry_1 = require("./teamRegistry");
const agentHandoff_1 = require("./agentHandoff");
const threeLayerMemory_1 = require("../threeLayerMemory");
const tenantContext_1 = require("./tenantContext");
const pluginManager_1 = require("../pluginManager");
const toolResultCache_1 = require("./toolResultCache");
const semanticCache_1 = require("./semanticCache");
const singleFlightRequestCache_1 = require("./singleFlightRequestCache");
const geminiCacheManager_1 = require("./geminiCacheManager");
const embedding_1 = require("./embedding");
const toolOutputManager_1 = require("./toolOutputManager");
const toolOrchestrator_1 = require("./toolOrchestrator");
const toolApproval_1 = require("./toolApproval");
const toolRetriever_1 = require("./toolRetriever");
const requestToolTool_1 = require("../tools/requestToolTool");
const toolPlanner_1 = require("./toolPlanner");
const cycleDetector_1 = require("./cycleDetector");
const toolCallRepair_1 = require("./toolCallRepair");
const toolCallValidator_1 = require("./toolCallValidator");
const toolCallRepair_2 = require("./toolCallRepair");
const toolRegistry_1 = require("../tools/toolRegistry");
const scheduler_1 = require("../atr/scheduler");
const leaseManager_1 = require("../atr/leaseManager");
const canonicalJson_1 = require("../atr/canonicalJson");
const structuredOutput_1 = require("./structuredOutput");
const entropyGater_1 = require("./entropyGater");
const interruptError_1 = require("./interruptError");
const contentScanner_1 = require("../contentScanner");
const contentScanner_2 = require("../contentScanner");
const privacyRouter_1 = require("./privacyRouter");
const rollbackPlanner_1 = require("../compensation/rollbackPlanner");
const tenantProvider_1 = require("./tenantProvider");
const lane_1 = require("../sandbox/lane");
const memory_1 = require("../memory");
const compensationEventSubscriber_1 = require("./compensationEventSubscriber");
const conversationStore_1 = require("../memory/conversationStore");
const openTelemetryExporter_1 = require("./openTelemetryExporter");
const sopExport_1 = require("./sopExport");
const promptBuilder_1 = require("./promptBuilder");
const projectContextLoader_1 = require("./projectContextLoader");
const reflexionGenerator_1 = require("./reflexionGenerator");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const logging_1 = require("../logging");
const costEstimator_1 = require("./costEstimator");
const modelPerformanceStore_1 = require("./modelPerformanceStore");
const guardianAgent_1 = require("../security/guardianAgent");
const securityMonitor_1 = require("../security/securityMonitor");
const runtimeHelpers_1 = require("./runtimeHelpers");
class AgentRuntime {
    constructor(config, router, tenantProvider) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
        this.providers = new Map();
        this.tools = new Map();
        this.smartRouter = null;
        /** When false, the smart router is bypassed and the legacy routeWithCascade path runs even if a smartRouter instance exists. Default ON. */
        this.smartRouterActive = true;
        this.activeRuns = new Set();
        this.pausedRuns = new Set();
        this.memory = null;
        this.reflexionGenerator = new reflexionGenerator_1.ReflexionGenerator();
        this.memoryStore = null;
        this.otelExporter = null;
        this.queueTimer = null;
        /** Tools promoted to Tier 1 (full schema) in the current turn — for hallucination rejection gate */
        this.promotedTools = new Set();
        // Phase 3 — ExecutionScheduler handle for the currently executing run
        this.runHandle = null;
        /** Tracks successful mutation tool calls per retry attempt for rollback planning */
        this.executedMutations = [];
        /** RunLedger transaction context (runId, leaseToken, fencingEpoch) */
        this.ledgerCtx = null;
        // Conversation store (FTS5-powered session persistence)
        this.conversationStore = null;
        // Concurrency semaphore (GAP-07)
        this.runningCount = 0;
        this.waitingQueue = [];
        this.tenantRateLimits = new Map();
        this.tenantRunningCounts = new Map();
        this.tenantSamplesStores = new Map();
        this.tenantTraceStores = new Map();
        this.tenantCheckpointers = new Map();
        this.config = { ...runtimeHelpers_1.DEFAULT_CONFIG, ...config };
        this.router = router !== null && router !== void 0 ? router : (0, modelRouter_1.getModelRouter)();
        if ((_a = this.config.smartModelRouter) === null || _a === void 0 ? void 0 : _a.enabled) {
            this.smartRouter =
                (_b = smartModelRouter_1.SmartModelRouter.fromEnv()) !== null && _b !== void 0 ? _b : new smartModelRouter_1.SmartModelRouter(this.config.smartModelRouter);
        }
        this.tenantProvider = tenantProvider !== null && tenantProvider !== void 0 ? tenantProvider : (0, tenantProvider_1.getGlobalTenantProvider)();
        this.compactor = new contextCompactor_1.ContextCompactor({
            maxContextTokens: this.config.budgetHardCapTokens || 128000,
        });
        this.slidingWindow = new slidingWindowOrchestrator_1.SlidingWindowOrchestrator();
        this.circuitBreaker = new circuitBreaker_1.CircuitBreaker(5, 30000);
        this.circuitBreaker.setProviderName('agentRuntime');
        this.circuitBreaker.setObservability({
            onTransition: (from, to, provider) => {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordCircuitTransition(from, to, provider !== null && provider !== void 0 ? provider : 'agentRuntime');
                }
                catch {
                    /* best-effort */
                }
                try {
                    this.dlq.enqueue({
                        category: 'circuit_breaker',
                        operationName: 'circuit.transition',
                        errorMessage: `${from}->${to}`,
                        tags: [`from:${from}`, `to:${to}`, `provider:${provider !== null && provider !== void 0 ? provider : 'agentRuntime'}`],
                        failureMode: 'circuit_open',
                        failureModeNumber: 11,
                    });
                }
                catch {
                    /* best-effort */
                }
                try {
                    (0, intentLog_1.getIntentLog)(undefined).write({
                        schemaVersion: 1,
                        runId: 'circuit-breaker',
                        capturedAt: new Date().toISOString(),
                        stage: 'agentRuntime.circuit',
                        decision: 'transition',
                        reason: `circuit ${from}->${to}`,
                        payload: { from, to, provider: provider !== null && provider !== void 0 ? provider : 'agentRuntime' },
                    });
                }
                catch {
                    /* best-effort */
                }
            },
        });
        // Wire semantic trip handler: when consecutive verification failures exceed
        // threshold, publish an alert and enqueue a dead-letter entry for operator
        // review. This enables operators to detect systemic quality degradation
        // (e.g., a model version regression) vs. isolated operational errors.
        this.circuitBreaker.setSemanticTripHandler((consecutiveFailures, reason) => {
            const bus = (0, messageBus_1.getMessageBus)();
            bus.publish('system.alert', 'runtime', {
                type: 'semantic_circuit_trip',
                consecutiveFailures,
                reason,
            });
            try {
                this.dlq.enqueue({
                    category: 'verification',
                    operationName: 'semantic.circuit_trip',
                    errorMessage: `Semantic circuit tripped after ${consecutiveFailures} consecutive verification failures: ${reason}`,
                    tags: ['semantic_drift', 'verification_failure', `count:${consecutiveFailures}`],
                    failureMode: 'verification',
                    failureModeNumber: 7,
                });
            }
            catch {
                /* best-effort */
            }
            try {
                (0, intentLog_1.getIntentLog)(undefined).write({
                    schemaVersion: 1,
                    runId: 'semantic-circuit-breaker',
                    capturedAt: new Date().toISOString(),
                    stage: 'agentRuntime.semantic',
                    decision: 'trip',
                    reason: `semantic circuit tripped: ${consecutiveFailures} consecutive failures`,
                    payload: { consecutiveFailures, reason },
                });
            }
            catch {
                /* best-effort */
            }
        });
        this.governor = new tokenGovernor_1.TokenGovernor({ totalBudget: this.config.budgetHardCapTokens || 200000 });
        this.verificationPipeline = new unifiedVerification_1.UnifiedVerificationPipeline({
            enabled: true,
            budgetFloorTokens: 1500,
            llmVerificationBudget: 300,
        });
        this.verificationPipeline.setRuntime(this);
        this.reflexionInjector = new reflexionInjector_1.ReflexionInjector({
            maxReflections: 3,
            maxTokensPerReflection: 50,
        });
        this.samplesStore = new samplesStore_1.SamplesStore();
        this.traceStore = new traceStore_1.PersistentTraceStore();
        this.checkpointer = new stateCheckpointer_1.StateCheckpointer();
        this.dlq = new deadLetterQueue_1.DeadLetterQueue();
        this.leaseManager = new leaseManager_1.LeaseManager();
        this.stepTimeout = new stepTimeoutManager_1.StepTimeoutManager();
        this.fallbackChain = new providerFallbackChain_1.ProviderFallbackChain();
        this.compensationRegistry = new compensationRegistry_1.CompensationRegistry();
        // Wire durable compensation queue for crash-safe retry
        try {
            this.compensationRegistry.setCompensationQueue((0, compensationQueue_1.getCompensationQueue)());
        }
        catch {
            /* queue requires better-sqlite3; skip durable retry */
        }
        this.compensationRegistry.setObservability({
            onSuccess: (action) => {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordCompensation(action.toolName, 'success');
                }
                catch {
                    /* best-effort */
                }
            },
            onFailed: (action, err) => {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordCompensation(action.toolName, 'failed');
                }
                catch {
                    /* best-effort */
                }
                try {
                    (0, intentLog_1.getIntentLog)(undefined).write({
                        schemaVersion: 1,
                        runId: 'compensation',
                        capturedAt: new Date().toISOString(),
                        stage: 'agentRuntime.compensation',
                        decision: 'failed',
                        reason: err.slice(0, 200),
                        payload: {
                            toolName: action.toolName,
                            actionId: action.actionId,
                            args: JSON.stringify(action.args).slice(0, 500),
                        },
                    });
                }
                catch {
                    /* best-effort */
                }
            },
            onExhausted: (action, err) => {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordCompensation(action.toolName, 'exhausted');
                }
                catch {
                    /* best-effort */
                }
                try {
                    this.dlq.enqueue({
                        category: 'compensation',
                        operationName: 'compensation.exhausted',
                        errorMessage: err,
                        tags: [action.toolName],
                        failureMode: 'compensation_exhausted',
                        failureModeNumber: 12,
                    });
                }
                catch {
                    /* best-effort */
                }
                try {
                    (0, intentLog_1.getIntentLog)(undefined).write({
                        schemaVersion: 1,
                        runId: 'compensation',
                        capturedAt: new Date().toISOString(),
                        stage: 'agentRuntime.compensation',
                        decision: 'exhausted',
                        reason: err.slice(0, 200),
                        payload: { toolName: action.toolName, actionId: action.actionId },
                    });
                }
                catch {
                    /* best-effort */
                }
            },
        });
        this.agentInbox = new agentInbox_1.AgentInbox();
        this.teamRegistry = new teamRegistry_1.TeamRegistry();
        this.agentHandoff = new agentHandoff_1.AgentHandoff(this.agentInbox, this.checkpointer);
        // Register default compensation handlers for mutation tools
        this.registerDefaultCompensation();
        try {
            this.memory = (0, threeLayerMemory_1.getGlobalThreeLayerMemory)();
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to initialize global memory', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
        try {
            (0, executionTrace_1.getTraceRecorder)(this.traceStore);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to initialize trace recorder', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
        // Initialize memory store if configured
        if (this.config.memoryStoreType) {
            (0, memory_1.createMemoryStore)(this.config.memoryStoreType)
                .then((store) => {
                this.memoryStore = store;
            })
                .catch((e) => {
                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to initialize memory store', {
                    type: this.config.memoryStoreType,
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            });
        }
        // Initialize OTel exporter if configured
        if ((_c = this.config.otelExporter) === null || _c === void 0 ? void 0 : _c.enabled) {
            try {
                const exporter = (0, openTelemetryExporter_1.getOTelExporter)({
                    endpoint: this.config.otelExporter.endpoint,
                    serviceName: this.config.otelExporter.serviceName,
                    headers: this.config.otelExporter.headers,
                });
                exporter.start().catch((e) => (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to start OTel exporter', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                }));
                this.otelExporter = exporter;
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to initialize OTel exporter', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
        // Tool calling infrastructure
        this.toolCache = new toolResultCache_1.ToolResultCache({
            enabled: true,
            maxEntries: 512,
            defaultTtlMs: 1800000,
        });
        this.semanticCache = resolveSemanticCache(this.config);
        this.singleFlight = new singleFlightRequestCache_1.SingleFlightRequestCache({
            enabled: (_e = (_d = this.config.singleFlight) === null || _d === void 0 ? void 0 : _d.enabled) !== null && _e !== void 0 ? _e : true,
            maxInFlight: (_g = (_f = this.config.singleFlight) === null || _f === void 0 ? void 0 : _f.maxInFlight) !== null && _g !== void 0 ? _g : 1000,
        });
        this.geminiCache = new geminiCacheManager_1.GeminiCacheManager({
            enabled: (_j = (_h = this.config.geminiCache) === null || _h === void 0 ? void 0 : _h.enabled) !== null && _j !== void 0 ? _j : true,
            maxEntries: (_l = (_k = this.config.geminiCache) === null || _k === void 0 ? void 0 : _k.maxEntries) !== null && _l !== void 0 ? _l : 100,
            defaultTtlSeconds: (_o = (_m = this.config.geminiCache) === null || _m === void 0 ? void 0 : _m.defaultTtlSeconds) !== null && _o !== void 0 ? _o : 300,
            fetchTimeoutMs: (_q = (_p = this.config.geminiCache) === null || _p === void 0 ? void 0 : _p.fetchTimeoutMs) !== null && _q !== void 0 ? _q : 30000,
        });
        this.outputManager = new toolOutputManager_1.ToolOutputManager({ enabled: true, turnBudget: 32000 });
        // ToolApproval with configurable approval callback
        // When approval is configured with a custom callback, use it; otherwise auto-approve.
        const approvalCfg = this.config.approval;
        const defaultApprovalCallback = async (req) => ({
            approved: true,
            requestId: req.id,
            approvedAt: new Date().toISOString(),
            reason: 'Auto-approved',
        });
        const approvalCallback = (_r = approvalCfg === null || approvalCfg === void 0 ? void 0 : approvalCfg.approvalCallback) !== null && _r !== void 0 ? _r : defaultApprovalCallback;
        const toolApproval = new toolApproval_1.ToolApproval(approvalCallback);
        this.orchestrator = new toolOrchestrator_1.ToolOrchestrator({ enabled: true, maxRetries: 1, circuitBreakerThreshold: 3, useApproval: true }, toolApproval);
        this.planner = new toolPlanner_1.ToolPlanner();
        this.cycleDetector = new cycleDetector_1.CycleDetector();
        this.contentScanner = (0, contentScanner_1.createContentScanner)();
        // Initialize ConversationStore for FTS5-powered conversation persistence
        try {
            this.conversationStore = (0, conversationStore_1.getConversationStore)();
            // Wire auto-recording of conversations via bus events
            // Every agent.started → startSession(), every agent.completed/failed → endSession().
            // Uses a runId→sessionId map instead of payload mutation because bus event
            // payloads are separate objects for started/completed/failed.
            const bus = (0, messageBus_1.getMessageBus)();
            const store = this.conversationStore;
            const sessionMap = new Map();
            bus.subscribe('agent.started', (msg) => {
                var _a;
                const payload = msg.payload;
                const runId = ((_a = payload.runId) !== null && _a !== void 0 ? _a : payload.taskId);
                const goal = payload.goal;
                if (!runId || !goal)
                    return;
                store
                    .startSession({
                    projectId: 'default',
                    agentId: msg.source,
                    goal: goal || undefined,
                    metadata: { runId, model: payload.model },
                })
                    .then((session) => {
                    sessionMap.set(runId, session.id);
                    store
                        .addTurn({
                        sessionId: session.id,
                        role: 'user',
                        content: goal,
                    })
                        .catch(() => { });
                })
                    .catch(() => { });
            });
            bus.subscribe('agent.completed', (msg) => {
                var _a;
                const payload = msg.payload;
                const runId = ((_a = payload.runId) !== null && _a !== void 0 ? _a : payload.taskId);
                const summary = payload.summary;
                if (!runId)
                    return;
                const sessionId = sessionMap.get(runId);
                if (sessionId) {
                    sessionMap.delete(runId);
                    store
                        .addTurn({
                        sessionId,
                        role: 'assistant',
                        content: (summary || '').slice(0, 5000),
                    })
                        .catch(() => { });
                    store.endSession(sessionId).catch(() => { });
                }
            });
            bus.subscribe('agent.failed', (msg) => {
                var _a;
                const payload = msg.payload;
                const runId = ((_a = payload.runId) !== null && _a !== void 0 ? _a : payload.taskId);
                const error = payload.error;
                if (!runId)
                    return;
                const sessionId = sessionMap.get(runId);
                if (sessionId) {
                    sessionMap.delete(runId);
                    store
                        .addTurn({
                        sessionId,
                        role: 'assistant',
                        content: `[Failed] ${(error || '').slice(0, 2000)}`,
                    })
                        .catch(() => { });
                    store.endSession(sessionId).catch(() => { });
                }
            });
            // Lazy init — the store initializes on first access
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to initialize conversation store', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
        // Wire compensation event subscriber for observability logging/metrics/traces
        this.compensationEventSubscriber = new compensationEventSubscriber_1.CompensationEventSubscriber();
        try {
            this.compensationEventSubscriber.start((0, messageBus_1.getMessageBus)(), this.traceStore);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to start compensation event subscriber', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
        // Auto-register adaptive parameter controller
        // Process any due compensations from the durable queue on startup
        try {
            this.compensationRegistry
                .processQueue()
                .then((n) => {
                if (n > 0)
                    (0, logging_1.getGlobalLogger)().info('AgentRuntime', `Processed ${n} queued compensations on startup`);
            })
                .catch(() => { });
        }
        catch {
            /* best-effort */
        }
        // Schedule periodic compensation queue processing (every 5 minutes)
        this.queueTimer = setInterval(() => {
            try {
                this.compensationRegistry.processQueue().catch(() => { });
            }
            catch {
                /* best-effort */
            }
        }, 5 * 60 * 1000);
        if (typeof this.queueTimer.unref === 'function')
            this.queueTimer.unref();
        (0, pluginManager_1.getHookManager)()
            .register((0, parameterController_1.createParameterControllerPlugin)())
            .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Hook registration', {
            error: e === null || e === void 0 ? void 0 : e.message,
        }));
        // Tier 1.2: Bind lease manager to checkpointer for run recovery validation
        this.checkpointer.setLeaseManager(this.leaseManager);
        // Tier 1.1: Install process crash handlers (uncaughtException, unhandledRejection, SIGTERM, SIGINT)
        (0, processCrashSafety_1.installProcessCrashHandlers)({
            dlq: this.dlq,
            leaseManager: this.leaseManager,
            activeRunIds: () => this.activeRuns,
            leaseTokenFor: (runId) => {
                var _a, _b;
                return ((_a = this.runHandle) === null || _a === void 0 ? void 0 : _a.runId) === runId
                    ? (_b = this.runHandle) === null || _b === void 0 ? void 0 : _b.leaseToken
                    : undefined;
            },
            fencingEpochFor: (runId) => {
                var _a, _b;
                return ((_a = this.runHandle) === null || _a === void 0 ? void 0 : _a.runId) === runId
                    ? (_b = this.runHandle) === null || _b === void 0 ? void 0 : _b.fencingEpoch
                    : undefined;
            },
            tenantIdFor: () => { var _a; return (_a = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _a !== void 0 ? _a : undefined; },
        });
        // Start security monitoring (best-effort)
        try {
            (0, securityMonitor_1.getSecurityMonitor)().start();
        }
        catch {
            /* best-effort */
        }
    }
    /**
     * Handle a mutation tool failure by generating a rollback plan and triggering compensation.
     * Publishes a 'tool.compensation_planned' bus event with plan metadata.
     * For safe plans, auto-executes compensation via SagaCoordinator.
     */
    async handleMutationToolFailure(toolName, args, error) {
        var _a, _b, _c, _d, _e;
        const bus = (0, messageBus_1.getMessageBus)();
        // Build rollback plan from mutations that occurred before this failure
        const input = {
            plannedCalls: this.executedMutations,
            failure: { toolName, args, error },
        };
        const plan = (0, rollbackPlanner_1.generateRollbackPlan)(input);
        // Record each compensation step in the registry
        for (const step of plan.steps) {
            this.compensationRegistry.recordAction({
                actionId: (_a = step.forwardAction.actionId) !== null && _a !== void 0 ? _a : `comp-${step.forwardAction.toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                toolName: step.forwardAction.toolName,
                args: step.forwardAction.args,
                description: step.description,
                tags: ['tool', 'compensation', step.forwardAction.toolName],
                runId: (_c = (_b = this.ledgerCtx) === null || _b === void 0 ? void 0 : _b.runId) !== null && _c !== void 0 ? _c : 'unknown',
                agentId: 'system',
            });
        }
        bus.publish('tool.compensation_planned', 'runtime', {
            runId: (_e = (_d = this.ledgerCtx) === null || _d === void 0 ? void 0 : _d.runId) !== null && _e !== void 0 ? _e : 'unknown',
            toolName,
            stepCount: plan.steps.length,
            risk: plan.risk,
        });
        // Auto-execute safe plans immediately
        if (plan.risk === 'safe' && plan.steps.length > 0) {
            await this.compensateViaSaga(plan);
        }
    }
    /**
     * Execute a compensation plan by iterating through steps and calling
     * compensationRegistry.compensate() for each recorded action.
     */
    async compensateViaSaga(plan) {
        var _a, _b, _c, _d, _e, _f;
        const bus = (0, messageBus_1.getMessageBus)();
        const totalSteps = plan.steps.length;
        // Execute each plan step sequentially using the compensation registry
        for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
            const step = plan.steps[stepIndex];
            const actionId = step.forwardAction.actionId;
            if (!actionId)
                continue;
            const stepPayload = {
                runId: (_b = (_a = this.ledgerCtx) === null || _a === void 0 ? void 0 : _a.runId) !== null && _b !== void 0 ? _b : 'unknown',
                toolName: step.forwardAction.toolName,
                actionId,
                stepIndex,
                totalSteps,
            };
            bus.publish('tool.compensation_step', 'runtime', {
                ...stepPayload,
                status: 'started',
            });
            try {
                const STEP_TIMEOUT_MS = 30000;
                const MAX_ATTEMPTS = 3;
                let lastError;
                let lastResult;
                let successfulAttempt = 0;
                for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    const ac = new AbortController();
                    const timeoutId = setTimeout(() => ac.abort(), STEP_TIMEOUT_MS);
                    const compensationPromise = this.compensationRegistry
                        .compensate(actionId)
                        .finally(() => clearTimeout(timeoutId));
                    try {
                        const result = await Promise.race([
                            compensationPromise,
                            new Promise((resolve) => {
                                ac.signal.addEventListener('abort', () => resolve({ _aborted: true, reason: 'compensation_timeout' }));
                            }),
                        ]);
                        if ('_aborted' in result) {
                            lastError = `Compensation timed out after ${STEP_TIMEOUT_MS}ms`;
                        }
                        else {
                            lastResult = result;
                            if (result.success) {
                                successfulAttempt = attempt;
                                break;
                            }
                            lastError = result.error;
                        }
                    }
                    catch (err) {
                        lastError = err instanceof Error ? err.message : String(err);
                    }
                    // Drain the dangling compensation promise after the race outcome is captured
                    // so late resolve/reject is consumed without leaking an unhandled rejection.
                    await compensationPromise.catch(() => undefined);
                    if (attempt < MAX_ATTEMPTS) {
                        const backoffMs = 200 * Math.pow(2, attempt - 1); // 200, 400, 800
                        await new Promise((r) => setTimeout(r, backoffMs));
                    }
                }
                const finalAttempt = successfulAttempt > 0 ? successfulAttempt : MAX_ATTEMPTS;
                if (lastResult === null || lastResult === void 0 ? void 0 : lastResult.success) {
                    bus.publish('tool.compensation_step', 'runtime', {
                        ...stepPayload,
                        status: 'completed',
                        attempt: finalAttempt,
                    });
                }
                else {
                    bus.publish('tool.compensation_step', 'runtime', {
                        ...stepPayload,
                        status: 'failed',
                        error: lastError,
                        attempt: finalAttempt,
                    });
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Compensation step failed', {
                        actionId,
                        toolName: step.forwardAction.toolName,
                        error: lastError,
                        attempt: finalAttempt,
                    });
                    try {
                        this.dlq.enqueue({
                            category: 'compensation',
                            operationName: 'compensation.exhausted',
                            errorMessage: lastError !== null && lastError !== void 0 ? lastError : 'unknown',
                            tags: [step.forwardAction.toolName, `attempt:${finalAttempt}`],
                            failureMode: 'compensation_exhausted',
                            failureModeNumber: 12,
                        });
                    }
                    catch { /* best-effort */ }
                }
            }
            catch (err) {
                // Surface as system.alert (visibly visible in dashboards) AND debug-log
                // for forensics. Re-throw so callers can detect partial-failure rather
                // than proceed as if rollback succeeded silently.
                try {
                    bus.publish('system.alert', 'runtime', {
                        type: 'compensation_saga_threw',
                        error: err instanceof Error ? err.message : String(err),
                        totalSteps,
                        runId: (_d = (_c = this.ledgerCtx) === null || _c === void 0 ? void 0 : _c.runId) !== null && _d !== void 0 ? _d : 'unknown',
                    });
                }
                catch { /* best-effort */ }
                (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Compensation via saga threw unexpectedly', {
                    error: err instanceof Error ? err.message : String(err),
                    totalSteps,
                    runId: (_f = (_e = this.ledgerCtx) === null || _e === void 0 ? void 0 : _e.runId) !== null && _f !== void 0 ? _f : 'unknown',
                });
                throw err;
            }
        }
    }
    /** Invalidate read caches after mutation tools succeed */
    invalidateMutationCache(toolName) {
        if (toolName.startsWith('file_')) {
            this.toolCache.invalidatePattern('file_read');
        }
        else if (toolName.startsWith('memory_')) {
            this.toolCache.invalidatePattern('memory_recall');
            this.toolCache.invalidatePattern('memory_list');
        }
        else if (toolName === 'git_push' || toolName === 'git_commit') {
            this.toolCache.invalidateTool('git');
        }
        else if (toolName === 'shell_execute' || toolName === 'python_execute') {
            // Shell commands may mutate filesystem; invalidate file_read broadly
            this.toolCache.invalidatePattern('file_read');
        }
    }
    /**
     * Check if the same tool+args pattern appears ≥3 times in recent calls.
     * Uses stable (alphabetically-sorted) JSON.stringify for deterministic keys.
     * On detection, publishes system.alert, increments metrics, and writes intent log.
     * Returns { retryLoopDetected, count } — caller should break the execution loop.
     */
    checkRetryLoop(toolName, args, patterns, runId, tenantId, toolLoopCount) {
        // Stable key ordering: sort object keys so {a:1,b:2} and {b:2,a:1} match.
        const canonicalArgs = JSON.stringify(args, [...Object.keys(args)].sort());
        const pattern = `${toolName}:${canonicalArgs}`;
        patterns.push(pattern);
        if (patterns.length > 20)
            patterns.shift();
        const count = patterns.filter((p) => p === pattern).length;
        if (count >= 3) {
            const bus = (0, messageBus_1.getMessageBus)();
            bus.publish('system.alert', 'runtime', {
                type: 'retry_loop_detected',
                toolName,
                pattern: `${toolName}:${canonicalArgs.slice(0, 200)}`,
                consecutiveCalls: count,
                toolLoopCount,
            });
            try {
                (0, metricsCollector_1.getMetricsCollector)().incrementCounter('retry_loops_detected_total', 'Retry loops detected', 1, [{ name: 'tool', value: toolName }]);
            }
            catch {
                /* best-effort */
            }
            try {
                (0, intentLog_1.getIntentLog)(tenantId).write({
                    schemaVersion: 1,
                    runId,
                    capturedAt: new Date().toISOString(),
                    stage: 'agentRuntime.tool_loop',
                    decision: 'retry_loop_detected',
                    reason: `${toolName} called ${count} times with identical arguments`,
                    payload: { toolName, calls: count, toolLoopCount },
                });
            }
            catch {
                /* best-effort */
            }
            return { detected: true, count };
        }
        return { detected: false, count: 0 };
    }
    registerProvider(name, provider) {
        this.providers.set(name, provider);
    }
    registerTool(name, tool) {
        this.tools.set(name, tool);
    }
    getProvider(name) {
        return this.providers.get(name);
    }
    getSmartRouter() {
        return this.smartRouter;
    }
    /**
     * Live toggle for SmartModelRouter participation. When false, the runtime
     * falls back to the legacy `routeWithCascade` path even if a smart router
     * instance exists. Default ON at construction. Idempotent.
     */
    setSmartModelRouterEnabled(enabled) {
        this.smartRouterActive = enabled;
    }
    /** Current state of the SmartModelRouter toggle (for diagnostics). */
    isSmartModelRouterEnabled() {
        return this.smartRouterActive;
    }
    getTool(name) {
        return this.tools.get(name);
    }
    getConfig() {
        return { ...this.config };
    }
    /** Access the persistent memory store (SqliteMemoryStore, JsonMemoryStore, etc.) or null if using default in-memory. */
    getMemoryStore() {
        return this.memoryStore;
    }
    /** Access the state checkpointer for crash recovery and run inspection. */
    getCheckpointer() {
        return this.checkpointer;
    }
    getInbox() {
        return this.agentInbox;
    }
    getTeamRegistry() {
        return this.teamRegistry;
    }
    getHandoff() {
        return this.agentHandoff;
    }
    getExecutionScheduler() {
        return (0, scheduler_1.getExecutionScheduler)();
    }
    getCompensationRegistry() {
        return this.compensationRegistry;
    }
    /** Cancel all in-flight steps managed by the StepTimeoutManager.
     *  Used during graceful shutdown to abort hung tool executions. */
    cancelAllSteps() {
        return this.stepTimeout.cancelAll();
    }
    /** Access the step timeout manager for shutdown coordination. */
    getStepTimeoutManager() {
        return this.stepTimeout;
    }
    /**
     * Resolve tenant context: enforce rate limits, concurrency limits, and set up
     * tenant-scoped storage instances. Returns overrides that must be restored in finally.
     */
    resolveTenantContext(tenantId, tenantCfg, runId, agentId, missionId) {
        var _a;
        if (!tenantId || !(tenantCfg === null || tenantCfg === void 0 ? void 0 : tenantCfg.enabled)) {
            return { allowed: true };
        }
        // Enforce per-tenant rate limit
        if (tenantCfg.maxRunsPerMinute > 0) {
            if (this.tenantRateLimits.size > 100) {
                const now = Date.now();
                for (const [tid, entry] of this.tenantRateLimits) {
                    if (now > entry.resetAt)
                        this.tenantRateLimits.delete(tid);
                }
            }
            const rateEntry = this.tenantRateLimits.get(tenantId);
            const now = Date.now();
            if (rateEntry && now < rateEntry.resetAt && rateEntry.count >= tenantCfg.maxRunsPerMinute) {
                return {
                    allowed: false,
                    error: 'TENANT_RATE_LIMIT: too many runs per minute',
                };
            }
            if (!rateEntry || now > rateEntry.resetAt) {
                this.tenantRateLimits.set(tenantId, { count: 1, resetAt: now + 60000 });
            }
            else {
                rateEntry.count++;
            }
        }
        // Enforce per-tenant concurrency limit
        if (tenantCfg.maxConcurrency > 0) {
            const current = (_a = this.tenantRunningCounts.get(tenantId)) !== null && _a !== void 0 ? _a : 0;
            if (current >= tenantCfg.maxConcurrency) {
                return {
                    allowed: false,
                    error: 'TENANT_CONCURRENCY_LIMIT: too many concurrent runs',
                };
            }
            this.tenantRunningCounts.set(tenantId, current + 1);
        }
        // Save original values for restore
        const overrides = {
            origSamplesStore: this.samplesStore,
            origTraceStore: this.traceStore,
            origCheckpointer: this.checkpointer,
            origMemory: this.memory,
            origGovernor: this.governor,
        };
        // Evict oldest tenant stores if too many accumulate
        const MAX_TENANT_STORES = 50;
        if (this.tenantSamplesStores.size >= MAX_TENANT_STORES &&
            !this.tenantSamplesStores.has(tenantId)) {
            const oldestKey = this.tenantSamplesStores.keys().next().value;
            if (oldestKey) {
                this.tenantSamplesStores.delete(oldestKey);
                this.tenantTraceStores.delete(oldestKey);
                this.tenantCheckpointers.delete(oldestKey);
            }
        }
        if (!this.tenantSamplesStores.has(tenantId)) {
            this.tenantSamplesStores.set(tenantId, new samplesStore_1.SamplesStore(undefined, tenantId));
        }
        if (!this.tenantTraceStores.has(tenantId)) {
            this.tenantTraceStores.set(tenantId, new traceStore_1.PersistentTraceStore(undefined, tenantId));
        }
        if (!this.tenantCheckpointers.has(tenantId)) {
            this.tenantCheckpointers.set(tenantId, new stateCheckpointer_1.StateCheckpointer(undefined, tenantId));
        }
        this.samplesStore = this.tenantSamplesStores.get(tenantId);
        this.traceStore = this.tenantTraceStores.get(tenantId);
        this.checkpointer = this.tenantCheckpointers.get(tenantId);
        this.memory = (0, tenantProvider_1.getGlobalMemoryRegistry)().getOrCreate(tenantId);
        return { allowed: true, overrides };
    }
    /**
     * Restore tenant overrides after run completes or fails.
     */
    restoreTenantOverrides(overrides, tenantId) {
        if (!overrides)
            return;
        this.samplesStore = overrides.origSamplesStore;
        this.traceStore = overrides.origTraceStore;
        this.checkpointer = overrides.origCheckpointer;
        this.memory = overrides.origMemory;
        this.governor = overrides.origGovernor;
    }
    /**
     * Execute an agent task end-to-end.
     * Wraps entire body in try/finally to guarantee cleanup (GAP-02, GAP-05).
     * Enforces maxConcurrency via semaphore (GAP-07).
     */
    async execute(ctx) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        await this.acquireSlot();
        const runId = (0, runtimeHelpers_1.generateId)();
        const bus = (0, messageBus_1.getMessageBus)();
        const tracer = (0, executionTrace_1.getTraceRecorder)();
        const startTime = Date.now();
        const tenantId = (_b = (_a = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _a !== void 0 ? _a : ctx.tenantId) !== null && _b !== void 0 ? _b : undefined;
        const tenantCfg = tenantId ? this.tenantProvider.getTenantConfig(tenantId) : undefined;
        const tenantResolution = this.resolveTenantContext(tenantId, tenantCfg, runId, ctx.agentId, ctx.missionId);
        if (!tenantResolution.allowed) {
            this.releaseSlot();
            return {
                runId,
                agentId: ctx.agentId,
                missionId: ctx.missionId,
                status: 'failed',
                summary: tenantResolution.error,
                steps: [],
                totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                totalDurationMs: 0,
                error: tenantResolution.error,
            };
        }
        const tenantOverrides = tenantResolution.overrides;
        // Execution Lane: acquire a lane slot (concurrent execution isolation)
        let currentLane;
        try {
            currentLane = await (0, lane_1.getLaneManager)().acquireSlot({
                tenantId: (_c = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _c !== void 0 ? _c : undefined,
                agentId: ctx.agentId,
                runId,
                args: ctx.lane ? { lane: ctx.lane } : undefined,
            });
        }
        catch {
            // Decrement tenant running count on lane acquisition failure
            if (tenantId && (tenantCfg === null || tenantCfg === void 0 ? void 0 : tenantCfg.enabled)) {
                const c = ((_d = this.tenantRunningCounts.get(tenantId)) !== null && _d !== void 0 ? _d : 1) - 1;
                if (c <= 0)
                    this.tenantRunningCounts.delete(tenantId);
                else
                    this.tenantRunningCounts.set(tenantId, c);
            }
            this.releaseSlot();
            return {
                runId,
                agentId: ctx.agentId,
                missionId: ctx.missionId,
                status: 'failed',
                summary: 'Failed to acquire lane slot',
                steps: [],
                totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                totalDurationMs: 0,
                error: 'LANE_ACQUISITION_FAILED',
            };
        }
        this.activeRuns.add(runId);
        tracer.startRun(runId, ctx.agentId, ctx.missionId, undefined, {
            tenantId: ctx.tenantId,
            parentRunId: ctx.parentRunId,
            subAgentDepth: ctx.subAgentDepth,
            subAgentRole: ctx.subAgentRole,
        });
        try {
            (0, intentLog_1.getIntentLog)(ctx.tenantId).write({
                schemaVersion: 1,
                runId,
                capturedAt: new Date().toISOString(),
                stage: 'agentRuntime.execute',
                decision: 'start',
                reason: 'execute() entered',
                payload: {
                    agentId: ctx.agentId,
                    goal: ctx.goal.slice(0, 200),
                    parentRunId: ctx.parentRunId,
                    subAgentDepth: ctx.subAgentDepth,
                },
            });
        }
        catch {
            /* best-effort */
        }
        (0, metricsCollector_1.getMetricsCollector)().setGauge('active_runs', 'Active concurrent runs', this.activeRuns.size);
        let circuitReleased = false;
        // Phase 3: register this run with the centralized ExecutionScheduler
        try {
            this.runHandle = (0, scheduler_1.getExecutionScheduler)().beginRun({
                runId,
                goal: ctx.goal,
                tenantId: (_e = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _e !== void 0 ? _e : undefined,
                metadata: { agentId: ctx.agentId, missionId: ctx.missionId },
                holder: 'agent-runtime',
            });
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to register run with execution scheduler', {
                error: e instanceof Error ? e.message : String(e),
            });
            return {
                runId,
                agentId: ctx.agentId,
                missionId: ctx.missionId,
                status: 'failed',
                summary: 'Failed to register run with execution scheduler',
                steps: [],
                totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                totalDurationMs: 0,
                error: 'SCHEDULER_REGISTRATION_FAILED',
            };
        }
        let execResult;
        try {
            execResult = await (0, tenantContext_1.runWithTenant)((_f = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _f !== void 0 ? _f : undefined, async () => {
                var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8;
                // ── Late-stage override — lift CLI-provided routing hints from
                //    contextData into top-level ctx fields so the routing block,
                //    samplesStore manifest, smart router, and tracer all see them.
                //    Without this lift, --model/--tier flags injected into
                //    contextData never reach `ctx.preferredModel` /
                //    `ctx.preferredModelTier` which is what every downstream
                //    consumer reads. (Audit P0-2 follow-up.)
                const cd = ctx.contextData;
                if ((cd === null || cd === void 0 ? void 0 : cd.preferredModel) && typeof cd.preferredModel === 'string') {
                    ctx.preferredModel = cd.preferredModel;
                }
                if ((cd === null || cd === void 0 ? void 0 : cd.preferredModelTier) && typeof cd.preferredModelTier === 'string') {
                    ctx.preferredModelTier = cd.preferredModelTier;
                }
                if ((cd === null || cd === void 0 ? void 0 : cd.cascadeEnabled) === true) {
                    this.smartRouterActive = true;
                }
                else if ((cd === null || cd === void 0 ? void 0 : cd.cascadeEnabled) === false) {
                    this.smartRouterActive = false;
                }
                // qualityThreshold is applied via orchestrator.setQualityGateThreshold()
                // before execute() — not here, because the orchestrator owns the gate
                // config and is constructed at the CLI layer.
                // Record run manifest (provenance, config, params)
                this.samplesStore.recordRunManifest(runId, {
                    ...(0, provenance_1.captureProvenance)(),
                    agentId: ctx.agentId,
                    missionId: ctx.missionId,
                    goal: ctx.goal.slice(0, 500),
                    tokenBudget: ctx.tokenBudget,
                    availableTools: ctx.availableTools,
                    modelId: this.router.route(ctx, undefined, ctx.preferredModelTier).modelId,
                    config: { ...this.config },
                    timestamp: new Date().toISOString(),
                });
                // Per-run governor to prevent concurrent run corruption (was shared instance)
                this.governor = new tokenGovernor_1.TokenGovernor({
                    totalBudget: ctx.tokenBudget || this.config.budgetHardCapTokens || 200000,
                });
                // Detect task type for strategy selection
                const taskType = (0, unifiedVerification_1.detectTaskType)(ctx.goal);
                this.governor.setTaskCategory(taskType === 'code'
                    ? 'code'
                    : taskType === 'search'
                        ? 'search'
                        : taskType === 'analysis'
                            ? 'analysis'
                            : taskType === 'structured'
                                ? 'structured'
                                : 'general');
                // 0. Pre-execution budget check (hard enforcement, not advisory)
                if (this.config.budgetHardCapTokens > 0 &&
                    ctx.tokenBudget > this.config.budgetHardCapTokens) {
                    const msg = `BUDGET_EXCEEDED: requested ${ctx.tokenBudget} > hard cap ${this.config.budgetHardCapTokens}`;
                    tracer.recordDecision(runId, msg, 0);
                    bus.publish('agent.failed', ctx.agentId, { runId, error: msg });
                    return {
                        runId,
                        agentId: ctx.agentId,
                        missionId: ctx.missionId,
                        status: 'cancelled',
                        summary: msg,
                        steps: [],
                        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                        totalDurationMs: 0,
                        error: msg,
                    };
                }
                // 1. Route to optimal model with FrugalGPT cascade awareness
                //    In tight/critical budget: start with cheapest model, escalate on failure
                //    In relaxed/moderate: start with optimal model (standard routing)
                let routing;
                let currentEscalationChain;
                if (this.smartRouter && this.smartRouterActive) {
                    const smartResult = this.smartRouter.route(ctx, {
                        governorPhase: this.governor.getState().phase,
                        registeredProviders: new Set(this.providers.keys()),
                        preferredTier: ctx.preferredModelTier,
                    });
                    routing = smartResult;
                    currentEscalationChain = ((_a = smartResult.escalationChain) !== null && _a !== void 0 ? _a : []).map((id) => {
                        var _a;
                        return (_a = this.router.getModel(id)) !== null && _a !== void 0 ? _a : {
                            id,
                            provider: 'unknown',
                            tier: 'standard',
                            costPer1KInput: 0,
                            costPer1KOutput: 0,
                            capabilities: [],
                            contextWindow: 128000,
                            priority: 0,
                        };
                    });
                }
                else {
                    const { initial: cascadeInitial, escalationChain } = this.router.routeWithCascade(ctx, this.governor.getState().phase, ctx.preferredModelTier);
                    routing = cascadeInitial;
                    currentEscalationChain = escalationChain;
                }
                // P0-4: Batch API routing for non-time-sensitive tasks (50% cost savings).
                // OpenAI, Anthropic, and Google all offer batch at 50% discount for tasks
                // that can tolerate 24h turnaround. Eligible tasks: evaluation runs, data
                // labeling, document processing, nightly analysis, embedding backfills.
                // Not eligible: interactive chat, real-time code fixes, sequential
                // multi-turn tool chains requiring immediate feedback.
                let batchRouting;
                if (modelRouter_1.ModelRouter.isBatchEligible(ctx) && this.governor.getState().phase !== 'critical') {
                    const batchModel = this.router.routeBatch(ctx, routing.tier);
                    if (batchModel) {
                        const estimatedInputTokens = Math.ceil(ctx.goal.length / 4) + 2048;
                        const estimatedOutputTokens = Math.min(ctx.tokenBudget, batchModel.contextWindow - estimatedInputTokens);
                        batchRouting = {
                            modelId: batchModel.id,
                            tier: batchModel.tier,
                            provider: batchModel.provider,
                            reasoning: [
                                ...routing.reasoning,
                                `batch_api: 50% cost savings via ${batchModel.provider}/${batchModel.id}`,
                                `batch_max_batch_size: ${(_b = batchModel.maxBatchSize) !== null && _b !== void 0 ? _b : 'unlimited'}`,
                            ],
                            estimatedCost: (estimatedInputTokens / 1000) * batchModel.costPer1KInput +
                                (estimatedOutputTokens / 1000) * batchModel.costPer1KOutput,
                            maxTokens: Math.min(estimatedOutputTokens, 200000),
                        };
                        tracer.recordDecision(runId, `batch_routing: ${batchModel.id} (${batchModel.tier}) — 50% cost savings via batch API`, 0);
                        bus.publish('system.alert', 'runtime', {
                            type: 'batch_routing_selected',
                            model: batchModel.id,
                            provider: batchModel.provider,
                            tier: batchModel.tier,
                            estimatedSavings: `${Math.round(batchRouting.estimatedCost * 100) / 100}`,
                        });
                        try {
                            (0, metricsCollector_1.getMetricsCollector)().incrementCounter('batch_routing_total', 'Batch API routing selections', 1, [
                                { name: 'provider', value: batchModel.provider },
                                { name: 'tier', value: batchModel.tier },
                            ]);
                        }
                        catch {
                            /* best-effort */
                        }
                        try {
                            (0, intentLog_1.getIntentLog)(ctx.tenantId).write({
                                schemaVersion: 1,
                                runId,
                                capturedAt: new Date().toISOString(),
                                stage: 'agentRuntime.batch',
                                decision: 'batch_routing',
                                reason: `Batch API selected: ${batchModel.id} (${batchModel.tier}) for 50% savings`,
                                payload: {
                                    model: batchModel.id,
                                    provider: batchModel.provider,
                                    tier: batchModel.tier,
                                    estimatedCost: batchRouting.estimatedCost,
                                },
                            });
                        }
                        catch {
                            /* best-effort */
                        }
                    }
                }
                tracer.recordDecision(runId, `routed to ${routing.modelId} (${routing.tier}) cascade=${currentEscalationChain.length > 0}${batchRouting ? ' [BATCH]' : ''}`, 0);
                // ── Privacy Routing ────────────────────────────────────────────────
                // Before sending anything to a cloud provider, scan the user's goal for
                // sensitive content (API keys, internal IPs, PII, secrets). If found,
                // either block execution or re-route to a local model (Ollama/vLLM).
                // This is the Local-First Fallback pattern for enterprise compliance.
                try {
                    const privacy = (0, privacyRouter_1.getPrivacyRouter)();
                    const decision = await privacy.checkContent(ctx.goal, {
                        agentId: ctx.agentId,
                        runId,
                    });
                    if (decision.blocked) {
                        // Critical secrets detected — abort execution entirely
                        const summary = `PRIVACY_BLOCKED: ${decision.reason}`;
                        tracer.recordDecision(runId, summary, 0);
                        bus.publish('agent.failed', ctx.agentId, { runId, error: summary });
                        try {
                            (0, metricsCollector_1.getMetricsCollector)().incrementCounter('privacy_blocks_total', 'Privacy blocks', 1, []);
                        }
                        catch {
                            /* best-effort */
                        }
                        return {
                            runId,
                            agentId: ctx.agentId,
                            missionId: ctx.missionId,
                            status: 'cancelled',
                            summary,
                            steps: [],
                            totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                            totalDurationMs: 0,
                            error: summary,
                        };
                    }
                    if (decision.route === 'local') {
                        // Sensitive content detected — override routing to use a local model
                        const origModel = routing.modelId;
                        routing = privacy.applyRouting(routing, decision);
                        tracer.recordDecision(runId, `privacy_routing: ${origModel} → ${routing.modelId} (${routing.provider}) — ${decision.reason}`, 0);
                        bus.publish('system.alert', 'runtime', {
                            type: 'privacy_routing_local',
                            originalModel: origModel,
                            routedModel: routing.modelId,
                            provider: routing.provider,
                            matchCount: decision.matches.length,
                        });
                        try {
                            (0, metricsCollector_1.getMetricsCollector)().incrementCounter('privacy_routes_local_total', 'Privacy routes to local model', 1, []);
                        }
                        catch {
                            /* best-effort */
                        }
                    }
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Privacy check failed', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                    // Best-effort: proceed with cloud routing on privacy check failure
                }
                // 1a. Pre-run cost estimation: predict cost and log for observability
                const costEstimator = (0, costEstimator_1.getCostEstimator)();
                const costEstimate = costEstimator.estimateBeforeRun(ctx, routing, this.router.getModel(routing.modelId));
                tracer.recordDecision(runId, `cost_estimate: $${costEstimate.predictedCostUsd} (${costEstimate.predictedTotalTokens}t, confidence=${(costEstimate.confidence * 100).toFixed(0)}%, samples=${costEstimate.sampleCount})`, 0);
                try {
                    (0, metricsCollector_1.getMetricsCollector)().setGauge('pre_run_cost_estimate_usd', 'Pre-run cost estimate in USD', costEstimate.predictedCostUsd, [
                        { name: 'task_category', value: costEstimate.taskCategory },
                        { name: 'model_tier', value: costEstimate.modelTier },
                        { name: 'model', value: routing.modelId },
                    ]);
                    (0, metricsCollector_1.getMetricsCollector)().setGauge('pre_run_token_estimate', 'Pre-run token estimate', costEstimate.predictedTotalTokens, [
                        { name: 'task_category', value: costEstimate.taskCategory },
                        { name: 'model_tier', value: costEstimate.modelTier },
                    ]);
                }
                catch {
                    /* best-effort */
                }
                // 2. Build LLM request with cache-optimized prompt structure
                //    Stable content (system, tools) FIRST for maximum cache hits.
                //    Variable content (user message) LAST.
                // --- Two-Tier Tool Loading (Lazy Schema Loading) ---
                // Research (arXiv:2604.21816): Eager schema injection costs 10k-60k tokens/turn.
                // Two-tier loading: Tier 1 (full schema for top-N) + Tier 2 (compact registry for rest).
                // Estimated savings: 60-80% of tool-related token cost.
                const allToolDefs = ctx.availableTools
                    .map((name) => { var _a; return (_a = this.tools.get(name)) === null || _a === void 0 ? void 0 : _a.definition; })
                    .filter((t) => t !== undefined);
                const maxActiveTools = (_d = (_c = this.config.toolRetrieval) === null || _c === void 0 ? void 0 : _c.maxTools) !== null && _d !== void 0 ? _d : 8;
                const twoTier = (0, toolRetriever_1.buildTwoTierTools)(ctx.goal, allToolDefs, maxActiveTools);
                const contextPromotions = (0, toolRetriever_1.detectContextPromotions)(ctx.goal, twoTier.registry);
                if (contextPromotions.length > 0) {
                    const toolMap = new Map(allToolDefs.map((t) => [t.name, t]));
                    for (const toolName of contextPromotions) {
                        const tool = toolMap.get(toolName);
                        if (tool) {
                            twoTier.active.push(tool);
                            twoTier.registry = twoTier.registry.filter((r) => r.name !== toolName);
                        }
                    }
                }
                const tierMetrics = (0, toolRetriever_1.calculateTierMetrics)(twoTier, allToolDefs.length);
                // Log token savings
                if (tierMetrics.registryCount > 0) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', `Two-tier tools: ${tierMetrics.activeCount} active (${tierMetrics.activeTokenEstimate} tok), ${tierMetrics.registryCount} registry (~${tierMetrics.registryTokenEstimate} tok), ~${tierMetrics.savingsPercent}% savings`);
                }
                // Tier 1: Active tools with full schema
                let toolDefs = twoTier.active;
                // Track promoted tools for hallucination rejection gate
                this.promotedTools = new Set(twoTier.active.map((t) => t.name));
                this.promotedTools.add('request_tool'); // always allow request_tool
                // Compact active tool schemas: strip verbose descriptions/examples.
                // Parameter-name minification is off for active tools so validation stays simple.
                const TIER_TO_COMPACT = {
                    eco: 'low',
                    standard: 'medium',
                    power: 'high',
                    consensus: 'high',
                };
                const compactConfig = (0, programmaticToolFormatter_1.getCompactConfigForTier)((_e = TIER_TO_COMPACT[this.config.defaultModelTier]) !== null && _e !== void 0 ? _e : 'high');
                toolDefs = (0, programmaticToolFormatter_1.compactToolDefs)(toolDefs, compactConfig);
                // Register request_tool for Tier 2 tools (if there are registry tools)
                if (twoTier.registry.length > 0) {
                    const registryNames = twoTier.registry.map((t) => t.name);
                    const requestTool = (0, requestToolTool_1.createRequestToolTool)((name) => {
                        const found = allToolDefs.find((t) => t.name === name);
                        return found ? (0, programmaticToolFormatter_1.compactToolDef)(found, compactConfig) : undefined;
                    }, registryNames);
                    // Add request_tool to active tools
                    toolDefs = [...toolDefs, requestTool.definition];
                    // Register for execution
                    this.tools.set('request_tool', requestTool);
                }
                // Build registry summary for system prompt
                const registrySummary = (0, toolRetriever_1.buildRegistrySummary)(twoTier.registry);
                // Load project context once per run. This is cached by file mtime and
                // injected into the stable prefix so it participates in KV-cache reuse.
                const projectContext = (0, projectContextLoader_1.loadProjectContext)();
                const systemPrompt = (0, promptBuilder_1.buildSystemPrompt)(ctx, routing, this.config, this.tools, this.governor, registrySummary, twoTier.active.map((t) => t.name), taskType, projectContext);
                // KV-cache: track whether the stable system-prompt prefix changed
                // since the prior call. The prefix is tool-list + governance +
                // registry summary + max-steps + task-type + project-context — all cacheable across requests.
                // A hit lets the provider reuse prefix tokens, cutting cost and
                // latency (Anthropic reports 5x cost reduction on cached prefixes).
                const activeToolNames = twoTier.active.map((t) => t.name);
                const newPrefixKey = (0, promptBuilder_1.computePrefixCacheKey)(this.config, this.tools, this.governor, registrySummary, activeToolNames, taskType, projectContext.cacheKey);
                const cacheHit = this.lastPrefixCacheKey !== undefined && this.lastPrefixCacheKey === newPrefixKey;
                this.lastPrefixCacheKey = newPrefixKey;
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordPromptPrefixCache(cacheHit, ctx.tenantId);
                    (0, metricsCollector_1.getMetricsCollector)().setPromptPrefixCacheKey(newPrefixKey, ctx.tenantId);
                }
                catch {
                    /* best-effort */
                }
                // Cache configuration: enable caching for system prompt + tools on providers that support it
                // 1h TTL is 2x write premium — only worth it on multi-step/long sessions, and the governor
                // forces 5m in 'critical' phase to avoid paying the write premium on tight budgets.
                const governorPhase = this.governor.getState().phase;
                const cacheTtl = this.config.promptCacheTtl === '1h' && governorPhase !== 'critical' ? '1h' : '5m';
                const cacheConfig = {
                    cacheSystemPrompt: true,
                    cacheTools: toolDefs.length > 0,
                    useCacheControl: true,
                    cacheTtl,
                    promptCacheKey: (_f = this.config.promptCacheKey) !== null && _f !== void 0 ? _f : derivePromptCacheKey(ctx, tenantId),
                    isBatch: !!batchRouting,
                };
                // Strip internal @tier suffix (eco/standard/power/consensus) before sending to provider
                const apiModel = (routing.modelId || '').replace(/@\w+$/, '') || routing.modelId;
                const selectedModelCfg = this.router.getModel(routing.modelId);
                const baseRequest = {
                    model: apiModel,
                    // Order: [system (stable, cacheable), user (variable)]
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt,
                        },
                        {
                            role: 'user',
                            content: (0, promptBuilder_1.buildCacheAwareUserPrompt)(ctx, routing, this.governor, this.config),
                        },
                    ],
                    maxTokens: routing.maxTokens,
                    tools: toolDefs,
                    cacheConfig,
                };
                // Wire provider-native structured output when an output schema is supplied.
                if (ctx.outputSchema && selectedModelCfg) {
                    if (selectedModelCfg.supportsStructuredOutput) {
                        baseRequest.responseFormat = {
                            type: 'json_schema',
                            schema: ctx.outputSchema,
                            name: 'structured_output',
                        };
                    }
                    else if (selectedModelCfg.supportsJSONMode) {
                        baseRequest.responseFormat = { type: 'json_object' };
                    }
                    // Anthropic / unsupported providers fall through to tool-use fallback in their provider.
                }
                // Apply parameter controller (eval profile, reasoning config, adaptive params)
                const request = (0, parameterController_1.applyControllerParams)(baseRequest, ctx.goal, baseRequest.messages, 0);
                // Pre-LLM tool provisioning: detect tool needs and inject results before LLM sees the question
                try {
                    const provisioned = await (0, toolProvisioner_1.provisionTools)(ctx.goal, request, this.tools, this.toolCache);
                    if (provisioned) {
                        bus.publish('system.alert', 'runtime', { type: 'tool_provisioned' });
                    }
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Tool provisioning failed (best-effort)', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
                this.checkpointer.checkpoint({
                    runId,
                    agentId: ctx.agentId,
                    missionId: ctx.missionId,
                    timestamp: (0, runtimeHelpers_1.now)(),
                    phase: 'started',
                    stepNumber: 0,
                    attemptNumber: 0,
                    messages: request.messages,
                    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                    stepDurations: [],
                    context: {
                        agentId: ctx.agentId,
                        missionId: ctx.missionId,
                        projectId: ctx.projectId,
                        goal: ctx.goal,
                        availableTools: ctx.availableTools,
                        maxSteps: ctx.maxSteps,
                        tokenBudget: ctx.tokenBudget,
                        projectContextCacheKey: projectContext.cacheKey,
                        projectContextFiles: projectContext.filesRead,
                    },
                    totalDurationMs: 0,
                });
                // Context injection with token budget cap to prevent pre-prompt bloat.
                // Cap injected context at 20% of total budget to leave room for actual execution.
                // Cache-stable context injection: consolidate all dynamic context into a single system message.
                // Research: Anthropic/OpenAI prompt caching requires stable prefixes for cache hits.
                // Multiple splice operations create variable-length arrays, reducing cache hit rates.
                // Solution: build a single context block and insert it once.
                const contextTokenCap = Math.max(2000, Math.floor((ctx.tokenBudget || 200000) * 0.2));
                let injectedContextTokens = 0;
                const estimateTokens = (text) => Math.ceil(text.length / 3.5);
                const contextParts = [];
                // Check agent inbox for pending messages before execution
                const inboxMessages = this.agentInbox.pollInbox(ctx.agentId);
                if (inboxMessages.length > 0) {
                    const inboxBlock = inboxMessages
                        .map((m) => `[from:${m.from}] ${m.subject}: ${m.body.slice(0, 300)}`)
                        .join('\n');
                    const inboxTokens = estimateTokens(inboxBlock);
                    if (injectedContextTokens + inboxTokens < contextTokenCap) {
                        contextParts.push(`## Pending Messages\n${inboxBlock}\n\nAddress these messages as part of your execution.`);
                        injectedContextTokens += inboxTokens;
                    }
                    for (const msg of inboxMessages) {
                        this.agentInbox.acknowledge(ctx.agentId, msg.id);
                    }
                }
                if (this.memory) {
                    try {
                        const keywords = ctx.goal
                            .split(/\s+/)
                            .filter((w) => w.length > 4)
                            .slice(0, 8);
                        if (keywords.length > 0) {
                            const memories = this.memory.query({
                                keywords,
                                limit: 5,
                                importanceThreshold: 0.3,
                            });
                            if (memories.length > 0) {
                                const memoryBlock = memories
                                    .map((m) => `[${m.layer}] ${m.content.slice(0, 300)} (importance:${m.importance.toFixed(2)}, tags:${m.tags.join(',')})`)
                                    .join('\n');
                                const memoryTokens = estimateTokens(memoryBlock);
                                if (injectedContextTokens + memoryTokens < contextTokenCap) {
                                    contextParts.push(`## Relevant Past Experiences\n${memoryBlock}\n\nLearn from these past experiences when working on the current task.`);
                                    injectedContextTokens += memoryTokens;
                                }
                            }
                        }
                    }
                    catch (e) {
                        (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Memory initialization failed', {
                            error: e === null || e === void 0 ? void 0 : e.message,
                        });
                    }
                }
                // Inject skills catalog (Level 0) into context
                try {
                    const { SkillInjector, getSkillSystem } = await Promise.resolve().then(() => __importStar(require('../skills')));
                    const injector = new SkillInjector(getSkillSystem().manager);
                    const skillsBlock = await injector.buildSkillsBlock(ctx.goal, 0);
                    const instructions = injector.buildSkillUsageInstructions();
                    if (skillsBlock) {
                        const skillsTokens = estimateTokens(skillsBlock + instructions);
                        if (injectedContextTokens + skillsTokens < contextTokenCap) {
                            contextParts.push(`${skillsBlock}\n\n${instructions}`);
                            injectedContextTokens += skillsTokens;
                        }
                    }
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Skills injection failed', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
                // Inject auto-extracted skill recall — check SkillExtractor for matching past successes
                try {
                    const { getSkillExtractor } = await Promise.resolve().then(() => __importStar(require('../intelligence/skillExtractor')));
                    const skillExtractor = getSkillExtractor();
                    const matchingSkill = skillExtractor.findMatchingSkill(ctx.goal);
                    if (matchingSkill && matchingSkill.confidence >= 0.5) {
                        try {
                            (0, metricsCollector_1.getMetricsCollector)().recordSkillRecallHit(true, ctx.tenantId);
                        }
                        catch {
                            /* best-effort */
                        }
                        const skillLines = [
                            '## Auto-Recalled Skill',
                            `You've successfully handled a similar task before. Use this proven pattern:`,
                            ``,
                            `**${matchingSkill.name}** (${(matchingSkill.successRate * 100).toFixed(0)}% success, used ${matchingSkill.usageCount}×)`,
                            `Description: ${matchingSkill.description}`,
                        ];
                        if (matchingSkill.steps.length > 0) {
                            skillLines.push(`Steps: ${matchingSkill.steps.join(' → ')}`);
                        }
                        if (matchingSkill.tools.length > 0) {
                            skillLines.push(`Recommended tools: ${matchingSkill.tools.join(', ')}`);
                        }
                        skillLines.push(``, `Reuse this pattern if applicable. Adapt based on the current context.`);
                        const skillBlock = skillLines.join('\n');
                        const skillTokens = estimateTokens(skillBlock);
                        if (injectedContextTokens + skillTokens < contextTokenCap) {
                            contextParts.push(skillBlock);
                            injectedContextTokens += skillTokens;
                        }
                    }
                    else {
                        try {
                            (0, metricsCollector_1.getMetricsCollector)().recordSkillRecallHit(false, ctx.tenantId);
                        }
                        catch {
                            /* best-effort */
                        }
                    }
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Skill recall injection failed (best-effort)', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
                // Single splice for cache stability — all dynamic context in one system message
                if (contextParts.length > 0) {
                    request.messages.splice(request.messages.length - 1, 0, {
                        role: 'system',
                        content: contextParts.join('\n\n---\n\n'),
                    });
                }
                // 3. Emit started event
                bus.publish('agent.started', ctx.agentId, {
                    runId,
                    missionId: ctx.missionId,
                    model: routing.modelId,
                    goal: ctx.goal,
                });
                // Fire plugin onAgentStart hooks
                (0, pluginManager_1.getHookManager)()
                    .fireOnAgentStart({ ctx, runId })
                    .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'onAgentStart hook failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                }));
                // 4. Execute with retry and circuit breaker
                let lastError;
                let lastErrorIsPermanent = false;
                const steps = [];
                let totalTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
                // Track content written by file_write tool calls for artifact propagation
                let largestFileWriteContent = '';
                let largestFileWritePath = '';
                // Cumulative evidence for SubAgentGuard progress tracking (persists across retries)
                let cumulativeEvidence = 0;
                // Per-run sliding window instance to prevent concurrent run corruption
                this.slidingWindow = new slidingWindowOrchestrator_1.SlidingWindowOrchestrator();
                // Resolve evaluator provider for verification pipeline (echo chamber breaker)
                if (this.config.evaluatorProviderName) {
                    const evalProvider = this.providers.get(this.config.evaluatorProviderName);
                    if (evalProvider) {
                        this.verificationPipeline.setEvaluatorProvider(evalProvider);
                    }
                }
                // Check circuit breaker before first attempt
                if (!this.circuitBreaker.isAvailable()) {
                    const msg = 'CIRCUIT_OPEN: Too many recent failures. Cooling down.';
                    tracer.recordDecision(runId, msg, 0);
                    bus.publish('agent.failed', ctx.agentId, { runId, error: msg });
                    return {
                        runId,
                        agentId: ctx.agentId,
                        missionId: ctx.missionId,
                        status: 'cancelled',
                        summary: msg,
                        steps: [],
                        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                        totalDurationMs: 0,
                        error: msg,
                    };
                }
                for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
                    const llmCtx = { request, agentId: ctx.agentId, runId };
                    let llmRequest = await (0, pluginManager_1.getHookManager)().fireBeforeLLMCall(llmCtx);
                    let response = await this.callWithTimeout(llmRequest, routing);
                    await (0, pluginManager_1.getHookManager)().fireAfterLLMCall({
                        request: llmRequest,
                        response,
                        agentId: ctx.agentId,
                        runId,
                    });
                    const stepDuration = Date.now() - startTime;
                    // Enforce sub-agent step limits (only when ctx.guard is set by subAgentExecutor)
                    (_g = ctx.guard) === null || _g === void 0 ? void 0 : _g.check(0);
                    if (response) {
                        // Accumulate token usage
                        totalTokens.promptTokens += response.usage.promptTokens;
                        totalTokens.completionTokens += response.usage.completionTokens;
                        totalTokens.totalTokens += response.usage.totalTokens;
                        this.governor.reportUsage(response.usage.totalTokens);
                        (_h = ctx.guard) === null || _h === void 0 ? void 0 : _h.recordTokens(response.usage.totalTokens);
                        const traceEventId = tracer.recordLLMCall(runId, routing.modelId, routing.provider, routing.tier, request, response, response.usage, stepDuration, undefined, { taskCategory: costEstimate.taskCategory });
                        (0, metricsCollector_1.getMetricsCollector)().recordLLMCall(routing.modelId, routing.provider, response.usage.totalTokens, stepDuration, undefined, tenantId);
                        // Record actual cost for estimator learning (per-step)
                        try {
                            const modelCfg = this.router.getModel(routing.modelId);
                            const stepCostUsd = costEstimator.estimateForModel(ctx, modelCfg !== null && modelCfg !== void 0 ? modelCfg : {
                                id: routing.modelId,
                                provider: routing.provider,
                                tier: routing.tier,
                                costPer1KInput: 0.003,
                                costPer1KOutput: 0.01,
                                capabilities: [],
                                contextWindow: 128000,
                                priority: 0,
                            }).costUsd *
                                (response.usage.totalTokens / (costEstimate.predictedTotalTokens || 1));
                            costEstimator.recordActualCost(costEstimate.taskCategory, routing.tier, response.usage.promptTokens, response.usage.completionTokens, stepCostUsd, stepDuration, true);
                            // Record model performance for cross-session learning
                            this.router.recordOutcome(routing.modelId, costEstimate.taskCategory, true, stepDuration, response.usage.totalTokens);
                            try {
                                (0, modelPerformanceStore_1.getModelPerformanceStore)().record({
                                    modelId: routing.modelId,
                                    taskType: costEstimate.taskCategory,
                                    success: true,
                                    durationMs: stepDuration,
                                    tokensUsed: response.usage.totalTokens,
                                    timestamp: Date.now(),
                                });
                            }
                            catch {
                                /* best-effort */
                            }
                        }
                        catch {
                            /* best-effort learning */
                        }
                        // Record step
                        const stepNumber = steps.length + 1;
                        const step = {
                            stepNumber,
                            timestamp: (0, runtimeHelpers_1.now)(),
                            type: 'response',
                            content: response.content ||
                                response.reasoning_content ||
                                '',
                            tokenUsage: response.usage,
                            durationMs: stepDuration,
                        };
                        // ── Hook: onStepStart ──
                        (0, pluginManager_1.getHookManager)()
                            .fireOnStepStart({
                            runId,
                            agentId: ctx.agentId,
                            stepNumber,
                            type: 'response',
                            content: response.content,
                        })
                            .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'onStepStart hook failed', {
                            error: e === null || e === void 0 ? void 0 : e.message,
                        }));
                        steps.push(step);
                        const anomalyDetector = (0, anomalyDetector_1.getAnomalyDetector)();
                        anomalyDetector.recordUsage(ctx.agentId, response.usage.totalTokens);
                        const anomaly = anomalyDetector.checkForAnomaly(ctx.agentId, runId, stepNumber, response.usage.totalTokens);
                        if (anomaly) {
                            bus.publish('system.alert', 'runtime', {
                                type: 'token_usage_anomaly',
                                ...anomaly,
                            });
                        }
                        if (response.content) {
                            const stagnation = this.cycleDetector.checkOutput(response.content);
                            if (stagnation.detected) {
                                bus.publish('system.alert', 'runtime', {
                                    ...stagnation,
                                    runId,
                                    agentId: ctx.agentId,
                                    stepNumber,
                                });
                                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Semantic stagnation detected', {
                                    stepNumber,
                                    similarity: stagnation.similarity,
                                });
                            }
                        }
                        // Entropy gating: if model is confident with no tool calls, skip verification
                        // to save tokens. Evidence: arXiv 2602.02050 — high-quality tool calls reduce
                        // model entropy; confident responses need no verification.
                        let earlyExit = false;
                        if (!response.toolCalls || response.toolCalls.length === 0) {
                            if ((0, entropyGater_1.isConfidentResponse)(response)) {
                                bus.publish('system.alert', 'runtime', {
                                    type: 'entropy_gate',
                                    reason: 'confident_no_tool_calls',
                                });
                                // Skip verification when model is confident — saves ~500-2000 tokens per skip
                                earlyExit = true;
                                (0, metricsCollector_1.getMetricsCollector)().incrementCounter('early_exits_total', 'Early exits due to confident responses', 1, [{ name: 'reason', value: 'confident_no_tools' }]);
                            }
                            // Attempt structured output extraction for potential JSON answers.
                            // Prefer provider-native parsed output, then fall back to content parsing.
                            if (response.parsed) {
                                step.content = JSON.stringify(response.parsed);
                            }
                            else {
                                const structured = (0, structuredOutput_1.parseStructuredOutput)(response.content);
                                if (structured) {
                                    step.content =
                                        typeof structured === 'string' ? structured : JSON.stringify(structured);
                                }
                            }
                        }
                        // Process tool calls in a loop — with caching, planning, cycle detection, and output management
                        const maxIterations = Math.max(ctx.maxSteps || 10, 20);
                        let toolLoopCount = 0;
                        this.cycleDetector.reset();
                        this.executedMutations = [];
                        // Track recent tool call patterns for retry-loop detection.
                        // A retry loop is when the same tool is called with identical
                        // arguments >= 3 times within a short window (last 20 calls).
                        const recentToolPatterns = [];
                        let retryLoopDetected = false;
                        let retryLoopCount = 0;
                        let cycleDetected = false;
                        let interruptData = null;
                        while (response.toolCalls &&
                            response.toolCalls.length > 0 &&
                            toolLoopCount < maxIterations &&
                            !cycleDetected &&
                            !retryLoopDetected &&
                            this.governor.getState().phase !== 'critical') {
                            toolLoopCount++;
                            // Reset output manager turn budget (governor-aware: shrink under pressure)
                            this.outputManager.resetTurn();
                            this.outputManager.adjustBudgetForPressure(this.governor.getState().pressure);
                            // Check cache for all tool calls first (zero-cost on hit)
                            const calls = response.toolCalls;
                            const uncachedCalls = [];
                            const cachedResults = [];
                            for (const tc of calls) {
                                const cached = this.toolCache.get(tc, tenantId);
                                if (cached) {
                                    cachedResults.push({
                                        toolCallId: tc.id,
                                        name: tc.name,
                                        output: cached.output,
                                        error: cached.error,
                                        durationMs: 0,
                                    });
                                }
                                else {
                                    uncachedCalls.push(tc);
                                }
                            }
                            // Plan execution for uncached calls using dependency-aware planner
                            const executionPlan = this.planner.plan(uncachedCalls, this.tools);
                            const rawResults = [];
                            // Execute each stage (parallel within stage, sequential across stages)
                            for (const stage of executionPlan.stages) {
                                if (stage.toolCalls.length === 0)
                                    continue;
                                // Apply descending scheduler if enabled (broad exploration first)
                                const stageCalls = this.config.enableDescendingScheduler
                                    ? (0, runtimeHelpers_1.descendingToolOrder)(stage.toolCalls)
                                    : stage.toolCalls;
                                // Check orchestration plan (circuit breakers, approvals)
                                const planResult = await this.orchestrator.planExecution(stageCalls, this.tools);
                                const approvedCalls = [...planResult.concurrent, ...planResult.serial];
                                // Log skipped/circuit-broken tools
                                for (const s of planResult.skipped) {
                                    bus.publish('tool.blocked', ctx.agentId, {
                                        runId,
                                        toolName: s.toolCall.name,
                                        reason: 'orchestrator_skipped',
                                        detail: s.reason,
                                    });
                                    rawResults.push({
                                        toolCallId: s.toolCall.id,
                                        name: s.toolCall.name,
                                        output: '',
                                        error: s.reason,
                                        durationMs: 0,
                                    });
                                }
                                for (const cb of planResult.circuitBroken) {
                                    bus.publish('tool.blocked', ctx.agentId, {
                                        runId,
                                        toolName: cb.toolCall.name,
                                        reason: 'circuit_broken',
                                        detail: cb.toolName,
                                    });
                                    rawResults.push({
                                        toolCallId: cb.toolCall.id,
                                        name: cb.toolCall.name,
                                        output: '',
                                        error: `CIRCUIT_OPEN: ${cb.toolName}`,
                                        durationMs: 0,
                                    });
                                }
                                // Partition approved calls: concurrent-safe first, then serial
                                const concurrencyMap = approvedCalls.map((tc) => {
                                    const tool = this.tools.get(tc.name);
                                    return { tc, isSafe: (tool === null || tool === void 0 ? void 0 : tool.isConcurrencySafe) === true };
                                });
                                const safeCalls = concurrencyMap.filter((c) => c.isSafe).map((c) => c.tc);
                                const serialCalls = concurrencyMap.filter((c) => !c.isSafe).map((c) => c.tc);
                                // Run concurrent-safe tools in parallel with sibling abort
                                if (safeCalls.length > 0) {
                                    const siblingAbort = new AbortController();
                                    const concurrentResults = await Promise.allSettled(safeCalls.map(async (tc) => {
                                        var _a, _b, _c, _d, _e;
                                        // Check HookManager beforeToolCall
                                        const hookCtx = {
                                            toolName: tc.name,
                                            args: tc.arguments,
                                            agentId: ctx.agentId,
                                            runId,
                                        };
                                        const hookResult = await (0, pluginManager_1.getHookManager)().fireBeforeToolCall(hookCtx);
                                        if (hookResult !== null) {
                                            bus.publish('tool.blocked', ctx.agentId, {
                                                runId,
                                                toolName: tc.name,
                                                reason: 'hook_denied',
                                                detail: (_a = hookResult.error) !== null && _a !== void 0 ? _a : '',
                                            });
                                            return {
                                                toolCallId: tc.id,
                                                name: tc.name,
                                                output: '',
                                                error: `Hook blocked: ${hookResult.error || 'denied'}`,
                                                durationMs: 0,
                                            };
                                        }
                                        if (siblingAbort.signal.aborted) {
                                            return {
                                                toolCallId: tc.id,
                                                name: tc.name,
                                                output: '',
                                                error: 'Cancelled: sibling tool error',
                                                durationMs: 0,
                                            };
                                        }
                                        // Retry-loop detection: canonicalized args for deterministic matching
                                        const rlCheck = this.checkRetryLoop(tc.name, tc.arguments, recentToolPatterns, runId, ctx.tenantId, toolLoopCount);
                                        if (rlCheck.detected) {
                                            retryLoopDetected = true;
                                            retryLoopCount = rlCheck.count;
                                            return {
                                                toolCallId: tc.id,
                                                name: tc.name,
                                                output: '',
                                                error: `Retry loop detected: ${tc.name}`,
                                                durationMs: 0,
                                            };
                                        }
                                        const cycleCheck = this.cycleDetector.check(tc.name, tc.arguments, toolLoopCount);
                                        if (cycleCheck.detected) {
                                            bus.publish('system.alert', 'runtime', {
                                                type: 'cycle_detected',
                                                toolName: tc.name,
                                                description: cycleCheck.description,
                                            });
                                            bus.publish('tool.blocked', ctx.agentId, {
                                                runId,
                                                toolName: tc.name,
                                                reason: 'cycle_detected',
                                                detail: cycleCheck.description,
                                            });
                                            cycleDetected = true;
                                            return {
                                                toolCallId: tc.id,
                                                name: tc.name,
                                                output: '',
                                                error: `Cycle detected: ${cycleCheck.description}`,
                                                durationMs: 0,
                                            };
                                        }
                                        // Catch InterruptError before StepErrorBoundary — it's a signal, not an error
                                        let toolResult;
                                        try {
                                            toolResult = await this.executeTool(runId, tc, ctx.agentId, tenantId, ctx.availableTools);
                                        }
                                        catch (err) {
                                            if (err instanceof interruptError_1.InterruptError) {
                                                // Signal interrupt — the tool loop will break after this iteration
                                                interruptData = { reason: err.reason, value: err.value };
                                                bus.publish('agent.interrupted', ctx.agentId, {
                                                    runId,
                                                    reason: err.reason,
                                                });
                                                return {
                                                    toolCallId: tc.id,
                                                    name: tc.name,
                                                    output: `Interrupted: ${err.reason}`,
                                                    error: undefined,
                                                    durationMs: 0,
                                                };
                                            }
                                            throw err; // Re-throw non-interrupt errors for StepErrorBoundary
                                        }
                                        toolResult = await (0, pluginManager_1.getHookManager)().fireAfterToolCall({
                                            toolName: tc.name,
                                            args: tc.arguments,
                                            result: toolResult,
                                            agentId: ctx.agentId,
                                            runId,
                                        });
                                        if (toolResult.error &&
                                            (tc.name === 'shell_execute' || tc.name === 'bash')) {
                                            siblingAbort.abort();
                                        }
                                        if (!toolResult.error) {
                                            this.toolCache.set(tc, toolResult, tenantId);
                                            this.invalidateMutationCache(tc.name);
                                            if ((0, runtimeHelpers_1.isMutationTool)(tc.name)) {
                                                this.executedMutations.push({
                                                    toolName: tc.name,
                                                    args: tc.arguments,
                                                });
                                            }
                                        }
                                        // Capture file_write content for artifact propagation
                                        if (tc.name === 'file_write' && !toolResult.error) {
                                            const writtenContent = String((_c = (_b = tc.arguments) === null || _b === void 0 ? void 0 : _b.content) !== null && _c !== void 0 ? _c : '');
                                            if (writtenContent.length > largestFileWriteContent.length) {
                                                largestFileWriteContent = writtenContent;
                                                largestFileWritePath = String((_e = (_d = tc.arguments) === null || _d === void 0 ? void 0 : _d.path) !== null && _e !== void 0 ? _e : '');
                                            }
                                        }
                                        return {
                                            toolCallId: tc.id,
                                            name: tc.name,
                                            output: toolResult.output,
                                            error: toolResult.error,
                                            durationMs: toolResult.durationMs,
                                        };
                                    }));
                                    for (let i = 0; i < concurrentResults.length; i++) {
                                        const r = concurrentResults[i];
                                        if (r.status === 'fulfilled') {
                                            if (r.status === 'fulfilled' && !r.value.error)
                                                cumulativeEvidence++;
                                            rawResults.push(r.value);
                                        }
                                        else {
                                            rawResults.push({
                                                toolCallId: safeCalls[i].id,
                                                name: safeCalls[i].name,
                                                output: '',
                                                error: ((_j = r.reason) === null || _j === void 0 ? void 0 : _j.toString()) || 'Execution failed',
                                                durationMs: 0,
                                            });
                                        }
                                    }
                                }
                                // Run serial tools in order
                                for (const tc of serialCalls) {
                                    const hookCtx = {
                                        toolName: tc.name,
                                        args: tc.arguments,
                                        agentId: ctx.agentId,
                                        runId,
                                    };
                                    const hookResult = await (0, pluginManager_1.getHookManager)().fireBeforeToolCall(hookCtx);
                                    if (hookResult !== null) {
                                        bus.publish('tool.blocked', ctx.agentId, {
                                            runId,
                                            toolName: tc.name,
                                            reason: 'hook_denied',
                                            detail: (_k = hookResult.error) !== null && _k !== void 0 ? _k : '',
                                        });
                                        rawResults.push({
                                            toolCallId: tc.id,
                                            name: tc.name,
                                            output: '',
                                            error: `Hook blocked: ${hookResult.error || 'denied'}`,
                                            durationMs: 0,
                                        });
                                        continue;
                                    }
                                    // Retry-loop detection: canonicalised args for deterministic matching
                                    const rlCheck = this.checkRetryLoop(tc.name, tc.arguments, recentToolPatterns, runId, ctx.tenantId, toolLoopCount);
                                    if (rlCheck.detected) {
                                        retryLoopDetected = true;
                                        retryLoopCount = rlCheck.count;
                                        rawResults.push({
                                            toolCallId: tc.id,
                                            name: tc.name,
                                            output: '',
                                            error: `Retry loop detected: ${tc.name}`,
                                            durationMs: 0,
                                        });
                                        break;
                                    }
                                    const cycleCheck = this.cycleDetector.check(tc.name, tc.arguments, toolLoopCount);
                                    if (cycleCheck.detected) {
                                        bus.publish('system.alert', 'runtime', {
                                            type: 'cycle_detected',
                                            toolName: tc.name,
                                            description: cycleCheck.description,
                                        });
                                        bus.publish('tool.blocked', ctx.agentId, {
                                            runId,
                                            toolName: tc.name,
                                            reason: 'cycle_detected',
                                            detail: cycleCheck.description,
                                        });
                                        rawResults.push({
                                            toolCallId: tc.id,
                                            name: tc.name,
                                            output: '',
                                            error: `Cycle detected: ${cycleCheck.description}`,
                                            durationMs: 0,
                                        });
                                        cycleDetected = true;
                                        break;
                                    }
                                    let toolResult = await this.executeTool(runId, tc, ctx.agentId, tenantId, ctx.availableTools);
                                    toolResult = await (0, pluginManager_1.getHookManager)().fireAfterToolCall({
                                        toolName: tc.name,
                                        args: tc.arguments,
                                        result: toolResult,
                                        agentId: ctx.agentId,
                                        runId,
                                    });
                                    if (!toolResult.error) {
                                        this.toolCache.set(tc, toolResult, tenantId);
                                        this.invalidateMutationCache(tc.name);
                                        if ((0, runtimeHelpers_1.isMutationTool)(tc.name)) {
                                            this.executedMutations.push({
                                                toolName: tc.name,
                                                args: tc.arguments,
                                            });
                                        }
                                    }
                                    // Capture file_write content for artifact propagation
                                    if (tc.name === 'file_write' && !toolResult.error) {
                                        const writtenContent = String((_m = (_l = tc.arguments) === null || _l === void 0 ? void 0 : _l.content) !== null && _m !== void 0 ? _m : '');
                                        if (writtenContent.length > largestFileWriteContent.length) {
                                            largestFileWriteContent = writtenContent;
                                            largestFileWritePath = String((_p = (_o = tc.arguments) === null || _o === void 0 ? void 0 : _o.path) !== null && _p !== void 0 ? _p : '');
                                        }
                                    }
                                    if (!toolResult.error)
                                        cumulativeEvidence++;
                                    rawResults.push({
                                        toolCallId: tc.id,
                                        name: tc.name,
                                        output: toolResult.output,
                                        error: toolResult.error,
                                        durationMs: toolResult.durationMs,
                                    });
                                }
                            }
                            // Merge cached + raw results, reorder to match original request order
                            const allResults = [...cachedResults, ...rawResults];
                            const resultMap = new Map(allResults.map((r) => [r.toolCallId, r]));
                            const orderedResults = calls.map((tc) => resultMap.get(tc.id)).filter(Boolean);
                            // Output management: cap, truncate, persist per-turn budget
                            const managedOutputs = this.outputManager.manageBatch(orderedResults.map((r, i) => ({
                                toolCall: calls[i],
                                result: {
                                    toolCallId: r.toolCallId,
                                    name: r.name,
                                    output: r.output,
                                    error: r.error,
                                    durationMs: r.durationMs,
                                },
                            })));
                            // Governor-driven observation masking: adjust window based on budget pressure
                            const maskDecision = this.governor.shouldApply('observation_mask');
                            const effectiveWindow = maskDecision.apply
                                ? Math.max(2, Math.floor(this.config.observationMaskWindow * (1 - maskDecision.intensity * 0.7)))
                                : this.config.observationMaskWindow;
                            const maskedResults = await (0, runtimeHelpers_1.applyObservationMask)(orderedResults.map((r, i) => {
                                var _a, _b;
                                return ({
                                    ...r,
                                    output: (_b = (_a = managedOutputs[i]) === null || _a === void 0 ? void 0 : _a.output) !== null && _b !== void 0 ? _b : r.output,
                                });
                            }), effectiveWindow);
                            // Governor-driven tool output truncation: truncate verbose outputs under budget pressure
                            const truncateDecision = this.governor.shouldApply('tool_output_truncate');
                            const truncLimit = truncateDecision.apply
                                ? Math.max(200, Math.floor(2000 * (1 - truncateDecision.intensity * 0.8)))
                                : 0;
                            for (const masked of maskedResults) {
                                let finalOutput = masked.output;
                                // Defense-in-depth: scan tool outputs for injection patterns before they enter the LLM context.
                                // Lightweight regex check — blocks known injection patterns without LLM cost.
                                try {
                                    const injectionScan = (0, contentScanner_2.scanToolOutputForInjection)(finalOutput);
                                    if (injectionScan.blocked) {
                                        finalOutput = `[Tool output filtered: ${injectionScan.reason}] (Original output length: ${finalOutput.length} chars)`;
                                        bus.publish('system.alert', 'runtime', {
                                            type: 'tool_output_injection_blocked',
                                            toolCallId: masked.toolCallId,
                                            reason: injectionScan.reason,
                                        });
                                        try {
                                            (0, metricsCollector_1.getMetricsCollector)().incrementCounter('tool_output_injection_blocked_total', 'Tool outputs blocked for injection patterns', 1, [{ name: 'reason', value: (_q = injectionScan.reason) !== null && _q !== void 0 ? _q : 'unknown' }]);
                                        }
                                        catch {
                                            /* best-effort */
                                        }
                                    }
                                }
                                catch {
                                    /* best-effort defense */
                                }
                                // Apply truncation if governor says so and output is verbose
                                if (truncLimit > 0 && finalOutput.length > truncLimit) {
                                    finalOutput =
                                        finalOutput.slice(0, truncLimit) +
                                            `\n...[truncated: ${masked.output.length - truncLimit} chars]`;
                                }
                                const tsNum = steps.length + 1;
                                const toolStep = {
                                    stepNumber: tsNum,
                                    timestamp: (0, runtimeHelpers_1.now)(),
                                    type: 'tool_result',
                                    content: masked.output,
                                    durationMs: masked.durationMs,
                                };
                                // ── Hook: onStepComplete ──
                                (0, pluginManager_1.getHookManager)()
                                    .fireOnStepComplete({
                                    runId,
                                    agentId: ctx.agentId,
                                    stepNumber: tsNum,
                                    type: 'tool_result',
                                    content: masked.output,
                                })
                                    .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'onStepComplete hook failed', {
                                    error: e === null || e === void 0 ? void 0 : e.message,
                                }));
                                steps.push(toolStep);
                                const assistantMsg = {
                                    role: 'assistant',
                                    content: response.content,
                                    ...(response.reasoning_content
                                        ? { reasoning_content: response.reasoning_content }
                                        : {}),
                                    ...(response.toolCalls
                                        ? {
                                            tool_calls: response.toolCalls.map((tc) => ({
                                                id: tc.id,
                                                type: 'function',
                                                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                                            })),
                                        }
                                        : {}),
                                };
                                request.messages.push(assistantMsg, {
                                    role: 'tool',
                                    content: masked.output,
                                    tool_call_id: masked.toolCallId,
                                });
                            }
                            // ── Sliding Window + Memory Solidification ──
                            // Before the follow-up LLM call, increment the turn counter,
                            // solidify completed turns to episodic memory (if due),
                            // enforce the window boundary, and retrieve relevant context.
                            this.slidingWindow.incrementTurn();
                            if (this.memory) {
                                // 1. Solidify completed turns to memory (every N turns)
                                try {
                                    const solidifyResult = await this.slidingWindow.solidifyCompletedTurns(request.messages, this.memory, ctx.goal, runId);
                                    if (solidifyResult.turnsSolidified > 0) {
                                        bus.publish('system.alert', 'runtime', {
                                            type: 'sliding_window_solidify',
                                            turnsSolidified: solidifyResult.turnsSolidified,
                                            tokensFreed: solidifyResult.tokensFreed,
                                        });
                                    }
                                }
                                catch (e) {
                                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Sliding window solidify failed (best-effort)', {
                                        error: e === null || e === void 0 ? void 0 : e.message,
                                    });
                                }
                                // 2. Apply sliding window (enforce max turns in context)
                                // request.messages is mutated in-place, so the subsequent
                                // followUpRequest will automatically reference the updated array.
                                try {
                                    const windowResult = this.slidingWindow.applyWindow(request.messages);
                                    if (windowResult.applied) {
                                        bus.publish('system.alert', 'runtime', {
                                            type: 'sliding_window_applied',
                                            turnsDropped: windowResult.turnsDropped,
                                            tokensFreed: windowResult.tokensFreed,
                                        });
                                    }
                                }
                                catch (e) {
                                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Sliding window apply failed (best-effort)', {
                                        error: e === null || e === void 0 ? void 0 : e.message,
                                    });
                                }
                                // 3. Retrieve relevant context from memory and inject
                                try {
                                    const retrievalResult = this.slidingWindow.retrieveContext(this.memory, ctx.goal, request.messages);
                                    if (retrievalResult.entriesRetrieved > 0 &&
                                        retrievalResult.injectedContext.length > 0) {
                                        // Inject as a system message before the last user message
                                        // This keeps prompt-cache stability (injected before variable content)
                                        request.messages.splice(request.messages.length - 1, 0, {
                                            role: 'system',
                                            content: retrievalResult.injectedContext,
                                        });
                                        bus.publish('system.alert', 'runtime', {
                                            type: 'sliding_window_retrieval',
                                            entriesRetrieved: retrievalResult.entriesRetrieved,
                                            injectedTokens: retrievalResult.injectedTokens,
                                        });
                                    }
                                }
                                catch (e) {
                                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Sliding window retrieval failed (best-effort)', {
                                        error: e === null || e === void 0 ? void 0 : e.message,
                                    });
                                }
                            }
                            // Resume the model with tool results
                            // followUpRequest is created fresh from the mutated request object,
                            // so it correctly sees the updated messages array.
                            const followUpCtx = { request, agentId: ctx.agentId, runId };
                            let followUpRequest = await (0, pluginManager_1.getHookManager)().fireBeforeLLMCall(followUpCtx);
                            const followUp = await this.callWithTimeout(followUpRequest, routing);
                            await (0, pluginManager_1.getHookManager)().fireAfterLLMCall({
                                request: followUpRequest,
                                response: followUp,
                                agentId: ctx.agentId,
                                runId,
                            });
                            if (!followUp)
                                break;
                            totalTokens.promptTokens += followUp.usage.promptTokens;
                            totalTokens.completionTokens += followUp.usage.completionTokens;
                            totalTokens.totalTokens += followUp.usage.totalTokens;
                            this.governor.reportUsage(followUp.usage.totalTokens);
                            (_r = ctx.guard) === null || _r === void 0 ? void 0 : _r.recordTokens(followUp.usage.totalTokens);
                            response = followUp;
                            // Enforce sub-agent step and progress limits at each tool loop iteration
                            (_s = ctx.guard) === null || _s === void 0 ? void 0 : _s.check(cumulativeEvidence);
                            // Context compaction: check every iteration after the first.
                            // The compactor's own layer thresholds (60%/70%/82%/92% full) decide whether to act.
                            // This prevents context bloat before the LLM call that would waste tokens.
                            if (toolLoopCount > 1) {
                                const tokensBefore = this.compactor.getUsage(request.messages).total;
                                const tt = (0, unifiedVerification_1.detectTaskType)(ctx.goal);
                                const taskType = tt === 'creative' ? 'general' : tt;
                                // ── Hook: beforeContextCompaction ──
                                (0, pluginManager_1.getHookManager)()
                                    .fireBeforeContextCompaction({
                                    messageCount: request.messages.length,
                                    totalTokens: tokensBefore,
                                    budgetTokens: this.config.budgetHardCapTokens || 128000,
                                    agentId: ctx.agentId,
                                    runId,
                                })
                                    .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'beforeContextCompaction hook failed', { error: e === null || e === void 0 ? void 0 : e.message }));
                                const compactResult = this.compactor.compact(request.messages, undefined, taskType);
                                if (compactResult.action.droppedCount > 0) {
                                    request.messages = compactResult.messages;
                                    this.governor.recordOutcome('context_compaction', tokensBefore, this.compactor.getUsage(request.messages).total);
                                    bus.publish('system.alert', 'runtime', {
                                        type: 'context_compaction',
                                        layer: compactResult.action.layer,
                                        droppedCount: compactResult.action.droppedCount,
                                        tokensSaved: compactResult.action.tokensSaved,
                                    });
                                    // ── Hook: afterContextCompaction ──
                                    (0, pluginManager_1.getHookManager)()
                                        .fireAfterContextCompaction({
                                        messageCount: request.messages.length,
                                        totalTokens: this.compactor.getUsage(request.messages).total,
                                        budgetTokens: this.config.budgetHardCapTokens || 128000,
                                        agentId: ctx.agentId,
                                        runId,
                                    })
                                        .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'afterContextCompaction hook failed', { error: e === null || e === void 0 ? void 0 : e.message }));
                                }
                            }
                        }
                        // Interrupt check: if a tool requested human input, pause execution
                        if (interruptData) {
                            const id = interruptData;
                            const totalDurationMs = Date.now() - startTime;
                            const result = {
                                runId,
                                agentId: ctx.agentId,
                                missionId: ctx.missionId,
                                status: 'interrupted',
                                summary: `Interrupted: ${id.reason}`,
                                steps,
                                totalTokenUsage: totalTokens,
                                totalDurationMs,
                                interrupt: id,
                            };
                            this.checkpointer.terminalCheckpoint({
                                runId,
                                agentId: ctx.agentId,
                                missionId: ctx.missionId,
                                timestamp: (0, runtimeHelpers_1.now)(),
                                phase: 'interrupted',
                                stepNumber: steps.length,
                                attemptNumber: attempt,
                                messages: request.messages,
                                tokenUsage: { ...totalTokens },
                                stepDurations: steps.map((s) => s.durationMs),
                                context: {
                                    agentId: ctx.agentId,
                                    missionId: ctx.missionId,
                                    projectId: ctx.projectId,
                                    goal: ctx.goal,
                                    availableTools: ctx.availableTools,
                                    maxSteps: ctx.maxSteps,
                                    tokenBudget: ctx.tokenBudget,
                                },
                                totalDurationMs,
                            });
                            tracer.recordDecision(runId, `Interrupted: ${id.reason}`, steps.length);
                            bus.publish('agent.interrupted', ctx.agentId, { runId, reason: id.reason });
                            try {
                                (0, metricsCollector_1.getMetricsCollector)().recordSubAgentOutcome(ctx.agentId, 'interrupted', (_t = ctx.subAgentDepth) !== null && _t !== void 0 ? _t : 0, ctx.tenantId);
                            }
                            catch {
                                /* best-effort */
                            }
                            return result;
                        }
                        // Early exit: skip verification when model is confident and has no tool calls.
                        // This saves the verification token cost (~500-2000 tokens) and avoids
                        // unnecessary retries on confident responses.
                        if (earlyExit) {
                            const safeContent = response.content ||
                                response.reasoning_content ||
                                '';
                            const totalDurationMs = Date.now() - startTime;
                            const result = {
                                runId,
                                agentId: ctx.agentId,
                                missionId: ctx.missionId,
                                status: 'success',
                                summary: safeContent || '[Early exit: confident response]',
                                steps,
                                totalTokenUsage: totalTokens,
                                totalDurationMs,
                            };
                            this.checkpointer.terminalCheckpoint({
                                runId,
                                agentId: ctx.agentId,
                                missionId: ctx.missionId,
                                timestamp: (0, runtimeHelpers_1.now)(),
                                phase: 'completed_early_exit',
                                stepNumber: steps.length,
                                attemptNumber: attempt,
                                messages: request.messages,
                                tokenUsage: { ...totalTokens },
                                stepDurations: steps.map((s) => s.durationMs),
                                context: {
                                    agentId: ctx.agentId,
                                    missionId: ctx.missionId,
                                    projectId: ctx.projectId,
                                    goal: ctx.goal,
                                    availableTools: ctx.availableTools,
                                    maxSteps: ctx.maxSteps,
                                    tokenBudget: ctx.tokenBudget,
                                },
                                totalDurationMs,
                            });
                            if (this.memory) {
                                try {
                                    this.memory.add(`[EARLY_EXIT] ${ctx.goal.slice(0, 200)}`, 'episodic', `run:${runId}|tokens:${totalTokens.totalTokens}|dur:${totalDurationMs}ms|steps:${steps.length}`, 0.6, ['execution', 'early_exit', ...ctx.availableTools.slice(0, 3)], {
                                        runId,
                                        goal: ctx.goal.slice(0, 500),
                                        tokenUsage: totalTokens,
                                        durationMs: totalDurationMs,
                                    });
                                }
                                catch {
                                    /* best-effort */
                                }
                            }
                            (0, metricsCollector_1.getMetricsCollector)().recordRunComplete('success_early_exit', totalDurationMs, steps.length, tenantId);
                            bus.publish('agent.completed', ctx.agentId, {
                                runId,
                                status: 'success',
                                summary: safeContent.slice(0, 200),
                                tokenUsage: totalTokens,
                                durationMs: totalDurationMs,
                            });
                            // Record final cost for estimator learning
                            try {
                                const modelCfg = this.router.getModel(routing.modelId);
                                const totalCostUsd = costEstimator.estimateForModel(ctx, modelCfg !== null && modelCfg !== void 0 ? modelCfg : {
                                    id: routing.modelId,
                                    provider: routing.provider,
                                    tier: routing.tier,
                                    costPer1KInput: 0.003,
                                    costPer1KOutput: 0.01,
                                    capabilities: [],
                                    contextWindow: 128000,
                                    priority: 0,
                                }).costUsd;
                                costEstimator.recordActualCost(costEstimate.taskCategory, routing.tier, totalTokens.promptTokens, totalTokens.completionTokens, totalCostUsd, totalDurationMs, true);
                            }
                            catch {
                                /* best-effort */
                            }
                            return result;
                        }
                        // ── Hook: onSessionArchive (before checkpoint) ──
                        (0, pluginManager_1.getHookManager)()
                            .fireOnSessionArchive({
                            runId,
                            phase: 'tool_execution',
                            stepNumber: steps.length,
                            tokenUsage: { totalTokens: totalTokens.totalTokens },
                        })
                            .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'onSessionArchive hook failed', {
                            error: e === null || e === void 0 ? void 0 : e.message,
                        }));
                        // Count successful tool results for sub-agent progress tracking
                        const evidenceCount = steps.filter((s) => {
                            var _a, _b;
                            return s.type === 'tool_result' &&
                                !((_a = s.content) === null || _a === void 0 ? void 0 : _a.startsWith('error:')) &&
                                !((_b = s.content) === null || _b === void 0 ? void 0 : _b.startsWith('TOOL_'));
                        }).length;
                        this.checkpointer.checkpoint({
                            runId,
                            agentId: ctx.agentId,
                            missionId: ctx.missionId,
                            timestamp: (0, runtimeHelpers_1.now)(),
                            phase: 'tool_execution',
                            stepNumber: steps.length,
                            attemptNumber: attempt,
                            messages: request.messages,
                            tokenUsage: { ...totalTokens },
                            stepDurations: steps.map((s) => s.durationMs),
                            context: {
                                agentId: ctx.agentId,
                                missionId: ctx.missionId,
                                projectId: ctx.projectId,
                                goal: ctx.goal,
                                availableTools: ctx.availableTools,
                                maxSteps: ctx.maxSteps,
                                tokenBudget: ctx.tokenBudget,
                            },
                            totalDurationMs: Date.now() - startTime,
                        });
                        // Enforce sub-agent progress and step limits
                        (_u = ctx.guard) === null || _u === void 0 ? void 0 : _u.check(evidenceCount);
                        // Unified Verification Pipeline: tiered zero-cost-first verification
                        // Governor strategy: skip LLM verification when budget is tight and model is confident
                        const verifSkipDecision = this.governor.shouldApply('verification_skip');
                        const shouldSkipVerification = verifSkipDecision.apply &&
                            verifSkipDecision.intensity > 0.7 &&
                            (!response.toolCalls || response.toolCalls.length === 0) &&
                            (0, entropyGater_1.isConfidentResponse)(response);
                        let verifReport;
                        if (shouldSkipVerification) {
                            // Skip verification to save tokens (500-2000 tokens saved)
                            verifReport = {
                                passed: true,
                                confidence: 0.85,
                                signals: [],
                                tokensUsed: 0,
                                stagesRun: [],
                                taskType: (0, unifiedVerification_1.detectTaskType)(ctx.goal),
                                skipped: true,
                                skipReason: 'verification_skip_governor',
                            };
                            try {
                                (0, metricsCollector_1.getMetricsCollector)().incrementCounter('verification_skipped_total', 'Verifications skipped by governor', 1, [{ name: 'reason', value: 'governor_skip' }]);
                            }
                            catch {
                                /* best-effort */
                            }
                        }
                        else {
                            const verifCtx = {
                                goal: ctx.goal,
                                output: response.content,
                                language: typeof ctx.goal === 'string'
                                    ? ctx.goal.toLowerCase().includes('python')
                                        ? 'python'
                                        : undefined
                                    : undefined,
                                schema: ctx.outputSchema,
                                toolsUsed: ctx.availableTools,
                                tokenBudgetRemaining: this.governor.getState().remainingTokens,
                                previousFailures: lastError ? [lastError] : undefined,
                            };
                            const verifStart = Date.now();
                            verifReport = await this.verificationPipeline.verify(verifCtx);
                            this.governor.reportUsage(verifReport.tokensUsed);
                            try {
                                (0, metricsCollector_1.getMetricsCollector)().recordStepLatency('verification', Date.now() - verifStart, (_v = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _v !== void 0 ? _v : undefined);
                            }
                            catch {
                                /* best-effort */
                            }
                            if (!verifReport.passed) {
                                this.recordCostByFailureMode('verification', response);
                            }
                        }
                        // Record verification result to samples store
                        this.samplesStore.recordVerification(ctx.goal, response.content, {
                            passed: verifReport.passed,
                            confidence: verifReport.confidence,
                            signalCount: verifReport.signals.length,
                            tokensUsed: verifReport.tokensUsed,
                            stagesRun: verifReport.stagesRun,
                            skipReason: verifReport.skipReason,
                        });
                        tracer.recordVerification(runId, verifReport.passed, verifReport.confidence, verifReport.signals.length, verifReport.tokensUsed > 0 ? 1 : 0);
                        try {
                            (0, metricsCollector_1.getMetricsCollector)().recordVerificationResult(verifReport.confidence, verifReport.passed, verifReport.signals.length, verifReport.signals.map((s) => { var _a, _b; return (_b = (_a = s.type) !== null && _a !== void 0 ? _a : s.name) !== null && _b !== void 0 ? _b : 'unknown'; }), (_w = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _w !== void 0 ? _w : undefined);
                        }
                        catch {
                            /* best-effort */
                        }
                        try {
                            (0, verificationReportStore_1.getVerificationReportStore)(ctx.tenantId).write({
                                schemaVersion: 1,
                                runId,
                                agentId: ctx.agentId,
                                capturedAt: new Date().toISOString(),
                                attempt,
                                passed: verifReport.passed,
                                confidence: verifReport.confidence,
                                skipReason: verifReport.skipReason,
                                outputPrefix: response.content.slice(0, 5000),
                                goal: ctx.goal.slice(0, 1000),
                                report: verifReport,
                            });
                        }
                        catch {
                            /* best-effort */
                        }
                        this.checkpointer.checkpoint({
                            runId,
                            agentId: ctx.agentId,
                            missionId: ctx.missionId,
                            timestamp: (0, runtimeHelpers_1.now)(),
                            phase: 'verification',
                            stepNumber: steps.length,
                            attemptNumber: attempt,
                            messages: request.messages,
                            tokenUsage: { ...totalTokens },
                            stepDurations: steps.map((s) => s.durationMs),
                            context: {
                                agentId: ctx.agentId,
                                missionId: ctx.missionId,
                                projectId: ctx.projectId,
                                goal: ctx.goal,
                                availableTools: ctx.availableTools,
                                maxSteps: ctx.maxSteps,
                                tokenBudget: ctx.tokenBudget,
                            },
                            lastError,
                            totalDurationMs: Date.now() - startTime,
                        });
                        // Tier 3.2: Record reflection from this verification attempt so future
                        // retries can learn from prior outcomes (Reflexion: Shinn et al., 2023).
                        const reflectionInsight = verifReport.passed
                            ? {
                                id: `${runId}-${attempt}-ok`,
                                insight: `Attempt ${attempt + 1} passed verification with confidence ${verifReport.confidence.toFixed(2)}.`,
                                type: 'success',
                                timestamp: Date.now(),
                            }
                            : {
                                id: `${runId}-${attempt}-fail`,
                                insight: `Attempt ${attempt + 1} failed verification: ${(verifReport.signals[0] && ((_x = verifReport.signals[0].type) !== null && _x !== void 0 ? _x : verifReport.signals[0].name)) || 'unknown'} signal.`,
                                type: 'failure',
                                timestamp: Date.now(),
                            };
                        this.reflexionInjector.addReflection(reflectionInsight);
                        // Semantic circuit breaker: track consecutive verification failures.
                        // When verification repeatedly fails, the circuit breaker can trigger
                        // semantic-level intervention (e.g., escalate to stronger model).
                        if (!verifReport.passed) {
                            this.circuitBreaker.recordSemanticFailure(`verification_failed: ${(verifReport.signals[0] && ((_y = verifReport.signals[0].type) !== null && _y !== void 0 ? _y : verifReport.signals[0].name)) || 'unknown'}`);
                        }
                        else {
                            this.circuitBreaker.recordSemanticSuccess();
                        }
                        if (!verifReport.passed && attempt < this.config.maxRetries) {
                            const maxReflexion = (_z = this.config.reflexionMaxIterations) !== null && _z !== void 0 ? _z : 2;
                            // Tier 3.2 (RFC v2): explicit reflection-driven self-correction loop for
                            // low-confidence verification failures. Heuristic-only generation avoids
                            // an extra LLM call; cap iterations to prevent runaway cost.
                            if (verifReport.confidence < 0.5 && maxReflexion > 0) {
                                let reflexionAttempt = 0;
                                let currentFeedback = this.verificationPipeline.toFeedback(verifReport);
                                while (reflexionAttempt < maxReflexion &&
                                    currentFeedback &&
                                    !verifReport.passed) {
                                    reflexionAttempt++;
                                    const firstSignal = verifReport.signals[0];
                                    const reflexionCtx = {
                                        goal: ctx.goal,
                                        attemptedAction: 'LLM response generation',
                                        actionResult: response.content,
                                        error: (firstSignal &&
                                            ((_0 = firstSignal.message) !== null && _0 !== void 0 ? _0 : firstSignal.name)) ||
                                            'verification failed',
                                        errorClass: 'permanent',
                                        attemptNumber: reflexionAttempt,
                                    };
                                    const reflexion = await this.reflexionGenerator.generate(reflexionCtx);
                                    this.reflexionInjector.addReflection({
                                        id: `${runId}-${attempt}-reflexion-${reflexionAttempt}`,
                                        insight: reflexionGenerator_1.ReflexionGenerator.formatForContext(reflexionCtx, reflexion),
                                        type: 'failure',
                                        timestamp: Date.now(),
                                    });
                                    request.messages.push({
                                        role: 'system',
                                        content: `[Reflexion guidance ${reflexionAttempt}/${maxReflexion}]\n${reflexionGenerator_1.ReflexionGenerator.formatForContext(reflexionCtx, reflexion)}`,
                                    });
                                    request.messages.push({ role: 'user', content: currentFeedback });
                                    const reflexionStart = Date.now();
                                    const reflexionResponse = await this.callWithTimeout(request, routing, attempt);
                                    if (!reflexionResponse)
                                        break;
                                    response = reflexionResponse;
                                    totalTokens.promptTokens += reflexionResponse.usage.promptTokens;
                                    totalTokens.completionTokens += reflexionResponse.usage.completionTokens;
                                    totalTokens.totalTokens += reflexionResponse.usage.totalTokens;
                                    this.governor.reportUsage(reflexionResponse.usage.totalTokens);
                                    verifReport = await this.verificationPipeline.verify({
                                        goal: ctx.goal,
                                        output: response.content,
                                        language: typeof ctx.goal === 'string'
                                            ? ctx.goal.toLowerCase().includes('python')
                                                ? 'python'
                                                : undefined
                                            : undefined,
                                        schema: ctx.outputSchema,
                                        toolsUsed: ctx.availableTools,
                                        tokenBudgetRemaining: this.governor.getState().remainingTokens,
                                        previousFailures: lastError ? [lastError] : undefined,
                                    });
                                    this.governor.reportUsage(verifReport.tokensUsed);
                                    try {
                                        (0, metricsCollector_1.getMetricsCollector)().recordStepLatency('reflexion', Date.now() - reflexionStart, (_1 = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _1 !== void 0 ? _1 : undefined);
                                    }
                                    catch {
                                        /* best-effort */
                                    }
                                    if (!verifReport.passed) {
                                        currentFeedback = this.verificationPipeline.toFeedback(verifReport);
                                    }
                                }
                            }
                            const feedback = this.verificationPipeline.toFeedback(verifReport);
                            if (feedback && !verifReport.passed) {
                                this.recordCostByFailureMode('verification', response);
                                lastError = feedback;
                                tracer.recordDecision(runId, `verification (attempt ${attempt + 1}, confidence ${verifReport.confidence.toFixed(2)}): ${feedback.slice(0, 100)}`, 0);
                                // Compact context before retry to avoid replaying bloated history.
                                // First, record which messages correlated with this verification failure
                                // so the compactor can prune failure-prone context first.
                                const failureSignal = (verifReport.signals[0] &&
                                    ((_2 = verifReport.signals[0].type) !== null && _2 !== void 0 ? _2 : verifReport.signals[0].name)) ||
                                    undefined;
                                this.compactor.recordFailureCorrelation(runId, request.messages, failureSignal);
                                const tokensBeforeRetry = this.compactor.getUsage(request.messages).total;
                                const tt = (0, unifiedVerification_1.detectTaskType)(ctx.goal);
                                const taskType = tt === 'creative' ? 'general' : tt;
                                const retryCompact = this.compactor.compact(request.messages, undefined, taskType);
                                if (retryCompact.action.droppedCount > 0) {
                                    request.messages = retryCompact.messages;
                                    this.governor.recordOutcome('context_compaction', tokensBeforeRetry, this.compactor.getUsage(request.messages).total);
                                    bus.publish('system.alert', 'runtime', {
                                        type: 'context_compaction',
                                        layer: retryCompact.action.layer,
                                        droppedCount: retryCompact.action.droppedCount,
                                        tokensSaved: retryCompact.action.tokensSaved,
                                    });
                                }
                                // Cascade escalation: try a more capable model on verification failure
                                // FrugalGPT pattern: escalate to stronger model when quality is insufficient
                                // Uses the escalation chain from routeWithCascade if available, otherwise falls back to getFallbackModel
                                let fallbackModel;
                                if (this.smartRouter && currentEscalationChain.length > 0) {
                                    const nextId = this.smartRouter.getNextEscalation(routing.modelId, currentEscalationChain.map((m) => m.id));
                                    fallbackModel = nextId
                                        ? ((_3 = this.router.getModel(nextId.id)) !== null && _3 !== void 0 ? _3 : undefined)
                                        : undefined;
                                }
                                else {
                                    fallbackModel =
                                        currentEscalationChain.length > 0
                                            ? this.router.getNextEscalation(routing.modelId, currentEscalationChain)
                                            : this.router.getFallbackModel(routing.modelId, tt);
                                }
                                if (fallbackModel && fallbackModel.tier !== routing.tier) {
                                    const newRouting = {
                                        modelId: fallbackModel.id,
                                        tier: fallbackModel.tier,
                                        provider: fallbackModel.provider,
                                        reasoning: [
                                            ...routing.reasoning,
                                            `cascade_escalation: ${routing.modelId} → ${fallbackModel.id} (verification failed)`,
                                        ],
                                        estimatedCost: routing.estimatedCost * 1.5,
                                        maxTokens: routing.maxTokens,
                                    };
                                    routing = newRouting;
                                    // Remove the escalated model from the chain so we don't escalate to it again
                                    currentEscalationChain = currentEscalationChain.filter((m) => m.id !== fallbackModel.id);
                                    request.model =
                                        (fallbackModel.id || '').replace(/@\w+$/, '') || fallbackModel.id;
                                    tracer.recordDecision(runId, `cascade escalation: ${routing.modelId} (${routing.tier}) chain_remaining=${currentEscalationChain.length}`, 0);
                                    bus.publish('system.alert', 'runtime', {
                                        type: 'cascade_escalation',
                                        from: routing.modelId,
                                        to: fallbackModel.id,
                                    });
                                    try {
                                        (0, metricsCollector_1.getMetricsCollector)().recordCascadeEscalation(routing.modelId, fallbackModel.id, 'verification_failed', (_4 = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _4 !== void 0 ? _4 : undefined);
                                    }
                                    catch {
                                        /* best-effort */
                                    }
                                    try {
                                        (0, intentLog_1.getIntentLog)(ctx.tenantId).write({
                                            schemaVersion: 1,
                                            runId,
                                            capturedAt: new Date().toISOString(),
                                            stage: 'agentRuntime.cascade',
                                            decision: 'escalate',
                                            reason: 'verification_failed',
                                            payload: { from: routing.modelId, to: fallbackModel.id },
                                        });
                                    }
                                    catch {
                                        /* best-effort */
                                    }
                                }
                                const reflections = this.reflexionInjector.getRecentReflections(3);
                                const augmentedFeedback = reflections.length > 0
                                    ? `${feedback}\n\n[Recent reflections — use these to avoid repeating mistakes]:\n${reflections.map((r, i) => `${i + 1}. ${r.insight}`).join('\n')}`
                                    : feedback;
                                request.messages.push({ role: 'user', content: augmentedFeedback });
                                continue;
                            }
                        }
                        // Content safety scan before returning result
                        // Reasoning models (MiMo, DeepSeek-R) put output in reasoning_content.
                        // Merge so downstream code (synthesis, summary) can read it.
                        let safeContent = response.content ||
                            response.reasoning_content ||
                            '';
                        try {
                            const scanResult = await this.contentScanner.scan(safeContent);
                            if (!scanResult.isSafe) {
                                const criticalThreats = scanResult.threats.filter((t) => t.severity === 'HIGH' || t.severity === 'CRITICAL');
                                if (criticalThreats.length > 0) {
                                    bus.publish('system.alert', 'runtime', {
                                        type: 'content_threat_blocked',
                                        threats: criticalThreats.map((t) => `${t.type}:${t.severity}`),
                                    });
                                    safeContent = `[Content blocked: ${criticalThreats.length} security threat(s) detected. Review and resubmit.]`;
                                }
                            }
                        }
                        catch (e) {
                            (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Content scan failed (best-effort)', {
                                error: e === null || e === void 0 ? void 0 : e.message,
                            });
                        }
                        // Output format: apply configurable formatting preference to the summary
                        // - 'concise': truncate verbose responses to first paragraph
                        // - 'structured': if response looks like JSON, pass through; otherwise no transformation
                        // - 'freeform' and 'auto': pass through without transformation
                        const outputFormat = (_5 = this.config.outputFormat) !== null && _5 !== void 0 ? _5 : 'auto';
                        if (outputFormat === 'concise' && safeContent && safeContent.length > 500) {
                            const firstParagraph = safeContent.split('\n\n')[0];
                            if (firstParagraph && firstParagraph.length > 50) {
                                safeContent = firstParagraph;
                            }
                        }
                        else if (outputFormat === 'structured' && safeContent) {
                            try {
                                JSON.parse(safeContent);
                            }
                            catch {
                                // Not JSON — no transformation applied
                            }
                        }
                        // If the final response has no text content (tool_call-only response),
                        // find the last text response from the step history for the summary.
                        if (!safeContent || safeContent.length === 0) {
                            for (let si = steps.length - 1; si >= 0; si--) {
                                const s = steps[si];
                                if (s.type === 'response' && s.content && !s.content.includes('<tool_call>')) {
                                    safeContent = s.content;
                                    break;
                                }
                            }
                        }
                        // If still empty, use the last tool result or provisioning data as summary
                        if (!safeContent || safeContent.length === 0) {
                            // Look for the last system message with tool results (provisioning injected)
                            for (let mi = request.messages.length - 1; mi >= 0; mi--) {
                                const msg = request.messages[mi];
                                if (msg.role === 'system' && ((_6 = msg.content) === null || _6 === void 0 ? void 0 : _6.startsWith('[Tool:'))) {
                                    safeContent = msg.content.slice(0, 2000);
                                    break;
                                }
                            }
                        }
                        // Last resort: use the last step's content (even if tool result)
                        if (!safeContent || safeContent.length === 0) {
                            for (let si = steps.length - 1; si >= 0; si--) {
                                const s = steps[si];
                                if (s.content && s.content.length > 0) {
                                    safeContent = s.content.slice(0, 2000);
                                    break;
                                }
                            }
                        }
                        // Absolute last resort: reflect the goal
                        if (!safeContent || safeContent.length === 0) {
                            safeContent = `[No text response generated by agent] Goal: ${ctx.goal.slice(0, 200)}`;
                        }
                        const totalDurationMs = Date.now() - startTime;
                        const result = {
                            runId,
                            agentId: ctx.agentId,
                            missionId: ctx.missionId,
                            status: 'success',
                            summary: safeContent,
                            steps,
                            totalTokenUsage: totalTokens,
                            totalDurationMs,
                            artifactContent: largestFileWriteContent || undefined,
                        };
                        // Record final actual cost for estimator learning
                        try {
                            const modelCfg = this.router.getModel(routing.modelId);
                            const totalCostUsd = costEstimator.estimateForModel(ctx, modelCfg !== null && modelCfg !== void 0 ? modelCfg : {
                                id: routing.modelId,
                                provider: routing.provider,
                                tier: routing.tier,
                                costPer1KInput: 0.003,
                                costPer1KOutput: 0.01,
                                capabilities: [],
                                contextWindow: 128000,
                                priority: 0,
                            }).costUsd;
                            costEstimator.recordActualCost(costEstimate.taskCategory, routing.tier, totalTokens.promptTokens, totalTokens.completionTokens, totalCostUsd, totalDurationMs, true);
                            // Log prediction accuracy for observability
                            const accuracy = costEstimate.predictedTotalTokens > 0
                                ? Math.min(2, Math.max(0.1, totalTokens.totalTokens / costEstimate.predictedTotalTokens))
                                : 1.0;
                            (0, metricsCollector_1.getMetricsCollector)().setGauge('cost_prediction_accuracy', 'Ratio of actual to predicted tokens (1.0 = perfect)', accuracy, [
                                { name: 'task_category', value: costEstimate.taskCategory },
                                { name: 'model_tier', value: routing.tier },
                            ]);
                        }
                        catch {
                            /* best-effort learning */
                        }
                        this.checkpointer.terminalCheckpoint({
                            runId,
                            agentId: ctx.agentId,
                            missionId: ctx.missionId,
                            timestamp: (0, runtimeHelpers_1.now)(),
                            phase: 'completed',
                            stepNumber: steps.length,
                            attemptNumber: attempt,
                            messages: request.messages,
                            tokenUsage: { ...totalTokens },
                            stepDurations: steps.map((s) => s.durationMs),
                            context: {
                                agentId: ctx.agentId,
                                missionId: ctx.missionId,
                                projectId: ctx.projectId,
                                goal: ctx.goal,
                                availableTools: ctx.availableTools,
                                maxSteps: ctx.maxSteps,
                                tokenBudget: ctx.tokenBudget,
                            },
                            totalDurationMs,
                        });
                        if (this.memory) {
                            try {
                                this.memory.add(`[SUCCESS] ${ctx.goal.slice(0, 200)}`, 'episodic', `run:${runId}|tokens:${totalTokens.totalTokens}|dur:${totalDurationMs}ms|steps:${steps.length}`, 0.7, ['execution', 'success', ...ctx.availableTools.slice(0, 3)], {
                                    runId,
                                    goal: ctx.goal.slice(0, 500),
                                    tokenUsage: totalTokens,
                                    durationMs: totalDurationMs,
                                });
                            }
                            catch (e) {
                                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to record success memory', {
                                    error: e === null || e === void 0 ? void 0 : e.message,
                                });
                            }
                        }
                        // Fire plugin onAgentComplete hooks
                        (0, pluginManager_1.getHookManager)()
                            .fireOnAgentComplete({ result, runId })
                            .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'onAgentComplete hook failed', {
                            error: e === null || e === void 0 ? void 0 : e.message,
                        }));
                        // Emit completed event
                        (0, metricsCollector_1.getMetricsCollector)().recordRunComplete('success', totalDurationMs, steps.length, tenantId);
                        bus.publish('agent.completed', ctx.agentId, {
                            runId,
                            missionId: ctx.missionId,
                            summary: result.summary,
                            tokenUsage: totalTokens,
                            durationMs: totalDurationMs,
                        });
                        this.circuitBreaker.onSuccess();
                        circuitReleased = true;
                        if (this.runHandle) {
                            try {
                                (0, scheduler_1.getExecutionScheduler)().commitRun({
                                    runId,
                                    leaseToken: this.runHandle.leaseToken,
                                    fencingEpoch: this.runHandle.fencingEpoch,
                                    tenantId: (_7 = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _7 !== void 0 ? _7 : undefined,
                                });
                            }
                            catch (e) {
                                (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Scheduler commitRun failed', {
                                    runId,
                                    error: e.message,
                                });
                            }
                        }
                        return result;
                    }
                    // Handle failure with error classification
                    const ce = (0, llmRetry_1.classifyLLMError)(new Error(lastError || 'Unknown error'));
                    lastError = ce.message;
                    lastErrorIsPermanent = !ce.retryable;
                    tracer.recordError(runId, `${ce.errorClass}: ${ce.message}`, Date.now() - startTime);
                    if (ce.retryable && attempt < this.config.maxRetries) {
                        const delayMs = (_8 = ce.retryAfter) !== null && _8 !== void 0 ? _8 : (0, llmRetry_1.computeBackoff)(attempt, this.config.retryDelayMs);
                        await (0, runtimeHelpers_1.delay)(delayMs);
                    }
                    else if (!ce.retryable) {
                        this.circuitBreaker.onFailure();
                        circuitReleased = true;
                        break; // Don't retry permanent errors
                    }
                }
                // All attempts failed
                tracer.recordError(runId, `All ${this.config.maxRetries + 1} attempts failed`, Date.now() - startTime);
                // Record final actual cost for failed run (for estimator learning)
                try {
                    const modelCfg = this.router.getModel(routing.modelId);
                    const totalCostUsd = costEstimator.estimateForModel(ctx, modelCfg !== null && modelCfg !== void 0 ? modelCfg : {
                        id: routing.modelId,
                        provider: routing.provider,
                        tier: routing.tier,
                        costPer1KInput: 0.003,
                        costPer1KOutput: 0.01,
                        capabilities: [],
                        contextWindow: 128000,
                        priority: 0,
                    }).costUsd;
                    costEstimator.recordActualCost(costEstimate.taskCategory, routing.tier, totalTokens.promptTokens, totalTokens.completionTokens, totalCostUsd, Date.now() - startTime, false);
                    // Record model performance failure for cross-session learning
                    this.router.recordOutcome(routing.modelId, costEstimate.taskCategory, false, Date.now() - startTime, totalTokens.totalTokens);
                    try {
                        (0, modelPerformanceStore_1.getModelPerformanceStore)().record({
                            modelId: routing.modelId,
                            taskType: costEstimate.taskCategory,
                            success: false,
                            durationMs: Date.now() - startTime,
                            tokensUsed: totalTokens.totalTokens,
                            timestamp: Date.now(),
                        });
                    }
                    catch {
                        /* best-effort */
                    }
                }
                catch {
                    /* best-effort learning */
                }
                // Fire plugin onError hooks
                (0, pluginManager_1.getHookManager)()
                    .fireOnError({ error: lastError !== null && lastError !== void 0 ? lastError : 'Unknown error', runId, agentId: ctx.agentId })
                    .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'onError hook failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                }));
                this.checkpointer.terminalCheckpoint({
                    runId,
                    agentId: ctx.agentId,
                    missionId: ctx.missionId,
                    timestamp: (0, runtimeHelpers_1.now)(),
                    phase: 'failed',
                    stepNumber: steps.length,
                    attemptNumber: this.config.maxRetries,
                    messages: request.messages,
                    tokenUsage: { ...totalTokens },
                    stepDurations: steps.map((s) => s.durationMs),
                    context: {
                        agentId: ctx.agentId,
                        missionId: ctx.missionId,
                        projectId: ctx.projectId,
                        goal: ctx.goal,
                        availableTools: ctx.availableTools,
                        maxSteps: ctx.maxSteps,
                        tokenBudget: ctx.tokenBudget,
                    },
                    lastError,
                    totalDurationMs: Date.now() - startTime,
                });
                if (this.memory) {
                    try {
                        this.memory.add(`[FAIL] ${ctx.goal.slice(0, 200)}`, 'episodic', `run:${runId}|error:${(lastError !== null && lastError !== void 0 ? lastError : 'unknown').slice(0, 100)}|dur:${Date.now() - startTime}ms`, 0.5 + (lastErrorIsPermanent ? 0.3 : 0), ['execution', 'failure', ...ctx.availableTools.slice(0, 3)], { runId, goal: ctx.goal.slice(0, 500), error: lastError });
                    }
                    catch (e) {
                        (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to record failure memory', {
                            error: e === null || e === void 0 ? void 0 : e.message,
                        });
                    }
                }
                (0, metricsCollector_1.getMetricsCollector)().recordRunComplete('failed', Date.now() - startTime, steps.length, tenantId);
                bus.publish('agent.failed', ctx.agentId, {
                    runId,
                    missionId: ctx.missionId,
                    error: lastError,
                });
                return {
                    runId,
                    agentId: ctx.agentId,
                    missionId: ctx.missionId,
                    status: 'failed',
                    summary: lastError !== null && lastError !== void 0 ? lastError : 'Unknown error',
                    steps,
                    totalTokenUsage: totalTokens,
                    totalDurationMs: Date.now() - startTime,
                    error: lastError,
                };
            });
            // GAP-08: Call scheduler abortRun for failed runs — triggers compensation
            // for any recorded compensable actions and releases the scheduler-level lease.
            // On success, commitRun is called inside the runWithTenant callback (line ~2002).
            if (execResult && execResult.status === 'failed' && this.runHandle) {
                const handle = this.runHandle;
                try {
                    await (0, scheduler_1.getExecutionScheduler)().abortRun({
                        runId,
                        leaseToken: handle.leaseToken,
                        fencingEpoch: handle.fencingEpoch,
                        tenantId: (_g = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _g !== void 0 ? _g : undefined,
                        reason: (_h = execResult.error) !== null && _h !== void 0 ? _h : 'execution failed',
                    });
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Scheduler abortRun failed', {
                        runId,
                        error: e.message,
                    });
                }
            }
            return execResult;
        }
        finally {
            // Release circuit breaker if neither onSuccess nor onFailure was called
            if (!circuitReleased)
                this.circuitBreaker.release();
            // GAP-02 + GAP-05: Guarantee cleanup on ALL exit paths (normal, error, exception)
            this.activeRuns.delete(runId);
            (0, metricsCollector_1.getMetricsCollector)().setGauge('active_runs', 'Active concurrent runs', this.activeRuns.size);
            if ((tenantCfg === null || tenantCfg === void 0 ? void 0 : tenantCfg.enabled) && tenantCfg.maxConcurrency > 0 && tenantId) {
                const c = ((_j = this.tenantRunningCounts.get(tenantId)) !== null && _j !== void 0 ? _j : 1) - 1;
                if (c <= 0)
                    this.tenantRunningCounts.delete(tenantId);
                else
                    this.tenantRunningCounts.set(tenantId, c);
            }
            (0, lane_1.getLaneManager)().releaseSlot(currentLane);
            this.releaseSlot();
            try {
                tracer.completeRun(runId);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to complete trace', {
                    runId,
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
            // Export trace to OpenTelemetry if configured
            if (this.otelExporter) {
                try {
                    const trace = tracer.getTrace(runId);
                    if (trace) {
                        const otelSpans = (0, openTelemetryExporter_1.executionTraceToOtlpSpans)(trace);
                        for (const span of otelSpans) {
                            this.otelExporter.exportSpan(span);
                        }
                    }
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to export OTel spans', {
                        runId,
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
            }
            // Auto-export SOP template on successful execution
            if ((execResult === null || execResult === void 0 ? void 0 : execResult.status) === 'success') {
                try {
                    const trace = tracer.getTrace(runId);
                    if (trace) {
                        const sop = (0, sopExport_1.exportSOPFromTrace)(trace);
                        if (sop) {
                            const sopDir = path.join(this.config.sopDir || '.commander/sops', ctx.agentId);
                            fs.mkdirSync(sopDir, { recursive: true });
                            const sopPath = path.join(sopDir, `${runId}.md`);
                            fs.writeFileSync(sopPath, (0, sopExport_1.formatSOPAsMarkdown)(sop), 'utf-8');
                            // Also write structured JSON for API retrieval
                            const jsonPath = path.join(sopDir, `${runId}.json`);
                            fs.writeFileSync(jsonPath, JSON.stringify(sop, null, 2), 'utf-8');
                            (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'SOP auto-exported', {
                                runId,
                                path: sopPath,
                            });
                            // Publish bus event for SSE streaming and API visibility
                            (0, messageBus_1.getMessageBus)().publish('sop.generated', ctx.agentId, {
                                runId,
                                agentId: ctx.agentId,
                                goal: sop.goal,
                                path: sopPath,
                                stepCount: sop.totalSteps,
                                status: 'success',
                                tags: sop.tags,
                            });
                        }
                    }
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'SOP auto-export failed', {
                        runId,
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
            }
            try {
                await this.samplesStore.flush();
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to flush samples', {
                    runId,
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
            try {
                this.traceStore.flushAll();
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to flush traces', {
                    runId,
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
            this.restoreTenantOverrides(tenantOverrides, tenantId);
        }
    }
    async callWithTimeout(request, routing, attemptNumber = 0, taskId) {
        // Build fallback chain: primary provider first, then all others as backups.
        // ProviderFallbackChain handles circuit-breaker-aware sequential failover.
        const primaryProvider = this.providers.get(routing.provider);
        const entries = [];
        if (primaryProvider) {
            entries.push({
                name: routing.provider,
                attempt: () => this.callProviderOrThrow(primaryProvider, routing.provider, request, attemptNumber, taskId),
            });
        }
        for (const [name, provider] of this.providers) {
            if (name === routing.provider)
                continue;
            entries.push({
                name,
                attempt: () => this.callProviderOrThrow(provider, name, request, attemptNumber, taskId),
            });
        }
        if (entries.length === 0) {
            this.samplesStore.recordLLMCall(request, null, {
                provider: 'none',
                durationMs: 0,
                attemptNumber,
                error: 'No provider available',
            });
            return null;
        }
        try {
            const { result } = await this.fallbackChain.tryProviders(entries);
            return result;
        }
        catch (err) {
            if (err instanceof providerFallbackChain_1.FallbackChainExhaustedError) {
                this.samplesStore.recordLLMCall(request, null, {
                    provider: 'fallback_exhausted',
                    durationMs: 0,
                    attemptNumber,
                    error: err.message,
                });
            }
            (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'All providers exhausted in fallback chain', {
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    }
    /** Thin forwarder that adapts callProvider's nullable return for ProviderFallbackChain.
     *  ProviderFallbackChain treats non-throwing returns as success, so we throw on null. */
    async callProviderOrThrow(provider, providerName, request, attemptNumber, taskId) {
        const result = await this.callProvider(provider, providerName, request, attemptNumber, taskId);
        if (!result) {
            throw new Error(`Provider "${providerName}" returned null (likely timeout or unavailable)`);
        }
        return result;
    }
    async callProvider(provider, providerName, request, attemptNumber, taskId) {
        var _a, _b, _c, _d, _e, _f, _g;
        const startMs = Date.now();
        try {
            const cached = await this.semanticCache.lookup(request);
            if (cached) {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordSemanticCacheEvent('hit', 0, (_a = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _a !== void 0 ? _a : undefined);
                }
                catch {
                    /* best-effort */
                }
                return cached;
            }
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordSemanticCacheEvent('miss', 0, (_b = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _b !== void 0 ? _b : undefined);
            }
            catch {
                /* best-effort */
            }
            // Google Gemini cachedContent wiring: when the provider is Google and the request carries
            // a system prompt, try to attach a server-side cached content name. Failures fall through
            // (cachedContent is a cost optimization, not a correctness requirement).
            if (providerName === 'google' && request.cacheConfig) {
                const systemMsg = request.messages.find((m) => m.role === 'system');
                const tenantForGemini = (_c = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _c !== void 0 ? _c : undefined;
                try {
                    const lookup = await this.geminiCache.getOrCreate({
                        systemInstruction: systemMsg === null || systemMsg === void 0 ? void 0 : systemMsg.content,
                        tools: request.tools,
                        model: request.model,
                        apiKey: (_d = process.env.GOOGLE_API_KEY) !== null && _d !== void 0 ? _d : '',
                        baseUrl: process.env.GOOGLE_BASE_URL,
                        tenantId: tenantForGemini,
                    });
                    if (lookup.cachedContentName) {
                        request.cacheConfig.geminiCachedContentName = lookup.cachedContentName;
                        try {
                            (0, metricsCollector_1.getMetricsCollector)().recordGeminiCacheEvent(lookup.createdNow ? 'create' : 'hit', tenantForGemini);
                        }
                        catch {
                            /* best-effort */
                        }
                    }
                }
                catch {
                    try {
                        (0, metricsCollector_1.getMetricsCollector)().recordGeminiCacheEvent('error', tenantForGemini);
                    }
                    catch {
                        /* best-effort */
                    }
                }
            }
            const tenantIdForFlight = (_e = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _e !== void 0 ? _e : undefined;
            const flightKey = singleFlightRequestCache_1.SingleFlightRequestCache.computeKey(request, tenantIdForFlight);
            const evictionsBefore = this.singleFlight.getStats().evictions;
            const inflightBefore = this.singleFlight.inflightCount();
            let result;
            const llmTimeoutMs = (_f = this.config.llmTimeoutMs) !== null && _f !== void 0 ? _f : 120000;
            result = await this.singleFlight.dedupe(flightKey, async () => {
                return this.stepTimeout.wrap(provider.call(request), {
                    timeoutMs: llmTimeoutMs,
                    stepId: `llm-${providerName}-${attemptNumber}-${taskId !== null && taskId !== void 0 ? taskId : 'main'}`,
                });
            }, tenantIdForFlight);
            const recentEvictionDelta = this.singleFlight.getStats().evictions - evictionsBefore;
            const wasHit = this.singleFlight.inflightCount() === inflightBefore;
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordSingleFlightEvent(wasHit ? 'hit' : 'miss', tenantIdForFlight);
            }
            catch {
                /* best-effort */
            }
            if (recentEvictionDelta > 0) {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordSingleFlightEvent('eviction', tenantIdForFlight);
                }
                catch {
                    /* best-effort */
                }
            }
            this.semanticCache.store(request, result);
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordSemanticCacheEvent('store', 0, (_g = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _g !== void 0 ? _g : undefined);
            }
            catch {
                /* best-effort */
            }
            this.samplesStore.recordLLMCall(request, result, {
                provider: providerName,
                durationMs: Date.now() - startMs,
                attemptNumber,
                taskId,
            });
            return result;
        }
        catch (err) {
            this.samplesStore.recordLLMCall(request, null, {
                provider: providerName,
                durationMs: Date.now() - startMs,
                attemptNumber,
                error: String(err),
                taskId,
            });
            (0, logging_1.getGlobalLogger)().error('AgentRuntime', 'Provider call failed', err);
            return null;
        }
    }
    /** Tier 4.4 helper: estimate cost of a failed step and attribute it to a failure mode. */
    recordCostByFailureMode(mode, response) {
        var _a;
        if (!response)
            return;
        try {
            const costUsd = (0, costEstimator_1.getCostEstimator)().estimateCostFromUsage(response.model, response.usage.promptTokens, response.usage.completionTokens);
            (0, metricsCollector_1.getMetricsCollector)().recordCostByFailureMode(mode, costUsd, (_a = (0, tenantProvider_1.getGlobalTenantProvider)().getCurrentTenantId()) !== null && _a !== void 0 ? _a : undefined);
        }
        catch {
            /* best-effort */
        }
    }
    /**
     * Execute a tool call and return STRUCTURED error context to the model.
     * Instead of silently logging errors, the model receives enough context
     * to reason about the failure and decide next steps.
     */
    async executeTool(runId, toolCall, agentId, tenantId, allowedTools, agentCtx) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t;
        const tracer = (0, executionTrace_1.getTraceRecorder)();
        const bus = (0, messageBus_1.getMessageBus)();
        const startTime = Date.now();
        try {
            // Sub-agent tool whitelist enforcement: if an allowlist is provided,
            // reject any tool call outside the allowed set.
            if (allowedTools && !allowedTools.includes(toolCall.name)) {
                const errorMsg = `TOOL_NOT_ALLOWED: "${toolCall.name}" is not in the allowed tools list for this agent. Allowed: ${allowedTools.join(', ')}`;
                bus.publish('tool.blocked', agentId, {
                    runId,
                    toolName: toolCall.name,
                    reason: 'not_allowed',
                    detail: errorMsg,
                });
                return {
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                    output: errorMsg,
                    error: errorMsg,
                    durationMs: 0,
                };
            }
            const reversibility = this.compensationRegistry.assessReversibility(toolCall.name);
            if (reversibility === 'non_reversible') {
                bus.publish('system.alert', 'runtime', {
                    type: 'non_reversible_tool',
                    tool: toolCall.name,
                    runId,
                    agentId,
                });
            }
            // ── Hook: beforeToolResolve (can block by returning ToolResult) ──
            const resolveBlock = await (0, pluginManager_1.getHookManager)().fireBeforeToolResolve({
                toolName: toolCall.name,
                args: toolCall.arguments,
                agentId,
                runId,
            });
            if (resolveBlock !== null) {
                bus.publish('tool.blocked', agentId, {
                    runId,
                    toolName: toolCall.name,
                    reason: 'hook_blocked',
                    detail: (_a = resolveBlock.error) !== null && _a !== void 0 ? _a : '',
                });
                return resolveBlock;
            }
            const tool = this.tools.get(toolCall.name);
            const toolFound = !!tool;
            // ── Hook: afterToolResolve ──
            (0, pluginManager_1.getHookManager)()
                .fireAfterToolResolve({
                toolName: toolCall.name,
                args: toolCall.arguments,
                tool: tool
                    ? { name: tool.definition.name, category: tool.definition.category }
                    : undefined,
                notFound: !toolFound,
                agentId,
                runId,
            })
                .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'afterToolResolve hook failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            }));
            if (!tool) {
                const error = `TOOL_NOT_FOUND: "${toolCall.name}" is not registered. Available: ${Array.from(this.tools.keys()).join(', ')}`;
                tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', 0, error);
                // Record to DLQ for dead-letter analysis
                this.dlq.record({
                    id: this.generateActionId(),
                    category: 'tool',
                    runId,
                    agentId,
                    timestamp: new Date().toISOString(),
                    errorClass: 'permanent',
                    errorMessage: error,
                    retryable: false,
                    attemptNumber: 0,
                    operationName: toolCall.name,
                    inputSnapshot: JSON.stringify(toolCall.arguments).slice(0, 500),
                    compensated: false,
                    recovered: false,
                    tags: ['tool_not_found', 'mode:1'],
                });
                const errorMsg = `error: ${error}\nadvice: Check the tool name and try again with a registered tool.`;
                return {
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                    output: errorMsg,
                    error: errorMsg,
                    durationMs: 0,
                };
            }
            // Hallucination rejection gate (arXiv:2604.21816):
            // If the tool was not promoted to Tier 1 (full schema), the model shouldn't call it directly.
            // Reject with guidance to use request_tool first. This prevents hallucinated tool calls.
            if (this.promotedTools.size > 0 && !this.promotedTools.has(toolCall.name)) {
                const available = Array.from(this.promotedTools)
                    .filter((n) => n !== 'request_tool')
                    .join(', ');
                const errorMsg = `TOOL_NOT_PROMOTED: "${toolCall.name}" was not in the active tool set for this turn. Use request_tool to load it first, or use one of: ${available}`;
                (0, logging_1.getGlobalLogger)().debug('AgentRuntime', `Hallucination gate: rejected call to non-promoted tool "${toolCall.name}"`);
                return {
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                    output: errorMsg,
                    error: errorMsg,
                    durationMs: 0,
                };
            }
            // Record compensable action for mutation tools before execution
            const isMutation = (0, runtimeHelpers_1.isMutationTool)(toolCall.name);
            const actionId = this.generateActionId();
            if (isMutation) {
                this.compensationRegistry.recordAction({
                    actionId,
                    toolName: toolCall.name,
                    args: toolCall.arguments,
                    description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
                    tags: ['tool', toolCall.name],
                    runId,
                    agentId,
                });
                const filePath = (_b = toolCall.arguments.filePath) !== null && _b !== void 0 ? _b : toolCall.arguments.path;
                if (typeof filePath === 'string' && toolCall.name !== 'file_delete') {
                    try {
                        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                        if (fs.existsSync(filePath)) {
                            fs.copyFileSync(filePath, `${filePath}.atr-snapshot.${actionId}`);
                        }
                    }
                    catch (err) {
                        (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Snapshot pre-mutation failed', {
                            filePath,
                            actionId,
                            error: err.message,
                        });
                    }
                }
            }
            const effectiveTimeout = (_c = tool.timeout) !== null && _c !== void 0 ? _c : this.config.timeoutMs;
            // Validate and repair tool call arguments before execution
            const { args: repairedArgs, repairs } = (0, toolCallRepair_1.repairToolCallArguments)(toolCall.arguments, toolCall.name);
            const schema = (_d = tool.compiledSchema) !== null && _d !== void 0 ? _d : toolRegistry_1.ToolRegistry.getCompiledSchema(toolCall.name);
            let validatedArgs = repairedArgs;
            if (schema) {
                const validation = (0, toolCallValidator_1.validateToolCall)(repairedArgs, schema);
                if (!validation.valid) {
                    const errorFeedback = (0, toolCallValidator_1.formatValidationErrors)(validation.errors, toolCall.name, repairs);
                    const structuredFeedback = (0, toolCallValidator_1.formatValidationErrorsJson)(validation.errors, toolCall.name, (_e = validation.repairs) !== null && _e !== void 0 ? _e : repairs, validation.repairedArgs);
                    structuredFeedback.errors = structuredFeedback.errors.map((e, i) => {
                        var _a, _b;
                        return ({
                            ...e,
                            suggestion: (_b = (_a = e.suggestion) !== null && _a !== void 0 ? _a : (0, toolCallRepair_2.suggestRepairsForValidationErrors)([validation.errors[i]])[0]) !== null && _b !== void 0 ? _b : `Adjust '${e.path}' to match the expected schema.`,
                        });
                    });
                    tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, errorFeedback, 0, errorFeedback);
                    return {
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        output: JSON.stringify(structuredFeedback),
                        error: errorFeedback,
                        durationMs: Date.now() - startTime,
                    };
                }
                validatedArgs = (_f = validation.repairedArgs) !== null && _f !== void 0 ? _f : repairedArgs;
            }
            // C2/Phase 3: Schedule tool call through ExecutionScheduler for idempotency + replay
            let schedulerActionId = null;
            if (this.runHandle) {
                try {
                    const idempotencyKey = (0, canonicalJson_1.generateIdempotencyKey)({
                        externalSystem: (_g = tool.externalSystem) !== null && _g !== void 0 ? _g : toolCall.name,
                        toolName: toolCall.name,
                        args: validatedArgs,
                        intentHash: this.runHandle.intentHash,
                        runId,
                        stepId: (_h = toolCall.id) !== null && _h !== void 0 ? _h : actionId,
                    });
                    const scheduleResult = (0, scheduler_1.getExecutionScheduler)().scheduleAction({
                        runId,
                        leaseToken: this.runHandle.leaseToken,
                        fencingEpoch: this.runHandle.fencingEpoch,
                        toolName: toolCall.name,
                        externalSystem: (_j = tool.externalSystem) !== null && _j !== void 0 ? _j : toolCall.name,
                        args: validatedArgs,
                        idempotencyKey,
                        compensable: isMutation,
                        tags: ['tool_execution', toolCall.name],
                        description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
                        tenantId,
                    });
                    if (scheduleResult) {
                        schedulerActionId = scheduleResult.actionId;
                        if (scheduleResult.replayed) {
                            const durationMs = Date.now() - startTime;
                            const cachedOutput = scheduleResult.cachedResult;
                            if (cachedOutput !== undefined) {
                                tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, cachedOutput, durationMs);
                                (0, metricsCollector_1.getMetricsCollector)().recordToolCall(toolCall.name, durationMs, undefined, tenantId);
                                bus.publish('tool.completed', agentId, {
                                    runId,
                                    toolName: toolCall.name,
                                    durationMs,
                                });
                                return {
                                    toolCallId: toolCall.id,
                                    name: toolCall.name,
                                    output: cachedOutput,
                                    durationMs,
                                };
                            }
                            const cachedError = scheduleResult.cachedError;
                            if (cachedError) {
                                tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', durationMs, cachedError);
                                (0, metricsCollector_1.getMetricsCollector)().recordToolCall(toolCall.name, durationMs, cachedError, tenantId);
                                return {
                                    toolCallId: toolCall.id,
                                    name: toolCall.name,
                                    output: '',
                                    error: cachedError,
                                    durationMs,
                                };
                            }
                        }
                    }
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Scheduler scheduleAction failed; running without ATR ledger', { runId, toolName: toolCall.name, error: e.message });
                }
            }
            // ExecPolicy gate: evaluate shell/Python commands before execution
            // Research backing: Codex CLI command safety classification, Claude Code deny-first evaluation
            if (toolCall.name === 'shell_execute' || toolCall.name === 'python_execute') {
                const command = String((_l = (_k = validatedArgs.command) !== null && _k !== void 0 ? _k : validatedArgs.code) !== null && _l !== void 0 ? _l : '');
                if (command) {
                    try {
                        const { ExecPolicyEngine } = await Promise.resolve().then(() => __importStar(require('../sandbox/execPolicy')));
                        const policy = new ExecPolicyEngine();
                        const decision = policy.evaluate(command);
                        if (decision.decision === 'forbidden') {
                            const errorMsg = `EXEC_POLICY_FORBIDDEN: Command blocked by security policy. Rule: ${(_o = (_m = decision.rule) === null || _m === void 0 ? void 0 : _m.id) !== null && _o !== void 0 ? _o : 'unknown'}. Justification: ${(_q = (_p = decision.rule) === null || _p === void 0 ? void 0 : _p.justification) !== null && _q !== void 0 ? _q : 'dangerous command'}`;
                            bus.publish('tool.blocked', agentId, {
                                runId,
                                toolName: toolCall.name,
                                reason: 'exec_policy_forbidden',
                                detail: errorMsg,
                            });
                            return {
                                toolCallId: toolCall.id,
                                name: toolCall.name,
                                output: errorMsg,
                                error: errorMsg,
                                durationMs: 0,
                            };
                        }
                        if (decision.decision === 'prompt') {
                            // Log the policy decision but allow execution (approval system handles prompting)
                            (0, logging_1.getGlobalLogger)().debug('AgentRuntime', `ExecPolicy: "${command.slice(0, 80)}..." requires approval (rule: ${(_r = decision.rule) === null || _r === void 0 ? void 0 : _r.id})`);
                        }
                    }
                    catch (e) {
                        // Policy engine load failure — proceed without gating (fail-open for availability)
                        (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'ExecPolicy load failed, proceeding without gate', { error: e === null || e === void 0 ? void 0 : e.message });
                    }
                }
            }
            bus.publish('tool.started', agentId, {
                runId,
                toolName: toolCall.name,
                args: toolCall.arguments,
            });
            const boundary = new stepErrorBoundary_1.StepErrorBoundary(runId, agentId, this.dlq, undefined, {
                maxRetries: 1,
                retryDelayMs: this.config.retryDelayMs,
                onExhausted: 'skip',
                onPermanent: 'abort',
            }, this.reflexionGenerator);
            // Guardian security check
            try {
                const intervention = (0, guardianAgent_1.getGuardianAgent)().monitor({
                    agentId,
                    runId,
                    timestamp: Date.now(),
                    type: 'tool_call',
                    content: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
                    metadata: { args: toolCall.arguments },
                });
                if (intervention) {
                    const errorMsg = `GUARDIAN_BLOCKED: ${intervention} by security guardian for ${toolCall.name}`;
                    const durationMs = Date.now() - startTime;
                    bus.publish('tool.blocked', agentId, {
                        runId,
                        toolName: toolCall.name,
                        reason: 'guardian_blocked',
                        detail: errorMsg,
                    });
                    return {
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        output: errorMsg,
                        error: errorMsg,
                        durationMs,
                    };
                }
            }
            catch { /* best-effort */ }
            let latestReflexion = null;
            let lastReflexionAttempt = 0;
            const boundaryResult = await boundary.execute(toolCall.name, 'tool', async () => {
                return this.stepTimeout.wrap(tool.execute(validatedArgs, agentCtx), {
                    timeoutMs: effectiveTimeout,
                    stepId: toolCall.id || toolCall.name,
                });
            }, {
                tags: ['tool_execution', toolCall.name],
                inputSnapshot: JSON.stringify(toolCall.arguments).slice(0, 1000),
                onReflexion: (reflexion, ctx) => {
                    latestReflexion = reflexion;
                    lastReflexionAttempt = ctx.attemptNumber;
                },
            });
            if (boundaryResult.recovered) {
                bus.publish('tool.retry', agentId, {
                    runId,
                    toolName: toolCall.name,
                    attempts: boundaryResult.attempts,
                });
            }
            if (!boundaryResult.success) {
                const durationMs = Date.now() - startTime;
                const errorMsg = (_s = boundaryResult.error) !== null && _s !== void 0 ? _s : 'Unknown tool error';
                tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', durationMs, errorMsg);
                (0, metricsCollector_1.getMetricsCollector)().recordToolCall(toolCall.name, durationMs, errorMsg, tenantId);
                (0, metricsCollector_1.getMetricsCollector)().recordError(boundaryResult.errorClass, tenantId);
                // Detect timeout from both legacy format and StepTimeoutManager
                if (errorMsg.includes('TOOL_TIMEOUT') || errorMsg.includes('exceeded timeout')) {
                    bus.publish('tool.timeout', agentId, {
                        runId,
                        toolName: toolCall.name,
                        timeoutMs: effectiveTimeout,
                        durationMs,
                    });
                }
                // Fire handleMutationToolFailure for mutation tools (generates rollback plan, publishes event, auto-executes safe plans)
                if ((0, runtimeHelpers_1.isMutationTool)(toolCall.name)) {
                    try {
                        await this.handleMutationToolFailure(toolCall.name, toolCall.arguments, errorMsg);
                    }
                    catch (innerErr) {
                        (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'handleMutationToolFailure threw (best-effort)', { actionId, error: innerErr.message });
                    }
                }
                // Compensate side-effects from prior mutation tools in this run
                let compensateResult = await this.compensationRegistry.compensate(actionId);
                if (!compensateResult.success) {
                    compensateResult = await this.compensationRegistry.compensate(actionId);
                }
                if (!compensateResult.success) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Compensation failed after retry', {
                        actionId,
                        error: compensateResult.error,
                    });
                }
                if (schedulerActionId && this.runHandle) {
                    try {
                        (0, scheduler_1.getExecutionScheduler)().recordError({
                            runId,
                            leaseToken: this.runHandle.leaseToken,
                            fencingEpoch: this.runHandle.fencingEpoch,
                            actionId: schedulerActionId,
                            error: errorMsg,
                            tenantId,
                        });
                    }
                    catch (e) {
                        (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Scheduler recordError failed', {
                            runId,
                            toolName: toolCall.name,
                            error: e.message,
                        });
                    }
                }
                const structuredError = [
                    `tool_error: "${toolCall.name}" failed after ${durationMs}ms`,
                    `  reason: ${errorMsg}`,
                    `  errorClass: ${boundaryResult.errorClass}`,
                    `  args: ${JSON.stringify(toolCall.arguments)}`,
                    ...(latestReflexion
                        ? [
                            reflexionGenerator_1.ReflexionGenerator.formatForContext({
                                goal: '',
                                attemptedAction: toolCall.name,
                                actionResult: '',
                                error: errorMsg,
                                errorClass: boundaryResult.errorClass,
                                attemptNumber: lastReflexionAttempt,
                            }, latestReflexion),
                        ]
                        : []),
                    `advice: `,
                    `  - If this is a transient error, retry the call`,
                    `  - If the arguments are invalid, correct them and retry`,
                    `  - If the tool is unavailable, try a different approach`,
                ].join('\n');
                return {
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                    output: '',
                    error: structuredError,
                    durationMs,
                };
            }
            let output = boundaryResult.value;
            const durationMs = Date.now() - startTime;
            // Result budgeting: persist large outputs to disk, return reference
            // Token-aware truncation: keep head (first ~60%) + tail (last ~40%) for maximum informational value.
            // The head preserves context/setup; the tail preserves results/errors.
            const maxSize = (_t = tool.maxOutputSize) !== null && _t !== void 0 ? _t : this.config.observationMaskWindow * 1000;
            if (typeof output === 'string' && output.length > maxSize && maxSize > 0) {
                const hash = crypto.createHash('md5').update(output).digest('hex').slice(0, 8);
                const resultDir = path.join(process.cwd(), '.commander_results');
                try {
                    await fs.promises.mkdir(resultDir, { recursive: true });
                    const resultFile = path.join(resultDir, `${toolCall.name}-${hash}.txt`);
                    await fs.promises.writeFile(resultFile, output, 'utf-8');
                    const headSize = Math.floor(maxSize * 0.6);
                    const tailSize = maxSize - headSize;
                    const head = output.slice(0, headSize);
                    const tail = output.length > headSize ? output.slice(-tailSize) : '';
                    output = `[Large output: ${output.length} chars. Saved to ${resultFile}.]\n${head}\n... [truncated, omitted ${output.length - maxSize} chars] ...\n${tail}\n[End. Full output at ${resultFile}]`;
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to persist large output', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                    // Fall through with truncated output
                    const headSize = Math.floor(maxSize * 0.6);
                    const head = output.slice(0, headSize);
                    const tail = output.length > headSize ? output.slice(-(maxSize - headSize)) : '';
                    output = `${head}\n... [truncated, omitted ${output.length - maxSize} chars] ...\n${tail}`;
                }
            }
            tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, output, durationMs);
            (0, metricsCollector_1.getMetricsCollector)().recordToolCall(toolCall.name, durationMs, undefined, tenantId);
            bus.publish('tool.executed', agentId, { toolName: toolCall.name, durationMs });
            bus.publish('tool.completed', agentId, { runId, toolName: toolCall.name, durationMs });
            if (schedulerActionId && this.runHandle) {
                try {
                    (0, scheduler_1.getExecutionScheduler)().recordResult({
                        runId,
                        leaseToken: this.runHandle.leaseToken,
                        fencingEpoch: this.runHandle.fencingEpoch,
                        actionId: schedulerActionId,
                        result: output,
                        tenantId,
                    });
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'Scheduler recordResult failed', {
                        runId,
                        toolName: toolCall.name,
                        error: e.message,
                    });
                }
            }
            return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: typeof output === 'string' ? output : JSON.stringify(output),
                durationMs,
            };
        }
        finally {
            const durationMs = Date.now() - startTime;
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordStepLatency('tool_execution', durationMs, tenantId);
            }
            catch {
                /* best-effort */
            }
        }
    }
    /** Register default compensation handlers for mutation tools */
    registerDefaultCompensation() {
        const reg = this.compensationRegistry;
        const restoreFromSnapshot = async (action) => {
            var _a;
            const filePath = (_a = action.args.filePath) !== null && _a !== void 0 ? _a : action.args.path;
            if (typeof filePath !== 'string')
                return { success: true };
            const snapshotPath = `${filePath}.atr-snapshot.${action.actionId}`;
            try {
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                if (!fs.existsSync(snapshotPath)) {
                    if (fs.existsSync(filePath))
                        fs.unlinkSync(filePath);
                    return { success: true };
                }
                const original = fs.readFileSync(snapshotPath, 'utf-8');
                fs.writeFileSync(filePath, original, 'utf-8');
                fs.unlinkSync(snapshotPath);
                return { success: true };
            }
            catch (err) {
                return { success: false, error: err.message };
            }
        };
        reg.register('file_write', restoreFromSnapshot);
        reg.register('file_edit', restoreFromSnapshot);
        reg.register('apply_patch', restoreFromSnapshot);
        reg.register('code_fixer', restoreFromSnapshot);
        reg.register('code_refiner', restoreFromSnapshot);
        reg.register('file_delete', restoreFromSnapshot);
        reg.register('mkdir', async (action) => {
            var _a;
            const dir = (_a = action.args.path) !== null && _a !== void 0 ? _a : action.args.dir;
            if (typeof dir !== 'string')
                return { success: true };
            try {
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                    fs.rmdirSync(dir);
                }
                return { success: true };
            }
            catch (err) {
                return { success: false, error: err.message };
            }
        });
        reg.register('memory_store', async (action) => {
            const key = action.args.key;
            if (typeof key !== 'string')
                return { success: true };
            try {
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                const memoryPath = path.join(process.cwd(), '.commander', 'memory.json');
                if (!fs.existsSync(memoryPath))
                    return { success: true };
                const data = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
                const filtered = data.filter((e) => e.key !== key);
                fs.writeFileSync(memoryPath, JSON.stringify(filtered, null, 2), 'utf-8');
                return { success: true };
            }
            catch (err) {
                return { success: false, error: err.message };
            }
        });
    }
    generateActionId() {
        return `act_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    // ---------------------------------------------------------------------------
    // Concurrency semaphore (GAP-07)
    // ---------------------------------------------------------------------------
    async acquireSlot() {
        if (this.runningCount < this.config.maxConcurrency) {
            this.runningCount++;
            return;
        }
        // Wait for a slot to free up
        return new Promise((resolve) => {
            this.waitingQueue.push(() => {
                this.runningCount++;
                resolve();
            });
        });
    }
    releaseSlot() {
        this.runningCount--;
        const next = this.waitingQueue.shift();
        if (next)
            next();
    }
    // ---------------------------------------------------------------------------
    // Auto-resume (GAP-03)
    // ---------------------------------------------------------------------------
    /**
     * List runs that crashed (have checkpoints but no terminal state).
     * Callers can use this to present a resume UI or auto-resume.
     */
    listUnfinishedRuns() {
        return this.checkpointer
            .listCheckpoints()
            .filter((cp) => cp.phase !== 'completed' && cp.phase !== 'failed');
    }
    /** Tier 1.2: Resume a crashed run using the full RunRecovery pipeline.
     *  Validates the lease, reconstructs completedToolCallIds from checkpoint
     *  messages, and returns a result suitable for continuing from the last step.
     *  Returns null if the checkpoint is not found or the lease was lost.
     */
    async resume(runId, tenantId) {
        const recovery = new runRecovery_1.RunRecovery(this.checkpointer, this.leaseManager);
        const result = await recovery.attempt(runId, { tenantId });
        if (result.status === 'not_found' || result.status === 'lease_lost') {
            (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Run recovery failed', {
                runId,
                status: result.status,
            });
            return null;
        }
        (0, logging_1.getGlobalLogger)().info('AgentRuntime', 'Run recovered', {
            runId,
            resumeFromStep: result.resumeFromStep,
            completedToolCalls: result.completedToolCallIds.size,
        });
        return result;
    }
    /** List all runs that have recoverable checkpoints (non-terminal phases). */
    listResumableRuns() {
        return this.checkpointer.listCheckpoints().map((entry) => ({
            runId: entry.runId,
            phase: entry.phase,
            timestamp: entry.timestamp,
        }));
    }
    /**
     * Signal a running execution to pause at the next checkpoint boundary.
     * Returns true if the run was active and pause was signaled, false otherwise.
     */
    pauseRun(runId) {
        if (!this.activeRuns.has(runId)) {
            return false;
        }
        this.pausedRuns.add(runId);
        return true;
    }
    /**
     * Clear the pause flag for a run (e.g., after resume).
     */
    unpauseRun(runId) {
        this.pausedRuns.delete(runId);
    }
    isPaused(runId) {
        return this.pausedRuns.has(runId);
    }
    /**
     * List all active runs with their pause state.
     * Returns an array of { runId, paused, checkpointPhase }.
     */
    getActiveRuns() {
        return Array.from(this.activeRuns).map((runId) => {
            const checkpoint = this.checkpointer.resume(runId);
            return {
                runId,
                paused: this.pausedRuns.has(runId),
                checkpointPhase: checkpoint === null || checkpoint === void 0 ? void 0 : checkpoint.phase,
            };
        });
    }
    getActiveRunCount() {
        return this.activeRuns.size;
    }
    isRunActive(runId) {
        return this.activeRuns.has(runId);
    }
    getSemanticCacheStats() {
        return this.semanticCache.getStats();
    }
    getSingleFlightStats() {
        return this.singleFlight.getStats();
    }
    getGeminiCacheStats() {
        return this.geminiCache.getStats();
    }
    getCostEstimatorHistory() {
        return (0, costEstimator_1.getCostEstimator)().exportHistory();
    }
    /** Tier 4.3: Return a per-provider health snapshot for the dashboard. */
    getProviderHealth() {
        const breakerStats = this.circuitBreaker.getStats();
        const health = [];
        for (const [name] of this.providers) {
            const success = (0, metricsCollector_1.getMetricsCollector)().getCounter('llm_success_total', [
                { name: 'provider', value: name },
            ]);
            const errors = (0, metricsCollector_1.getMetricsCollector)().getCounter('llm_errors_total', [
                { name: 'provider', value: name },
            ]);
            const total = success + errors;
            health.push({
                provider: name,
                state: breakerStats.state,
                errorRate: total > 0 ? errors / total : 0,
                requestCount: total,
                lastFailureAt: breakerStats.lastFailureTime,
            });
        }
        return health;
    }
    /** Dispose sub-resources (timers, file handles) when this runtime is discarded */
    dispose() {
        if (this.queueTimer) {
            clearInterval(this.queueTimer);
            this.queueTimer = null;
        }
        this.toolCache.dispose();
        try {
            (0, modelPerformanceStore_1.getModelPerformanceStore)().dispose();
        }
        catch {
            /* best-effort */
        }
        this.agentInbox.dispose();
        // Shutdown trace store to flush pending buffers
        if (typeof this.traceStore.shutdown === 'function')
            this.traceStore.shutdown();
        // Stop OpenTelemetry exporter if running
        if (this.otelExporter) {
            this.otelExporter.stop().catch((err) => {
                (0, logging_1.getGlobalLogger)().debug('AgentRuntime', 'OTel exporter stop failed (non-critical)', {
                    error: err === null || err === void 0 ? void 0 : err.message,
                });
            });
        }
        // Dispose tenant-scoped stores
        for (const store of this.tenantSamplesStores.values()) {
            try {
                store.flush();
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to flush tenant samples store during dispose', { error: e === null || e === void 0 ? void 0 : e.message });
            }
        }
        for (const store of this.tenantTraceStores.values()) {
            try {
                store.shutdown();
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('AgentRuntime', 'Failed to shutdown tenant trace store during dispose', { error: e === null || e === void 0 ? void 0 : e.message });
            }
        }
        this.tenantSamplesStores.clear();
        this.tenantTraceStores.clear();
        this.tenantCheckpointers.clear();
    }
}
exports.AgentRuntime = AgentRuntime;
function resolveSemanticCache(config) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t;
    const cfg = config.semanticCache;
    if (!(cfg === null || cfg === void 0 ? void 0 : cfg.enabled)) {
        return new semanticCache_1.SemanticCache(new embedding_1.MockEmbeddingFunction(), { enabled: false, pruneIntervalMs: 0 });
    }
    const apiKey = (_a = cfg.openaiApiKey) !== null && _a !== void 0 ? _a : process.env.OPENAI_API_KEY;
    if (!apiKey) {
        // Fall back to local embeddings (no API key needed)
        (0, logging_1.getGlobalLogger)().debug('AgentRuntime', `Semantic cache enabled with local embeddings (threshold=${(_b = cfg.similarityThreshold) !== null && _b !== void 0 ? _b : 0.92}). Set OPENAI_API_KEY for higher-quality OpenAI embeddings.`);
        return new semanticCache_1.SemanticCache(new embedding_1.LocalEmbeddingFunction(), {
            enabled: true,
            similarityThreshold: (_c = cfg.similarityThreshold) !== null && _c !== void 0 ? _c : 0.92,
            maxEntries: (_d = cfg.maxEntries) !== null && _d !== void 0 ? _d : 10000,
            defaultTtlMs: (_e = cfg.defaultTtlMs) !== null && _e !== void 0 ? _e : 86400000,
            maxBucketSize: (_f = cfg.maxBucketSize) !== null && _f !== void 0 ? _f : 64,
            cacheStochastic: (_g = cfg.cacheStochastic) !== null && _g !== void 0 ? _g : false,
            cacheToolCalls: (_h = cfg.cacheToolCalls) !== null && _h !== void 0 ? _h : false,
            pruneIntervalMs: (_j = cfg.pruneIntervalMs) !== null && _j !== void 0 ? _j : 60000,
        });
    }
    (0, logging_1.getGlobalLogger)().debug('AgentRuntime', `Semantic cache enabled with OpenAI embeddings (model=${(_k = cfg.embeddingModel) !== null && _k !== void 0 ? _k : 'text-embedding-3-small'}, threshold=${(_l = cfg.similarityThreshold) !== null && _l !== void 0 ? _l : 0.92})`);
    return new semanticCache_1.SemanticCache(new embedding_1.OpenAIEmbeddingFunction({
        apiKey,
        model: cfg.embeddingModel,
        baseUrl: cfg.embeddingBaseUrl,
    }), {
        enabled: true,
        similarityThreshold: (_m = cfg.similarityThreshold) !== null && _m !== void 0 ? _m : 0.92,
        maxEntries: (_o = cfg.maxEntries) !== null && _o !== void 0 ? _o : 10000,
        defaultTtlMs: (_p = cfg.defaultTtlMs) !== null && _p !== void 0 ? _p : 86400000,
        maxBucketSize: (_q = cfg.maxBucketSize) !== null && _q !== void 0 ? _q : 64,
        cacheStochastic: (_r = cfg.cacheStochastic) !== null && _r !== void 0 ? _r : false,
        cacheToolCalls: (_s = cfg.cacheToolCalls) !== null && _s !== void 0 ? _s : false,
        pruneIntervalMs: (_t = cfg.pruneIntervalMs) !== null && _t !== void 0 ? _t : 60000,
    });
}
function derivePromptCacheKey(ctx, tenantId) {
    var _a, _b;
    const goal = (_a = ctx.goal) !== null && _a !== void 0 ? _a : '';
    let hash = 0;
    for (let i = 0; i < goal.length; i++) {
        hash = ((hash << 5) - hash + goal.charCodeAt(i)) | 0;
    }
    const goalTag = Math.abs(hash).toString(36).slice(0, 12);
    const tenantTag = tenantId !== null && tenantId !== void 0 ? tenantId : 'default';
    const agentTag = (_b = ctx.agentId) !== null && _b !== void 0 ? _b : 'shared';
    return `${tenantTag}:${agentTag}:${goalTag}`.slice(0, 64);
}
