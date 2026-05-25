/**
 * Commander — Public API Surface
 *
 * Re-exports all public types, interfaces, and classes.
 * Inline domain models moved to ./models.ts for maintainability.
 */
export * from './models';

// Orchestration exports
export {
  /** Individual step in a sequential pipeline. */
  SequentialStep,
  /** Execution context shared across sequential steps. */
  SequentialContext,
  /** Result of a single sequential step execution. */
  SequentialStepResult,
  /** Lifecycle status of a sequential pipeline. */
  SequentialPipelineStatus,
  /** Defines a linear execution flow of multiple steps. */
  SequentialPipeline,
  /** Represents a specific execution instance of a sequential pipeline. */
  SequentialPipelineRun,
  /** Event emitted during pipeline execution. */
  SequentialEvent,
  /** Handler function for sequential events. */
  SequentialEventHandler,
  /** Fluent builder for constructing sequential pipelines. */
  SequentialPipelineBuilder,
  /** Metrics collected during orchestration. */
  OrchestrationMetrics,
  /** Calculates metrics for a given orchestration run. */
  calculateOrchestrationMetrics,
  /** Token usage statistics. */
  TokenUsage,
} from './orchestration';

// Memory exports (re-export from memory module)
export {
  /** Priority level for memory retention and retrieval. */
  MemoryPriority,
  /** Short-term, session-scoped memory item. */
  EpisodicMemoryItem,
  /** Structure for querying the memory store. */
  MemorySearchQuery,
  /** Result of a memory search operation. */
  MemorySearchResult,
  /** Options for writing new memory items. */
  MemoryWriteOptions,
  /** Options for managing existing memory (pruning, updating). */
  MemoryManageOptions,
  /** Statistical overview of memory store health. */
  MemoryStats,
  /** Interface for memory persistence and retrieval. */
  MemoryStore,
  /** In-memory implementation of the memory store. */
  InMemoryMemoryStore,
  /** File-backed JSON implementation of the memory store. */
  JsonMemoryStore,
  /** Factory function for creating memory stores. */
  createMemoryStore,
  /** Converts a ProjectMemoryItem to an internal EpisodicMemoryItem. */
  fromProjectMemoryItem,
  /** Converts an internal memory item to a ProjectMemoryItem. */
  toProjectMemoryItem,
} from './memory';

// Ultimate Framework exports (legacy)
export {
  /** Mode of orchestration (Single, Multi-agent, etc.) */
  OrchestrationMode,
  /** Decision made by the orchestrator regarding task execution. */
  OrchestrationDecision,
  /** Allocation of token budget across agents or phases. */
  TokenBudgetAllocation,
  /** Configuration for different model tiers (Low, Medium, High). */
  ModelTierConfig,
  /** Default configuration for model routing and selection. */
  DEFAULT_MODEL_CONFIG,

  /** Represents an allocated portion of the token budget. */
  AllocatedBudget,
  /** A quality gate interface for verifying execution results. */
  QualityGate,
  /** Executor for running quality gate checks. */
  QualityGateExecutor,
  /** Result of a quality gate verification. */
  QualityGateResult,
} from './ultimate';
/** Orchestrator that adapts its behavior based on task complexity and feedback. */
export { AdaptiveOrchestrator } from './adaptiveOrchestrator';
/** Allocator for managing and distributing token budgets. */
export { TokenBudgetAllocator } from './tokenBudgetAllocator';

// ============================================================================
// Ultimate Multi-Agent Orchestration System (v2)
// ============================================================================
export {
  /** The main entry point for the Ultimate orchestration framework. */
  UltimateOrchestrator,
  /** Deliberates on a task to produce an execution plan. */
  deliberate,
  /** Atomizes complex tasks into smaller, manageable subtasks. */
  RecursiveAtomizer,
  /** Routes tasks to appropriate topologies based on requirements. */
  TopologyRouter,
  /** Executes subtasks using assigned agents. */
  SubAgentExecutor,
  /** Synthesizes results from multiple agents into a unified output. */
  MultiAgentSynthesizer,
  /** Core system for managing execution artifacts. */
  ArtifactSystem,
  /** Retrieves the singleton artifact system instance. */
  getArtifactSystem,
  /** Resets the artifact system state. */
  resetArtifactSystem,
  /** Registry of agent capabilities and tools. */
  CapabilityRegistry,
  /** Retrieves the singleton capability registry instance. */
  getCapabilityRegistry,
  /** Manages persistent teams of agents. */
  AgentTeamManager,
  /** Retrieves the singleton agent team manager instance. */
  getTeamManager,
  /** Retrieves effort scaling rules for orchestration. */
  getEffortRules,
  /** Classifies the effort level required for a task. */
  classifyEffortLevel,
  /** Selects the optimal topology for a given effort level. */
  selectTopologyForEffort,
} from './ultimate/index';

export type {
  /** Supported orchestration topologies (Single, Parallel, etc.). */
  OrchestrationTopology,
  /** Directed Acyclic Graph representation of a task plan. */
  TaskDAG,
  /** Individual node in a task DAG. */
  TaskDAGNode,
  /** Directed edge in a task DAG defining dependencies. */
  TaskDAGEdge,
  /** Plan resulting from the deliberation phase. */
  DeliberationPlan,
  /** Node in a hierarchical task tree. */
  TaskTreeNode,
  /** Reference to a stored artifact. */
  ArtifactReference,
  /** Represents a collaborative team of agents. */
  AgentTeam,
  /** Individual member of an agent team. */
  TeamMember,
  /** A task shared among multiple agents. */
  SharedTask,
  /** Message in an agent's asynchronous inbox. */
  InboxMessage,
  /** Vector representing agent capabilities for matching. */
  CapabilityVector,
  /** Definition of a specific agent capability. */
  AgentCapability,
  /** Level of effort required for task completion. */
  EffortLevel,
  /** Rules defining how resources scale with effort level. */
  EffortScalingRules,
  /** Token budget for LLM thinking/reasoning steps. */
  ThinkingBudget,
  /** Strategy for synthesizing multi-agent outputs. */
  SynthesisStrategy,
  /** Configuration for the synthesis process. */
  SynthesisConfig,
  /** Configuration for quality gate verification. */
  QualityGateConfig,
  /** Execution context for the Ultimate orchestrator. */
  UltimateExecutionContext,
  /** Result of an Ultimate orchestration run. */
  UltimateExecutionResult,
  /** Metrics collected during Ultimate orchestration. */
  UltimateMetrics,
  /** Error occurred during execution. */
  ExecutionError,
  /** Configuration for the Ultimate Orchestrator. */
  UltimateOrchestratorConfig,
} from './ultimate/index';

export {
  /** Default thinking budget for orchestration. */
  DEFAULT_THINKING_BUDGET,
  /** Default configuration for result synthesis. */
  DEFAULT_SYNTHESIS_CONFIG,
  /** Default configuration for the Ultimate framework. */
  DEFAULT_ULTIMATE_CONFIG,
} from './ultimate/index';

// ============================================================================
// Tools — Web Search, File System, Code Execution
// ============================================================================
export {
  /** Tool for performing web searches. */
  WebSearchTool,
  /** Tool for fetching content from URLs. */
  WebFetchTool,
  /** Tool for reading files from the local filesystem. */
  FileReadTool,
  /** Tool for writing files to the local filesystem. */
  FileWriteTool,
  /** Tool for editing files via string replacement. */
  FileEditTool,
  /** Tool for searching file contents via regex. */
  FileSearchTool,
  /** Tool for listing files in a directory. */
  FileListTool,
  /** Tool for executing Python code in a sandbox. */
  PythonExecuteTool,
  /** Tool for executing shell commands. */
  ShellExecuteTool,
  /** Factory to create all standard tools. */
  createAllTools,
  /** A meta-tool that can orchestrate other tools. */
  MetaTool,
  /** Retrieves built-in meta-tool specifications. */
  getBuiltinMetaSpecs,
  /** Finds a matching meta-tool specification for a task. */
  findMatchingMetaSpec,
  /** Registry for managing and retrieving tools. */
  ToolRegistry,
  /** Categorization of available tools. */
  TOOL_CATEGORIES,
} from './tools/index';
export type {
  /** Specification for a meta-tool. */
  MetaToolSpec,
  /** Individual step in a meta-tool execution. */
  MetaToolStep,
  /** Definition of an agent for tool-based orchestration. */
  AgentDef,
} from './tools/index';

// ============================================================================
// Agent Loop — Persistent multi-agent execution
// ============================================================================
/** Controller for running a persistent multi-agent execution loop. */
export { CommanderAgentLoop } from './agentLoop';
/** Configuration for the agent execution loop. */
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
  /** Scanner for identifying sensitive or forbidden content in messages. */
  ContentScanner,
  /** Default implementation of the ContentScanner interface. */
  DefaultContentScanner,
  /** Factory function for creating a content scanner instance. */
  createContentScanner,
  /** Utility function for scanning content with default settings. */
  scanContent,
} from './contentScanner';

// Configuration Validation
export {
  /** Creates a validation schema for configuration objects. */
  createSchema,
  /** Validates a configuration object against a schema. */
  validateConfig,
  /** Merges user configuration with default values. */
  mergeWithDefaults,
  /** Validates the main runtime configuration. */
  validateRuntimeConfig,
  /** Validates the HTTP server configuration. */
  validateHttpServerConfig,
  /** Validates an individual configuration field. */
  validateField,
} from './runtime/configValidator';
export type {
  /** Supported field types for configuration. */
  FieldType,
  /** Definition of a single configuration field. */
  ConfigField,
  /** Full schema for a configuration object. */
  ConfigSchema,
  /** Result of a configuration validation operation. */
  ConfigValidationResult,
  /** Individual error found during configuration validation. */
  ConfigValidationError,
} from './runtime/configValidator';

// Authentication & Authorization
export {
  /** Manager for handling authentication and authorization roles. */
  AuthManager,
  /** Retrieves the singleton authentication manager instance. */
  getAuthManager,
  /** Resets the authentication manager state. */
  resetAuthManager,
  /** Defined hierarchy of authorization roles. */
  ROLE_HIERARCHY,
} from './runtime/authManager';
export type {
  /** Valid authorization roles in the system. */
  AuthRole,
  /** Represents an authenticated user. */
  AuthUser,
  /** Entry for an API key in the authorization store. */
  ApiKeyEntry,
} from './runtime/authManager';

// Webhook Dispatcher
export {
  /** Dispatcher for sending asynchronous webhook notifications. */
  WebhookDispatcher,
  /** Retrieves the singleton webhook dispatcher instance. */
  getWebhookDispatcher,
  /** Resets the webhook dispatcher state. */
  resetWebhookDispatcher,
} from './runtime/webhookDispatcher';
export type {
  /** Configuration for a specific webhook endpoint. */
  WebhookConfig,
  /** Represents an event to be dispatched via webhook. */
  WebhookEvent,
  /** Tracking information for a webhook delivery attempt. */
  WebhookDelivery,
} from './runtime/webhookDispatcher';

// OpenTelemetry Exporter
export {
  /** Exporter for sending execution traces to OpenTelemetry collectors. */
  OpenTelemetryExporter,
  /** Retrieves the singleton OTel exporter instance. */
  getOTelExporter,
  /** Resets the OTel exporter state. */
  resetOTelExporter,
} from './runtime/openTelemetryExporter';
export type {
  /** Configuration for the OpenTelemetry exporter. */
  OTelExporterConfig,
  /** Represents an individual trace span. */
  OTelSpan,
} from './runtime/openTelemetryExporter';

// Ultimate Framework - Additional Components (Phase 1)
/** High-performance three-layer memory system (Episodic, Working, Long-term). */
export { ThreeLayerMemory } from './threeLayerMemory';

// Logging & Metrics (Phase 2)
export {
  /** Parses structured output from LLMs using defined schemas. */
  parseStructuredOutput,
  /** Validates that LLM output conforms to a required structure. */
  validateStructuredOutput,
  /** Runtime type guard validating parsed data matches expected shape. */
  validateShape,
} from './runtime/structuredOutput';
export {
  /** Manages context window limits and token compaction. */
  ContextWindowManager,
  /** Estimates total tokens in a message history. */
  estimateTotalTokens,
} from './runtime/contextWindow';
export type {
  /** Configuration for context window management. */
  ContextWindowConfig,
  /** Action to take when context window limits are reached. */
  WindowAction,
} from './runtime/contextWindow';

 export {
   /** System logger for structured diagnostic output. */
   Logger,
   /** Collector for Prometheus-compatible metrics. */
   MetricsCollector,
   /** Retrieves the global logger instance. */
   getGlobalLogger,
   /** Retrieves the global metrics collector instance. */
   getGlobalMetrics,
 } from './logging';

// Error Handler (Phase 2)
export {
  /** Global error handler for the Commander framework. */
  ErrorHandler,
  /** Base class for all Commander-specific errors. */
  CommanderError,
  /** Error indicating task complexity issues. */
  TaskComplexityError,
  /** Error occurred during multi-agent orchestration. */
  OrchestrationError,
  /** Error indicating that the token budget has been exhausted. */
  BudgetExhaustedError,
  /** Error occurred during memory operations. */
  MemoryError,
  /** Error occurred during consensus checking. */
  ConsensusError,
  /** Error occurred during agent inspection. */
  InspectionError,
} from './errorHandler';

export {
  /** Initializes the full Commander framework with default settings. */
  initializeFramework,
  /** Retrieves the active framework instance. */
  getFramework,
  /** Creates an execution plan for a specific goal. */
  createExecutionPlan,
  /** Allocates token budget for a run. */
  allocateBudget,
  /** Records an item into the project's memory. */
  recordMemory,
  /** Queries project memory for relevant information. */
  queryMemory,
  /** Starts a post-execution reflection session. */
  startReflection,
  /** Completes an active reflection session. */
  completeReflection,
  /** Runs a consensus check across multiple agent outputs. */
  runConsensusCheck,
  /** Updates the health status of a framework component. */
  updateComponentHealth,
  /** Runs an inspection on an agent's state or behavior. */
  runInspection,
} from './frameworkIntegration';

// Hallucination Detector
export {
  /** Detector for identifying potential hallucinations in LLM responses. */
  HallucinationDetector,
  /** Retrieves the global hallucination detector instance. */
  getHallucinationDetector,
} from './hallucinationDetector';
export type {
  /** Signal used to detect potential hallucinations. */
  HallucinationSignal,
  /** Detailed report of detected hallucinations. */
  HallucinationReport,
} from './hallucinationDetector';

// ============================================================================
// Runtime System — Agent Execution Engine (Phase 3)
// ============================================================================
export type {
  /** Individual message in an LLM conversation. */
  LLMMessage,
  /** Request sent to an LLM provider. */
  LLMRequest,
  /** Response received from an LLM provider. */
  LLMResponse,
  /** Interface for implementing an LLM model provider. */
  LLMProvider,
  /** Configuration for tool result caching. */
  CacheConfig,
  /** Statistics on cache usage for a run. */
  CacheUsage,
  /** Metadata defining a tool's parameters and purpose. */
  ToolDefinition,
  /** Request to call a specific tool. */
  ToolCall,
  /** Result returned by a tool execution. */
  ToolResult,
  /** Interface for implementing a system tool. */
  Tool,
  /** Classification of model tiers by capability. */
  ModelTier,
  /** Configuration for a specific LLM model. */
  ModelConfig,
  /** Decision made by the model router. */
  RoutingDecision,
  /** Execution context for an individual agent run. */
  AgentExecutionContext,
  /** Single step within an agent's execution loop. */
  AgentExecutionStep,
  /** Final result of an agent's execution run. */
  AgentExecutionResult,
  /** Main configuration for the agent runtime. */
  AgentRuntimeConfig,
  /** Topics available on the internal message bus. */
  MessageBusTopic,
  /** Priorities for messages on the bus. */
  MessagePriority as BusMessagePriority,
  /** Message transmitted over the internal bus. */
  BusMessage,
  /** Handler function for bus messages. */
  MessageHandler,
  /** Individual event within an execution trace. */
  TraceEvent,
  /** Full trace of an agent's execution. */
  ExecutionTrace,
  /** Individual section within an HTML report. */
  HTMLReportSection,
  /** Data structure for generating an HTML report. */
  HTMLReport,
  /** Summary of the experience gained during a run. */
  ExecutionExperience,
  /** Suggestion for optimizing future runs. */
  OptimizationSuggestion,
  /** Performance metrics for an orchestration strategy. */
  StrategyPerformance,
} from './runtime/types';
export {
   /** Routes requests to the optimal LLM provider and model. */
   ModelRouter,
   /** Retrieves the singleton model router instance. */
   getModelRouter,
   /** Resets the model router state. */
   resetModelRouter,
   /** Internal message bus for inter-agent communication. */
   MessageBus,
   /** Retrieves the singleton message bus instance. */
   getMessageBus,
   /** Resets the message bus state. */
   resetMessageBus,
   /** Recorder for capturing detailed execution traces. */
   ExecutionTraceRecorder,
   /** Retrieves the singleton trace recorder instance. */
   getTraceRecorder,
   /** Resets the trace recorder state. */
   resetTraceRecorder,
   /** Core runtime engine for agent execution. */
   AgentRuntime,
   /** Mock implementation of an embedding function for testing. */
   MockEmbeddingFunction,
   /** Calculates cosine similarity between two vectors. */
   cosineSimilarity,
   /** Calculates L2 distance between two vectors. */
   l2Distance,
   /** Simple in-memory store for vector embeddings. */
   InMemoryEmbeddingStore,
   /** Calculates a relevance score for a memory item. */
   calculateMemoryScore,
   /** Provider for OpenAI models. */
   OpenAIProvider,
   /** Provider for Anthropic Claude models. */
   AnthropicProvider,
   /** Provider for Google Gemini models. */
   GoogleProvider,
   /** Provider for OpenRouter aggregator. */
   OpenRouterProvider,
   /** Provider for DeepSeek models. */
   DeepSeekProvider,
   /** Provider for Zhipu GLM models. */
   GLMProvider,
   /** Provider for MiMo models. */
   MiMoProvider,
   /** Provider for Xiaomi models. */
   XiaomiProvider,
   /** Provider for Ollama models (self-hosted). */
   OllamaProvider,
   /** Provider for vLLM models (self-hosted). */
   VLLMProvider,
   /** Provider for Cohere models. */
   CohereProvider,
   /** Provider for Mistral models. */
   MistralProvider,
   /** Provider for Groq models. */
   GroqProvider,
   /** Provider for Together AI models. */
   TogetherProvider,
   /** Provider for Perplexity models. */
   PerplexityProvider,
   /** Provider for Fireworks models. */
   FireworksProvider,
   /** Provider for Replicate models. */
   ReplicateProvider,
   /** Provider for AWS Bedrock models. */
   BedrockProvider,
   /** Provider for xAI models. */
   XAIProvider,
   /** Provider for Anyscale models. */
   AnyscaleProvider,
   /** Provider for DeepInfra models. */
   DeepInfraProvider,
   /** Runtime implementation for interacting with remote MCP servers. */
   MCPRemoteRuntime,
   /** Stream implementation for Server-Sent Events. */
   SSEStream,
   /** Selects the most relevant tools for a given task. */
   selectTools,
   /** Calculates relevance scores for tools based on task description. */
   getToolRelevanceScores,
   /** Retrieves the category for a specific tool. */
   getToolCategory,
   /** Determines if an LLM response meets confidence thresholds. */
   isConfidentResponse,
   /** Determines if a response provides significant new information. */
   hasInformationGain,
   /** Tracker for identifying recurring patterns in agent behavior. */
   PatternTracker,
   /** Retrieves the singleton pattern tracker instance. */
   getPatternTracker,
   /** Resets the pattern tracker state. */
   resetPatternTracker,
   /** Plans speculative execution of multiple steps to reduce latency. */
   planSpeculativeExecution,
   /** Determines if a speculative execution plan is safe to run. */
   isSpeculativelySafe,
} from './runtime';
export type {
  /** Interface for vector embedding functions. */
  EmbeddingFunction,
  /** Configuration for automated tool retrieval. */
  ToolRetrievalConfig,
  /** Configuration for entropy-based response gating. */
  EntropyGatingConfig,
  /** Configuration for speculative execution. */
  SpeculativeExecutionConfig,
} from './runtime';

// ============================================================================
// HTML Reporting — Human-readable reports (Phase 3)
// ============================================================================
export {
  /** Renderer for generating professional HTML reports from execution traces. */
  HTMLReportRenderer,
  /** Retrieves the singleton HTML report renderer instance. */
  getHTMLReportRenderer,
  /** Utility function to create a project War Room report. */
  createWarRoomHTMLReport,
} from './reporting';

// ============================================================================
// Self-Evolution Engine — Meta-learning & optimization (Phase 3)
// ============================================================================
export {
  /** Engine for analyzing past runs and generating optimization strategies. */
  MetaLearner,
  /** Retrieves the singleton meta-learner instance. */
  getMetaLearner,
  /** Resets the meta-learner state. */
  resetMetaLearner,
  /** Default meta-learner configuration. */
  DEFAULT_META_LEARNER_CONFIG,
} from './selfEvolution/metaLearner';
export {
  /** Classifies execution trajectories into failure categories. light/balanced/thorough modes. */
  TrajectoryAnalyzer,
} from './selfEvolution/trajectoryAnalyzer';
export {
  /** Auto-tunes orchestrator config based on trajectory failure patterns. */
  EvolverAgent,
  /** Returns the global evolver agent singleton. */
  getEvolverAgent,
  /** Resets the global evolver agent singleton (for testing). */
  resetEvolverAgent,
} from './selfEvolution/evolverAgent';
export type {
  /** A single config mutation produced by the evolver. */
  EvolverMutation,
  /** Result of an evolution cycle. */
  EvolutionCycle,
} from './selfEvolution/evolverAgent';
export {
  /** Engine for post-run reflection and lesson extraction. */
  ReflectionEngine,
  /** Factory for creating reflection engines. */
  createReflectionEngine,
  /** Retrieves the global reflection engine instance. */
  getGlobalReflectionEngine,
} from './reflectionEngine';
export {
  /** Checker for verifying consensus among multiple agent outputs. */
  ConsensusChecker,
  /** Factory for creating consensus checkers. */
  createConsensusChecker,
} from './consensusCheck';

/** Agent specialized in inspecting and auditing other agents' behavior. */
export { InspectorAgent, createInspector } from './inspectorAgent';
/** Analyzer for measuring task complexity and recommending decomposition. */
export { TaskComplexityAnalyzer } from './taskComplexityAnalyzer';

// ============================================================================
// Runtime Enhancements — Agent Execution Improvements
// ============================================================================
/** Detects cycles or infinite loops in agent reasoning or tool calls. */
export { CycleDetector } from './runtime/cycleDetector';
export {
  /** Tool approval configuration. */
  ToolApproval,
  /** Request for human or automated tool approval. */
  ApprovalRequest,
  /** Result of an approval request. */
  ApprovalResult,
  /** Level of approval required (Auto, Manual, etc.). */
  ApprovalLevel,
  /** Policy defining approval requirements for tools. */
  ApprovalPolicy,
  /** Standard set of default approval policies. */
  DEFAULT_APPROVAL_POLICIES,
} from './runtime/toolApproval';
export {
  /** Engine for running evolutionary workflows that improve over time. */
  EvolutionaryWorkflowEngine,
  /** Directed Acyclic Graph representing an evolutionary workflow. */
  WorkflowDAG,
  /** Individual node in a workflow DAG. */
  WorkflowNode,
  /** dependency edge in a workflow DAG. */
  WorkflowEdge,
  /** Result of an evolutionary workflow run. */
  EvolutionResult,
  /** Options for the evolutionary workflow engine. */
  EvolutionOptions,
} from './runtime/evolutionaryWorkflowEngine';
/** HTTP server providing a REST API and real-time streaming for Commander. */
export { CommanderHttpServer, createHttpServer } from './runtime/httpServer';
/** Base class for implementing communication channel adapters (Slack, Discord, etc.). */
export { BaseChannelAdapter } from './runtime/channelAdapter';

// Unified Verification Pipeline — tiered zero-cost-first verification
export {
  /** Tiered pipeline for verifying task completion and quality. */
  UnifiedVerificationPipeline,
  /** Detects the type of task for optimized verification. */
  detectTaskType,
} from './runtime/unifiedVerification';
export type {
  /** Signal used for task verification. */
  VerificationSignal,
  /** Detailed report of verification results. */
  VerificationReport,
  /** Context provided to the Unified Verification Pipeline. */
  UVPTaskContext,
  /** Configuration for the verification pipeline. */
  UVPConfig,
  /** Supported task types for verification. */
  TaskType,
} from './runtime/unifiedVerification';

// Token Budget Governor — central token optimization coordinator
export {
  /** Central coordinator for token budget enforcement and optimization. */
  TokenGovernor,
  /** Retrieves the singleton token governor instance. */
  getTokenGovernor,
  /** Resets the token governor state. */
  resetTokenGovernor,
} from './runtime/tokenGovernor';
export type {
  /** Strategy for token optimization. */
  OptimizationStrategy,
  /** Current state of a token budget. */
  BudgetState,
  /** Decision made by the token governor. */
  GovernorDecision,
  /** Configuration for the token governor. */
  GovernorConfig,
  /** Categorization of tasks for budget allocation. */
  TaskCategory,
} from './runtime/tokenGovernor';

// Tool Calling Infrastructure
export {
  /** Cache for storing and retrieving tool execution results. */
  ToolResultCache,
} from './runtime/toolResultCache';
export type {
  /** Configuration for the tool result cache. */
  ToolCacheConfig,
  /** Statistics on tool cache performance. */
  ToolCacheStats,
} from './runtime/toolResultCache';
export {
  /** Manages tool output to ensure it fits within context limits. */
  ToolOutputManager,
} from './runtime/toolOutputManager';
export type {
  /** Configuration for the tool output manager. */
  ToolOutputConfig,
  /** Represents a managed tool output. */
  ManagedOutput,
  /** Budget state for a single execution turn. */
  TurnBudgetState,
} from './runtime/toolOutputManager';
export {
  /** Orchestrates complex tool execution plans with dependency management. */
  ToolOrchestrator,
} from './runtime/toolOrchestrator';
export type {
  /** Configuration for the tool orchestrator. */
  OrchestratorConfig,
  /** Result of an orchestrated tool execution. */
  OrchestratedResult,
  /** Execution plan for multiple tools. */
  ToolExecutionPlan,
  /** Context for a tool execution step. */
  ToolExecutionContext,
} from './runtime/toolOrchestrator';
export {
  /** Manager for controlling tool availability based on rules. */
  ToolAvailabilityManager,
  /** Evaluates an availability expression. */
  evaluate,
  /** Boolean AND operator for availability rules. */
  allOf,
  /** Boolean OR operator for availability rules. */
  anyOf,
  /** Boolean NOT operator for availability rules. */
  not,
  /** Always true availability rule. */
  always,
  /** Always false availability rule. */
  never,
  /** Rule that limits tool use in early execution steps. */
  earlySteps,
  /** Rule that checks if the token budget is relaxed. */
  budgetRelaxed,
  /** Rule that checks if the budget is not critical. */
  budgetNotCritical,
  /** Expression to check task type. */
  taskType as taskTypeExpr,
  /** Rule that checks if a tool has not yet been used. */
  notYetUsed,
  /** Rule that checks if a task requires a specific tool. */
  requiresTool,
  /** Rule that limits tool use after a maximum number of errors. */
  maxErrors,
  /** Factory for creating default tool availability rules. */
  createDefaultRules,
} from './runtime/toolAvailability';
export type {
  /** Context provided to availability rules. */
  AvailabilityContext,
  /** DSL expression for defining tool availability. */
  AvailabilityExpression,
  /** Individual rule for tool availability. */
  ToolAvailabilityRule,
} from './runtime/toolAvailability';
export {
  /** Planner for generating optimal tool execution sequences. */
  ToolPlanner,
} from './runtime/toolPlanner';
export type {
  /** Generated plan for tool execution. */
  ExecutionPlan,
  /** Individual stage in a tool execution plan. */
  ExecutionStage,
  /** Dependency edge between tool stages. */
  DependencyEdge,
  /** Potential resource conflict in a plan. */
  ResourceConflict,
} from './runtime/toolPlanner';
export type {
  /** Interface for channel communication adapters. */
  ChannelAdapter,
  /** Configuration for a communication channel. */
  ChannelConfig,
  /** Message transmitted via a channel. */
  ChannelMessage,
  /** Current status of a channel connection. */
  ChannelStatus,
  /** Attachment in a channel message. */
  ChannelAttachment,
  /** Options for sending channel messages. */
  SendOptions,
  /** Role of a message sender (Agent, User, etc.). */
  MessageRole,
} from './runtime/channelAdapter';

// ============================================================================
// Topology & Workflow Optimization
// ============================================================================
export {
  /** Optimizer that uses reflexion to improve orchestration topologies. */
  ReflexionTopologicalOptimizer as TopologyOptimizer,
  /** Diagnostic information for a topology optimization run. */
  TopologyDiagnostics,
  /** Proposal for optimizing a task topology. */
  OptimizationProposal,
  /** Specific action to take for topology optimization. */
  OptimizationAction,
} from './ultimate/topologyOptimizer';
export {
  /** Adapter for integrating runtime execution with workflow definitions. */
  RuntimeWorkflowAdapter,
  /** Result of an adaptive workflow execution. */
  AdaptiveExecutionResult,
} from './ultimate/runtimeWorkflowAdapter';

// ============================================================================
// Plugin System — Hooks & Extensions
// ============================================================================
export {
  /** Central manager for registering and firing lifecycle hooks and plugins. */
  HookManager,
  /** Retrieves the singleton hook manager instance. */
  getHookManager,
  /** Resets the hook manager state. */
  resetHookManager,
  /** Factory for creating a standard logging plugin. */
  createLoggingPlugin,
} from './pluginManager';
export type {
  /** Interface for implementing a Commander framework plugin. */
  CommanderPlugin,
  /** Supported hook points in the framework lifecycle. */
  HookPoint,
  /** Context for the beforeToolCall hook. */
  BeforeToolCallContext,
  /** Context for the afterToolCall hook. */
  AfterToolCallContext,
  /** Context for the beforeLLMCall hook. */
  BeforeLLMCallContext,
  /** Context for the afterLLMCall hook. */
  AfterLLMCallContext,
  /** Context for the agentStart hook. */
  AgentStartContext,
  /** Context for the agentComplete hook. */
  AgentCompleteContext,
  /** Context for the error hook. */
  ErrorContext,
} from './pluginManager';

// ============================================================================
// TELOS Framework — Token-Efficient Low-waste Orchestration System (Phase 4)
// ============================================================================
export type {
  /** Token budget configuration for TELOS. */
  TELOSBudget,
  /** Result of a token budget check. */
  TokenCheckResult,
  /** Record of the cost for a single LLM call. */
  CostRecord,
  /** Summary of total costs for a run. */
  CostSummary,
  /** Alert triggered when budget thresholds are reached. */
  BudgetAlert,
  /** Context provided to the TELOS planner. */
  TELOSPlanContext,
  /** Assignment of an agent to a task within TELOS. */
  TELOSAgentAssignment,
  /** Supported orchestration modes in TELOS. */
  TELOSOrchestrationMode,
  /** Endpoint for an LLM provider in the TELOS pool. */
  ProviderEndpoint,
  /** Health status of a provider endpoint. */
  ProviderHealth,
  /** Result of a provider selection operation. */
  ProviderSelection,
  /** Chunk of data in a streaming LLM response. */
  StreamChunk,
  /** Callback function for processing stream chunks. */
  StreamCallback,
  /** Controller for managing active LLM streams. */
  StreamController,
  /** Main configuration for the TELOS framework. */
  TELOSConfig,
} from './telos/types';
export {
  /** Default configuration for the TELOS framework. */
  DEFAULT_TELOS_CONFIG,
} from './telos/types';
export {
  /** Sentinel for monitoring and enforcing token budgets. */
  TokenSentinel,
  /** Retrieves the singleton token sentinel instance. */
  getTokenSentinel,
  /** Resets the token sentinel state. */
  resetTokenSentinel,
  /** Estimates the token count for a text string. */
  estimateTokenCount,
  /** Estimates the token count for a message history. */
  estimateMessagesTokens,
  /** Calculates the financial cost of a run. */
  calculateCost,
  /** Pool for managing multiple LLM provider endpoints. */
  ProviderPool,
  /** Retrieves the singleton provider pool instance. */
  getProviderPool,
  /** Resets the provider pool state. */
  resetProviderPool,
  /** Main orchestrator for the TELOS framework. */
  TELOSOrchestrator,
  /** Evaluator that uses heuristics to select the best provider. */
  HeuristicEvaluator,
  /** Suite of evaluation criteria for provider selection. */
  EvalSuite,
  /** Retrieves the singleton heuristic evaluator instance. */
  getHeuristicEvaluator,
  /** Resets the heuristic evaluator state. */
  resetHeuristicEvaluator,
  /** Standard dimensions for evaluating model/provider quality. */
  EVALUATION_DIMENSIONS,
  /** Default criteria used for provider evaluation. */
  DEFAULT_EVAL_CRITERIA,
} from './telos';

// ============================================================================
// MCP — Model Context Protocol (Agent ↔ Tool communication standard)
// ============================================================================
export type {
  /** Definition of a tool exported via MCP. */
  MCPTool,
  /** Definition of a resource exported via MCP. */
  MCPResource,
  /** Definition of a prompt template exported via MCP. */
  MCPPrompt,
  /** Individual content item in an MCP response. */
  MCPContentItem,
  /** Result of an MCP tool execution. */
  MCPToolResult,
  /** Contents of an MCP resource. */
  MCPResourceContents,
  /** JSON schema used in MCP definitions. */
  MCPJsonSchema,
  /** Interface for implementing an MCP transport. */
  MCPTransport,
  /** Configuration for an MCP client. */
  MCPClientConfig,
  /** Standard JSON-RPC request. */
  JSONRPCRequest,
  /** Standard JSON-RPC response. */
  JSONRPCResponse,
  /** Standardized card representing an agent in A2A communication. */
  A2AAgentCard,
  /** JSON-RPC request specialized for Agent-to-Agent communication. */
  A2AJsonRpcRequest,
  /** JSON-RPC response specialized for Agent-to-Agent communication. */
  A2AJsonRpcResponse,
  /** Represents a task transmitted via the A2A protocol. */
  A2ATask,
  /** Lifecycle state of an A2A task. */
  A2ATaskState,
  /** Message exchanged between agents using the A2A protocol. */
  A2AMessage,
} from './mcp';
export {
  /** Client for interacting with MCP servers. */
  MCPClient,
  /** Transport implementation for MCP using standard input/output. */
  StdioClientTransport,
  /** Transport implementation for MCP using streaming HTTP. */
  StreamableHTTPClientTransport,
  /** Factory function for creating MCP clients. */
  createMCPClient,
  /** Base class for implementing an MCP server. */
  MCPServer,
  /** Standard error codes defined by the MCP protocol. */
  MCP_ERROR_CODES,
  /** Determines if an A2A task can transition between states. */
  canTransition,
  /** Well-known path for retrieving an agent's A2A card. */
  AGENT_CARD_WELL_KNOWN_PATH,
  /** Standard header for A2A protocol version. */
  A2A_VERSION_HEADER,
  /** Current version of the A2A protocol. */
  A2A_PROTOCOL_VERSION,
  /** Standard error messages for the A2A protocol. */
  A2A_ERROR,
  /** Supported methods in the A2A protocol. */
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
  /** Autonomous goal-driven execution with AgentRuntime, state persistence, and self-correction. */
  DriveOrchestrator,
  /** Configuration for drive mode. */
  DriveConfig,
  DEFAULT_DRIVE_CONFIG,
  /** Individual step in a drive execution plan. */
  DriveStep,
  /** Persisted state of a drive execution. */
  DriveState,
  /** Result of a complete drive execution. */
  DriveResult,
  DriveStatus,
} from './drive';

// Experimental — not yet wired into the main execution flow
export {
  /** @experimental Adaptive orchestrator with dynamic step planning. */
  DynamicOrchestrator,
} from './orchestration/dynamicOrchestrator';
export {
  /** @experimental Plugin discovery and loading system. */
  PluginLoader,
  getPluginLoader,
} from './pluginLoader';
export {
  /** @testing Deterministic mock LLM provider for unit tests. */
  MockLLMProvider,
  createMockProvider,
  createMockProviderWithTools,
} from './runtime/mockLLMProvider';
