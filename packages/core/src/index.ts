/**
 * Commander — Public API Surface
 *
 * Re-exports all public types, interfaces, and classes.
 */
export * from './models';

// Orchestration exports
export {
  SequentialStep,
  SequentialContext,
  SequentialStepResult,
  SequentialPipelineStatus,
  SequentialPipeline,
  SequentialPipelineRun,
  SequentialEvent,
  SequentialEventHandler,
  SequentialPipelineBuilder,
  OrchestrationMetrics,
  calculateOrchestrationMetrics,
  TokenUsage,
} from './orchestration';

// Memory exports
export {
  MemoryPriority,
  EpisodicMemoryItem,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryWriteOptions,
  MemoryManageOptions,
  MemoryStats,
  MemoryStore,
  InMemoryMemoryStore,
  JsonMemoryStore,
  createMemoryStore,
  fromProjectMemoryItem,
  toProjectMemoryItem,
} from './memory';

// Ultimate Framework exports (legacy)
export {
  OrchestrationMode,
  OrchestrationDecision,
  TokenBudgetAllocation,
  ModelTierConfig,
  DEFAULT_MODEL_CONFIG,
  AllocatedBudget,
  QualityGate,
  QualityGateExecutor,
  QualityGateResult,
} from './ultimate';
export { AdaptiveOrchestrator } from './adaptiveOrchestrator';
export { TokenBudgetAllocator } from './tokenBudgetAllocator';

// Ultimate Multi-Agent Orchestration System (v2)
export {
  UltimateOrchestrator,
  deliberate,
  RecursiveAtomizer,
  TopologyRouter,
  SubAgentExecutor,
  MultiAgentSynthesizer,
  ArtifactSystem,
  getArtifactSystem,
  resetArtifactSystem,
  AgentTeamManager,
  getTeamManager,
  WorkCoordinator,
  getWorkCoordinator,
  resetWorkCoordinator,
  getEffortRules,
  classifyEffortLevel,
  selectTopologyForEffort,
} from './ultimate/index';

export type {
  OrchestrationTopology,
  TaskDAG,
  TaskDAGNode,
  TaskDAGEdge,
  DeliberationPlan,
  TaskTreeNode,
  ArtifactReference,
  AgentTeam,
  TeamMember,
  SharedTask,
  InboxMessage,
  CapabilityVector,
  AgentCapability,
  EffortLevel,
  EffortScalingRules,
  ThinkingBudget,
  SynthesisStrategy,
  SynthesisConfig,
  QualityGateConfig,
  UltimateExecutionContext,
  UltimateExecutionResult,
  UltimateMetrics,
  ExecutionError,
  UltimateOrchestratorConfig,
  WorkItem,
  WorkStatus,
  WorkEvent,
  WorkEventHandler,
  EnqueueInput,
  ClaimFilter,
  TeamStatus,
} from './ultimate/index';

export {
  DEFAULT_THINKING_BUDGET,
  DEFAULT_SYNTHESIS_CONFIG,
  DEFAULT_ULTIMATE_CONFIG,
} from './ultimate/index';

// Tools — Web Search, File System, Code Execution
export {
  WebSearchTool,
  WebFetchTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  FileSearchTool,
  FileListTool,
  FileHashEditTool,
  PythonExecuteTool,
  ShellExecuteTool,
  createAllTools,
  MetaTool,
  getBuiltinMetaSpecs,
  findMatchingMetaSpec,
  ToolRegistry,
  TOOL_CATEGORIES,
} from './tools/index';
export type { MetaToolSpec, MetaToolStep, AgentDef } from './tools/index';

// Agent Loop — Persistent multi-agent execution
export { CommanderAgentLoop } from './agentLoop';
export type { AgentLoopConfig } from './agentLoop';

// Goal module — multi-agent goal-driven execution loop
export { GoalOrchestrator } from './goal/goalOrchestrator';
export type {
  GoalNode,
  GoalConfig,
  GoalResult,
  RoundLedger,
  RoundDecision,
  ManagerDecomposition,
  ManagerReview,
  CriticOutput,
  CritiqueResult,
  CritiqueFinding,
  CritiqueCategory,
} from './goal/types';

// ContentScanner exports - Agent Security Layer
export {
  ContentScanner,
  DefaultContentScanner,
  createContentScanner,
  scanContent,
  scanToolOutputForInjection,
} from './contentScanner';

// Configuration Validation
export {
  createSchema,
  validateConfig,
  mergeWithDefaults,
  validateRuntimeConfig,
  validateHttpServerConfig,
  validateField,
} from './runtime/configValidator';
export type {
  FieldType,
  ConfigField,
  ConfigSchema,
  ConfigValidationResult,
  ConfigValidationError,
} from './runtime/configValidator';

// Authentication & Authorization
export {
  AuthManager,
  getAuthManager,
  resetAuthManager,
  ROLE_HIERARCHY,
} from './runtime/authManager';
export type { AuthRole, AuthUser, ApiKeyEntry } from './runtime/authManager';

// Webhook Dispatcher
export {
  WebhookDispatcher,
  getWebhookDispatcher,
  resetWebhookDispatcher,
} from './runtime/webhookDispatcher';
export type { WebhookConfig, WebhookEvent, WebhookDelivery } from './runtime/webhookDispatcher';

// OpenTelemetry Exporter
export {
  OpenTelemetryExporter,
  getOTelExporter,
  resetOTelExporter,
} from './runtime/openTelemetryExporter';
export type { OTelExporterConfig, OTelSpan } from './runtime/openTelemetryExporter';

// ThreeLayerMemory
export {
  ThreeLayerMemory,
  getGlobalThreeLayerMemory,
  resetGlobalThreeLayerMemory,
  createThreeLayerMemory,
} from './threeLayerMemory';

// Logging & Metrics
export {
  parseStructuredOutput,
  validateStructuredOutput,
  validateShape,
} from './runtime/structuredOutput';
export { ContextWindowManager, estimateTotalTokens } from './runtime/contextWindow';
export type { ContextWindowConfig, WindowAction } from './runtime/contextWindow';

export { Logger, MetricsCollector, getGlobalLogger, getGlobalMetrics } from './logging';

// Error Handler
export {
  ErrorHandler,
  CommanderError,
  TaskComplexityError,
  OrchestrationError,
  BudgetExhaustedError,
  MemoryError,
  ConsensusError,
  InspectionError,
} from './errorHandler';

export {
  initializeFramework,
  getFramework,
  createExecutionPlan,
  allocateBudget,
  recordMemory,
  queryMemory,
  startReflection,
  completeReflection,
  runConsensusCheck,
  updateComponentHealth,
  runInspection,
} from './frameworkIntegration';

// Shell & Runner exports
export { getSandboxManager, SandboxManager, ExecPolicyEngine, TEESandbox } from './sandbox';
export type {
  SandboxMode,
  SandboxProfile,
  SandboxMechanism,
  NetworkPolicy,
  FileAccessPolicy,
  SandboxExecutionResult,
  PlatformSandbox,
  TEEBackend,
  TEEAttestation,
  TEESandboxResult,
} from './sandbox';

// Credential Manager
export {
  CredentialManager,
  getCredentialManager,
  resetCredentialManager,
} from './runtime/credentialManager';

// Hallucination Detector
export { HallucinationDetector, getHallucinationDetector } from './hallucinationDetector';

export type { HallucinationSignal, HallucinationReport } from './hallucinationDetector';

// Security Subsystem
export {
  SecurityMonitor,
  getSecurityMonitor,
  resetSecurityMonitor,
} from './security/securityMonitor';
export { GuardianAgent, getGuardianAgent, resetGuardianAgent } from './security/guardianAgent';
export {
  SecurityAuditLogger,
  getSecurityAuditLogger,
  resetSecurityAuditLogger,
} from './security/securityAuditLogger';

// CapabilityToken — short-lived HMAC-signed authorization tokens
export {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  CapabilityTokenError,
  getCapabilityTokenIssuer,
  resetCapabilityTokenState,
} from './security/capabilityToken';
export type {
  CapabilityScope,
  CapabilityPayload,
  VerifyResult,
  RiskLevel,
} from './security/capabilityToken';

// AuditChainLedger — tamper-evident hash-chained audit log
export {
  AuditChainLedger,
  getAuditChainLedger,
  resetAuditChainLedger,
} from './security/auditChainLedger';

// AgentLineage — immutable parent→child agent relationship tracking
export { AgentLineage, getAgentLineage, resetAgentLineage } from './security/agentLineage';
export type { LineageNode, LineageSummary, LineageQuery } from './security/agentLineage';

// SupplyChainScanner — enterprise-grade skill/tool pre-load security scanning
export { SupplyChainScanner, getSupplyChainScanner } from './security/supplyChainScanner';
export type { SupplyChainScanRequest, SupplyChainScanResult } from './security/supplyChainScanner';

// RedTeamFramework — automated adversarial security testing
export {
  RedTeamFramework,
  getRedTeamFramework,
  createContentScannerDefender,
  createComprehensiveDefender,
  generateSecurityReport,
  generateSecurityReportJson,
  ATTACK_SCENARIOS,
} from './security/redTeamFramework';
export type { RedTeamTestScenario, RedTeamTestResult, RedTeamRunReport } from './security/redTeamFramework';

// OutputSanitizer — data exfiltration prevention at the output boundary
export {
  OutputSanitizer,
  getOutputSanitizer,
  resetOutputSanitizer,
  sanitizeOutput,
  sanitizeIfNeeded,
} from './security/outputSanitizer';
export type {
  SensitivityCategory,
  RedactionStrategy,
  RedactionRule,
  RedactionRecord,
  SanitizeResult,
  OutputSanitizerConfig,
} from './security/outputSanitizer';

// CostGuard — enterprise economic attack detection & auto circuit-breaker
export { CostGuard, getCostGuard, resetCostGuard } from './security/costGuard';
export type {
  CostAttackType,
  CostGuardAction,
  CostTier,
  CostGuardConfig,
  CostGuardDecision,
  CostGuardReport,
} from './security/costGuard';

// AgentSOC — P0-P4 incident classification, playbook engine, escalation paths, SOC dashboard
export { AgentSoc, getAgentSoc, resetAgentSoc } from './security/agentSoc';
export type {
  IncidentPriority,
  IncidentStatus,
  EscalationLevel,
  PlaybookTrigger,
  Incident,
  Playbook,
  PostmortemReport,
  SocHealth,
  AgentSocConfig,
} from './security/agentSoc';

// EuAiActCompliance — EU AI Act Article 12/13/14 automated compliance reporting
export {
  EuAiActComplianceReporter,
  getEuAiActComplianceReporter,
  resetEuAiActComplianceReporter,
} from './security/euAiActCompliance';
export type {
  EuAiActReport,
  Article12Report,
  Article13Report,
  Article14Report,
  ComplianceSummary,
  ComplianceReportOptions,
} from './security/euAiActCompliance';

// AgentStandbyManager — hot standby agent architecture with auto-failover
export { AgentStandbyManager, getAgentStandbyManager } from './security/agentStandbyManager';
export type {
  AgentTier,
  AgentInstance,
  SwitchTrigger,
  SwitchEvent,
  StandbyConfig,
  StandbyHealth,
} from './security/agentStandbyManager';

// RedTeamBaseline — regression detection for continuous red team CI/CD
export {
  RedTeamBaselineManager,
  getRedTeamBaseline,
} from './security/redTeamBaseline';
export type {
  RegressionSeverity,
  RegressionResult,
  ImprovementResult,
  BaselineComparison,
} from './security/redTeamBaseline';

// EdgeSecurityProfile — unified edge/offline mode
export { EdgeSecurityProfile, getEdgeSecurityProfile } from './security/edgeSecurityProfile';
export type {
  EdgeMode,
  EdgeDetectionResult,
  EdgeSecurityConfig,
  EdgeSecurityStatus,
} from './security/edgeSecurityProfile';

// ComplianceAuditManager — ISO 42001/NIST AI RMF audit preparation
export {
  ComplianceAuditManager,
  getComplianceAuditManager,
} from './security/complianceAuditReport';
export type {
  ComplianceControl,
  DimensionScore,
  SecurityPosture,
  PostureSnapshot,
  ComplianceAuditReport,
  TrendAnalysis,
} from './security/complianceAuditReport';

// ThreatIntelligenceFeed — dynamic threat feed with TLP and SupplyChainScanner integration
export {
  ThreatIntelligenceFeed,
  getThreatIntelligenceFeed,
  resetThreatIntelligenceFeed,
} from './security/threatIntelligenceFeed';
export type {
  TlpLevel,
  ThreatSignature,
  ThreatFeedSource,
  ThreatFeedHealth,
  ThreatFeedConfig,
} from './security/threatIntelligenceFeed';

// CrossAgentCorrelator — multi-agent attack chain detection
export {
  CrossAgentCorrelator,
  getCrossAgentCorrelator,
  resetCrossAgentCorrelator,
} from './security/crossAgentCorrelator';
export type {
  CorrelationRuleType,
  CrossAgentEvent,
  CorrelationMatch,
  CorrelationRule,
  CorrelatorConfig,
} from './security/crossAgentCorrelator';

// MLInjectionDetector — embedding-based semantic injection detection
export {
  MLInjectionDetector,
  getMLInjectionDetector,
  resetMLInjectionDetector,
} from './security/mlInjectionDetector';
export type {
  InjectionVector,
  DetectionResult,
  MLDetectorConfig,
} from './security/mlInjectionDetector';

// FuzzTestFramework — mutation-based tool input fuzzer with coverage-guided feedback
export {
  FuzzTestFramework,
  getFuzzTestFramework,
  resetFuzzTestFramework,
} from './security/fuzzTestFramework';
export type { FuzzInput, FuzzResult, FuzzRunReport, FuzzerConfig } from './security/fuzzTestFramework';

// PostQuantumCrypto — PQ-safe hash (SHAKE-256), key generation, MAC creation/verification
export {
  PostQuantumCrypto,
  getPostQuantumCrypto,
  resetPostQuantumCrypto,
  pqHash,
  pqVerifyMac,
} from './security/postQuantumCrypto';
export type { PqKeyPair, PqMac, PqHashResult, PqCryptoConfig } from './security/postQuantumCrypto';

// MultimodalContentScanner — voice/video/image threat scanning
export {
  MultimodalContentScanner,
  getMultimodalContentScanner,
  resetMultimodalContentScanner,
} from './security/multimodalContentScanner';
export type {
  MultimodalThreat,
  MultimodalScanResult,
  MultimodalScannerConfig,
} from './security/multimodalContentScanner';

// SandboxVerifier — formal sandbox verification harness
export {
  SandboxVerifier,
  getSandboxVerifier,
  resetSandboxVerifier,
} from './security/sandboxVerifier';
export type { SandboxVerificationReport } from './security/sandboxVerifier';

// VoiceContentScanner — enhanced audio/voice threat scanning
export {
  VoiceContentScanner,
  getVoiceContentScanner,
  resetVoiceContentScanner,
} from './security/voiceContentScanner';
export type { VoiceThreat, VoiceScanResult } from './security/voiceContentScanner';

// FederatedIdentity — cross-org trust delegation with HMAC+OIDC JWT dual signing (Phase 3)
export {
  FederatedIdentity,
  getFederatedIdentity,
  resetFederatedIdentity,
} from './security/federatedIdentity';
export type {
  FederationTrust,
  FederatedExchangeResult,
  FederatedExchangeOutcome,
} from './security/federatedIdentity';

// MitreAtlasMapper — MITRE ATLAS tactics/techniques mapping
export { MitreAtlasMapper, getMitreAtlasMapper, resetMitreAtlasMapper } from './security/mitreAtlasMapper';
export type {
  AtlasTactic,
  AtlasTechnique,
  AtlasHeatmapCell,
  AtlasMapping,
  MitreAtlasReport,
} from './security/mitreAtlasMapper';

// AdaptiveHITL — risk-adaptive human-in-the-loop strategy engine
export { AdaptiveHITL, getAdaptiveHitl, resetAdaptiveHitl, maxStrategy } from './security/adaptiveHitl';
export type {
  HITLStrategy,
  ToolRiskSignal,
  AgentConfidenceSignal,
  MissionSignal,
  HITLSignalBundle,
  HITLFactor,
  HITLDecision,
  AgentBehaviorProfile,
  AdaptiveHITLConfig,
} from './security/adaptiveHitl';

// SecurityBenchmarkRunner — automated CI/CD security benchmark scoring
export {
  SecurityBenchmarkRunner,
  getSecurityBenchmarkRunner,
  ALL_BENCHMARK_CASES,
  getCasesForBenchmark,
} from './security/securityBenchmarkRunner';
export type {
  BenchmarkId,
  BenchmarkTestCase,
  BenchmarkTestResult,
  BenchmarkRunReport,
  BenchmarkTrend,
  BenchmarkRunnerConfig,
  DefenderFn,
} from './security/securityBenchmarkRunner';

// SupplyChainAttestor — SPDX 2.3 SBOM + Sigstore keyless attestation
export {
  SupplyChainAttestor,
  getSupplyChainAttestor,
  resetSupplyChainAttestor,
  componentToPurl,
  hashFile,
  hashString,
} from './security/supplyChainAttestor';
export type {
  SpdxDocument,
  AttestationBundle,
  AttestationResult,
  VerificationResult,
  ComponentEntry,
  AttestorConfig,
} from './security/supplyChainAttestor';

// DifferentialPrivacyLayer — ε-DP Laplace/Gaussian mechanisms for cross-agent memory sharing
export {
  DifferentialPrivacyLayer,
  getDifferentialPrivacyLayer,
  resetDifferentialPrivacyLayer,
  sampleLaplace,
  sampleGaussian,
  laplaceMechanism,
  gaussianMechanism,
  analyzeSensitivity,
  classifyEpsilon,
} from './security/differentialPrivacyLayer';
export type {
  DPPrivacyLevel,
  DPQueryType,
  DPSensitivity,
  DPDataBounds,
  PrivacyBudget,
  DifferentialPrivacyConfig,
  DPQueryResult,
  DPQueryRejection,
  DPQueryOutcome,
} from './security/differentialPrivacyLayer';

// Cost Estimation
export { CostEstimator, getCostEstimator, resetCostEstimator } from './runtime/costEstimator';
export type { CostEstimatorConfig } from './runtime/costEstimator';

// Anomaly Detection
export { getAnomalyDetector } from './observability/anomalyDetector';

// SLO Management
export { SLOManager, getSLOManager } from './observability/sloManager';

// Decision Provenance
export { buildDecisions, decisionsSummary } from './observability/decisionProvenance';

// Execution Provenance
export { captureProvenance } from './runtime/provenance';

// Metrics (from metricsCollector, not the logging re-export)
export { getMetricsCollector, resetMetricsCollector } from './runtime/metricsCollector';

// Tenant Provider — multi-tenant isolation primitives
export {
  TenantProvider,
  NullTenantProvider,
  SimpleTenantProvider,
  ThreeLayerMemoryRegistry,
  getGlobalTenantProvider,
  setGlobalTenantProvider,
  resetGlobalTenantProvider,
  getGlobalMemoryRegistry,
  resetGlobalMemoryRegistry,
} from './runtime/tenantProvider';

// Cost Model — token-based price calculation (also re-exported via @commander/observability)
export {
  CostModel,
  getCostModel,
  resetCostModel,
  DEFAULT_PRICING,
} from './observability/costModel';
export type { CostBreakdown, TokenBreakdown, ModelPricing } from './observability/types';

// Trace Store — durable execution-trace persistence (also re-exported via @commander/observability)
export { PersistentTraceStore } from './runtime/traceStore';
export type { TraceStore } from './runtime/traceStore';

// Runtime System — Agent Execution Engine
export type {
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMProvider,
  CacheConfig,
  CacheUsage,
  ToolDefinition,
  ToolCall,
  ToolResult,
  Tool,
  ModelTier,
  ModelConfig,
  RoutingDecision,
  AgentExecutionContext,
  AgentExecutionStep,
  AgentExecutionResult,
  AgentRuntimeConfig,
  MessageBusTopic,
  MessagePriority as BusMessagePriority,
  BusMessage,
  MessageHandler,
  TraceEvent,
  ExecutionTrace,
  HTMLReportSection,
  HTMLReport,
  ExecutionExperience,
  OptimizationSuggestion,
  StrategyPerformance,
} from './runtime/types';
export {
  ModelRouter,
  getModelRouter,
  resetModelRouter,
  MessageBus,
  getMessageBus,
  resetMessageBus,
  ExecutionTraceRecorder,
  getTraceRecorder,
  resetTraceRecorder,
  AgentRuntime,
  OpenAIProvider,
  AnthropicProvider,
  GoogleProvider,
  OpenRouterProvider,
  DeepSeekProvider,
  GLMProvider,
  MiMoProvider,
  XiaomiProvider,
  OllamaProvider,
  VLLMProvider,
  CohereProvider,
  MistralProvider,
  GroqProvider,
  TogetherProvider,
  PerplexityProvider,
  FireworksProvider,
  ReplicateProvider,
  BedrockProvider,
  XAIProvider,
  AnyscaleProvider,
  DeepInfraProvider,
  AgnesProvider,
  MCPRemoteRuntime,
  SSEStream,
  selectTools,
  getToolRelevanceScores,
  getToolCategory,
  isConfidentResponse,
  hasInformationGain,
  PatternTracker,
  getPatternTracker,
  resetPatternTracker,
  planSpeculativeExecution,
  isSpeculativelySafe,
  // SOP generation & dashboard
  exportSOPFromTrace,
  exportSOPFromResult,
  formatSOPAsMarkdown,
  formatSOPAsContext,
  listSOPs,
  getSOP,
  getSOPMarkdown,
  getSOPDashboardData,
  renderSOPDashboardHtml,
} from './runtime';
export type { AgentRuntimeInterface } from './runtime';
export type {
  EmbeddingFunction,
  ToolRetrievalConfig,
  EntropyGatingConfig,
  SpeculativeExecutionConfig,
  // SOP types
  SOPListItem,
  SOPDashboardData,
  SOPTemplate,
  SOPPhase,
  SOPDecision,
  SOPToolCall,
  SOPFileAccess,
} from './runtime';

// HTML Reporting
export { HTMLReportRenderer, getHTMLReportRenderer, createWarRoomHTMLReport } from './reporting';

// Self-Evolution Engine — Meta-learning & optimization
export {
  MetaLearner,
  getMetaLearner,
  resetMetaLearner,
  DEFAULT_META_LEARNER_CONFIG,
} from './selfEvolution/metaLearner';
export { TrajectoryAnalyzer } from './selfEvolution/trajectoryAnalyzer';
export { EvolverAgent, getEvolverAgent, resetEvolverAgent } from './selfEvolution/evolverAgent';
export type { EvolverMutation, EvolutionCycle } from './selfEvolution/evolverAgent';
export {
  ReflectionEngine,
  createReflectionEngine,
  getGlobalReflectionEngine,
} from './reflectionEngine';
export { ConsensusChecker, createConsensusChecker } from './consensusCheck';

export { InspectorAgent, createInspector } from './inspectorAgent';
export { TaskComplexityAnalyzer } from './taskComplexityAnalyzer';

// Runtime Enhancements — Agent Execution Improvements
export { CycleDetector } from './runtime/cycleDetector';
export {
  ToolApproval,
  ApprovalRequest,
  ApprovalResult,
  ApprovalLevel,
  ApprovalPolicy,
  DEFAULT_APPROVAL_POLICIES,
} from './runtime/toolApproval';
export { EvolutionaryWorkflowEngine } from './runtime/evolutionaryWorkflowEngine';
export type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowDAG,
  EvolutionResult,
  EvolutionOptions,
} from './runtime/evolutionaryWorkflowTypes';
export { CommanderHttpServer, createHttpServer } from './runtime/httpServer';
export { BaseChannelAdapter } from './runtime/channelAdapter';

// Unified Verification Pipeline
export { UnifiedVerificationPipeline } from './runtime/unifiedVerification';
export { detectTaskType, classifyProvisionIntent } from './runtime/taskAnalyzer';
export type {
  VerificationSignal,
  VerificationReport,
  UVPTaskContext,
  UVPConfig,
  TaskType,
  ProvisionIntentScores,
} from './runtime/unifiedVerificationTypes';

// Token Budget Governor
export { TokenGovernor, getTokenGovernor, resetTokenGovernor } from './runtime/tokenGovernor';

// Token Budget Manager — per-run proportional sub-agent allocation
export {
  TokenBudgetManager,
  getTokenBudgetManager,
  resetTokenBudgetManager,
} from './runtime/tokenBudgetManager';
export type {
  SubAgentAllocation,
  RunBudgetStatus,
  TokenBudgetConfig,
} from './runtime/tokenBudgetManager';

// Checkpoint Writer — MiMo-style independent checkpoint sub-agent
export {
  CheckpointWriter,
  getCheckpointWriter,
  resetCheckpointWriter,
} from './runtime/checkpointWriter';
export type {
  CheckpointWriterConfig,
  CheckpointTrigger,
  CheckpointDocument,
  CheckpointResult,
} from './runtime/checkpointWriter';

// Goal Judge — Independent judge model for verifying task completion
export { GoalJudge, getGoalJudge, resetGoalJudge } from './runtime/goalJudge';
export type {
  StopCondition,
  StopConditionResult,
  JudgeVerdict,
  GoalJudgeConfig,
} from './runtime/goalJudge';

// Rebuild Prompt — Layer 5: complete context window reset + reconstruction
export {
  RebuildPrompt,
  getRebuildPrompt,
  resetRebuildPrompt,
  isRebuilt,
} from './runtime/rebuildPrompt';
export type { RebuildParams, RebuildSection, RebuildResult } from './runtime/rebuildPrompt';
export type {
  OptimizationStrategy,
  BudgetState,
  GovernorDecision,
  GovernorConfig,
  TaskCategory,
} from './runtime/tokenGovernor';

// Tool Calling Infrastructure
export { ToolResultCache } from './runtime/toolResultCache';
export type { ToolCacheConfig, ToolCacheStats } from './runtime/toolResultCache';
export { ToolOutputManager } from './runtime/toolOutputManager';
export type { ToolOutputConfig, ManagedOutput, TurnBudgetState } from './runtime/toolOutputManager';
export { ToolOrchestrator } from './runtime/toolOrchestrator';
export type {
  OrchestratorConfig,
  OrchestratedResult,
  ToolExecutionPlan,
  ToolExecutionContext,
} from './runtime/toolOrchestrator';
export {
  ToolAvailabilityManager,
  evaluate,
  allOf,
  anyOf,
  not,
  always,
  never,
  earlySteps,
  budgetRelaxed,
  budgetNotCritical,
  notYetUsed,
  requiresTool,
  maxErrors,
  createDefaultRules,
} from './runtime/toolAvailability';
export type {
  AvailabilityContext,
  AvailabilityExpression,
  ToolAvailabilityRule,
} from './runtime/toolAvailability';
export { ToolPlanner } from './runtime/toolPlanner';
export type {
  ExecutionPlan,
  ExecutionStage,
  DependencyEdge,
  ResourceConflict,
} from './runtime/toolPlanner';
export type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelStatus,
  ChannelAttachment,
  SendOptions,
  MessageRole,
} from './runtime/channelAdapter';

// Topology & Workflow Optimization
export {
  ReflexionTopologicalOptimizer as TopologyOptimizer,
  TopologyDiagnostics,
  OptimizationProposal,
  OptimizationAction,
} from './ultimate/topologyOptimizer';
export { RuntimeWorkflowAdapter, AdaptiveExecutionResult } from './ultimate/runtimeWorkflowAdapter';

// Plugin System — Hooks & Extensions
export {
  HookManager,
  getHookManager,
  resetHookManager,
  createLoggingPlugin,
} from './pluginManager';
export type {
  CommanderPlugin,
  HookPoint,
  BeforeToolCallContext,
  AfterToolCallContext,
  BeforeLLMCallContext,
  AfterLLMCallContext,
  AgentStartContext,
  AgentCompleteContext,
  ErrorContext,
} from './pluginManager';

// TELOS Framework — Token-Efficient Low-waste Orchestration System
export type {
  TELOSBudget,
  TokenCheckResult,
  CostRecord,
  CostSummary,
  BudgetAlert,
  TELOSPlanContext,
  TELOSAgentAssignment,
  TELOSOrchestrationMode,
  ProviderEndpoint,
  ProviderHealth,
  ProviderSelection,
  StreamChunk,
  StreamCallback,
  StreamController,
  TELOSConfig,
} from './telos/types';
export { DEFAULT_TELOS_CONFIG } from './telos/types';
export {
  TokenSentinel,
  getTokenSentinel,
  resetTokenSentinel,
  estimateTokenCount,
  estimateMessagesTokens,
  calculateCost,
  ProviderPool,
  getProviderPool,
  resetProviderPool,
  TELOSOrchestrator,
  HeuristicEvaluator,
  EvalSuite,
  getHeuristicEvaluator,
  resetHeuristicEvaluator,
  EVALUATION_DIMENSIONS,
  DEFAULT_EVAL_CRITERIA,
} from './telos';

// MCP — Model Context Protocol
export type {
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPContentItem,
  MCPToolResult,
  MCPResourceContents,
  MCPJsonSchema,
  MCPTransport,
  MCPClientConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  A2AAgentCard,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2ATaskState,
  A2AMessage,
} from './mcp';
export {
  MCPClient,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  createMCPClient,
  MCPServer,
  MCP_ERROR_CODES,
  canTransition,
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_VERSION_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_ERROR,
  A2A_METHODS,
} from './mcp';

export {
  SwarmOrchestrator,
  FusionEngine,
  SwarmConfig,
  DEFAULT_SWARM_CONFIG,
  SwarmNode,
  SwarmManager,
  SwarmTopology,
  FusionConflict,
  FusionReport,
  SwarmResult,
  SwarmStatus,
} from './swarm';

export {
  DriveOrchestrator,
  DriveConfig,
  DEFAULT_DRIVE_CONFIG,
  DriveStep,
  DriveState,
  DriveResult,
  DriveStatus,
} from './drive';

// Experimental — not yet wired into the main execution flow
export { PluginLoader, getPluginLoader } from './pluginLoader';

// SecurityOrchestrator — unified runtime security coordination facade
export {
  SecurityOrchestrator,
  getSecurityOrchestrator,
  resetSecurityOrchestrator,
} from './runtime/securityOrchestrator';
export type {
  SecurityOrchestratorDecision,
  SecurityOrchestratorConfig,
} from './runtime/securityOrchestrator';
export type { ReliabilityEngineConfig, ReliabilityStats } from './runtime/reliabilityEngine';

// Commander Core — tiered auto-configuration control center (recommended entry)
export { Commander } from './commander';
export type { CommanderResult, CommanderStatus } from './commander';
export type { CommanderOptions, DeploymentTier, ResolvedConfig } from './commander/tier';
export type { ProbeResult } from './commander/probe';

// PrivacyRouter — Sensitive content detection + local model fallback
export { PrivacyRouter, getPrivacyRouter, resetPrivacyRouter } from './runtime/privacyRouter';
export type {
  PrivacyRouterConfig,
  PrivacyDecision,
  PrivacyRoute,
  SensitivityMatch,
  SensitivityCategory as PrivacySensitivityCategory,
} from './runtime/privacyRouter';

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
