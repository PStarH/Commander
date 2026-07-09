/**
 * Plugin Type Definitions — extracted from pluginManager.ts for modularity.
 *
 * All hook context interfaces, the CommanderPlugin interface, config schema,
 * and the SPI/tool-adapter types live here. HookManager lives in hookManager.ts;
 * the barrel re-export in pluginManager.ts preserves the public API.
 */

import type {
  ToolResult,
  LLMRequest,
  LLMResponse,
  AgentExecutionContext,
  AgentExecutionResult,
  Tool,
} from './runtime';
import type { ContentThreatSeverity } from './contentScanner';

// ============================================================================
// Hook Types
// ============================================================================

export type HookPoint =
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'beforeLLMCall'
  | 'afterLLMCall'
  | 'onAgentStart'
  | 'onAgentComplete'
  | 'onError'
  | 'beforeToolResolve'
  | 'afterToolResolve'
  | 'onToolTimeout'
  | 'onToolRetry'
  | 'beforeContextCompaction'
  | 'afterContextCompaction'
  | 'onSessionFork'
  | 'onSessionArchive'
  | 'onStepStart'
  | 'onStepComplete'
  | 'beforeBackendSelect'
  | 'afterBackendSelect';

export type PluginCategory =
  | 'monitoring'
  | 'security'
  | 'optimization'
  | 'integration'
  | 'analytics';

/** Context passed to beforeToolCall hooks */
export interface BeforeToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  runId: string;
  /** Full tool reference — available when the call originates from the
   * registered ToolRegistry. Plugins may use this to read definition metadata
   * (riskMetadata, category, etc.). May be undefined for synthetic contexts. */
  tool?: Tool;
}

/** Context passed to afterToolCall hooks */
export interface AfterToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  agentId: string;
  runId: string;
  /** Full tool reference (see BeforeToolCallContext). */
  tool?: Tool;
}

/** Context passed to beforeLLMCall hooks */
export interface BeforeLLMCallContext {
  request: LLMRequest;
  agentId: string;
  runId: string;
}

/** Context passed to afterLLMCall hooks */
export interface AfterLLMCallContext {
  request: LLMRequest;
  response: LLMResponse | null;
  agentId: string;
  runId: string;
}

/** Context passed to onAgentStart hooks */
export interface AgentStartContext {
  ctx: AgentExecutionContext;
  runId: string;
}

/** Context passed to onAgentComplete hooks */
export interface AgentCompleteContext {
  result: AgentExecutionResult;
  runId: string;
}

/** Context passed to onError hooks */
export interface ErrorContext {
  error: string;
  runId: string;
  agentId: string;
}

// ── Sprint 3: Extended hook contexts ──

/** Context passed to beforeToolResolve hooks */
export interface BeforeToolResolveContext {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  runId: string;
}

/** Context passed to afterToolResolve hooks */
export interface AfterToolResolveContext {
  toolName: string;
  args: Record<string, unknown>;
  /** The resolved tool, if found */
  tool?: { name: string; category?: string };
  /** If tool was not found */
  notFound: boolean;
  agentId: string;
  runId: string;
}

/** Context passed to onToolTimeout hooks */
export interface ToolTimeoutContext {
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  durationMs: number;
  agentId: string;
  runId: string;
}

/** Context passed to onToolRetry hooks */
export interface ToolRetryContext {
  toolName: string;
  args: Record<string, unknown>;
  attempt: number;
  maxRetries: number;
  lastError: string;
  agentId: string;
  runId: string;
}

/** Context passed to beforeContextCompaction / afterContextCompaction hooks */
export interface ContextCompactionContext {
  messageCount: number;
  totalTokens: number;
  budgetTokens: number;
  agentId: string;
  runId: string;
}

/** Context passed to onSessionFork hooks */
export interface SessionForkContext {
  parentRunId: string;
  childRunId: string;
  agentId: string;
  goal: string;
}

/** Context passed to onSessionArchive hooks */
export interface SessionArchiveContext {
  runId: string;
  phase: string;
  stepNumber: number;
  tokenUsage: { totalTokens: number };
}

/** Context passed to onStepStart / onStepComplete hooks */
export interface StepLifecycleContext {
  runId: string;
  agentId: string;
  stepNumber: number;
  type: 'thought' | 'tool_call' | 'tool_result' | 'response';
  content?: string;
}

/** Context passed to beforeBackendSelect hooks */
export interface BeforeBackendSelectContext {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  runId: string;
}

/** Context passed to afterBackendSelect hooks */
export interface AfterBackendSelectContext {
  toolName: string;
  args: Record<string, unknown>;
  selectedBackend: string;
  agentId: string;
  runId: string;
}

/** Union of all hook contexts */
export type HookContext =
  | BeforeToolCallContext
  | AfterToolCallContext
  | BeforeLLMCallContext
  | AfterLLMCallContext
  | AgentStartContext
  | AgentCompleteContext
  | ErrorContext
  | BeforeToolResolveContext
  | AfterToolResolveContext
  | ToolTimeoutContext
  | ToolRetryContext
  | ContextCompactionContext
  | SessionForkContext
  | SessionArchiveContext
  | StepLifecycleContext
  | BeforeBackendSelectContext
  | AfterBackendSelectContext;

// ============================================================================
// Plugin Config Schema
// ============================================================================

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  default?: unknown;
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigField>;
  required?: string[];
}

// ============================================================================
// Content Scanner Rule Declarations
// ============================================================================

export interface PluginContentScannerRuleDeclaration {
  category: string;
  severity: ContentThreatSeverity;
  /** RegExp source — serializable in JSON manifests. */
  pattern: string;
  flags?: string;
}

export interface PluginContentScannerRules {
  /** Inline rules declared directly in the manifest. */
  inline?: PluginContentScannerRuleDeclaration[];
  /** Reference to a module export containing HarmfulContentRule[] instances. */
  export?: {
    module: string;
    name: string;
  };
}

// ============================================================================
// Builtin Plugin Tool — declarative tool definition for built-in plugins
// ============================================================================

/**
 * A tool that a builtin CommanderPlugin can declare via its `tools` field.
 * Mirrors the subset of the SDK's PluginTool that the runtime needs to wire a
 * tool into the ToolRegistry: a definition (name/description/schema) plus an
 * async execute() handler.
 */
export interface BuiltinPluginTool {
  /** Tool name (unique within the plugin). */
  name: string;
  /** Description shown to the LLM. */
  description: string;
  /** JSON Schema for the tool's input arguments. */
  inputSchema: Record<string, unknown>;
  /** Execute the tool with validated arguments; return a string result. */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ============================================================================
// SPI — Service Provider Interface declarations
// ============================================================================

/**
 * A service implementation a plugin provides. This is the SPI mechanism that
 * lets plugins declare "I provide the MemoryStore implementation" or
 * "I provide the ExecutionScheduler" rather than only being able to
 * intercept/modify via hooks. The host resolves providers via
 * `HookManager.getService(serviceId)`.
 *
 * Resolution order: enabled plugins are queried in registration order; the
 * first non-null implementation wins. This keeps the model simple and
 * deterministic while allowing later-registered plugins to layer on top
 * via hooks if needed.
 */
export interface PluginServiceDeclaration {
  /** Stable service identifier (e.g. "memory.store", "execution.scheduler"). */
  service: string;
  /** The implementation object. Typed as unknown; callers cast. */
  implementation: unknown;
  /** Optional human-readable description of what this provider offers. */
  description?: string;
}

// ============================================================================
// Plugin Load Context — built by HookManager.buildSandboxedLoadContext()
// ============================================================================

// Forward-declared via `import type` below to avoid a circular runtime import:
// HookManager references PluginLoadContext (here), and PluginLoadContext
// references HookManager (type-only, so this is safe with `import type`).
import type { HookManager } from './hookManager';

export interface PluginLoadContext {
  config: Record<string, unknown>;
  /**
   * Raw HookManager reference.
   * @deprecated — When a plugin declares permissions (loaded via PluginLoader),
   * this field is intentionally omitted to prevent privilege escalation.
   * Plugins should use the sandbox context methods (readFile, writeFile, fetch,
   * getEnvVar, registerHook, log) provided alongside this context instead.
   * Only present for built-in plugins registered directly without permissions.
   */
  hookManager?: HookManager;
}

// ============================================================================
// Plugin Interface
// ============================================================================

export interface CommanderPlugin {
  /** Plugin name (must be unique) */
  name: string;
  /** Plugin version */
  version?: string;
  /** Plugin description */
  description?: string;
  /** Plugin category for discovery and grouping */
  category?: PluginCategory;
  /** Plugins this plugin depends on (resolved before this plugin's hooks fire) */
  dependsOn?: string[];
  /** Config schema for validation */
  configSchema?: PluginConfigSchema;
  /** Content scanner rules contributed by this plugin. */
  contentScannerRules?: PluginContentScannerRules;

  /** Called when the plugin is loaded (after registration). Can reject to fail registration. */
  onLoad?: (ctx: PluginLoadContext) => Promise<void> | void;
  /** Called when the plugin is unloaded. Cleanup resources here. */
  onUnload?: () => Promise<void> | void;

  /** Called before a tool is executed. Return null to allow, or a ToolResult to block/override. */
  beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<ToolResult | null> | ToolResult | null;
  /** Called after a tool is executed. Can modify the result. */
  afterToolCall?: (ctx: AfterToolCallContext) => Promise<ToolResult> | ToolResult;
  /** Called before an LLM call. Can modify the request. */
  beforeLLMCall?: (ctx: BeforeLLMCallContext) => Promise<LLMRequest> | LLMRequest;
  /** Called after an LLM call. Can modify the response. */
  afterLLMCall?: (ctx: AfterLLMCallContext) => Promise<AfterLLMCallContext> | AfterLLMCallContext;
  /** Called when an agent starts execution */
  onAgentStart?: (ctx: AgentStartContext) => Promise<void> | void;
  /** Called when an agent completes execution */
  onAgentComplete?: (ctx: AgentCompleteContext) => Promise<void> | void;
  /** If true, plugin hook failures will abort the operation instead of being silently swallowed. */
  required?: boolean;

  /** Called when an error occurs */
  onError?: (ctx: ErrorContext) => Promise<void> | void;

  // ── Sprint 3: Interceptor hooks ──

  /** Called before resolving a tool from the registry. Can short-circuit by returning a ToolResult to block. */
  beforeToolResolve?: (
    ctx: BeforeToolResolveContext,
  ) => Promise<ToolResult | null> | ToolResult | null;
  /** Called after a tool is resolved from the registry. Tool may be not found. */
  afterToolResolve?: (ctx: AfterToolResolveContext) => Promise<void> | void;
  /** Called when a tool execution times out. */
  onToolTimeout?: (ctx: ToolTimeoutContext) => Promise<void> | void;
  /** Called before retrying a failed tool call. */
  onToolRetry?: (ctx: ToolRetryContext) => Promise<void> | void;
  /** Called before context compaction (message trimming). */
  beforeContextCompaction?: (ctx: ContextCompactionContext) => Promise<void> | void;
  /** Called after context compaction is applied. */
  afterContextCompaction?: (ctx: ContextCompactionContext) => Promise<void> | void;
  /** Called when a sub-agent session is forked from the parent. */
  onSessionFork?: (ctx: SessionForkContext) => Promise<void> | void;
  /** Called when a session state is archived/checkpointed. */
  onSessionArchive?: (ctx: SessionArchiveContext) => Promise<void> | void;
  /** Called when a single execution step starts. */
  onStepStart?: (ctx: StepLifecycleContext) => Promise<void> | void;
  /** Called when a single execution step completes. */
  onStepComplete?: (ctx: StepLifecycleContext) => Promise<void> | void;
  /** Called before execution backend is selected for a tool call. Can override by returning a backend name. */
  beforeBackendSelect?: (ctx: BeforeBackendSelectContext) => Promise<string | null> | string | null;
  /** Called after execution backend is selected. */
  afterBackendSelect?: (ctx: AfterBackendSelectContext) => Promise<void> | void;

  /**
   * Optional tools declared by this builtin plugin. The host (API / runtime)
   * can read this list and wire the tools into the ToolRegistry so the LLM can
   * invoke them. Each tool is self-contained: name, description, JSON-Schema
   * input, and an async execute() returning a string result.
   *
   * This field is additive — existing plugins that do not set it are unaffected.
   */
  tools?: BuiltinPluginTool[];

  /**
   * SPI: services this plugin provides. Lets a plugin declare "I provide the
   * MemoryStore implementation" or "I provide the ExecutionScheduler" rather
   * than only being able to intercept/modify via hooks. The host resolves
   * providers via `HookManager.getService(serviceId)`.
   *
   * Resolution order: enabled plugins are queried in registration order; the
   * first non-null implementation wins. This keeps the model simple and
   * deterministic while allowing later-registered plugins to layer on top
   * via hooks if needed.
   *
   * This is the primary mechanism for abstracting out memory / atr /
   * intelligence into pluggable providers without requiring host code changes.
   */
  provides?: PluginServiceDeclaration[];
}

// ============================================================================
// Plugin Entry (internal wrapper used by HookManager)
// ============================================================================

export interface PluginEntry {
  plugin: CommanderPlugin;
  enabled: boolean;
  config: Record<string, unknown>;
}

// ============================================================================
// Builtin Plugin Tool Adapter
// ============================================================================

/**
 * Adapt a builtin plugin's declarative tool into Commander's internal Tool
 * interface so the host can register it with the ToolRegistry and the LLM
 * can invoke it. Tool names are namespaced as `${pluginName}__${toolName}`
 * to avoid collisions between plugins and with built-in tools.
 */
export function adaptBuiltinPluginTool(pluginName: string, builtinTool: BuiltinPluginTool): Tool {
  const namespacedName = `${pluginName}__${builtinTool.name}`;
  return {
    definition: {
      name: namespacedName,
      description: builtinTool.description,
      inputSchema: builtinTool.inputSchema,
      category: `plugin:${pluginName}`,
    },
    execute: async (args) => builtinTool.execute(args),
    // Plugin tools run in the host process; treat as non-concurrent + read-only
    // by default. Plugins that need different flags should register a Tool
    // directly with the ToolRegistry instead of using the declarative field.
    isConcurrencySafe: false,
    isReadOnly: false,
    timeout: 0,
    maxOutputSize: 10000,
  };
}
