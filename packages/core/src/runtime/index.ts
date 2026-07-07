export type {
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMProvider,
  TokenUsage,
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
  MessagePriority,
  BusMessage,
  MessageHandler,
  BusPayloadMap,
  TraceEvent,
  TraceSpan,
  ExecutionTrace,
  HTMLReportSection,
  HTMLReport,
  ExecutionExperience,
  OptimizationSuggestion,
  StrategyPerformance,
  ToolRetrievalConfig,
  EntropyGatingConfig,
  SpeculativeExecutionConfig,
} from './types';

export { ModelRouter, getModelRouter, resetModelRouter } from './modelRouter';
export { MessageBus, getMessageBus, resetMessageBus } from './messageBus';
export { ExecutionTraceRecorder, getTraceRecorder, resetTraceRecorder } from './executionTrace';
export { AgentRuntime } from './agentRuntime';
export type { AgentRuntimeInterface } from './agentRuntimeInterface';
export type { EmbeddingFunction } from './embedding';
export {
  MockEmbeddingFunction,
  cosineSimilarity,
  l2Distance,
  InMemoryEmbeddingStore,
  calculateMemoryScore,
} from './embedding';
export { OpenAIProvider } from './providers/openaiProvider';
export { AnthropicProvider } from './providers/anthropicProvider';
export { GoogleProvider } from './providers/googleProvider';
export { OpenRouterProvider } from './providers/openRouterProvider';
export { DeepSeekProvider } from './providers/deepseekProvider';
export { GLMProvider } from './providers/glmProvider';
export { MiMoProvider } from './providers/mimoProvider';
export { XiaomiProvider } from './providers/xiaomiProvider';
export { OllamaProvider } from './providers/ollamaProvider';
export { VLLMProvider } from './providers/vllmProvider';
export { CohereProvider } from './providers/cohereProvider';
export { MistralProvider } from './providers/mistralProvider';
export { GroqProvider } from './providers/groqProvider';
export { TogetherProvider } from './providers/togetherProvider';
export { PerplexityProvider } from './providers/perplexityProvider';
export { FireworksProvider } from './providers/fireworksProvider';
export { ReplicateProvider } from './providers/replicateProvider';
export { BedrockProvider } from './providers/bedrockProvider';
export { XAIProvider } from './providers/xaiProvider';
export { AnyscaleProvider } from './providers/anyscaleProvider';
export { DeepInfraProvider } from './providers/deepinfraProvider';
export { AgnesProvider } from './providers/agnesProvider';
export { StepFunProvider } from './providers/stepfunProvider';
export { MiniMaxProvider } from './providers/minimaxProvider';
export {
  BaseOpenAICompatibleProvider,
  callOpenAICompatibleAPI,
  parseOpenAIStream,
  parseOpenAIResponse,
  buildOpenAIBody,
} from './providers/baseOpenAICompatible';
export { MCPRemoteRuntime } from './mcpRemoteRuntime';
export type { MCPRemoteRuntimeConfig } from './mcpRemoteRuntime';
export { SSEStream } from './sseStream';
export type { StructuredSSEEventType, StructuredSSEEvent } from './sseStream';
export { selectTools, getToolRelevanceScores, getToolCategory } from './toolRetriever';
export { isConfidentResponse, hasInformationGain } from './entropyGater';
export { parseStructuredOutput, validateStructuredOutput, validateShape } from './structuredOutput';
export { ContextWindowManager, estimateTotalTokens } from './contextWindow';
export type { ContextWindowConfig, WindowAction } from './contextWindow';
export {
  PatternTracker,
  getPatternTracker,
  resetPatternTracker,
  planSpeculativeExecution,
  isSpeculativelySafe,
} from './speculativeExecutor';
export {
  OpenTelemetryExporter,
  getOTelExporter,
  resetOTelExporter,
  executionTraceToOtlpSpans,
} from './openTelemetryExporter';
export type { OTelExporterConfig, OTelSpan } from './openTelemetryExporter';
export { UnifiedVerificationPipeline } from './unifiedVerification';
export { detectTaskType, classifyProvisionIntent } from './taskAnalyzer';
export type {
  VerificationSignal,
  VerificationReport,
  UVPTaskContext,
  UVPConfig,
  TaskType,
  ProvisionIntentScores,
} from './unifiedVerificationTypes';
export { StateCheckpointer } from './stateCheckpointer';
export type { CheckpointState } from './stateCheckpointer';
export { ReliabilityEngine } from './reliabilityEngine';
export type { ReliabilityEngineConfig, ReliabilityStats } from './reliabilityEngine';
export { PrivacyRouter, getPrivacyRouter, resetPrivacyRouter } from './privacyRouter';
export type {
  PrivacyRouterConfig,
  PrivacyDecision,
  PrivacyRoute,
  SensitivityMatch,
  SensitivityCategory,
} from './privacyRouter';
export { PersistentTraceStore } from './traceStore';
export type { TraceStore } from './traceStore';
export { DeadLetterQueue } from './deadLetterQueue';
export type { DeadLetterEntry, DLQCategory } from './deadLetterQueue';
export { StepErrorBoundary } from './stepErrorBoundary';
export type {
  RecoveryStrategy,
  ErrorBoundaryConfig,
  ErrorBoundaryResult,
} from './stepErrorBoundary';
export { CompensationRegistry } from './compensationRegistry';
export type { CompensableAction, CompensationHandler } from './compensationRegistry';
export { AgentInbox } from './agentInbox';
export type { InboxMessage, MessageStatus } from './agentInbox';
export { TeamRegistry } from './teamRegistry';
export type { TeamSpec, TeamMember, TeamRole } from './teamRegistry';
export { AgentHandoff } from './agentHandoff';
export type { HandoffRequest, HandoffStatus } from './agentHandoff';
export { TokenGovernor, getTokenGovernor, resetTokenGovernor } from './tokenGovernor';
export type {
  OptimizationStrategy,
  BudgetState,
  GovernorDecision,
  GovernorConfig,
  TaskCategory,
} from './tokenGovernor';
export { ToolResultCache } from './toolResultCache';
export type { ToolCacheConfig, ToolCacheStats } from './toolResultCache';
export { ToolOutputManager } from './toolOutputManager';
export type { ToolOutputConfig, ManagedOutput, TurnBudgetState } from './toolOutputManager';
export { ToolOrchestrator } from './toolOrchestrator';
export type {
  OrchestratorConfig,
  OrchestratedResult,
  ToolExecutionPlan,
  ToolExecutionContext,
} from './toolOrchestrator';
// Canonical synthetic-error row shape + factory + discriminated-union
// return type shared by AgentRuntime pre-tool-call gates and ToolOrchestrator
// boundary. Exported here so downstream consumers can type their own
// gate-aware / shape-aware code against the same definitions.
export { toolErrorRow } from './toolResultShape';
export type { SyntheticErrorRow, PreToolCallGateResult } from './toolResultShape';
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
  taskType,
  notYetUsed,
  requiresTool,
  maxErrors,
  createDefaultRules,
} from './toolAvailability';
export type {
  AvailabilityContext,
  AvailabilityExpression,
  ToolAvailabilityRule,
} from './toolAvailability';
export { ToolPlanner } from './toolPlanner';
export type {
  ExecutionPlan,
  ExecutionStage,
  DependencyEdge,
  ResourceConflict,
} from './toolPlanner';
export {
  exportSOPFromTrace,
  exportSOPFromResult,
  formatSOPAsMarkdown,
  formatSOPAsContext,
} from './sopExport';
export type { SOPTemplate, SOPPhase, SOPDecision, SOPToolCall, SOPFileAccess } from './sopExport';

export {
  listSOPs,
  getSOP,
  getSOPMarkdown,
  getSOPDashboardData,
  renderSOPDashboardHtml,
  type SOPListItem,
  type SOPDashboardData,
} from './sopDashboard';

export { CommanderHttpServer, createHttpServer } from './httpServer';
export { MtlsRuntimeServer } from './mtlsRuntimeServer';
export type { MtlsRuntimeServerConfig } from './mtlsRuntimeServer';
export { MtlsRuntimeProxy } from './mtlsRuntimeProxy';
export type { MtlsRuntimeProxyConfig } from './mtlsRuntimeProxy';
export { BaseChannelAdapter } from './channelAdapter';
export { TelegramAdapter, createTelegramAdapter } from './adapters/telegramAdapter';
export type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelStatus,
  ChannelAttachment,
  SendOptions,
  MessageRole,
} from './channelAdapter';
export {
  initLSP,
  disconnectLSP,
  isLSPReady,
  attachDiagnostics,
  getFileDiagnostics,
  hasLSErrors,
  getLSErrorCount,
  openLSEDocument,
  LSPDiagnosticsTool,
  LSPAttachTool,
} from './lspIntegration';
export { VCRProvider, createVCRProvider } from './vcrProvider';
export type { VCREntry, VCRCassette, VCRConfig } from './vcrProvider';
export { BatchLLMProvider, createBatchProvider } from './batchProvider';
export type { BatchJob, BatchProviderConfig } from './batchProvider';
export { executeViaBatchAPI, supportsNativeBatchAPI } from './batchApiClient';
export type { BatchAPIConfig, BatchSubmissionResult, BatchPollResult } from './batchApiClient';

// Tenant Provider — re-exported through the runtime barrel so core internal
// consumers can import alongside other runtime primitives.
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
} from './tenantProvider';
export type { TenantConfig } from './tenantProvider';

// Extracted runtime modules (structural-debt cleanup baseline 2026-07-05)
export { LlmCaller, type LLMCallerDeps, type LLMCallerCallInput } from './llm/llmCaller';
export { normalizeToolCall } from './tool/toolCallNormalizer';
export { ToolCallRetryLoopDetector } from './tool/toolCallRetryLoopDetector';
export {
  ToolCallSecurityGate,
  type ToolCallSecurityGateDeps,
  type BeforeToolCallSecurityResult,
} from './tool/toolCallSecurityGate';
export {
  TenantContextResolver,
  type TenantContextResolverDeps,
} from './tenant/tenantContextResolver';
