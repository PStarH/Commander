import type { ToolResult, LLMRequest, LLMResponse, AgentExecutionContext, AgentExecutionResult } from './runtime/types';
export type HookPoint = 'beforeToolCall' | 'afterToolCall' | 'beforeLLMCall' | 'afterLLMCall' | 'onAgentStart' | 'onAgentComplete' | 'onError' | 'beforeToolResolve' | 'afterToolResolve' | 'onToolTimeout' | 'onToolRetry' | 'beforeContextCompaction' | 'afterContextCompaction' | 'onSessionFork' | 'onSessionArchive' | 'onStepStart' | 'onStepComplete' | 'beforeBackendSelect' | 'afterBackendSelect';
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
    tool?: {
        name: string;
        category?: string;
    };
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
    tokenUsage: {
        totalTokens: number;
    };
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
export type HookContext = BeforeToolCallContext | AfterToolCallContext | BeforeLLMCallContext | AfterLLMCallContext | AgentStartContext | AgentCompleteContext | ErrorContext | BeforeToolResolveContext | AfterToolResolveContext | ToolTimeoutContext | ToolRetryContext | ContextCompactionContext | SessionForkContext | SessionArchiveContext | StepLifecycleContext | BeforeBackendSelectContext | AfterBackendSelectContext;
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
    /** If true, plugin hook failures will abort the operation instead of being silently swallowed. */
    required?: boolean;
    /** Called when an error occurs */
    onError?: (ctx: ErrorContext) => Promise<void> | void;
    /** Called before resolving a tool from the registry. Can short-circuit by returning a ToolResult to block. */
    beforeToolResolve?: (ctx: BeforeToolResolveContext) => Promise<ToolResult | null> | ToolResult | null;
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
export declare class HookManager {
    private plugins;
    private hookTimeoutMs;
    setHookTimeout(ms: number): void;
    getHookTimeout(): number;
    /**
     * Register a plugin with optional config.
     * Validates config schema, resolves dependencies, calls onLoad().
     * Throws if a plugin with the same name is already registered.
     */
    register(plugin: CommanderPlugin, config?: Record<string, unknown>): Promise<void>;
    /**
     * Unregister a plugin by name.
     * Calls onUnload lifecycle hook.
     * Returns true if the plugin was found and removed.
     */
    unregister(name: string): Promise<boolean>;
    /** Get all registered plugin names */
    listPlugins(): string[];
    /** Get detailed plugin info */
    getPluginInfo(name: string): {
        plugin: CommanderPlugin;
        enabled: boolean;
        config: Record<string, unknown>;
    } | undefined;
    /** Check if a plugin is registered */
    hasPlugin(name: string): boolean;
    /** Get a specific plugin by name */
    getPlugin(name: string): CommanderPlugin | undefined;
    enable(name: string): boolean;
    disable(name: string): boolean;
    isEnabled(name: string): boolean;
    getConfig(name: string): Record<string, unknown> | undefined;
    updateConfig(name: string, config: Record<string, unknown>): Promise<void>;
    /**
     * Topological sort of registered plugins by dependency.
     * Throws if a circular dependency is detected.
     */
    getDependencyOrder(): string[];
    /** Get enabled plugin names in dependency order */
    private getEnabledInOrder;
    fireBeforeToolCall(ctx: BeforeToolCallContext): Promise<ToolResult | null>;
    fireAfterToolCall(ctx: AfterToolCallContext): Promise<ToolResult>;
    fireBeforeLLMCall(ctx: BeforeLLMCallContext): Promise<LLMRequest>;
    fireAfterLLMCall(ctx: AfterLLMCallContext): Promise<void>;
    fireOnAgentStart(ctx: AgentStartContext): Promise<void>;
    fireOnAgentComplete(ctx: AgentCompleteContext): Promise<void>;
    fireOnError(ctx: ErrorContext): Promise<void>;
    fireBeforeToolResolve(ctx: BeforeToolResolveContext): Promise<ToolResult | null>;
    fireAfterToolResolve(ctx: AfterToolResolveContext): Promise<void>;
    fireOnToolTimeout(ctx: ToolTimeoutContext): Promise<void>;
    fireOnToolRetry(ctx: ToolRetryContext): Promise<void>;
    fireBeforeContextCompaction(ctx: ContextCompactionContext): Promise<void>;
    fireAfterContextCompaction(ctx: ContextCompactionContext): Promise<void>;
    fireOnSessionFork(ctx: SessionForkContext): Promise<void>;
    fireOnSessionArchive(ctx: SessionArchiveContext): Promise<void>;
    fireOnStepStart(ctx: StepLifecycleContext): Promise<void>;
    fireOnStepComplete(ctx: StepLifecycleContext): Promise<void>;
    fireBeforeBackendSelect(ctx: BeforeBackendSelectContext): Promise<string | null>;
    fireAfterBackendSelect(ctx: AfterBackendSelectContext): Promise<void>;
    private validateAndMergeConfig;
    /** Wrap a plugin hook promise with a timeout. */
    private withTimeout;
}
export declare function getHookManager(): HookManager;
export declare function resetHookManager(): void;
export declare function createLoggingPlugin(): CommanderPlugin;
//# sourceMappingURL=pluginManager.d.ts.map