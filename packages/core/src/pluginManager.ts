import { reportSilentFailure } from './silentFailureReporter';
import type {
  ToolResult,
  LLMRequest,
  LLMResponse,
  AgentExecutionContext,
  AgentExecutionResult,
} from './runtime/types';
import { getGlobalLogger } from './logging';
import { getMetricsCollector } from './runtime/metricsCollector';

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
}

/** Context passed to afterToolCall hooks */
export interface AfterToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  agentId: string;
  runId: string;
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

export interface PluginLoadContext {
  config: Record<string, unknown>;
  hookManager: HookManager;
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
}

// ============================================================================
// Plugin Entry (internal wrapper)
// ============================================================================

interface PluginEntry {
  plugin: CommanderPlugin;
  enabled: boolean;
  config: Record<string, unknown>;
}

// ============================================================================
// Hook Manager
// ============================================================================

export class HookManager {
  private plugins: Map<string, PluginEntry> = new Map();
  private hookTimeoutMs = 5000;

  setHookTimeout(ms: number): void {
    this.hookTimeoutMs = ms;
  }
  getHookTimeout(): number {
    return this.hookTimeoutMs;
  }

  /**
   * Register a plugin with optional config.
   * Validates config schema, resolves dependencies, calls onLoad().
   * Throws if a plugin with the same name is already registered.
   */
  async register(plugin: CommanderPlugin, config: Record<string, unknown> = {}): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    // Validate dependencies are registered (but not necessarily loaded yet)
    if (plugin.dependsOn) {
      for (const dep of plugin.dependsOn) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Plugin "${plugin.name}" depends on "${dep}" which is not registered`);
        }
      }
    }

    // Validate config against schema
    const mergedConfig = this.validateAndMergeConfig(plugin, config);

    const entry: PluginEntry = {
      plugin,
      enabled: true,
      config: mergedConfig,
    };

    this.plugins.set(plugin.name, entry);

    // Call onLoad lifecycle hook
    if (plugin.onLoad) {
      try {
        await plugin.onLoad({ config: mergedConfig, hookManager: this });
      } catch (err) {
        this.plugins.delete(plugin.name);
        throw new Error(
          `Plugin "${plugin.name}" onLoad failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Unregister a plugin by name.
   * Calls onUnload lifecycle hook.
   * Returns true if the plugin was found and removed.
   */
  async unregister(name: string): Promise<boolean> {
    const entry = this.plugins.get(name);
    if (!entry) return false;
    if (entry.plugin.onUnload) {
      try {
        await entry.plugin.onUnload();
      } catch (err) {
        reportSilentFailure(err, 'pluginManager:381');
        getGlobalLogger().warn('PluginManager', `Plugin "${name}" onUnload failed`);
      }
    }
    this.plugins.delete(name);
    return true;
  }

  /** Get all registered plugin names */
  listPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  /** Get detailed plugin info */
  getPluginInfo(
    name: string,
  ): { plugin: CommanderPlugin; enabled: boolean; config: Record<string, unknown> } | undefined {
    const entry = this.plugins.get(name);
    if (!entry) return undefined;
    return { plugin: entry.plugin, enabled: entry.enabled, config: { ...entry.config } };
  }

  /** Get all plugins in a specific category */
  getPluginsByCategory(category: PluginCategory): CommanderPlugin[] {
    const result: CommanderPlugin[] = [];
    for (const entry of this.plugins.values()) {
      if (entry.plugin.category === category) {
        result.push(entry.plugin);
      }
    }
    return result;
  }

  /** Get all registered categories */
  getCategories(): PluginCategory[] {
    const categories = new Set<PluginCategory>();
    for (const entry of this.plugins.values()) {
      if (entry.plugin.category) {
        categories.add(entry.plugin.category);
      }
    }
    return Array.from(categories);
  }

  /** Check if a plugin is registered */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  /** Get a specific plugin by name */
  getPlugin(name: string): CommanderPlugin | undefined {
    return this.plugins.get(name)?.plugin;
  }

  // ── Runtime enable/disable ──

  enable(name: string): boolean {
    const entry = this.plugins.get(name);
    if (!entry) return false;
    entry.enabled = true;
    return true;
  }

  disable(name: string): boolean {
    const entry = this.plugins.get(name);
    if (!entry) return false;
    entry.enabled = false;
    return true;
  }

  isEnabled(name: string): boolean {
    return this.plugins.get(name)?.enabled ?? false;
  }

  // ── Config ──

  getConfig(name: string): Record<string, unknown> | undefined {
    return this.plugins.get(name)?.config;
  }

  async updateConfig(name: string, config: Record<string, unknown>): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`Plugin "${name}" not found`);
    const merged = this.validateAndMergeConfig(entry.plugin, config);
    entry.config = merged;
    // Unload old config first, then re-load with new config
    if (entry.plugin.onUnload) {
      await entry.plugin.onUnload();
    }
    if (entry.plugin.onLoad) {
      await entry.plugin.onLoad({ config: merged, hookManager: this });
    }
  }

  // ── Dependency ordering ──

  /**
   * Topological sort of registered plugins by dependency.
   * Throws if a circular dependency is detected.
   */
  getDependencyOrder(): string[] {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const order: string[] = [];

    const visit = (name: string) => {
      if (inStack.has(name)) {
        throw new Error(`Circular plugin dependency detected involving "${name}"`);
      }
      if (visited.has(name)) return;
      inStack.add(name);
      visited.add(name);
      const entry = this.plugins.get(name);
      if (entry?.plugin.dependsOn) {
        for (const dep of entry.plugin.dependsOn) {
          if (this.plugins.has(dep)) visit(dep);
        }
      }
      inStack.delete(name);
      order.push(name);
    };

    for (const name of this.plugins.keys()) {
      if (!visited.has(name)) visit(name);
    }
    return order;
  }

  /** Get enabled plugin names in dependency order */
  private getEnabledInOrder(): string[] {
    return this.getDependencyOrder().filter((name) => this.plugins.get(name)?.enabled);
  }

  // ── Hook firing (with dep ordering + enabled check) ──

  async fireBeforeToolCall(ctx: BeforeToolCallContext): Promise<ToolResult | null> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.beforeToolCall) {
        try {
          const result = await this.withTimeout(
            plugin.beforeToolCall(ctx),
            plugin.name,
            'beforeToolCall',
          );
          if (result !== null) return result;
          getMetricsCollector().recordHookSuccess('beforeToolCall', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('beforeToolCall', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" beforeToolCall failed`);
        }
      }
    }
    return null;
  }

  async fireAfterToolCall(ctx: AfterToolCallContext): Promise<ToolResult> {
    let currentResult = ctx.result;
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.afterToolCall) {
        try {
          currentResult = await this.withTimeout(
            plugin.afterToolCall({ ...ctx, result: currentResult }),
            plugin.name,
            'afterToolCall',
          );
          getMetricsCollector().recordHookSuccess('afterToolCall', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('afterToolCall', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" afterToolCall failed`);
        }
      }
    }
    return currentResult;
  }

  async fireBeforeLLMCall(ctx: BeforeLLMCallContext): Promise<LLMRequest> {
    let currentRequest = ctx.request;
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.beforeLLMCall) {
        try {
          currentRequest = await this.withTimeout(
            plugin.beforeLLMCall({ ...ctx, request: currentRequest }),
            plugin.name,
            'beforeLLMCall',
          );
          getMetricsCollector().recordHookSuccess('beforeLLMCall', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('beforeLLMCall', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" beforeLLMCall failed`);
        }
      }
    }
    return currentRequest;
  }

  async fireAfterLLMCall(ctx: AfterLLMCallContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.afterLLMCall) {
        try {
          await this.withTimeout(plugin.afterLLMCall(ctx), plugin.name, 'afterLLMCall');
          getMetricsCollector().recordHookSuccess('afterLLMCall', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('afterLLMCall', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" afterLLMCall failed`);
        }
      }
    }
  }

  async fireOnAgentStart(ctx: AgentStartContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onAgentStart) {
        try {
          await this.withTimeout(plugin.onAgentStart(ctx), plugin.name, 'onAgentStart');
          getMetricsCollector().recordHookSuccess('onAgentStart', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onAgentStart', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onAgentStart failed`);
        }
      }
    }
  }

  async fireOnAgentComplete(ctx: AgentCompleteContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onAgentComplete) {
        try {
          await this.withTimeout(plugin.onAgentComplete(ctx), plugin.name, 'onAgentComplete');
          getMetricsCollector().recordHookSuccess('onAgentComplete', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onAgentComplete', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onAgentComplete failed`);
        }
      }
    }
  }

  async fireOnError(ctx: ErrorContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onError) {
        try {
          await this.withTimeout(plugin.onError(ctx), plugin.name, 'onError');
          getMetricsCollector().recordHookSuccess('onError', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onError', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onError failed`);
        }
      }
    }
  }

  // ── Sprint 3: Interceptor hook firing ──

  async fireBeforeToolResolve(ctx: BeforeToolResolveContext): Promise<ToolResult | null> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.beforeToolResolve) {
        try {
          const result = await this.withTimeout(
            plugin.beforeToolResolve(ctx),
            plugin.name,
            'beforeToolResolve',
          );
          if (result !== null) return result;
          getMetricsCollector().recordHookSuccess('beforeToolResolve', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('beforeToolResolve', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" beforeToolResolve failed`);
        }
      }
    }
    return null;
  }

  async fireAfterToolResolve(ctx: AfterToolResolveContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.afterToolResolve) {
        try {
          await this.withTimeout(plugin.afterToolResolve(ctx), plugin.name, 'afterToolResolve');
          getMetricsCollector().recordHookSuccess('afterToolResolve', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('afterToolResolve', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" afterToolResolve failed`);
        }
      }
    }
  }

  async fireOnToolTimeout(ctx: ToolTimeoutContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onToolTimeout) {
        try {
          await this.withTimeout(plugin.onToolTimeout(ctx), plugin.name, 'onToolTimeout');
          getMetricsCollector().recordHookSuccess('onToolTimeout', name);
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onToolTimeout', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onToolTimeout failed`);
        }
      }
    }
  }

  async fireOnToolRetry(ctx: ToolRetryContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onToolRetry) {
        try {
          await this.withTimeout(plugin.onToolRetry(ctx), plugin.name, 'onToolRetry');
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onToolRetry', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onToolRetry failed`);
        }
      }
    }
  }

  async fireBeforeContextCompaction(ctx: ContextCompactionContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.beforeContextCompaction) {
        try {
          await this.withTimeout(
            plugin.beforeContextCompaction(ctx),
            plugin.name,
            'beforeContextCompaction',
          );
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('beforeContextCompaction', name);
          getGlobalLogger().warn(
            'PluginManager',
            `Plugin "${name}" beforeContextCompaction failed`,
          );
        }
      }
    }
  }

  async fireAfterContextCompaction(ctx: ContextCompactionContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.afterContextCompaction) {
        try {
          await this.withTimeout(
            plugin.afterContextCompaction(ctx),
            plugin.name,
            'afterContextCompaction',
          );
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('afterContextCompaction', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" afterContextCompaction failed`);
        }
      }
    }
  }

  async fireOnSessionFork(ctx: SessionForkContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onSessionFork) {
        try {
          await this.withTimeout(plugin.onSessionFork(ctx), plugin.name, 'onSessionFork');
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onSessionFork', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onSessionFork failed`);
        }
      }
    }
  }

  async fireOnSessionArchive(ctx: SessionArchiveContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onSessionArchive) {
        try {
          await this.withTimeout(plugin.onSessionArchive(ctx), plugin.name, 'onSessionArchive');
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onSessionArchive', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onSessionArchive failed`);
        }
      }
    }
  }

  async fireOnStepStart(ctx: StepLifecycleContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onStepStart) {
        try {
          await this.withTimeout(plugin.onStepStart(ctx), plugin.name, 'onStepStart');
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onStepStart', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onStepStart failed`);
        }
      }
    }
  }

  async fireOnStepComplete(ctx: StepLifecycleContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onStepComplete) {
        try {
          await this.withTimeout(plugin.onStepComplete(ctx), plugin.name, 'onStepComplete');
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('onStepComplete', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" onStepComplete failed`);
        }
      }
    }
  }

  async fireBeforeBackendSelect(ctx: BeforeBackendSelectContext): Promise<string | null> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.beforeBackendSelect) {
        try {
          const result = await this.withTimeout(
            plugin.beforeBackendSelect(ctx),
            plugin.name,
            'beforeBackendSelect',
          );
          if (result !== null) return result;
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('beforeBackendSelect', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" beforeBackendSelect failed`);
        }
      }
    }
    return null;
  }

  async fireAfterBackendSelect(ctx: AfterBackendSelectContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.afterBackendSelect) {
        try {
          await this.withTimeout(plugin.afterBackendSelect(ctx), plugin.name, 'afterBackendSelect');
        } catch (err) {
          if (plugin.required) throw err;
          getMetricsCollector().recordHookFailure('afterBackendSelect', name);
          getGlobalLogger().warn('PluginManager', `Plugin "${name}" afterBackendSelect failed`);
        }
      }
    }
  }

  // ── Config validation ──

  private validateAndMergeConfig(
    plugin: CommanderPlugin,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = plugin.configSchema;
    if (!schema) return { ...config };

    const merged: Record<string, unknown> = { ...config };

    // Apply defaults and validate types
    for (const [key, field] of Object.entries(schema.properties)) {
      const value = key in merged ? merged[key] : field.default;
      if (value !== undefined) {
        if (field.type === 'array' && !Array.isArray(value)) {
          throw new Error(
            `Plugin "${plugin.name}" config "${key}": expected array, got ${typeof value}`,
          );
        }
        if (typeof value !== field.type && field.type !== 'array' && field.type !== 'object') {
          throw new Error(
            `Plugin "${plugin.name}" config "${key}": expected ${field.type}, got ${typeof value}`,
          );
        }
        merged[key] = value;
      }
    }

    // Check required fields
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in merged) || merged[key] === undefined) {
          throw new Error(`Plugin "${plugin.name}" config "${key}" is required`);
        }
      }
    }

    return merged;
  }

  /** Wrap a plugin hook promise with a timeout. */
  private withTimeout<T>(
    promise: Promise<T> | T,
    pluginName: string,
    hookName: string,
  ): Promise<T> {
    if (typeof promise !== 'object' || promise === null || !('then' in promise)) {
      return Promise.resolve(promise);
    }
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      (promise as Promise<T>).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Plugin "${pluginName}" hook "${hookName}" timed out after ${this.hookTimeoutMs}ms`,
              ),
            ),
          this.hookTimeoutMs,
        );
        timer.unref();
      }),
    ]);
  }
}

// ============================================================================
import { createTenantAwareSingleton } from './runtime/tenantAwareSingleton';

const hookManagerSingleton = createTenantAwareSingleton(() => new HookManager());

export function getHookManager(): HookManager {
  return hookManagerSingleton.get();
}

export function resetHookManager(): void {
  hookManagerSingleton.reset();
}

// ============================================================================
// Built-in plugins
// ============================================================================

export function createLoggingPlugin(): CommanderPlugin {
  return {
    name: 'builtin-logger',
    description: 'Logs all hook activity to console',
    version: '0.1.0',
    configSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Log all hook points', default: false },
        prefix: { type: 'string', description: 'Log prefix', default: '[Plugin:logger]' },
      },
    },
    onLoad: async (ctx) => {
      const prefix = (ctx.config.prefix as string) ?? '[Plugin:logger]';
      getGlobalLogger().info('PluginManager', `${prefix} loaded (verbose=${ctx.config.verbose})`);
    },
    beforeToolCall: async (ctx) => {
      getGlobalLogger().info('PluginManager', `[Plugin:logger] beforeToolCall: ${ctx.toolName}`);
      return null;
    },
    onAgentStart: async (ctx) => {
      getGlobalLogger().info(
        'PluginManager',
        `[Plugin:logger] Agent started: ${ctx.ctx.agentId}, goal: ${ctx.ctx.goal.slice(0, 60)}...`,
      );
    },
    onAgentComplete: async (ctx) => {
      getGlobalLogger().info(
        'PluginManager',
        `[Plugin:logger] Agent completed: ${ctx.result.status}`,
      );
    },
    onError: async (ctx) => {
      getGlobalLogger().error('PluginManager', `[Plugin:logger] Error: ${ctx.error.slice(0, 100)}`);
    },
  };
}
