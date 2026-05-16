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
// Plugin Interface
// ============================================================================

/**
 * A Commander plugin.
 * Hooks are optional — only implement what you need.
 */
export interface CommanderPlugin {
  /** Plugin name (must be unique) */
  name: string;
  /** Plugin version */
  version?: string;
  /** Plugin description */
  description?: string;

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
// Hook Manager
// ============================================================================

export class HookManager {
  private plugins: Map<string, CommanderPlugin> = new Map();

  /**
   * Register a plugin.
   * Throws if a plugin with the same name is already registered.
   */
  register(plugin: CommanderPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Unregister a plugin by name.
   * Returns true if the plugin was found and removed.
   */
  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  /** Get all registered plugin names */
  listPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  /** Check if a plugin is registered */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  /** Get a specific plugin by name */
  getPlugin(name: string): CommanderPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Fire 'beforeToolCall' hooks.
   * Hooks run in registration order. If any hook returns a non-null ToolResult,
   * subsequent hooks are skipped and the returned result is used.
   * This allows plugins to block or override tool calls.
   */
  async fireBeforeToolCall(ctx: BeforeToolCallContext): Promise<ToolResult | null> {
    for (const plugin of this.plugins.values()) {
      if (plugin.beforeToolCall) {
        const result = await plugin.beforeToolCall(ctx);
        if (result !== null) return result;
      }
    }
    return null;
  }

  /**
   * Fire 'afterToolCall' hooks.
   * Each hook can transform the result. Hooks run in registration order,
   * with each hook receiving the previous hook's output.
   */
  async fireAfterToolCall(ctx: AfterToolCallContext): Promise<ToolResult> {
    let currentResult = ctx.result;
    for (const plugin of this.plugins.values()) {
      if (plugin.afterToolCall) {
        currentResult = await plugin.afterToolCall({ ...ctx, result: currentResult });
      }
    }
    return currentResult;
  }

  /**
   * Fire 'beforeLLMCall' hooks.
   * Each hook can modify the request. Hooks run in registration order,
   * with each hook receiving the previous hook's output.
   */
  async fireBeforeLLMCall(ctx: BeforeLLMCallContext): Promise<LLMRequest> {
    let currentRequest = ctx.request;
    for (const plugin of this.plugins.values()) {
      if (plugin.beforeLLMCall) {
        currentRequest = await plugin.beforeLLMCall({ ...ctx, request: currentRequest });
      }
    }
    return currentRequest;
  }

  /**
   * Fire 'afterLLMCall' hooks.
   */
  async fireAfterLLMCall(ctx: AfterLLMCallContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.afterLLMCall) {
        await plugin.afterLLMCall(ctx);
      }
    }
  }

  /**
   * Fire 'onAgentStart' hooks.
   */
  async fireOnAgentStart(ctx: AgentStartContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.onAgentStart) {
        await plugin.onAgentStart(ctx);
      }
    }
  }

  /**
   * Fire 'onAgentComplete' hooks.
   */
  async fireOnAgentComplete(ctx: AgentCompleteContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.onAgentComplete) {
        await plugin.onAgentComplete(ctx);
      }
    }
  }

  /**
   * Fire 'onError' hooks.
   */
  async fireOnError(ctx: ErrorContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.onError) {
        await plugin.onError(ctx);
      }
    }
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

/**
 * Create a logging plugin that prints hook activity to console.
 */
export function createLoggingPlugin(): CommanderPlugin {
  return {
    name: 'builtin-logger',
    description: 'Logs all hook activity to console',
    version: '0.1.0',
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