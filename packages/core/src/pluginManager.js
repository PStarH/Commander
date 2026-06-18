"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HookManager = void 0;
exports.getHookManager = getHookManager;
exports.resetHookManager = resetHookManager;
exports.createLoggingPlugin = createLoggingPlugin;
const logging_1 = require("./logging");
const metricsCollector_1 = require("./runtime/metricsCollector");
// ============================================================================
// Hook Manager
// ============================================================================
class HookManager {
    constructor() {
        this.plugins = new Map();
        this.hookTimeoutMs = 5000;
    }
    setHookTimeout(ms) {
        this.hookTimeoutMs = ms;
    }
    getHookTimeout() {
        return this.hookTimeoutMs;
    }
    /**
     * Register a plugin with optional config.
     * Validates config schema, resolves dependencies, calls onLoad().
     * Throws if a plugin with the same name is already registered.
     */
    async register(plugin, config = {}) {
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
        const entry = {
            plugin,
            enabled: true,
            config: mergedConfig,
        };
        this.plugins.set(plugin.name, entry);
        // Call onLoad lifecycle hook
        if (plugin.onLoad) {
            try {
                await plugin.onLoad({ config: mergedConfig, hookManager: this });
            }
            catch (err) {
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
    async unregister(name) {
        const entry = this.plugins.get(name);
        if (!entry)
            return false;
        if (entry.plugin.onUnload) {
            try {
                await entry.plugin.onUnload();
            }
            catch {
                (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onUnload failed`);
            }
        }
        this.plugins.delete(name);
        return true;
    }
    /** Get all registered plugin names */
    listPlugins() {
        return Array.from(this.plugins.keys());
    }
    /** Get detailed plugin info */
    getPluginInfo(name) {
        const entry = this.plugins.get(name);
        if (!entry)
            return undefined;
        return { plugin: entry.plugin, enabled: entry.enabled, config: { ...entry.config } };
    }
    /** Check if a plugin is registered */
    hasPlugin(name) {
        return this.plugins.has(name);
    }
    /** Get a specific plugin by name */
    getPlugin(name) {
        var _a;
        return (_a = this.plugins.get(name)) === null || _a === void 0 ? void 0 : _a.plugin;
    }
    // ── Runtime enable/disable ──
    enable(name) {
        const entry = this.plugins.get(name);
        if (!entry)
            return false;
        entry.enabled = true;
        return true;
    }
    disable(name) {
        const entry = this.plugins.get(name);
        if (!entry)
            return false;
        entry.enabled = false;
        return true;
    }
    isEnabled(name) {
        var _a, _b;
        return (_b = (_a = this.plugins.get(name)) === null || _a === void 0 ? void 0 : _a.enabled) !== null && _b !== void 0 ? _b : false;
    }
    // ── Config ──
    getConfig(name) {
        var _a;
        return (_a = this.plugins.get(name)) === null || _a === void 0 ? void 0 : _a.config;
    }
    async updateConfig(name, config) {
        const entry = this.plugins.get(name);
        if (!entry)
            throw new Error(`Plugin "${name}" not found`);
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
    getDependencyOrder() {
        const visited = new Set();
        const inStack = new Set();
        const order = [];
        const visit = (name) => {
            if (inStack.has(name)) {
                throw new Error(`Circular plugin dependency detected involving "${name}"`);
            }
            if (visited.has(name))
                return;
            inStack.add(name);
            visited.add(name);
            const entry = this.plugins.get(name);
            if (entry === null || entry === void 0 ? void 0 : entry.plugin.dependsOn) {
                for (const dep of entry.plugin.dependsOn) {
                    if (this.plugins.has(dep))
                        visit(dep);
                }
            }
            inStack.delete(name);
            order.push(name);
        };
        for (const name of this.plugins.keys()) {
            if (!visited.has(name))
                visit(name);
        }
        return order;
    }
    /** Get enabled plugin names in dependency order */
    getEnabledInOrder() {
        return this.getDependencyOrder().filter((name) => { var _a; return (_a = this.plugins.get(name)) === null || _a === void 0 ? void 0 : _a.enabled; });
    }
    // ── Hook firing (with dep ordering + enabled check) ──
    async fireBeforeToolCall(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.beforeToolCall) {
                try {
                    const result = await this.withTimeout(plugin.beforeToolCall(ctx), plugin.name, 'beforeToolCall');
                    if (result !== null)
                        return result;
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('beforeToolCall', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" beforeToolCall failed`);
                }
            }
        }
        return null;
    }
    async fireAfterToolCall(ctx) {
        let currentResult = ctx.result;
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.afterToolCall) {
                try {
                    currentResult = await this.withTimeout(plugin.afterToolCall({ ...ctx, result: currentResult }), plugin.name, 'afterToolCall');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('afterToolCall', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" afterToolCall failed`);
                }
            }
        }
        return currentResult;
    }
    async fireBeforeLLMCall(ctx) {
        let currentRequest = ctx.request;
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.beforeLLMCall) {
                try {
                    currentRequest = await this.withTimeout(plugin.beforeLLMCall({ ...ctx, request: currentRequest }), plugin.name, 'beforeLLMCall');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('beforeLLMCall', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" beforeLLMCall failed`);
                }
            }
        }
        return currentRequest;
    }
    async fireAfterLLMCall(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.afterLLMCall) {
                try {
                    await this.withTimeout(plugin.afterLLMCall(ctx), plugin.name, 'afterLLMCall');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('afterLLMCall', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" afterLLMCall failed`);
                }
            }
        }
    }
    async fireOnAgentStart(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onAgentStart) {
                try {
                    await this.withTimeout(plugin.onAgentStart(ctx), plugin.name, 'onAgentStart');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onAgentStart', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onAgentStart failed`);
                }
            }
        }
    }
    async fireOnAgentComplete(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onAgentComplete) {
                try {
                    await this.withTimeout(plugin.onAgentComplete(ctx), plugin.name, 'onAgentComplete');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onAgentComplete', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onAgentComplete failed`);
                }
            }
        }
    }
    async fireOnError(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onError) {
                try {
                    await this.withTimeout(plugin.onError(ctx), plugin.name, 'onError');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onError', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onError failed`);
                }
            }
        }
    }
    // ── Sprint 3: Interceptor hook firing ──
    async fireBeforeToolResolve(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.beforeToolResolve) {
                try {
                    const result = await this.withTimeout(plugin.beforeToolResolve(ctx), plugin.name, 'beforeToolResolve');
                    if (result !== null)
                        return result;
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('beforeToolResolve', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" beforeToolResolve failed`);
                }
            }
        }
        return null;
    }
    async fireAfterToolResolve(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.afterToolResolve) {
                try {
                    await this.withTimeout(plugin.afterToolResolve(ctx), plugin.name, 'afterToolResolve');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('afterToolResolve', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" afterToolResolve failed`);
                }
            }
        }
    }
    async fireOnToolTimeout(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onToolTimeout) {
                try {
                    await this.withTimeout(plugin.onToolTimeout(ctx), plugin.name, 'onToolTimeout');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onToolTimeout', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onToolTimeout failed`);
                }
            }
        }
    }
    async fireOnToolRetry(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onToolRetry) {
                try {
                    await this.withTimeout(plugin.onToolRetry(ctx), plugin.name, 'onToolRetry');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onToolRetry', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onToolRetry failed`);
                }
            }
        }
    }
    async fireBeforeContextCompaction(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.beforeContextCompaction) {
                try {
                    await this.withTimeout(plugin.beforeContextCompaction(ctx), plugin.name, 'beforeContextCompaction');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('beforeContextCompaction', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" beforeContextCompaction failed`);
                }
            }
        }
    }
    async fireAfterContextCompaction(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.afterContextCompaction) {
                try {
                    await this.withTimeout(plugin.afterContextCompaction(ctx), plugin.name, 'afterContextCompaction');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('afterContextCompaction', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" afterContextCompaction failed`);
                }
            }
        }
    }
    async fireOnSessionFork(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onSessionFork) {
                try {
                    await this.withTimeout(plugin.onSessionFork(ctx), plugin.name, 'onSessionFork');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onSessionFork', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onSessionFork failed`);
                }
            }
        }
    }
    async fireOnSessionArchive(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onSessionArchive) {
                try {
                    await this.withTimeout(plugin.onSessionArchive(ctx), plugin.name, 'onSessionArchive');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onSessionArchive', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onSessionArchive failed`);
                }
            }
        }
    }
    async fireOnStepStart(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onStepStart) {
                try {
                    await this.withTimeout(plugin.onStepStart(ctx), plugin.name, 'onStepStart');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onStepStart', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onStepStart failed`);
                }
            }
        }
    }
    async fireOnStepComplete(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.onStepComplete) {
                try {
                    await this.withTimeout(plugin.onStepComplete(ctx), plugin.name, 'onStepComplete');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('onStepComplete', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" onStepComplete failed`);
                }
            }
        }
    }
    async fireBeforeBackendSelect(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.beforeBackendSelect) {
                try {
                    const result = await this.withTimeout(plugin.beforeBackendSelect(ctx), plugin.name, 'beforeBackendSelect');
                    if (result !== null)
                        return result;
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('beforeBackendSelect', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" beforeBackendSelect failed`);
                }
            }
        }
        return null;
    }
    async fireAfterBackendSelect(ctx) {
        for (const name of this.getEnabledInOrder()) {
            const plugin = this.plugins.get(name).plugin;
            if (plugin.afterBackendSelect) {
                try {
                    await this.withTimeout(plugin.afterBackendSelect(ctx), plugin.name, 'afterBackendSelect');
                }
                catch (err) {
                    if (plugin.required)
                        throw err;
                    (0, metricsCollector_1.getMetricsCollector)().recordHookFailure('afterBackendSelect', name);
                    (0, logging_1.getGlobalLogger)().warn('PluginManager', `Plugin "${name}" afterBackendSelect failed`);
                }
            }
        }
    }
    // ── Config validation ──
    validateAndMergeConfig(plugin, config) {
        const schema = plugin.configSchema;
        if (!schema)
            return { ...config };
        const merged = { ...config };
        // Apply defaults and validate types
        for (const [key, field] of Object.entries(schema.properties)) {
            const value = key in merged ? merged[key] : field.default;
            if (value !== undefined) {
                if (field.type === 'array' && !Array.isArray(value)) {
                    throw new Error(`Plugin "${plugin.name}" config "${key}": expected array, got ${typeof value}`);
                }
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
    withTimeout(promise, pluginName, hookName) {
        if (typeof promise !== 'object' || promise === null || !('then' in promise)) {
            return Promise.resolve(promise);
        }
        let timer;
        return Promise.race([
            promise.finally(() => clearTimeout(timer)),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Plugin "${pluginName}" hook "${hookName}" timed out after ${this.hookTimeoutMs}ms`)), this.hookTimeoutMs);
                timer.unref();
            }),
        ]);
    }
}
exports.HookManager = HookManager;
// ============================================================================
const tenantAwareSingleton_1 = require("./runtime/tenantAwareSingleton");
const hookManagerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new HookManager());
function getHookManager() {
    return hookManagerSingleton.get();
}
function resetHookManager() {
    hookManagerSingleton.reset();
}
// ============================================================================
// Built-in plugins
// ============================================================================
function createLoggingPlugin() {
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
            var _a;
            const prefix = (_a = ctx.config.prefix) !== null && _a !== void 0 ? _a : '[Plugin:logger]';
            (0, logging_1.getGlobalLogger)().info('PluginManager', `${prefix} loaded (verbose=${ctx.config.verbose})`);
        },
        beforeToolCall: async (ctx) => {
            (0, logging_1.getGlobalLogger)().info('PluginManager', `[Plugin:logger] beforeToolCall: ${ctx.toolName}`);
            return null;
        },
        onAgentStart: async (ctx) => {
            (0, logging_1.getGlobalLogger)().info('PluginManager', `[Plugin:logger] Agent started: ${ctx.ctx.agentId}, goal: ${ctx.ctx.goal.slice(0, 60)}...`);
        },
        onAgentComplete: async (ctx) => {
            (0, logging_1.getGlobalLogger)().info('PluginManager', `[Plugin:logger] Agent completed: ${ctx.result.status}`);
        },
        onError: async (ctx) => {
            (0, logging_1.getGlobalLogger)().error('PluginManager', `[Plugin:logger] Error: ${ctx.error.slice(0, 100)}`);
        },
    };
}
