/**
 * HookManager — extracted from pluginManager.ts for modularity.
 *
 * The HookManager owns plugin registration, enable/disable, dependency-ordered
 * hook firing, config validation, and the sandboxed load context. Plugin types
 * (CommanderPlugin, hook contexts, config schema) live in pluginTypes.ts; the
 * barrel re-export in pluginManager.ts preserves the public API so all existing
 * `import { ... } from './pluginManager'` calls continue to work unchanged.
 */

import { reportSilentFailure } from './silentFailureReporter';
import type { ToolResult, LLMRequest } from './runtime/types';
import { getGlobalLogger } from './logging';
import { getMetricsCollector } from './runtime/metricsCollector';
import { getGlobalPluginPermissionRegistry } from './security/pluginPermissions';
import { createPluginSandboxContext } from './runtime/pluginSandboxContext';
import { createTenantAwareSingleton } from './runtime/tenantAwareSingleton';

import type {
  CommanderPlugin,
  PluginEntry,
  PluginCategory,
  PluginLoadContext,
  PluginServiceDeclaration,
  BeforeToolCallContext,
  AfterToolCallContext,
  BeforeLLMCallContext,
  AfterLLMCallContext,
  AgentStartContext,
  AgentCompleteContext,
  ErrorContext,
  BeforeToolResolveContext,
  AfterToolResolveContext,
  ToolTimeoutContext,
  ToolRetryContext,
  ContextCompactionContext,
  SessionForkContext,
  SessionArchiveContext,
  StepLifecycleContext,
  BeforeBackendSelectContext,
  AfterBackendSelectContext,
} from './pluginTypes';
import { adaptBuiltinPluginTool } from './pluginTypes';

export class HookManager {
  private plugins: Map<string, PluginEntry> = new Map();
  private hookTimeoutMs = 5000;
  /** Tool names currently registered into the ToolRegistry by plugins.
   * Tracked so we can cleanly unregister on disable/unregister. */
  private registeredPluginToolNames: Set<string> = new Set();

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
    // P-SEC: When a permission enforcer exists, pass ONLY the sandboxed context.
    // The raw HookManager is deliberately withheld to prevent privilege
    // escalation — without it, a plugin cannot call register/unregister/
    // updateConfig/getPlugin on other plugins or the hook system itself.
    // Built-in plugins (no enforcer) still receive the raw hookManager.
    if (plugin.onLoad) {
      try {
        const loadCtx = this.buildSandboxedLoadContext(plugin, mergedConfig);
        await plugin.onLoad(loadCtx);
      } catch (err) {
        this.plugins.delete(plugin.name);
        throw new Error(
          `Plugin "${plugin.name}" onLoad failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Wire declarative plugin tools into the ToolRegistry so the LLM can
    // invoke them. Previously the `tools` field was a dead declaration with
    // no host integration. Idempotent — see syncPluginToolsToRegistry().
    this.syncPluginToolsToRegistry();
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
    // P-SEC: Clean up permission registration when plugin is unloaded
    getGlobalPluginPermissionRegistry().unregister(name);
    // Reconcile ToolRegistry: remove tools that belonged to this plugin.
    this.syncPluginToolsToRegistry();
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
    // Tools become reachable again when the plugin is re-enabled.
    this.syncPluginToolsToRegistry();
    return true;
  }

  disable(name: string): boolean {
    const entry = this.plugins.get(name);
    if (!entry) return false;
    entry.enabled = false;
    // Tools from a disabled plugin must not be invocable by the LLM.
    this.syncPluginToolsToRegistry();
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
    // P-SEC: Apply the same sandboxed context as register() — do NOT pass
    // raw hookManager here. Previously this bypassed the permission system
    // entirely, allowing a config update to escalate privileges.
    if (entry.plugin.onLoad) {
      const loadCtx = this.buildSandboxedLoadContext(entry.plugin, merged);
      await entry.plugin.onLoad(loadCtx);
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

  // ── Plugin tools → ToolRegistry reconciliation ─────────────────────────

  /**
   * Collect every tool declared by enabled plugins. Used internally to keep
   * the ToolRegistry in sync after register/unregister/enable/disable, and
   * exposed for hosts that want to inspect what plugins currently offer.
   */
  getDeclaredPluginTools(): ReturnType<typeof adaptBuiltinPluginTool>[] {
    const out: ReturnType<typeof adaptBuiltinPluginTool>[] = [];
    for (const entry of this.plugins.values()) {
      if (!entry.enabled) continue;
      const tools = entry.plugin.tools;
      if (!tools || tools.length === 0) continue;
      for (const t of tools) {
        out.push(adaptBuiltinPluginTool(entry.plugin.name, t));
      }
    }
    return out;
  }

  /**
   * Idempotent reconciliation: walk enabled plugins, register any declared
   * tools into the ToolRegistry, and unregister any tools whose owning
   * plugin was removed or disabled.
   *
   * Lazy-requires the ToolRegistry to avoid a hard runtime dependency cycle
   * (pluginTypes / hookManager must remain importable by the tool layer).
   */
  private syncPluginToolsToRegistry(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ToolRegistry: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./tools/toolRegistry');
      ToolRegistry = mod.ToolRegistry ?? mod.default?.ToolRegistry ?? null;
    } catch {
      // ToolRegistry not available in this process (e.g., tests). No-op —
      // hosts that wire plugin tools must call getDeclaredPluginTools()
      // themselves when the registry is bootstrapped later.
      return;
    }
    if (!ToolRegistry || typeof ToolRegistry.register !== 'function') return;

    const desired = new Set<string>();
    for (const tool of this.getDeclaredPluginTools()) {
      const name = tool.definition.name;
      desired.add(name);
      try {
        // ToolRegistry.register(tool, category?) — single tool argument.
        ToolRegistry.register(tool);
      } catch {
        /* duplicate registration or schema compile error — non-fatal */
      }
    }
    // Unregister any previously-registered plugin tool that is no longer desired.
    for (const name of this.registeredPluginToolNames) {
      if (!desired.has(name)) {
        try {
          ToolRegistry.unregister(name);
        } catch {
          /* already gone — fine */
        }
      }
    }
    this.registeredPluginToolNames = desired;
  }

  // ── SPI: Service Provider Interface ────────────────────────────────────

  /**
   * Resolve a service implementation declared by an enabled plugin.
   * Plugins are queried in registration order; the first non-null
   * implementation wins. Returns undefined when no plugin provides the
   * requested service.
   *
   * This is the SPI hook that lets plugins replace core subsystems (e.g.,
   * declare "I provide the MemoryStore" via `provides: [{service:
   * 'memory.store', implementation: new MyStore()}]`) without requiring
   * host code changes.
   */
  getService<T = unknown>(serviceId: string): T | undefined {
    for (const entry of this.plugins.values()) {
      if (!entry.enabled) continue;
      const decls = entry.plugin.provides;
      if (!decls) continue;
      for (const d of decls) {
        if (d.service === serviceId && d.implementation != null) {
          return d.implementation as T;
        }
      }
    }
    return undefined;
  }

  /**
   * List every (serviceId, pluginName) pair currently offered by enabled
   * plugins. Useful for diagnostics / dashboards that show what subsystems
   * have been replaced by plugin providers.
   */
  listProvidedServices(): Array<{ service: string; plugin: string; description?: string }> {
    const out: Array<{ service: string; plugin: string; description?: string }> = [];
    for (const entry of this.plugins.values()) {
      if (!entry.enabled) continue;
      const decls = entry.plugin.provides;
      if (!decls) continue;
      for (const d of decls) {
        out.push({
          service: d.service,
          plugin: entry.plugin.name,
          description: (d as PluginServiceDeclaration).description,
        });
      }
    }
    return out;
  }

  // ── Sandbox context builder ─────────────────────────────────────────

  /**
   * P-SEC: Build the load context for a plugin's onLoad hook.
   *
   * - If a permission enforcer exists for this plugin (i.e., the plugin was
   *   loaded via PluginLoader with declared permissions): return ONLY the
   *   sandboxed context + config. The raw `hookManager` is deliberately
   *   omitted to prevent privilege escalation.
   * - If no enforcer exists (built-in plugin registered directly): return
   *   the legacy context with the raw `hookManager` for backward compat.
   */
  private buildSandboxedLoadContext(
    plugin: CommanderPlugin,
    mergedConfig: Record<string, unknown>,
  ): PluginLoadContext {
    const enforcer = getGlobalPluginPermissionRegistry().get(plugin.name);
    if (!enforcer) {
      // Built-in plugin — no permission envelope, full access
      return { config: mergedConfig, hookManager: this };
    }

    // Third-party plugin with declared permissions — sandbox only
    const sandboxContext = createPluginSandboxContext(
      plugin.name,
      enforcer,
      mergedConfig,
      (hookName: string, callback: (...args: unknown[]) => unknown | Promise<unknown>) => {
        const check = enforcer.checkHook(hookName);
        if (check.allowed) {
          (plugin as unknown as Record<string, unknown>)[hookName] = callback;
        } else {
          getGlobalLogger().warn('PluginSecurity', 'Hook registration denied during onLoad', {
            plugin: plugin.name,
            hook: hookName,
            reason: check.reason,
          });
        }
      },
    );

    // Intentionally do NOT include `hookManager` — the sandbox context
    // provides all necessary APIs through permission-checked methods.
    return {
      config: mergedConfig,
      ...sandboxContext,
    } as unknown as PluginLoadContext;
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

  /**
   * Wrap a plugin hook promise with a timeout.
   * P-SEC: Uses the per-plugin maxExecutionTimeMs from the permission enforcer
   * when available, falling back to the global hookTimeoutMs. This ensures a
   * plugin cannot exceed its declared execution budget even if the global
   * timeout is set higher.
   */
  private withTimeout<T>(
    promise: Promise<T> | T,
    pluginName: string,
    hookName: string,
  ): Promise<T> {
    if (typeof promise !== 'object' || promise === null || !('then' in promise)) {
      return Promise.resolve(promise);
    }

    // P-SEC: Enforce per-plugin execution time limit from permission enforcer.
    // If the plugin has a declared maxExecutionTimeMs, use the stricter of
    // (per-plugin limit, global limit) to prevent timeout-based DoS.
    const enforcer = getGlobalPluginPermissionRegistry().get(pluginName);
    const perPluginLimit = enforcer?.maxExecutionTimeMs;
    const timeoutMs =
      perPluginLimit !== undefined
        ? Math.min(perPluginLimit, this.hookTimeoutMs)
        : this.hookTimeoutMs;

    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      (promise as Promise<T>).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Plugin "${pluginName}" hook "${hookName}" timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  }
}

// ============================================================================
// Tenant-aware singleton accessor
// ============================================================================

const hookManagerSingleton = createTenantAwareSingleton(() => new HookManager());

export function getHookManager(): HookManager {
  return hookManagerSingleton.get();
}

export function resetHookManager(): void {
  hookManagerSingleton.reset();
}
