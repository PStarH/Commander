import type { ToolCall, ToolResult, LLMRequest, LLMResponse, AgentExecutionContext, AgentExecutionResult } from './runtime/types';

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
  | 'onError';

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

/** Union of all hook contexts */
export type HookContext =
  | BeforeToolCallContext
  | AfterToolCallContext
  | BeforeLLMCallContext
  | AfterLLMCallContext
  | AgentStartContext
  | AgentCompleteContext
  | ErrorContext;

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
  /** Called when an error occurs */
  onError?: (ctx: ErrorContext) => Promise<void> | void;
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

  setHookTimeout(ms: number): void { this.hookTimeoutMs = ms; }
  getHookTimeout(): number { return this.hookTimeoutMs; }

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
        throw new Error(`Plugin "${plugin.name}" onLoad failed: ${err instanceof Error ? err.message : String(err)}`);
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
      try { await entry.plugin.onUnload(); } catch { /* ok */ }
    }
    this.plugins.delete(name);
    return true;
  }

  /** Get all registered plugin names */
  listPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  /** Get detailed plugin info */
  getPluginInfo(name: string): { plugin: CommanderPlugin; enabled: boolean; config: Record<string, unknown> } | undefined {
    const entry = this.plugins.get(name);
    if (!entry) return undefined;
    return { plugin: entry.plugin, enabled: entry.enabled, config: { ...entry.config } };
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
    // Re-trigger onLoad so plugin can react to config changes
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
    return this.getDependencyOrder().filter(name => this.plugins.get(name)?.enabled);
  }

  // ── Hook firing (with dep ordering + enabled check) ──

  async fireBeforeToolCall(ctx: BeforeToolCallContext): Promise<ToolResult | null> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.beforeToolCall) {
        try {
          const result = await this.withTimeout(plugin.beforeToolCall(ctx), plugin.name, 'beforeToolCall');
          if (result !== null) return result;
        } catch { /* skip */ }
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
          currentResult = await this.withTimeout(plugin.afterToolCall({ ...ctx, result: currentResult }), plugin.name, 'afterToolCall');
        } catch { /* keep previous */ }
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
          currentRequest = await this.withTimeout(plugin.beforeLLMCall({ ...ctx, request: currentRequest }), plugin.name, 'beforeLLMCall');
        } catch { /* keep previous */ }
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
        } catch { /* continue */ }
      }
    }
  }

  async fireOnAgentStart(ctx: AgentStartContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onAgentStart) {
        try {
          await this.withTimeout(plugin.onAgentStart(ctx), plugin.name, 'onAgentStart');
        } catch { /* continue */ }
      }
    }
  }

  async fireOnAgentComplete(ctx: AgentCompleteContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onAgentComplete) {
        try {
          await this.withTimeout(plugin.onAgentComplete(ctx), plugin.name, 'onAgentComplete');
        } catch { /* continue */ }
      }
    }
  }

  async fireOnError(ctx: ErrorContext): Promise<void> {
    for (const name of this.getEnabledInOrder()) {
      const plugin = this.plugins.get(name)!.plugin;
      if (plugin.onError) {
        try {
          await this.withTimeout(plugin.onError(ctx), plugin.name, 'onError');
        } catch { /* continue */ }
      }
    }
  }

  // ── Config validation ──

  private validateAndMergeConfig(plugin: CommanderPlugin, config: Record<string, unknown>): Record<string, unknown> {
    const schema = plugin.configSchema;
    if (!schema) return { ...config };

    const merged: Record<string, unknown> = { ...config };

    // Apply defaults and validate types
    for (const [key, field] of Object.entries(schema.properties)) {
      const value = key in merged ? merged[key] : field.default;
      if (value !== undefined) {
        if (typeof value !== field.type && field.type !== 'array' && field.type !== 'object') {
          throw new Error(`Plugin "${plugin.name}" config "${key}": expected ${field.type}, got ${typeof value}`);
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
  private withTimeout<T>(promise: Promise<T> | T, pluginName: string, hookName: string): Promise<T> {
    if (typeof promise !== 'object' || promise === null || !('then' in promise)) {
      return Promise.resolve(promise);
    }
    return Promise.race([
      promise as Promise<T>,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Plugin "${pluginName}" hook "${hookName}" timed out after ${this.hookTimeoutMs}ms`)), this.hookTimeoutMs);
      }),
    ]);
  }
}

// ============================================================================
// Global Singleton
// ============================================================================

let globalHookManager: HookManager | null = null;

export function getHookManager(): HookManager {
  if (!globalHookManager) {
    globalHookManager = new HookManager();
  }
  return globalHookManager;
}

export function resetHookManager(): void {
  globalHookManager = null;
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
      console.log(`${prefix} loaded (verbose=${ctx.config.verbose})`);
    },
    beforeToolCall: async (ctx) => {
      console.log(`[Plugin:logger] beforeToolCall: ${ctx.toolName}`);
      return null;
    },
    onAgentStart: async (ctx) => {
      console.log(`[Plugin:logger] Agent started: ${ctx.ctx.agentId}, goal: ${ctx.ctx.goal.slice(0, 60)}...`);
    },
    onAgentComplete: async (ctx) => {
      console.log(`[Plugin:logger] Agent completed: ${ctx.result.status}`);
    },
    onError: async (ctx) => {
      console.error(`[Plugin:logger] Error: ${ctx.error.slice(0, 100)}`);
    },
  };
}
