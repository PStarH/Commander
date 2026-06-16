/**
 * Commander — Public API Surface
 *
 * Re-exports all public types, interfaces, and classes.
 */
export * from './models';

// Orchestration exports
export {
  SequentialStep, SequentialContext, SequentialStepResult,
  SequentialPipelineStatus, SequentialPipeline, SequentialPipelineRun,
  SequentialEvent, SequentialEventHandler, SequentialPipelineBuilder,
  OrchestrationMetrics, calculateOrchestrationMetrics, TokenUsage,
} from './orchestration';

// Memory exports
export {
  MemoryPriority, EpisodicMemoryItem, MemorySearchQuery,
  MemorySearchResult, MemoryWriteOptions, MemoryManageOptions,
  MemoryStats, MemoryStore, InMemoryMemoryStore, JsonMemoryStore,
  createMemoryStore, fromProjectMemoryItem, toProjectMemoryItem,
} from './memory';

// Ultimate Framework exports (legacy)
export {
  OrchestrationMode, OrchestrationDecision, TokenBudgetAllocation,
  ModelTierConfig, DEFAULT_MODEL_CONFIG,
  AllocatedBudget, QualityGate, QualityGateExecutor, QualityGateResult,
} from './ultimate';
export { AdaptiveOrchestrator } from './adaptiveOrchestrator';
export { TokenBudgetAllocator } from './tokenBudgetAllocator';

// Ultimate Multi-Agent Orchestration System (v2)
export {
  UltimateOrchestrator, deliberate, RecursiveAtomizer,
  TopologyRouter, SubAgentExecutor, MultiAgentSynthesizer,
  ArtifactSystem, getArtifactSystem, resetArtifactSystem,
  CapabilityRegistry, getCapabilityRegistry,
  AgentTeamManager, getTeamManager,
  WorkCoordinator, getWorkCoordinator, resetWorkCoordinator,
  getEffortRules, classifyEffortLevel, selectTopologyForEffort,
} from './ultimate/index';

export type {
  OrchestrationTopology, TaskDAG, TaskDAGNode, TaskDAGEdge,
  DeliberationPlan, TaskTreeNode, ArtifactReference,
  AgentTeam, TeamMember, SharedTask, InboxMessage,
  CapabilityVector, AgentCapability, EffortLevel, EffortScalingRules,
  ThinkingBudget, SynthesisStrategy, SynthesisConfig, QualityGateConfig,
  UltimateExecutionContext, UltimateExecutionResult, UltimateMetrics,
  ExecutionError, UltimateOrchestratorConfig,
  WorkItem, WorkStatus, WorkEvent, WorkEventHandler,
  EnqueueInput, ClaimFilter, TeamStatus,
} from './ultimate/index';

export {
  DEFAULT_THINKING_BUDGET, DEFAULT_SYNTHESIS_CONFIG, DEFAULT_ULTIMATE_CONFIG,
} from './ultimate/index';

// Tools — Web Search, File System, Code Execution
export {
  WebSearchTool, WebFetchTool, FileReadTool, FileWriteTool,
  FileEditTool, FileSearchTool, FileListTool,
  FileHashEditTool,
  PythonExecuteTool, ShellExecuteTool,
  createAllTools, MetaTool,
  getBuiltinMetaSpecs, findMatchingMetaSpec,
  ToolRegistry, TOOL_CATEGORIES,
} from './tools/index';
export type {
  MetaToolSpec, MetaToolStep, AgentDef,
} from './tools/index';

// Agent Loop — Persistent multi-agent execution
export { CommanderAgentLoop } from './agentLoop';
export type { AgentLoopConfig } from './agentLoop';

// Goal module — multi-agent goal-driven execution loop
export { GoalOrchestrator } from './goal/goalOrchestrator';
export type {
  GoalNode, GoalConfig, GoalResult, RoundLedger, RoundDecision,
  ManagerDecomposition, ManagerReview, CriticOutput,
  CritiqueResult, CritiqueFinding, CritiqueCategory,
} from './goal/types';

// ContentScanner exports - Agent Security Layer
export {
  ContentScanner, DefaultContentScanner, createContentScanner, scanContent, scanToolOutputForInjection,
} from './contentScanner';

// Configuration Validation
export {
  createSchema, validateConfig, mergeWithDefaults,
  validateRuntimeConfig, validateHttpServerConfig, validateField,
} from './runtime/configValidator';
export type {
  FieldType, ConfigField, ConfigSchema, ConfigValidationResult, ConfigValidationError,
} from './runtime/configValidator';

// Authentication & Authorization
export {
  AuthManager, getAuthManager, resetAuthManager, ROLE_HIERARCHY,
} from './runtime/authManager';
export type {
  AuthRole, AuthUser, ApiKeyEntry,
} from './runtime/authManager';

// Webhook Dispatcher
export {
  WebhookDispatcher, getWebhookDispatcher, resetWebhookDispatcher,
} from './runtime/webhookDispatcher';
export type {
  WebhookConfig, WebhookEvent, WebhookDelivery,
} from './runtime/webhookDispatcher';

// OpenTelemetry Exporter
export {
  OpenTelemetryExporter, getOTelExporter, resetOTelExporter,
} from './runtime/openTelemetryExporter';
export type {
  OTelExporterConfig, OTelSpan,
} from './runtime/openTelemetryExporter';

// ThreeLayerMemory
export { ThreeLayerMemory, getGlobalThreeLayerMemory, resetGlobalThreeLayerMemory, createThreeLayerMemory } from './threeLayerMemory';

// Logging & Metrics
export {
  parseStructuredOutput, validateStructuredOutput, validateShape,
} from './runtime/structuredOutput';
export {
  ContextWindowManager, estimateTotalTokens,
} from './runtime/contextWindow';
export type {
  ContextWindowConfig, WindowAction,
} from './runtime/contextWindow';

export {
  Logger, MetricsCollector, getGlobalLogger, getGlobalMetrics,
} from './logging';

// Error Handler
export {
  ErrorHandler, CommanderError, TaskComplexityError,
  OrchestrationError, BudgetExhaustedError, MemoryError,
  ConsensusError, InspectionError,
} from './errorHandler';

export {
  initializeFramework, getFramework, createExecutionPlan,
  allocateBudget, recordMemory, queryMemory,
  startReflection, completeReflection, runConsensusCheck,
  updateComponentHealth, runInspection,
} from './frameworkIntegration';

// Shell & Runner exports
export {
  getSandboxManager,
  SandboxManager,
  ExecPolicyEngine,
} from './sandbox';
export type {
  SandboxMode, SandboxProfile, SandboxMechanism, NetworkPolicy,
  FileAccessPolicy, SandboxExecutionResult, PlatformSandbox,
} from './sandbox';

// Credential Manager
export {
  CredentialManager, getCredentialManager, resetCredentialManager,
} from './runtime/credentialManager';

// Hallucination Detector
export {
  HallucinationDetector, getHallucinationDetector,
} from './hallucinationDetector';

export type {
  HallucinationSignal, HallucinationReport,
} from './hallucinationDetector';

// Security Subsystem
export {
  SecurityMonitor, getSecurityMonitor, resetSecurityMonitor,
} from './security/securityMonitor';
export {
  GuardianAgent, getGuardianAgent, resetGuardianAgent,
} from './security/guardianAgent';
export {
  SecurityAuditLogger, getSecurityAuditLogger, resetSecurityAuditLogger,
} from './security/securityAuditLogger';

// Cost Estimation
export {
  CostEstimator, getCostEstimator, resetCostEstimator,
} from './runtime/costEstimator';
export type { CostEstimatorConfig } from './runtime/costEstimator';

// Anomaly Detection
export {
  getAnomalyDetector,
} from './observability/anomalyDetector';

// SLO Management
export {
  SLOManager, getSLOManager,
} from './observability/sloManager';

// Decision Provenance
export {
  buildDecisions, decisionsSummary,
} from './observability/decisionProvenance';

// Execution Provenance
export {
  captureProvenance,
} from './runtime/provenance';

// Metrics (from metricsCollector, not the logging re-export)
export {
  getMetricsCollector, resetMetricsCollector,
} from './runtime/metricsCollector';

// Runtime System — Agent Execution Engine
export type {
  LLMMessage, LLMRequest, LLMResponse, LLMProvider,
  CacheConfig, CacheUsage, ToolDefinition, ToolCall, ToolResult, Tool,
  ModelTier, ModelConfig, RoutingDecision,
  AgentExecutionContext, AgentExecutionStep, AgentExecutionResult, AgentRuntimeConfig,
  MessageBusTopic,   MessagePriority as BusMessagePriority,
  BusMessage, MessageHandler,
  TraceEvent, ExecutionTrace,
  HTMLReportSection, HTMLReport,
  ExecutionExperience, OptimizationSuggestion, StrategyPerformance,
} from './runtime/types';
export {
  ModelRouter, getModelRouter, resetModelRouter,
  MessageBus, getMessageBus, resetMessageBus,
  ExecutionTraceRecorder, getTraceRecorder, resetTraceRecorder,
  AgentRuntime,
  OpenAIProvider, AnthropicProvider, GoogleProvider,
  OpenRouterProvider, DeepSeekProvider, GLMProvider,
  MiMoProvider, XiaomiProvider, OllamaProvider, VLLMProvider,
  CohereProvider, MistralProvider, GroqProvider,
  TogetherProvider, PerplexityProvider, FireworksProvider,
  ReplicateProvider, BedrockProvider, XAIProvider,
  AnyscaleProvider, DeepInfraProvider, AgnesProvider,
  MCPRemoteRuntime, SSEStream,
  selectTools, getToolRelevanceScores, getToolCategory,
  isConfidentResponse, hasInformationGain,
  PatternTracker, getPatternTracker, resetPatternTracker,
  planSpeculativeExecution, isSpeculativelySafe,
  // SOP generation & dashboard
  exportSOPFromTrace, exportSOPFromResult,
  formatSOPAsMarkdown, formatSOPAsContext,
  listSOPs, getSOP, getSOPMarkdown,
  getSOPDashboardData, renderSOPDashboardHtml,
} from './runtime';
export type { AgentRuntimeInterface } from './runtime';
export type {
  EmbeddingFunction, ToolRetrievalConfig, EntropyGatingConfig, SpeculativeExecutionConfig,
  // SOP types
  SOPListItem, SOPDashboardData, SOPTemplate,
  SOPPhase, SOPDecision, SOPToolCall, SOPFileAccess,
} from './runtime';

// HTML Reporting
export {
  HTMLReportRenderer, getHTMLReportRenderer, createWarRoomHTMLReport,
} from './reporting';

// Self-Evolution Engine — Meta-learning & optimization
export {
  MetaLearner, getMetaLearner, resetMetaLearner, DEFAULT_META_LEARNER_CONFIG,
} from './selfEvolution/metaLearner';
export { TrajectoryAnalyzer } from './selfEvolution/trajectoryAnalyzer';
export {
  EvolverAgent, getEvolverAgent, resetEvolverAgent,
} from './selfEvolution/evolverAgent';
export type {
  EvolverMutation, EvolutionCycle,
} from './selfEvolution/evolverAgent';
export {
  ReflectionEngine, createReflectionEngine, getGlobalReflectionEngine,
} from './reflectionEngine';
export {
  ConsensusChecker, createConsensusChecker,
} from './consensusCheck';

export { InspectorAgent, createInspector } from './inspectorAgent';
export { TaskComplexityAnalyzer } from './taskComplexityAnalyzer';

// Runtime Enhancements — Agent Execution Improvements
export { CycleDetector } from './runtime/cycleDetector';
export {
  ToolApproval, ApprovalRequest, ApprovalResult, ApprovalLevel,
  ApprovalPolicy, DEFAULT_APPROVAL_POLICIES,
} from './runtime/toolApproval';
export { EvolutionaryWorkflowEngine } from './runtime/evolutionaryWorkflowEngine';
export type {
  WorkflowNode, WorkflowEdge, WorkflowDAG,
  EvolutionResult, EvolutionOptions,
} from './runtime/evolutionaryWorkflowTypes';
export { CommanderHttpServer, createHttpServer } from './runtime/httpServer';
export { BaseChannelAdapter } from './runtime/channelAdapter';

// Unified Verification Pipeline
export { UnifiedVerificationPipeline } from './runtime/unifiedVerification';
export { detectTaskType, classifyProvisionIntent } from './runtime/taskAnalyzer';
export type {
  VerificationSignal, VerificationReport, UVPTaskContext,
  UVPConfig, TaskType, ProvisionIntentScores,
} from './runtime/unifiedVerificationTypes';

// Token Budget Governor
export {
  TokenGovernor, getTokenGovernor, resetTokenGovernor,
} from './runtime/tokenGovernor';

// Token Budget Manager — per-run proportional sub-agent allocation
export {
  TokenBudgetManager, getTokenBudgetManager, resetTokenBudgetManager,
} from './runtime/tokenBudgetManager';
export type {
  SubAgentAllocation, RunBudgetStatus, TokenBudgetConfig,
} from './runtime/tokenBudgetManager';

// Checkpoint Writer — MiMo-style independent checkpoint sub-agent
export {
  CheckpointWriter, getCheckpointWriter, resetCheckpointWriter,
} from './runtime/checkpointWriter';
export type {
  CheckpointWriterConfig, CheckpointTrigger, CheckpointDocument, CheckpointResult,
} from './runtime/checkpointWriter';

// Goal Judge — Independent judge model for verifying task completion
export {
  GoalJudge, getGoalJudge, resetGoalJudge,
} from './runtime/goalJudge';
export type {
  StopCondition, StopConditionResult, JudgeVerdict, GoalJudgeConfig,
} from './runtime/goalJudge';

// Rebuild Prompt — Layer 5: complete context window reset + reconstruction
export {
  RebuildPrompt, getRebuildPrompt, resetRebuildPrompt, isRebuilt,
} from './runtime/rebuildPrompt';
export type {
  RebuildParams, RebuildSection, RebuildResult,
} from './runtime/rebuildPrompt';
export type {
  OptimizationStrategy, BudgetState, GovernorDecision,
  GovernorConfig, TaskCategory,
} from './runtime/tokenGovernor';

// Tool Calling Infrastructure
export { ToolResultCache } from './runtime/toolResultCache';
export type { ToolCacheConfig, ToolCacheStats } from './runtime/toolResultCache';
export { ToolOutputManager } from './runtime/toolOutputManager';
export type { ToolOutputConfig, ManagedOutput, TurnBudgetState } from './runtime/toolOutputManager';
export { ToolOrchestrator } from './runtime/toolOrchestrator';
export type { OrchestratorConfig, OrchestratedResult, ToolExecutionPlan, ToolExecutionContext } from './runtime/toolOrchestrator';
export {
  ToolAvailabilityManager, evaluate, allOf, anyOf, not,
  always, never, earlySteps, budgetRelaxed, budgetNotCritical,
  notYetUsed, requiresTool, maxErrors, createDefaultRules,
} from './runtime/toolAvailability';
export type {
  AvailabilityContext, AvailabilityExpression, ToolAvailabilityRule,
} from './runtime/toolAvailability';
export { ToolPlanner } from './runtime/toolPlanner';
export type {
  ExecutionPlan, ExecutionStage, DependencyEdge, ResourceConflict,
} from './runtime/toolPlanner';
export type {
  ChannelAdapter, ChannelConfig, ChannelMessage, ChannelStatus,
  ChannelAttachment, SendOptions, MessageRole,
} from './runtime/channelAdapter';

// Topology & Workflow Optimization
export {
  ReflexionTopologicalOptimizer as TopologyOptimizer,
  TopologyDiagnostics, OptimizationProposal, OptimizationAction,
} from './ultimate/topologyOptimizer';
export {
  RuntimeWorkflowAdapter, AdaptiveExecutionResult,
} from './ultimate/runtimeWorkflowAdapter';

// Plugin System — Hooks & Extensions
export {
  HookManager, getHookManager, resetHookManager, createLoggingPlugin,
} from './pluginManager';
export type {
  CommanderPlugin, HookPoint,
  BeforeToolCallContext, AfterToolCallContext,
  BeforeLLMCallContext, AfterLLMCallContext,
  AgentStartContext, AgentCompleteContext, ErrorContext,
} from './pluginManager';

// TELOS Framework — Token-Efficient Low-waste Orchestration System
export type {
  TELOSBudget, TokenCheckResult, CostRecord, CostSummary, BudgetAlert,
  TELOSPlanContext, TELOSAgentAssignment, TELOSOrchestrationMode,
  ProviderEndpoint, ProviderHealth, ProviderSelection,
  StreamChunk, StreamCallback, StreamController, TELOSConfig,
} from './telos/types';
export { DEFAULT_TELOS_CONFIG } from './telos/types';
export {
  TokenSentinel, getTokenSentinel, resetTokenSentinel,
  estimateTokenCount, estimateMessagesTokens, calculateCost,
  ProviderPool, getProviderPool, resetProviderPool,
  TELOSOrchestrator, HeuristicEvaluator, EvalSuite,
  getHeuristicEvaluator, resetHeuristicEvaluator,
  EVALUATION_DIMENSIONS, DEFAULT_EVAL_CRITERIA,
} from './telos';

// MCP — Model Context Protocol
export type {
  MCPTool, MCPResource, MCPPrompt, MCPContentItem,
  MCPToolResult, MCPResourceContents, MCPJsonSchema,
  MCPTransport, MCPClientConfig,
  JSONRPCRequest, JSONRPCResponse,
  A2AAgentCard, A2AJsonRpcRequest, A2AJsonRpcResponse,
  A2ATask, A2ATaskState, A2AMessage,
} from './mcp';
export {
  MCPClient, StdioClientTransport, StreamableHTTPClientTransport,
  createMCPClient, MCPServer, MCP_ERROR_CODES,
  canTransition, AGENT_CARD_WELL_KNOWN_PATH,
  A2A_VERSION_HEADER, A2A_PROTOCOL_VERSION, A2A_ERROR, A2A_METHODS,
} from './mcp';

export {
  SwarmOrchestrator, FusionEngine, SwarmConfig, DEFAULT_SWARM_CONFIG,
  SwarmNode, SwarmManager, SwarmTopology,
  FusionConflict, FusionReport, SwarmResult, SwarmStatus,
} from './swarm';

export {
  DriveOrchestrator, DriveConfig, DEFAULT_DRIVE_CONFIG,
  DriveStep, DriveState, DriveResult, DriveStatus,
} from './drive';

// Experimental — not yet wired into the main execution flow
export { PluginLoader, getPluginLoader } from './pluginLoader';

// Reliability Engine — Unified resilience facade (circuit breaker + DLQ + compensation + checkpoints)
export { ReliabilityEngine } from './runtime/reliabilityEngine';
export type { ReliabilityEngineConfig, ReliabilityStats } from './runtime/reliabilityEngine';

// Commander Core — tiered auto-configuration control center (recommended entry)
export { Commander } from './commander';
export type { CommanderResult, CommanderStatus } from './commander';
export type { CommanderOptions, DeploymentTier, ResolvedConfig } from './commander/tier';
export type { ProbeResult } from './commander/probe';

// PrivacyRouter — Sensitive content detection + local model fallback
export { PrivacyRouter, getPrivacyRouter, resetPrivacyRouter } from './runtime/privacyRouter';
export type { PrivacyRouterConfig, PrivacyDecision, PrivacyRoute, SensitivityMatch, SensitivityCategory } from './runtime/privacyRouter';

// Saga Runtime — durable compensating transactions
export {
  createSaga,
  buildSaga,
  SagaBuilder,
  SagaBuilderError,
  runSaga,
  startSaga,
  SagaCoordinator,
  SagaCoordinatorError,
  SagaNodeError,
  SagaAbortedError,
  attachSagaHandle,
  ExecutionGraph,
  ExecutionGraphError,
  CheckpointManager,
  CheckpointError,
  InMemorySagaStore,
  FileSagaStore,
  InProcessWorkerPool,
  WorkerPool,
  WorkerPoolError,
  CompensationScheduler,
  CompensationSchedulerError,
  defaultCompensationRetryPolicy,
  ApprovalManager,
  ApprovalError,
  InMemoryApprovalStore,
  FileApprovalStore,
  ApprovalStoreError,
  RetryController,
  RetryControllerError,
  mergeRetryPolicy,
  isStepNode,
  isParallelNode,
  isNestedNode,
  isApprovalNode,
} from './saga';
export type {
  SagaGraph,
  SagaNode,
  SagaStepNode,
  SagaParallelNode,
  SagaNestedNode,
  SagaApprovalNode,
  SagaContext,
  SagaResult,
  SagaEvent,
  SagaEventKind,
  SagaStateSnapshot,
  NodeState,
  SagaRunOptions,
  SagaRunHandle,
  RunningSaga,
  SagaStepOptions,
  SagaParallelConfig,
  SagaNestedConfig,
  SagaApprovalConfig,
  RetryPolicy,
  CompensationFn,
  SagaStore,
  FileSagaStoreOptions,
  SagaApprovalRequest,
  SagaApprovalDecision,
  SagaApprovalResult,
  ApprovalStore,
  ApprovalManagerOptions,
  ApprovalWaitOptions,
  FileApprovalStoreOptions,
  WorkerPoolOptions,
  CompensableStep,
  CompensationAttempt,
  CompensationResult,
  FailedCompensation,
  DeadLetterSink,
  CompensationSchedulerOptions,
  RecoveredState,
} from './saga';
export {
  DEFAULT_RETRY_POLICY,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
} from './saga';
