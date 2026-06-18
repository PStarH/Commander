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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommanderAgentLoop = exports.TOOL_CATEGORIES = exports.ToolRegistry = exports.findMatchingMetaSpec = exports.getBuiltinMetaSpecs = exports.MetaTool = exports.createAllTools = exports.ShellExecuteTool = exports.PythonExecuteTool = exports.FileHashEditTool = exports.FileListTool = exports.FileSearchTool = exports.FileEditTool = exports.FileWriteTool = exports.FileReadTool = exports.WebFetchTool = exports.WebSearchTool = exports.DEFAULT_ULTIMATE_CONFIG = exports.DEFAULT_SYNTHESIS_CONFIG = exports.DEFAULT_THINKING_BUDGET = exports.selectTopologyForEffort = exports.classifyEffortLevel = exports.getEffortRules = exports.resetWorkCoordinator = exports.getWorkCoordinator = exports.WorkCoordinator = exports.getTeamManager = exports.AgentTeamManager = exports.getCapabilityRegistry = exports.CapabilityRegistry = exports.resetArtifactSystem = exports.getArtifactSystem = exports.ArtifactSystem = exports.MultiAgentSynthesizer = exports.SubAgentExecutor = exports.TopologyRouter = exports.RecursiveAtomizer = exports.deliberate = exports.UltimateOrchestrator = exports.TokenBudgetAllocator = exports.AdaptiveOrchestrator = exports.QualityGateExecutor = exports.DEFAULT_MODEL_CONFIG = exports.toProjectMemoryItem = exports.fromProjectMemoryItem = exports.createMemoryStore = exports.JsonMemoryStore = exports.InMemoryMemoryStore = exports.calculateOrchestrationMetrics = exports.SequentialPipelineBuilder = void 0;
exports.completeReflection = exports.startReflection = exports.queryMemory = exports.recordMemory = exports.allocateBudget = exports.createExecutionPlan = exports.getFramework = exports.initializeFramework = exports.InspectionError = exports.ConsensusError = exports.MemoryError = exports.BudgetExhaustedError = exports.OrchestrationError = exports.TaskComplexityError = exports.CommanderError = exports.ErrorHandler = exports.getGlobalMetrics = exports.getGlobalLogger = exports.MetricsCollector = exports.Logger = exports.estimateTotalTokens = exports.ContextWindowManager = exports.validateShape = exports.validateStructuredOutput = exports.parseStructuredOutput = exports.createThreeLayerMemory = exports.resetGlobalThreeLayerMemory = exports.getGlobalThreeLayerMemory = exports.ThreeLayerMemory = exports.resetOTelExporter = exports.getOTelExporter = exports.OpenTelemetryExporter = exports.resetWebhookDispatcher = exports.getWebhookDispatcher = exports.WebhookDispatcher = exports.ROLE_HIERARCHY = exports.resetAuthManager = exports.getAuthManager = exports.AuthManager = exports.validateField = exports.validateHttpServerConfig = exports.validateRuntimeConfig = exports.mergeWithDefaults = exports.validateConfig = exports.createSchema = exports.scanToolOutputForInjection = exports.scanContent = exports.createContentScanner = exports.DefaultContentScanner = exports.GoalOrchestrator = void 0;
exports.OllamaProvider = exports.XiaomiProvider = exports.MiMoProvider = exports.GLMProvider = exports.DeepSeekProvider = exports.OpenRouterProvider = exports.GoogleProvider = exports.AnthropicProvider = exports.OpenAIProvider = exports.AgentRuntime = exports.resetTraceRecorder = exports.getTraceRecorder = exports.ExecutionTraceRecorder = exports.resetMessageBus = exports.getMessageBus = exports.MessageBus = exports.resetModelRouter = exports.getModelRouter = exports.ModelRouter = exports.resetMetricsCollector = exports.getMetricsCollector = exports.captureProvenance = exports.decisionsSummary = exports.buildDecisions = exports.getSLOManager = exports.SLOManager = exports.getAnomalyDetector = exports.resetCostEstimator = exports.getCostEstimator = exports.CostEstimator = exports.resetSecurityAuditLogger = exports.getSecurityAuditLogger = exports.SecurityAuditLogger = exports.resetGuardianAgent = exports.getGuardianAgent = exports.GuardianAgent = exports.resetSecurityMonitor = exports.getSecurityMonitor = exports.SecurityMonitor = exports.getHallucinationDetector = exports.HallucinationDetector = exports.resetCredentialManager = exports.getCredentialManager = exports.CredentialManager = exports.ExecPolicyEngine = exports.SandboxManager = exports.getSandboxManager = exports.runInspection = exports.updateComponentHealth = exports.runConsensusCheck = void 0;
exports.createConsensusChecker = exports.ConsensusChecker = exports.getGlobalReflectionEngine = exports.createReflectionEngine = exports.ReflectionEngine = exports.resetEvolverAgent = exports.getEvolverAgent = exports.EvolverAgent = exports.TrajectoryAnalyzer = exports.DEFAULT_META_LEARNER_CONFIG = exports.resetMetaLearner = exports.getMetaLearner = exports.MetaLearner = exports.createWarRoomHTMLReport = exports.getHTMLReportRenderer = exports.HTMLReportRenderer = exports.renderSOPDashboardHtml = exports.getSOPDashboardData = exports.getSOPMarkdown = exports.getSOP = exports.listSOPs = exports.formatSOPAsContext = exports.formatSOPAsMarkdown = exports.exportSOPFromResult = exports.exportSOPFromTrace = exports.isSpeculativelySafe = exports.planSpeculativeExecution = exports.resetPatternTracker = exports.getPatternTracker = exports.PatternTracker = exports.hasInformationGain = exports.isConfidentResponse = exports.getToolCategory = exports.getToolRelevanceScores = exports.selectTools = exports.SSEStream = exports.MCPRemoteRuntime = exports.AgnesProvider = exports.DeepInfraProvider = exports.AnyscaleProvider = exports.XAIProvider = exports.BedrockProvider = exports.ReplicateProvider = exports.FireworksProvider = exports.PerplexityProvider = exports.TogetherProvider = exports.GroqProvider = exports.MistralProvider = exports.CohereProvider = exports.VLLMProvider = void 0;
exports.HookManager = exports.RuntimeWorkflowAdapter = exports.TopologyOptimizer = exports.ToolPlanner = exports.createDefaultRules = exports.maxErrors = exports.requiresTool = exports.notYetUsed = exports.budgetNotCritical = exports.budgetRelaxed = exports.earlySteps = exports.never = exports.always = exports.not = exports.anyOf = exports.allOf = exports.evaluate = exports.ToolAvailabilityManager = exports.ToolOrchestrator = exports.ToolOutputManager = exports.ToolResultCache = exports.isRebuilt = exports.resetRebuildPrompt = exports.getRebuildPrompt = exports.RebuildPrompt = exports.resetGoalJudge = exports.getGoalJudge = exports.GoalJudge = exports.resetCheckpointWriter = exports.getCheckpointWriter = exports.CheckpointWriter = exports.resetTokenBudgetManager = exports.getTokenBudgetManager = exports.TokenBudgetManager = exports.resetTokenGovernor = exports.getTokenGovernor = exports.TokenGovernor = exports.classifyProvisionIntent = exports.detectTaskType = exports.UnifiedVerificationPipeline = exports.BaseChannelAdapter = exports.createHttpServer = exports.CommanderHttpServer = exports.EvolutionaryWorkflowEngine = exports.DEFAULT_APPROVAL_POLICIES = exports.ToolApproval = exports.CycleDetector = exports.TaskComplexityAnalyzer = exports.createInspector = exports.InspectorAgent = void 0;
exports.startSaga = exports.runSaga = exports.SagaBuilderError = exports.SagaBuilder = exports.buildSaga = exports.createSaga = exports.resetPrivacyRouter = exports.getPrivacyRouter = exports.PrivacyRouter = exports.Commander = exports.ReliabilityEngine = exports.getPluginLoader = exports.PluginLoader = exports.DEFAULT_DRIVE_CONFIG = exports.DriveOrchestrator = exports.DEFAULT_SWARM_CONFIG = exports.FusionEngine = exports.SwarmOrchestrator = exports.A2A_METHODS = exports.A2A_ERROR = exports.A2A_PROTOCOL_VERSION = exports.A2A_VERSION_HEADER = exports.AGENT_CARD_WELL_KNOWN_PATH = exports.canTransition = exports.MCP_ERROR_CODES = exports.MCPServer = exports.createMCPClient = exports.StreamableHTTPClientTransport = exports.StdioClientTransport = exports.MCPClient = exports.DEFAULT_EVAL_CRITERIA = exports.EVALUATION_DIMENSIONS = exports.resetHeuristicEvaluator = exports.getHeuristicEvaluator = exports.EvalSuite = exports.HeuristicEvaluator = exports.TELOSOrchestrator = exports.resetProviderPool = exports.getProviderPool = exports.ProviderPool = exports.calculateCost = exports.estimateMessagesTokens = exports.estimateTokenCount = exports.resetTokenSentinel = exports.getTokenSentinel = exports.TokenSentinel = exports.DEFAULT_TELOS_CONFIG = exports.createLoggingPlugin = exports.resetHookManager = exports.getHookManager = void 0;
exports.DEFAULT_IDEMPOTENCY_TTL_SECONDS = exports.DEFAULT_LEASE_TTL_SECONDS = exports.DEFAULT_STEP_TIMEOUT_MS = exports.DEFAULT_RETRY_POLICY = exports.isApprovalNode = exports.isNestedNode = exports.isParallelNode = exports.isStepNode = exports.mergeRetryPolicy = exports.RetryControllerError = exports.RetryController = exports.ApprovalStoreError = exports.FileApprovalStore = exports.InMemoryApprovalStore = exports.ApprovalError = exports.ApprovalManager = exports.defaultCompensationRetryPolicy = exports.CompensationSchedulerError = exports.CompensationScheduler = exports.WorkerPoolError = exports.WorkerPool = exports.InProcessWorkerPool = exports.FileSagaStore = exports.InMemorySagaStore = exports.CheckpointError = exports.CheckpointManager = exports.ExecutionGraphError = exports.ExecutionGraph = exports.attachSagaHandle = exports.SagaAbortedError = exports.SagaNodeError = exports.SagaCoordinatorError = exports.SagaCoordinator = void 0;
/**
 * Commander — Public API Surface
 *
 * Re-exports all public types, interfaces, and classes.
 */
__exportStar(require("./models"), exports);
// Orchestration exports
var orchestration_1 = require("./orchestration");
Object.defineProperty(exports, "SequentialPipelineBuilder", { enumerable: true, get: function () { return orchestration_1.SequentialPipelineBuilder; } });
Object.defineProperty(exports, "calculateOrchestrationMetrics", { enumerable: true, get: function () { return orchestration_1.calculateOrchestrationMetrics; } });
// Memory exports
var memory_1 = require("./memory");
Object.defineProperty(exports, "InMemoryMemoryStore", { enumerable: true, get: function () { return memory_1.InMemoryMemoryStore; } });
Object.defineProperty(exports, "JsonMemoryStore", { enumerable: true, get: function () { return memory_1.JsonMemoryStore; } });
Object.defineProperty(exports, "createMemoryStore", { enumerable: true, get: function () { return memory_1.createMemoryStore; } });
Object.defineProperty(exports, "fromProjectMemoryItem", { enumerable: true, get: function () { return memory_1.fromProjectMemoryItem; } });
Object.defineProperty(exports, "toProjectMemoryItem", { enumerable: true, get: function () { return memory_1.toProjectMemoryItem; } });
// Ultimate Framework exports (legacy)
var ultimate_1 = require("./ultimate");
Object.defineProperty(exports, "DEFAULT_MODEL_CONFIG", { enumerable: true, get: function () { return ultimate_1.DEFAULT_MODEL_CONFIG; } });
Object.defineProperty(exports, "QualityGateExecutor", { enumerable: true, get: function () { return ultimate_1.QualityGateExecutor; } });
var adaptiveOrchestrator_1 = require("./adaptiveOrchestrator");
Object.defineProperty(exports, "AdaptiveOrchestrator", { enumerable: true, get: function () { return adaptiveOrchestrator_1.AdaptiveOrchestrator; } });
var tokenBudgetAllocator_1 = require("./tokenBudgetAllocator");
Object.defineProperty(exports, "TokenBudgetAllocator", { enumerable: true, get: function () { return tokenBudgetAllocator_1.TokenBudgetAllocator; } });
// Ultimate Multi-Agent Orchestration System (v2)
var index_1 = require("./ultimate/index");
Object.defineProperty(exports, "UltimateOrchestrator", { enumerable: true, get: function () { return index_1.UltimateOrchestrator; } });
Object.defineProperty(exports, "deliberate", { enumerable: true, get: function () { return index_1.deliberate; } });
Object.defineProperty(exports, "RecursiveAtomizer", { enumerable: true, get: function () { return index_1.RecursiveAtomizer; } });
Object.defineProperty(exports, "TopologyRouter", { enumerable: true, get: function () { return index_1.TopologyRouter; } });
Object.defineProperty(exports, "SubAgentExecutor", { enumerable: true, get: function () { return index_1.SubAgentExecutor; } });
Object.defineProperty(exports, "MultiAgentSynthesizer", { enumerable: true, get: function () { return index_1.MultiAgentSynthesizer; } });
Object.defineProperty(exports, "ArtifactSystem", { enumerable: true, get: function () { return index_1.ArtifactSystem; } });
Object.defineProperty(exports, "getArtifactSystem", { enumerable: true, get: function () { return index_1.getArtifactSystem; } });
Object.defineProperty(exports, "resetArtifactSystem", { enumerable: true, get: function () { return index_1.resetArtifactSystem; } });
Object.defineProperty(exports, "CapabilityRegistry", { enumerable: true, get: function () { return index_1.CapabilityRegistry; } });
Object.defineProperty(exports, "getCapabilityRegistry", { enumerable: true, get: function () { return index_1.getCapabilityRegistry; } });
Object.defineProperty(exports, "AgentTeamManager", { enumerable: true, get: function () { return index_1.AgentTeamManager; } });
Object.defineProperty(exports, "getTeamManager", { enumerable: true, get: function () { return index_1.getTeamManager; } });
Object.defineProperty(exports, "WorkCoordinator", { enumerable: true, get: function () { return index_1.WorkCoordinator; } });
Object.defineProperty(exports, "getWorkCoordinator", { enumerable: true, get: function () { return index_1.getWorkCoordinator; } });
Object.defineProperty(exports, "resetWorkCoordinator", { enumerable: true, get: function () { return index_1.resetWorkCoordinator; } });
Object.defineProperty(exports, "getEffortRules", { enumerable: true, get: function () { return index_1.getEffortRules; } });
Object.defineProperty(exports, "classifyEffortLevel", { enumerable: true, get: function () { return index_1.classifyEffortLevel; } });
Object.defineProperty(exports, "selectTopologyForEffort", { enumerable: true, get: function () { return index_1.selectTopologyForEffort; } });
var index_2 = require("./ultimate/index");
Object.defineProperty(exports, "DEFAULT_THINKING_BUDGET", { enumerable: true, get: function () { return index_2.DEFAULT_THINKING_BUDGET; } });
Object.defineProperty(exports, "DEFAULT_SYNTHESIS_CONFIG", { enumerable: true, get: function () { return index_2.DEFAULT_SYNTHESIS_CONFIG; } });
Object.defineProperty(exports, "DEFAULT_ULTIMATE_CONFIG", { enumerable: true, get: function () { return index_2.DEFAULT_ULTIMATE_CONFIG; } });
// Tools — Web Search, File System, Code Execution
var index_3 = require("./tools/index");
Object.defineProperty(exports, "WebSearchTool", { enumerable: true, get: function () { return index_3.WebSearchTool; } });
Object.defineProperty(exports, "WebFetchTool", { enumerable: true, get: function () { return index_3.WebFetchTool; } });
Object.defineProperty(exports, "FileReadTool", { enumerable: true, get: function () { return index_3.FileReadTool; } });
Object.defineProperty(exports, "FileWriteTool", { enumerable: true, get: function () { return index_3.FileWriteTool; } });
Object.defineProperty(exports, "FileEditTool", { enumerable: true, get: function () { return index_3.FileEditTool; } });
Object.defineProperty(exports, "FileSearchTool", { enumerable: true, get: function () { return index_3.FileSearchTool; } });
Object.defineProperty(exports, "FileListTool", { enumerable: true, get: function () { return index_3.FileListTool; } });
Object.defineProperty(exports, "FileHashEditTool", { enumerable: true, get: function () { return index_3.FileHashEditTool; } });
Object.defineProperty(exports, "PythonExecuteTool", { enumerable: true, get: function () { return index_3.PythonExecuteTool; } });
Object.defineProperty(exports, "ShellExecuteTool", { enumerable: true, get: function () { return index_3.ShellExecuteTool; } });
Object.defineProperty(exports, "createAllTools", { enumerable: true, get: function () { return index_3.createAllTools; } });
Object.defineProperty(exports, "MetaTool", { enumerable: true, get: function () { return index_3.MetaTool; } });
Object.defineProperty(exports, "getBuiltinMetaSpecs", { enumerable: true, get: function () { return index_3.getBuiltinMetaSpecs; } });
Object.defineProperty(exports, "findMatchingMetaSpec", { enumerable: true, get: function () { return index_3.findMatchingMetaSpec; } });
Object.defineProperty(exports, "ToolRegistry", { enumerable: true, get: function () { return index_3.ToolRegistry; } });
Object.defineProperty(exports, "TOOL_CATEGORIES", { enumerable: true, get: function () { return index_3.TOOL_CATEGORIES; } });
// Agent Loop — Persistent multi-agent execution
var agentLoop_1 = require("./agentLoop");
Object.defineProperty(exports, "CommanderAgentLoop", { enumerable: true, get: function () { return agentLoop_1.CommanderAgentLoop; } });
// Goal module — multi-agent goal-driven execution loop
var goalOrchestrator_1 = require("./goal/goalOrchestrator");
Object.defineProperty(exports, "GoalOrchestrator", { enumerable: true, get: function () { return goalOrchestrator_1.GoalOrchestrator; } });
// ContentScanner exports - Agent Security Layer
var contentScanner_1 = require("./contentScanner");
Object.defineProperty(exports, "DefaultContentScanner", { enumerable: true, get: function () { return contentScanner_1.DefaultContentScanner; } });
Object.defineProperty(exports, "createContentScanner", { enumerable: true, get: function () { return contentScanner_1.createContentScanner; } });
Object.defineProperty(exports, "scanContent", { enumerable: true, get: function () { return contentScanner_1.scanContent; } });
Object.defineProperty(exports, "scanToolOutputForInjection", { enumerable: true, get: function () { return contentScanner_1.scanToolOutputForInjection; } });
// Configuration Validation
var configValidator_1 = require("./runtime/configValidator");
Object.defineProperty(exports, "createSchema", { enumerable: true, get: function () { return configValidator_1.createSchema; } });
Object.defineProperty(exports, "validateConfig", { enumerable: true, get: function () { return configValidator_1.validateConfig; } });
Object.defineProperty(exports, "mergeWithDefaults", { enumerable: true, get: function () { return configValidator_1.mergeWithDefaults; } });
Object.defineProperty(exports, "validateRuntimeConfig", { enumerable: true, get: function () { return configValidator_1.validateRuntimeConfig; } });
Object.defineProperty(exports, "validateHttpServerConfig", { enumerable: true, get: function () { return configValidator_1.validateHttpServerConfig; } });
Object.defineProperty(exports, "validateField", { enumerable: true, get: function () { return configValidator_1.validateField; } });
// Authentication & Authorization
var authManager_1 = require("./runtime/authManager");
Object.defineProperty(exports, "AuthManager", { enumerable: true, get: function () { return authManager_1.AuthManager; } });
Object.defineProperty(exports, "getAuthManager", { enumerable: true, get: function () { return authManager_1.getAuthManager; } });
Object.defineProperty(exports, "resetAuthManager", { enumerable: true, get: function () { return authManager_1.resetAuthManager; } });
Object.defineProperty(exports, "ROLE_HIERARCHY", { enumerable: true, get: function () { return authManager_1.ROLE_HIERARCHY; } });
// Webhook Dispatcher
var webhookDispatcher_1 = require("./runtime/webhookDispatcher");
Object.defineProperty(exports, "WebhookDispatcher", { enumerable: true, get: function () { return webhookDispatcher_1.WebhookDispatcher; } });
Object.defineProperty(exports, "getWebhookDispatcher", { enumerable: true, get: function () { return webhookDispatcher_1.getWebhookDispatcher; } });
Object.defineProperty(exports, "resetWebhookDispatcher", { enumerable: true, get: function () { return webhookDispatcher_1.resetWebhookDispatcher; } });
// OpenTelemetry Exporter
var openTelemetryExporter_1 = require("./runtime/openTelemetryExporter");
Object.defineProperty(exports, "OpenTelemetryExporter", { enumerable: true, get: function () { return openTelemetryExporter_1.OpenTelemetryExporter; } });
Object.defineProperty(exports, "getOTelExporter", { enumerable: true, get: function () { return openTelemetryExporter_1.getOTelExporter; } });
Object.defineProperty(exports, "resetOTelExporter", { enumerable: true, get: function () { return openTelemetryExporter_1.resetOTelExporter; } });
// ThreeLayerMemory
var threeLayerMemory_1 = require("./threeLayerMemory");
Object.defineProperty(exports, "ThreeLayerMemory", { enumerable: true, get: function () { return threeLayerMemory_1.ThreeLayerMemory; } });
Object.defineProperty(exports, "getGlobalThreeLayerMemory", { enumerable: true, get: function () { return threeLayerMemory_1.getGlobalThreeLayerMemory; } });
Object.defineProperty(exports, "resetGlobalThreeLayerMemory", { enumerable: true, get: function () { return threeLayerMemory_1.resetGlobalThreeLayerMemory; } });
Object.defineProperty(exports, "createThreeLayerMemory", { enumerable: true, get: function () { return threeLayerMemory_1.createThreeLayerMemory; } });
// Logging & Metrics
var structuredOutput_1 = require("./runtime/structuredOutput");
Object.defineProperty(exports, "parseStructuredOutput", { enumerable: true, get: function () { return structuredOutput_1.parseStructuredOutput; } });
Object.defineProperty(exports, "validateStructuredOutput", { enumerable: true, get: function () { return structuredOutput_1.validateStructuredOutput; } });
Object.defineProperty(exports, "validateShape", { enumerable: true, get: function () { return structuredOutput_1.validateShape; } });
var contextWindow_1 = require("./runtime/contextWindow");
Object.defineProperty(exports, "ContextWindowManager", { enumerable: true, get: function () { return contextWindow_1.ContextWindowManager; } });
Object.defineProperty(exports, "estimateTotalTokens", { enumerable: true, get: function () { return contextWindow_1.estimateTotalTokens; } });
var logging_1 = require("./logging");
Object.defineProperty(exports, "Logger", { enumerable: true, get: function () { return logging_1.Logger; } });
Object.defineProperty(exports, "MetricsCollector", { enumerable: true, get: function () { return logging_1.MetricsCollector; } });
Object.defineProperty(exports, "getGlobalLogger", { enumerable: true, get: function () { return logging_1.getGlobalLogger; } });
Object.defineProperty(exports, "getGlobalMetrics", { enumerable: true, get: function () { return logging_1.getGlobalMetrics; } });
// Error Handler
var errorHandler_1 = require("./errorHandler");
Object.defineProperty(exports, "ErrorHandler", { enumerable: true, get: function () { return errorHandler_1.ErrorHandler; } });
Object.defineProperty(exports, "CommanderError", { enumerable: true, get: function () { return errorHandler_1.CommanderError; } });
Object.defineProperty(exports, "TaskComplexityError", { enumerable: true, get: function () { return errorHandler_1.TaskComplexityError; } });
Object.defineProperty(exports, "OrchestrationError", { enumerable: true, get: function () { return errorHandler_1.OrchestrationError; } });
Object.defineProperty(exports, "BudgetExhaustedError", { enumerable: true, get: function () { return errorHandler_1.BudgetExhaustedError; } });
Object.defineProperty(exports, "MemoryError", { enumerable: true, get: function () { return errorHandler_1.MemoryError; } });
Object.defineProperty(exports, "ConsensusError", { enumerable: true, get: function () { return errorHandler_1.ConsensusError; } });
Object.defineProperty(exports, "InspectionError", { enumerable: true, get: function () { return errorHandler_1.InspectionError; } });
var frameworkIntegration_1 = require("./frameworkIntegration");
Object.defineProperty(exports, "initializeFramework", { enumerable: true, get: function () { return frameworkIntegration_1.initializeFramework; } });
Object.defineProperty(exports, "getFramework", { enumerable: true, get: function () { return frameworkIntegration_1.getFramework; } });
Object.defineProperty(exports, "createExecutionPlan", { enumerable: true, get: function () { return frameworkIntegration_1.createExecutionPlan; } });
Object.defineProperty(exports, "allocateBudget", { enumerable: true, get: function () { return frameworkIntegration_1.allocateBudget; } });
Object.defineProperty(exports, "recordMemory", { enumerable: true, get: function () { return frameworkIntegration_1.recordMemory; } });
Object.defineProperty(exports, "queryMemory", { enumerable: true, get: function () { return frameworkIntegration_1.queryMemory; } });
Object.defineProperty(exports, "startReflection", { enumerable: true, get: function () { return frameworkIntegration_1.startReflection; } });
Object.defineProperty(exports, "completeReflection", { enumerable: true, get: function () { return frameworkIntegration_1.completeReflection; } });
Object.defineProperty(exports, "runConsensusCheck", { enumerable: true, get: function () { return frameworkIntegration_1.runConsensusCheck; } });
Object.defineProperty(exports, "updateComponentHealth", { enumerable: true, get: function () { return frameworkIntegration_1.updateComponentHealth; } });
Object.defineProperty(exports, "runInspection", { enumerable: true, get: function () { return frameworkIntegration_1.runInspection; } });
// Shell & Runner exports
var sandbox_1 = require("./sandbox");
Object.defineProperty(exports, "getSandboxManager", { enumerable: true, get: function () { return sandbox_1.getSandboxManager; } });
Object.defineProperty(exports, "SandboxManager", { enumerable: true, get: function () { return sandbox_1.SandboxManager; } });
Object.defineProperty(exports, "ExecPolicyEngine", { enumerable: true, get: function () { return sandbox_1.ExecPolicyEngine; } });
// Credential Manager
var credentialManager_1 = require("./runtime/credentialManager");
Object.defineProperty(exports, "CredentialManager", { enumerable: true, get: function () { return credentialManager_1.CredentialManager; } });
Object.defineProperty(exports, "getCredentialManager", { enumerable: true, get: function () { return credentialManager_1.getCredentialManager; } });
Object.defineProperty(exports, "resetCredentialManager", { enumerable: true, get: function () { return credentialManager_1.resetCredentialManager; } });
// Hallucination Detector
var hallucinationDetector_1 = require("./hallucinationDetector");
Object.defineProperty(exports, "HallucinationDetector", { enumerable: true, get: function () { return hallucinationDetector_1.HallucinationDetector; } });
Object.defineProperty(exports, "getHallucinationDetector", { enumerable: true, get: function () { return hallucinationDetector_1.getHallucinationDetector; } });
// Security Subsystem
var securityMonitor_1 = require("./security/securityMonitor");
Object.defineProperty(exports, "SecurityMonitor", { enumerable: true, get: function () { return securityMonitor_1.SecurityMonitor; } });
Object.defineProperty(exports, "getSecurityMonitor", { enumerable: true, get: function () { return securityMonitor_1.getSecurityMonitor; } });
Object.defineProperty(exports, "resetSecurityMonitor", { enumerable: true, get: function () { return securityMonitor_1.resetSecurityMonitor; } });
var guardianAgent_1 = require("./security/guardianAgent");
Object.defineProperty(exports, "GuardianAgent", { enumerable: true, get: function () { return guardianAgent_1.GuardianAgent; } });
Object.defineProperty(exports, "getGuardianAgent", { enumerable: true, get: function () { return guardianAgent_1.getGuardianAgent; } });
Object.defineProperty(exports, "resetGuardianAgent", { enumerable: true, get: function () { return guardianAgent_1.resetGuardianAgent; } });
var securityAuditLogger_1 = require("./security/securityAuditLogger");
Object.defineProperty(exports, "SecurityAuditLogger", { enumerable: true, get: function () { return securityAuditLogger_1.SecurityAuditLogger; } });
Object.defineProperty(exports, "getSecurityAuditLogger", { enumerable: true, get: function () { return securityAuditLogger_1.getSecurityAuditLogger; } });
Object.defineProperty(exports, "resetSecurityAuditLogger", { enumerable: true, get: function () { return securityAuditLogger_1.resetSecurityAuditLogger; } });
// Cost Estimation
var costEstimator_1 = require("./runtime/costEstimator");
Object.defineProperty(exports, "CostEstimator", { enumerable: true, get: function () { return costEstimator_1.CostEstimator; } });
Object.defineProperty(exports, "getCostEstimator", { enumerable: true, get: function () { return costEstimator_1.getCostEstimator; } });
Object.defineProperty(exports, "resetCostEstimator", { enumerable: true, get: function () { return costEstimator_1.resetCostEstimator; } });
// Anomaly Detection
var anomalyDetector_1 = require("./observability/anomalyDetector");
Object.defineProperty(exports, "getAnomalyDetector", { enumerable: true, get: function () { return anomalyDetector_1.getAnomalyDetector; } });
// SLO Management
var sloManager_1 = require("./observability/sloManager");
Object.defineProperty(exports, "SLOManager", { enumerable: true, get: function () { return sloManager_1.SLOManager; } });
Object.defineProperty(exports, "getSLOManager", { enumerable: true, get: function () { return sloManager_1.getSLOManager; } });
// Decision Provenance
var decisionProvenance_1 = require("./observability/decisionProvenance");
Object.defineProperty(exports, "buildDecisions", { enumerable: true, get: function () { return decisionProvenance_1.buildDecisions; } });
Object.defineProperty(exports, "decisionsSummary", { enumerable: true, get: function () { return decisionProvenance_1.decisionsSummary; } });
// Execution Provenance
var provenance_1 = require("./runtime/provenance");
Object.defineProperty(exports, "captureProvenance", { enumerable: true, get: function () { return provenance_1.captureProvenance; } });
// Metrics (from metricsCollector, not the logging re-export)
var metricsCollector_1 = require("./runtime/metricsCollector");
Object.defineProperty(exports, "getMetricsCollector", { enumerable: true, get: function () { return metricsCollector_1.getMetricsCollector; } });
Object.defineProperty(exports, "resetMetricsCollector", { enumerable: true, get: function () { return metricsCollector_1.resetMetricsCollector; } });
var runtime_1 = require("./runtime");
Object.defineProperty(exports, "ModelRouter", { enumerable: true, get: function () { return runtime_1.ModelRouter; } });
Object.defineProperty(exports, "getModelRouter", { enumerable: true, get: function () { return runtime_1.getModelRouter; } });
Object.defineProperty(exports, "resetModelRouter", { enumerable: true, get: function () { return runtime_1.resetModelRouter; } });
Object.defineProperty(exports, "MessageBus", { enumerable: true, get: function () { return runtime_1.MessageBus; } });
Object.defineProperty(exports, "getMessageBus", { enumerable: true, get: function () { return runtime_1.getMessageBus; } });
Object.defineProperty(exports, "resetMessageBus", { enumerable: true, get: function () { return runtime_1.resetMessageBus; } });
Object.defineProperty(exports, "ExecutionTraceRecorder", { enumerable: true, get: function () { return runtime_1.ExecutionTraceRecorder; } });
Object.defineProperty(exports, "getTraceRecorder", { enumerable: true, get: function () { return runtime_1.getTraceRecorder; } });
Object.defineProperty(exports, "resetTraceRecorder", { enumerable: true, get: function () { return runtime_1.resetTraceRecorder; } });
Object.defineProperty(exports, "AgentRuntime", { enumerable: true, get: function () { return runtime_1.AgentRuntime; } });
Object.defineProperty(exports, "OpenAIProvider", { enumerable: true, get: function () { return runtime_1.OpenAIProvider; } });
Object.defineProperty(exports, "AnthropicProvider", { enumerable: true, get: function () { return runtime_1.AnthropicProvider; } });
Object.defineProperty(exports, "GoogleProvider", { enumerable: true, get: function () { return runtime_1.GoogleProvider; } });
Object.defineProperty(exports, "OpenRouterProvider", { enumerable: true, get: function () { return runtime_1.OpenRouterProvider; } });
Object.defineProperty(exports, "DeepSeekProvider", { enumerable: true, get: function () { return runtime_1.DeepSeekProvider; } });
Object.defineProperty(exports, "GLMProvider", { enumerable: true, get: function () { return runtime_1.GLMProvider; } });
Object.defineProperty(exports, "MiMoProvider", { enumerable: true, get: function () { return runtime_1.MiMoProvider; } });
Object.defineProperty(exports, "XiaomiProvider", { enumerable: true, get: function () { return runtime_1.XiaomiProvider; } });
Object.defineProperty(exports, "OllamaProvider", { enumerable: true, get: function () { return runtime_1.OllamaProvider; } });
Object.defineProperty(exports, "VLLMProvider", { enumerable: true, get: function () { return runtime_1.VLLMProvider; } });
Object.defineProperty(exports, "CohereProvider", { enumerable: true, get: function () { return runtime_1.CohereProvider; } });
Object.defineProperty(exports, "MistralProvider", { enumerable: true, get: function () { return runtime_1.MistralProvider; } });
Object.defineProperty(exports, "GroqProvider", { enumerable: true, get: function () { return runtime_1.GroqProvider; } });
Object.defineProperty(exports, "TogetherProvider", { enumerable: true, get: function () { return runtime_1.TogetherProvider; } });
Object.defineProperty(exports, "PerplexityProvider", { enumerable: true, get: function () { return runtime_1.PerplexityProvider; } });
Object.defineProperty(exports, "FireworksProvider", { enumerable: true, get: function () { return runtime_1.FireworksProvider; } });
Object.defineProperty(exports, "ReplicateProvider", { enumerable: true, get: function () { return runtime_1.ReplicateProvider; } });
Object.defineProperty(exports, "BedrockProvider", { enumerable: true, get: function () { return runtime_1.BedrockProvider; } });
Object.defineProperty(exports, "XAIProvider", { enumerable: true, get: function () { return runtime_1.XAIProvider; } });
Object.defineProperty(exports, "AnyscaleProvider", { enumerable: true, get: function () { return runtime_1.AnyscaleProvider; } });
Object.defineProperty(exports, "DeepInfraProvider", { enumerable: true, get: function () { return runtime_1.DeepInfraProvider; } });
Object.defineProperty(exports, "AgnesProvider", { enumerable: true, get: function () { return runtime_1.AgnesProvider; } });
Object.defineProperty(exports, "MCPRemoteRuntime", { enumerable: true, get: function () { return runtime_1.MCPRemoteRuntime; } });
Object.defineProperty(exports, "SSEStream", { enumerable: true, get: function () { return runtime_1.SSEStream; } });
Object.defineProperty(exports, "selectTools", { enumerable: true, get: function () { return runtime_1.selectTools; } });
Object.defineProperty(exports, "getToolRelevanceScores", { enumerable: true, get: function () { return runtime_1.getToolRelevanceScores; } });
Object.defineProperty(exports, "getToolCategory", { enumerable: true, get: function () { return runtime_1.getToolCategory; } });
Object.defineProperty(exports, "isConfidentResponse", { enumerable: true, get: function () { return runtime_1.isConfidentResponse; } });
Object.defineProperty(exports, "hasInformationGain", { enumerable: true, get: function () { return runtime_1.hasInformationGain; } });
Object.defineProperty(exports, "PatternTracker", { enumerable: true, get: function () { return runtime_1.PatternTracker; } });
Object.defineProperty(exports, "getPatternTracker", { enumerable: true, get: function () { return runtime_1.getPatternTracker; } });
Object.defineProperty(exports, "resetPatternTracker", { enumerable: true, get: function () { return runtime_1.resetPatternTracker; } });
Object.defineProperty(exports, "planSpeculativeExecution", { enumerable: true, get: function () { return runtime_1.planSpeculativeExecution; } });
Object.defineProperty(exports, "isSpeculativelySafe", { enumerable: true, get: function () { return runtime_1.isSpeculativelySafe; } });
// SOP generation & dashboard
Object.defineProperty(exports, "exportSOPFromTrace", { enumerable: true, get: function () { return runtime_1.exportSOPFromTrace; } });
Object.defineProperty(exports, "exportSOPFromResult", { enumerable: true, get: function () { return runtime_1.exportSOPFromResult; } });
Object.defineProperty(exports, "formatSOPAsMarkdown", { enumerable: true, get: function () { return runtime_1.formatSOPAsMarkdown; } });
Object.defineProperty(exports, "formatSOPAsContext", { enumerable: true, get: function () { return runtime_1.formatSOPAsContext; } });
Object.defineProperty(exports, "listSOPs", { enumerable: true, get: function () { return runtime_1.listSOPs; } });
Object.defineProperty(exports, "getSOP", { enumerable: true, get: function () { return runtime_1.getSOP; } });
Object.defineProperty(exports, "getSOPMarkdown", { enumerable: true, get: function () { return runtime_1.getSOPMarkdown; } });
Object.defineProperty(exports, "getSOPDashboardData", { enumerable: true, get: function () { return runtime_1.getSOPDashboardData; } });
Object.defineProperty(exports, "renderSOPDashboardHtml", { enumerable: true, get: function () { return runtime_1.renderSOPDashboardHtml; } });
// HTML Reporting
var reporting_1 = require("./reporting");
Object.defineProperty(exports, "HTMLReportRenderer", { enumerable: true, get: function () { return reporting_1.HTMLReportRenderer; } });
Object.defineProperty(exports, "getHTMLReportRenderer", { enumerable: true, get: function () { return reporting_1.getHTMLReportRenderer; } });
Object.defineProperty(exports, "createWarRoomHTMLReport", { enumerable: true, get: function () { return reporting_1.createWarRoomHTMLReport; } });
// Self-Evolution Engine — Meta-learning & optimization
var metaLearner_1 = require("./selfEvolution/metaLearner");
Object.defineProperty(exports, "MetaLearner", { enumerable: true, get: function () { return metaLearner_1.MetaLearner; } });
Object.defineProperty(exports, "getMetaLearner", { enumerable: true, get: function () { return metaLearner_1.getMetaLearner; } });
Object.defineProperty(exports, "resetMetaLearner", { enumerable: true, get: function () { return metaLearner_1.resetMetaLearner; } });
Object.defineProperty(exports, "DEFAULT_META_LEARNER_CONFIG", { enumerable: true, get: function () { return metaLearner_1.DEFAULT_META_LEARNER_CONFIG; } });
var trajectoryAnalyzer_1 = require("./selfEvolution/trajectoryAnalyzer");
Object.defineProperty(exports, "TrajectoryAnalyzer", { enumerable: true, get: function () { return trajectoryAnalyzer_1.TrajectoryAnalyzer; } });
var evolverAgent_1 = require("./selfEvolution/evolverAgent");
Object.defineProperty(exports, "EvolverAgent", { enumerable: true, get: function () { return evolverAgent_1.EvolverAgent; } });
Object.defineProperty(exports, "getEvolverAgent", { enumerable: true, get: function () { return evolverAgent_1.getEvolverAgent; } });
Object.defineProperty(exports, "resetEvolverAgent", { enumerable: true, get: function () { return evolverAgent_1.resetEvolverAgent; } });
var reflectionEngine_1 = require("./reflectionEngine");
Object.defineProperty(exports, "ReflectionEngine", { enumerable: true, get: function () { return reflectionEngine_1.ReflectionEngine; } });
Object.defineProperty(exports, "createReflectionEngine", { enumerable: true, get: function () { return reflectionEngine_1.createReflectionEngine; } });
Object.defineProperty(exports, "getGlobalReflectionEngine", { enumerable: true, get: function () { return reflectionEngine_1.getGlobalReflectionEngine; } });
var consensusCheck_1 = require("./consensusCheck");
Object.defineProperty(exports, "ConsensusChecker", { enumerable: true, get: function () { return consensusCheck_1.ConsensusChecker; } });
Object.defineProperty(exports, "createConsensusChecker", { enumerable: true, get: function () { return consensusCheck_1.createConsensusChecker; } });
var inspectorAgent_1 = require("./inspectorAgent");
Object.defineProperty(exports, "InspectorAgent", { enumerable: true, get: function () { return inspectorAgent_1.InspectorAgent; } });
Object.defineProperty(exports, "createInspector", { enumerable: true, get: function () { return inspectorAgent_1.createInspector; } });
var taskComplexityAnalyzer_1 = require("./taskComplexityAnalyzer");
Object.defineProperty(exports, "TaskComplexityAnalyzer", { enumerable: true, get: function () { return taskComplexityAnalyzer_1.TaskComplexityAnalyzer; } });
// Runtime Enhancements — Agent Execution Improvements
var cycleDetector_1 = require("./runtime/cycleDetector");
Object.defineProperty(exports, "CycleDetector", { enumerable: true, get: function () { return cycleDetector_1.CycleDetector; } });
var toolApproval_1 = require("./runtime/toolApproval");
Object.defineProperty(exports, "ToolApproval", { enumerable: true, get: function () { return toolApproval_1.ToolApproval; } });
Object.defineProperty(exports, "DEFAULT_APPROVAL_POLICIES", { enumerable: true, get: function () { return toolApproval_1.DEFAULT_APPROVAL_POLICIES; } });
var evolutionaryWorkflowEngine_1 = require("./runtime/evolutionaryWorkflowEngine");
Object.defineProperty(exports, "EvolutionaryWorkflowEngine", { enumerable: true, get: function () { return evolutionaryWorkflowEngine_1.EvolutionaryWorkflowEngine; } });
var httpServer_1 = require("./runtime/httpServer");
Object.defineProperty(exports, "CommanderHttpServer", { enumerable: true, get: function () { return httpServer_1.CommanderHttpServer; } });
Object.defineProperty(exports, "createHttpServer", { enumerable: true, get: function () { return httpServer_1.createHttpServer; } });
var channelAdapter_1 = require("./runtime/channelAdapter");
Object.defineProperty(exports, "BaseChannelAdapter", { enumerable: true, get: function () { return channelAdapter_1.BaseChannelAdapter; } });
// Unified Verification Pipeline
var unifiedVerification_1 = require("./runtime/unifiedVerification");
Object.defineProperty(exports, "UnifiedVerificationPipeline", { enumerable: true, get: function () { return unifiedVerification_1.UnifiedVerificationPipeline; } });
var taskAnalyzer_1 = require("./runtime/taskAnalyzer");
Object.defineProperty(exports, "detectTaskType", { enumerable: true, get: function () { return taskAnalyzer_1.detectTaskType; } });
Object.defineProperty(exports, "classifyProvisionIntent", { enumerable: true, get: function () { return taskAnalyzer_1.classifyProvisionIntent; } });
// Token Budget Governor
var tokenGovernor_1 = require("./runtime/tokenGovernor");
Object.defineProperty(exports, "TokenGovernor", { enumerable: true, get: function () { return tokenGovernor_1.TokenGovernor; } });
Object.defineProperty(exports, "getTokenGovernor", { enumerable: true, get: function () { return tokenGovernor_1.getTokenGovernor; } });
Object.defineProperty(exports, "resetTokenGovernor", { enumerable: true, get: function () { return tokenGovernor_1.resetTokenGovernor; } });
// Token Budget Manager — per-run proportional sub-agent allocation
var tokenBudgetManager_1 = require("./runtime/tokenBudgetManager");
Object.defineProperty(exports, "TokenBudgetManager", { enumerable: true, get: function () { return tokenBudgetManager_1.TokenBudgetManager; } });
Object.defineProperty(exports, "getTokenBudgetManager", { enumerable: true, get: function () { return tokenBudgetManager_1.getTokenBudgetManager; } });
Object.defineProperty(exports, "resetTokenBudgetManager", { enumerable: true, get: function () { return tokenBudgetManager_1.resetTokenBudgetManager; } });
// Checkpoint Writer — MiMo-style independent checkpoint sub-agent
var checkpointWriter_1 = require("./runtime/checkpointWriter");
Object.defineProperty(exports, "CheckpointWriter", { enumerable: true, get: function () { return checkpointWriter_1.CheckpointWriter; } });
Object.defineProperty(exports, "getCheckpointWriter", { enumerable: true, get: function () { return checkpointWriter_1.getCheckpointWriter; } });
Object.defineProperty(exports, "resetCheckpointWriter", { enumerable: true, get: function () { return checkpointWriter_1.resetCheckpointWriter; } });
// Goal Judge — Independent judge model for verifying task completion
var goalJudge_1 = require("./runtime/goalJudge");
Object.defineProperty(exports, "GoalJudge", { enumerable: true, get: function () { return goalJudge_1.GoalJudge; } });
Object.defineProperty(exports, "getGoalJudge", { enumerable: true, get: function () { return goalJudge_1.getGoalJudge; } });
Object.defineProperty(exports, "resetGoalJudge", { enumerable: true, get: function () { return goalJudge_1.resetGoalJudge; } });
// Rebuild Prompt — Layer 5: complete context window reset + reconstruction
var rebuildPrompt_1 = require("./runtime/rebuildPrompt");
Object.defineProperty(exports, "RebuildPrompt", { enumerable: true, get: function () { return rebuildPrompt_1.RebuildPrompt; } });
Object.defineProperty(exports, "getRebuildPrompt", { enumerable: true, get: function () { return rebuildPrompt_1.getRebuildPrompt; } });
Object.defineProperty(exports, "resetRebuildPrompt", { enumerable: true, get: function () { return rebuildPrompt_1.resetRebuildPrompt; } });
Object.defineProperty(exports, "isRebuilt", { enumerable: true, get: function () { return rebuildPrompt_1.isRebuilt; } });
// Tool Calling Infrastructure
var toolResultCache_1 = require("./runtime/toolResultCache");
Object.defineProperty(exports, "ToolResultCache", { enumerable: true, get: function () { return toolResultCache_1.ToolResultCache; } });
var toolOutputManager_1 = require("./runtime/toolOutputManager");
Object.defineProperty(exports, "ToolOutputManager", { enumerable: true, get: function () { return toolOutputManager_1.ToolOutputManager; } });
var toolOrchestrator_1 = require("./runtime/toolOrchestrator");
Object.defineProperty(exports, "ToolOrchestrator", { enumerable: true, get: function () { return toolOrchestrator_1.ToolOrchestrator; } });
var toolAvailability_1 = require("./runtime/toolAvailability");
Object.defineProperty(exports, "ToolAvailabilityManager", { enumerable: true, get: function () { return toolAvailability_1.ToolAvailabilityManager; } });
Object.defineProperty(exports, "evaluate", { enumerable: true, get: function () { return toolAvailability_1.evaluate; } });
Object.defineProperty(exports, "allOf", { enumerable: true, get: function () { return toolAvailability_1.allOf; } });
Object.defineProperty(exports, "anyOf", { enumerable: true, get: function () { return toolAvailability_1.anyOf; } });
Object.defineProperty(exports, "not", { enumerable: true, get: function () { return toolAvailability_1.not; } });
Object.defineProperty(exports, "always", { enumerable: true, get: function () { return toolAvailability_1.always; } });
Object.defineProperty(exports, "never", { enumerable: true, get: function () { return toolAvailability_1.never; } });
Object.defineProperty(exports, "earlySteps", { enumerable: true, get: function () { return toolAvailability_1.earlySteps; } });
Object.defineProperty(exports, "budgetRelaxed", { enumerable: true, get: function () { return toolAvailability_1.budgetRelaxed; } });
Object.defineProperty(exports, "budgetNotCritical", { enumerable: true, get: function () { return toolAvailability_1.budgetNotCritical; } });
Object.defineProperty(exports, "notYetUsed", { enumerable: true, get: function () { return toolAvailability_1.notYetUsed; } });
Object.defineProperty(exports, "requiresTool", { enumerable: true, get: function () { return toolAvailability_1.requiresTool; } });
Object.defineProperty(exports, "maxErrors", { enumerable: true, get: function () { return toolAvailability_1.maxErrors; } });
Object.defineProperty(exports, "createDefaultRules", { enumerable: true, get: function () { return toolAvailability_1.createDefaultRules; } });
var toolPlanner_1 = require("./runtime/toolPlanner");
Object.defineProperty(exports, "ToolPlanner", { enumerable: true, get: function () { return toolPlanner_1.ToolPlanner; } });
// Topology & Workflow Optimization
var topologyOptimizer_1 = require("./ultimate/topologyOptimizer");
Object.defineProperty(exports, "TopologyOptimizer", { enumerable: true, get: function () { return topologyOptimizer_1.ReflexionTopologicalOptimizer; } });
var runtimeWorkflowAdapter_1 = require("./ultimate/runtimeWorkflowAdapter");
Object.defineProperty(exports, "RuntimeWorkflowAdapter", { enumerable: true, get: function () { return runtimeWorkflowAdapter_1.RuntimeWorkflowAdapter; } });
// Plugin System — Hooks & Extensions
var pluginManager_1 = require("./pluginManager");
Object.defineProperty(exports, "HookManager", { enumerable: true, get: function () { return pluginManager_1.HookManager; } });
Object.defineProperty(exports, "getHookManager", { enumerable: true, get: function () { return pluginManager_1.getHookManager; } });
Object.defineProperty(exports, "resetHookManager", { enumerable: true, get: function () { return pluginManager_1.resetHookManager; } });
Object.defineProperty(exports, "createLoggingPlugin", { enumerable: true, get: function () { return pluginManager_1.createLoggingPlugin; } });
var types_1 = require("./telos/types");
Object.defineProperty(exports, "DEFAULT_TELOS_CONFIG", { enumerable: true, get: function () { return types_1.DEFAULT_TELOS_CONFIG; } });
var telos_1 = require("./telos");
Object.defineProperty(exports, "TokenSentinel", { enumerable: true, get: function () { return telos_1.TokenSentinel; } });
Object.defineProperty(exports, "getTokenSentinel", { enumerable: true, get: function () { return telos_1.getTokenSentinel; } });
Object.defineProperty(exports, "resetTokenSentinel", { enumerable: true, get: function () { return telos_1.resetTokenSentinel; } });
Object.defineProperty(exports, "estimateTokenCount", { enumerable: true, get: function () { return telos_1.estimateTokenCount; } });
Object.defineProperty(exports, "estimateMessagesTokens", { enumerable: true, get: function () { return telos_1.estimateMessagesTokens; } });
Object.defineProperty(exports, "calculateCost", { enumerable: true, get: function () { return telos_1.calculateCost; } });
Object.defineProperty(exports, "ProviderPool", { enumerable: true, get: function () { return telos_1.ProviderPool; } });
Object.defineProperty(exports, "getProviderPool", { enumerable: true, get: function () { return telos_1.getProviderPool; } });
Object.defineProperty(exports, "resetProviderPool", { enumerable: true, get: function () { return telos_1.resetProviderPool; } });
Object.defineProperty(exports, "TELOSOrchestrator", { enumerable: true, get: function () { return telos_1.TELOSOrchestrator; } });
Object.defineProperty(exports, "HeuristicEvaluator", { enumerable: true, get: function () { return telos_1.HeuristicEvaluator; } });
Object.defineProperty(exports, "EvalSuite", { enumerable: true, get: function () { return telos_1.EvalSuite; } });
Object.defineProperty(exports, "getHeuristicEvaluator", { enumerable: true, get: function () { return telos_1.getHeuristicEvaluator; } });
Object.defineProperty(exports, "resetHeuristicEvaluator", { enumerable: true, get: function () { return telos_1.resetHeuristicEvaluator; } });
Object.defineProperty(exports, "EVALUATION_DIMENSIONS", { enumerable: true, get: function () { return telos_1.EVALUATION_DIMENSIONS; } });
Object.defineProperty(exports, "DEFAULT_EVAL_CRITERIA", { enumerable: true, get: function () { return telos_1.DEFAULT_EVAL_CRITERIA; } });
var mcp_1 = require("./mcp");
Object.defineProperty(exports, "MCPClient", { enumerable: true, get: function () { return mcp_1.MCPClient; } });
Object.defineProperty(exports, "StdioClientTransport", { enumerable: true, get: function () { return mcp_1.StdioClientTransport; } });
Object.defineProperty(exports, "StreamableHTTPClientTransport", { enumerable: true, get: function () { return mcp_1.StreamableHTTPClientTransport; } });
Object.defineProperty(exports, "createMCPClient", { enumerable: true, get: function () { return mcp_1.createMCPClient; } });
Object.defineProperty(exports, "MCPServer", { enumerable: true, get: function () { return mcp_1.MCPServer; } });
Object.defineProperty(exports, "MCP_ERROR_CODES", { enumerable: true, get: function () { return mcp_1.MCP_ERROR_CODES; } });
Object.defineProperty(exports, "canTransition", { enumerable: true, get: function () { return mcp_1.canTransition; } });
Object.defineProperty(exports, "AGENT_CARD_WELL_KNOWN_PATH", { enumerable: true, get: function () { return mcp_1.AGENT_CARD_WELL_KNOWN_PATH; } });
Object.defineProperty(exports, "A2A_VERSION_HEADER", { enumerable: true, get: function () { return mcp_1.A2A_VERSION_HEADER; } });
Object.defineProperty(exports, "A2A_PROTOCOL_VERSION", { enumerable: true, get: function () { return mcp_1.A2A_PROTOCOL_VERSION; } });
Object.defineProperty(exports, "A2A_ERROR", { enumerable: true, get: function () { return mcp_1.A2A_ERROR; } });
Object.defineProperty(exports, "A2A_METHODS", { enumerable: true, get: function () { return mcp_1.A2A_METHODS; } });
var swarm_1 = require("./swarm");
Object.defineProperty(exports, "SwarmOrchestrator", { enumerable: true, get: function () { return swarm_1.SwarmOrchestrator; } });
Object.defineProperty(exports, "FusionEngine", { enumerable: true, get: function () { return swarm_1.FusionEngine; } });
Object.defineProperty(exports, "DEFAULT_SWARM_CONFIG", { enumerable: true, get: function () { return swarm_1.DEFAULT_SWARM_CONFIG; } });
var drive_1 = require("./drive");
Object.defineProperty(exports, "DriveOrchestrator", { enumerable: true, get: function () { return drive_1.DriveOrchestrator; } });
Object.defineProperty(exports, "DEFAULT_DRIVE_CONFIG", { enumerable: true, get: function () { return drive_1.DEFAULT_DRIVE_CONFIG; } });
// Experimental — not yet wired into the main execution flow
var pluginLoader_1 = require("./pluginLoader");
Object.defineProperty(exports, "PluginLoader", { enumerable: true, get: function () { return pluginLoader_1.PluginLoader; } });
Object.defineProperty(exports, "getPluginLoader", { enumerable: true, get: function () { return pluginLoader_1.getPluginLoader; } });
// Reliability Engine — Unified resilience facade (circuit breaker + DLQ + compensation + checkpoints)
var reliabilityEngine_1 = require("./runtime/reliabilityEngine");
Object.defineProperty(exports, "ReliabilityEngine", { enumerable: true, get: function () { return reliabilityEngine_1.ReliabilityEngine; } });
// Commander Core — tiered auto-configuration control center (recommended entry)
var commander_1 = require("./commander");
Object.defineProperty(exports, "Commander", { enumerable: true, get: function () { return commander_1.Commander; } });
// PrivacyRouter — Sensitive content detection + local model fallback
var privacyRouter_1 = require("./runtime/privacyRouter");
Object.defineProperty(exports, "PrivacyRouter", { enumerable: true, get: function () { return privacyRouter_1.PrivacyRouter; } });
Object.defineProperty(exports, "getPrivacyRouter", { enumerable: true, get: function () { return privacyRouter_1.getPrivacyRouter; } });
Object.defineProperty(exports, "resetPrivacyRouter", { enumerable: true, get: function () { return privacyRouter_1.resetPrivacyRouter; } });
// Saga Runtime — durable compensating transactions
var saga_1 = require("./saga");
Object.defineProperty(exports, "createSaga", { enumerable: true, get: function () { return saga_1.createSaga; } });
Object.defineProperty(exports, "buildSaga", { enumerable: true, get: function () { return saga_1.buildSaga; } });
Object.defineProperty(exports, "SagaBuilder", { enumerable: true, get: function () { return saga_1.SagaBuilder; } });
Object.defineProperty(exports, "SagaBuilderError", { enumerable: true, get: function () { return saga_1.SagaBuilderError; } });
Object.defineProperty(exports, "runSaga", { enumerable: true, get: function () { return saga_1.runSaga; } });
Object.defineProperty(exports, "startSaga", { enumerable: true, get: function () { return saga_1.startSaga; } });
Object.defineProperty(exports, "SagaCoordinator", { enumerable: true, get: function () { return saga_1.SagaCoordinator; } });
Object.defineProperty(exports, "SagaCoordinatorError", { enumerable: true, get: function () { return saga_1.SagaCoordinatorError; } });
Object.defineProperty(exports, "SagaNodeError", { enumerable: true, get: function () { return saga_1.SagaNodeError; } });
Object.defineProperty(exports, "SagaAbortedError", { enumerable: true, get: function () { return saga_1.SagaAbortedError; } });
Object.defineProperty(exports, "attachSagaHandle", { enumerable: true, get: function () { return saga_1.attachSagaHandle; } });
Object.defineProperty(exports, "ExecutionGraph", { enumerable: true, get: function () { return saga_1.ExecutionGraph; } });
Object.defineProperty(exports, "ExecutionGraphError", { enumerable: true, get: function () { return saga_1.ExecutionGraphError; } });
Object.defineProperty(exports, "CheckpointManager", { enumerable: true, get: function () { return saga_1.CheckpointManager; } });
Object.defineProperty(exports, "CheckpointError", { enumerable: true, get: function () { return saga_1.CheckpointError; } });
Object.defineProperty(exports, "InMemorySagaStore", { enumerable: true, get: function () { return saga_1.InMemorySagaStore; } });
Object.defineProperty(exports, "FileSagaStore", { enumerable: true, get: function () { return saga_1.FileSagaStore; } });
Object.defineProperty(exports, "InProcessWorkerPool", { enumerable: true, get: function () { return saga_1.InProcessWorkerPool; } });
Object.defineProperty(exports, "WorkerPool", { enumerable: true, get: function () { return saga_1.WorkerPool; } });
Object.defineProperty(exports, "WorkerPoolError", { enumerable: true, get: function () { return saga_1.WorkerPoolError; } });
Object.defineProperty(exports, "CompensationScheduler", { enumerable: true, get: function () { return saga_1.CompensationScheduler; } });
Object.defineProperty(exports, "CompensationSchedulerError", { enumerable: true, get: function () { return saga_1.CompensationSchedulerError; } });
Object.defineProperty(exports, "defaultCompensationRetryPolicy", { enumerable: true, get: function () { return saga_1.defaultCompensationRetryPolicy; } });
Object.defineProperty(exports, "ApprovalManager", { enumerable: true, get: function () { return saga_1.ApprovalManager; } });
Object.defineProperty(exports, "ApprovalError", { enumerable: true, get: function () { return saga_1.ApprovalError; } });
Object.defineProperty(exports, "InMemoryApprovalStore", { enumerable: true, get: function () { return saga_1.InMemoryApprovalStore; } });
Object.defineProperty(exports, "FileApprovalStore", { enumerable: true, get: function () { return saga_1.FileApprovalStore; } });
Object.defineProperty(exports, "ApprovalStoreError", { enumerable: true, get: function () { return saga_1.ApprovalStoreError; } });
Object.defineProperty(exports, "RetryController", { enumerable: true, get: function () { return saga_1.RetryController; } });
Object.defineProperty(exports, "RetryControllerError", { enumerable: true, get: function () { return saga_1.RetryControllerError; } });
Object.defineProperty(exports, "mergeRetryPolicy", { enumerable: true, get: function () { return saga_1.mergeRetryPolicy; } });
Object.defineProperty(exports, "isStepNode", { enumerable: true, get: function () { return saga_1.isStepNode; } });
Object.defineProperty(exports, "isParallelNode", { enumerable: true, get: function () { return saga_1.isParallelNode; } });
Object.defineProperty(exports, "isNestedNode", { enumerable: true, get: function () { return saga_1.isNestedNode; } });
Object.defineProperty(exports, "isApprovalNode", { enumerable: true, get: function () { return saga_1.isApprovalNode; } });
var saga_2 = require("./saga");
Object.defineProperty(exports, "DEFAULT_RETRY_POLICY", { enumerable: true, get: function () { return saga_2.DEFAULT_RETRY_POLICY; } });
Object.defineProperty(exports, "DEFAULT_STEP_TIMEOUT_MS", { enumerable: true, get: function () { return saga_2.DEFAULT_STEP_TIMEOUT_MS; } });
Object.defineProperty(exports, "DEFAULT_LEASE_TTL_SECONDS", { enumerable: true, get: function () { return saga_2.DEFAULT_LEASE_TTL_SECONDS; } });
Object.defineProperty(exports, "DEFAULT_IDEMPOTENCY_TTL_SECONDS", { enumerable: true, get: function () { return saga_2.DEFAULT_IDEMPOTENCY_TTL_SECONDS; } });
