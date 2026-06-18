"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_CATEGORIES = exports.ToolRegistry = void 0;
const toolCallValidator_1 = require("../runtime/toolCallValidator");
const logging_1 = require("../logging");
/**
 * ToolRegistry — Auto-Discovery Tool Registry
 *
 * Inspired by Hermes Agent's tools/registry.py (auto-registration at import time)
 * and OpenClaw's tool registration pattern.
 *
 * Tools self-register via `ToolRegistry.register()` during initialization.
 * This replaces the manual `createAllTools()` approach with a cleaner,
 * extensible pattern.
 *
 * Usage:
 *   // In any tool file:
 *   ToolRegistry.register(new MyTool());
 *
 *   // In runtime setup:
 *   const allTools = ToolRegistry.getAllTools();
 */
class ToolRegistry {
    constructor() {
        this.tools = new Map();
        this.categories = new Map();
        this.compiledSchemas = new Map();
    }
    static getInstance() {
        if (!ToolRegistry.instance) {
            ToolRegistry.instance = new ToolRegistry();
        }
        return ToolRegistry.instance;
    }
    /**
     * Register a tool. If a tool with the same name already exists,
     * the later registration overwrites the earlier one (enables customization).
     */
    static register(tool, category) {
        const registry = ToolRegistry.getInstance();
        registry.tools.set(tool.definition.name, tool);
        // Auto-compile schema for runtime validation
        try {
            const compiled = (0, toolCallValidator_1.compileSchema)(tool.definition.inputSchema);
            registry.compiledSchemas.set(tool.definition.name, compiled);
            tool.compiledSchema = compiled;
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('ToolRegistry', 'Schema compilation failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
                tool: tool.definition.name,
            });
        }
        if (category) {
            // Remove from old category if re-registering
            for (const [cat, names] of registry.categories) {
                const idx = names.indexOf(tool.definition.name);
                if (idx !== -1) {
                    names.splice(idx, 1);
                    if (names.length === 0)
                        registry.categories.delete(cat);
                }
            }
            const existing = registry.categories.get(category) || [];
            existing.push(tool.definition.name);
            registry.categories.set(category, existing);
        }
    }
    /**
     * Batch register multiple tools.
     */
    static registerAll(tools, category) {
        for (const [, tool] of tools) {
            ToolRegistry.register(tool, category);
        }
    }
    /**
     * Get a tool by name.
     */
    static get(name) {
        return ToolRegistry.getInstance().tools.get(name);
    }
    /**
     * Get all registered tools as a Map.
     */
    static getAllTools() {
        return new Map(ToolRegistry.getInstance().tools);
    }
    /**
     * Get all tool definitions (for LLM function calling).
     */
    static getAllDefinitions() {
        return Array.from(ToolRegistry.getInstance().tools.values()).map((t) => t.definition);
    }
    /**
     * Get tool names by category.
     */
    static getToolsByCategory(category) {
        return ToolRegistry.getInstance().categories.get(category) || [];
    }
    /** Reset the singleton instance (for test isolation). */
    static resetInstance() {
        ToolRegistry.instance = undefined;
    }
    /**
     * Get compiled schema for a tool (for runtime validation).
     */
    static getCompiledSchema(name) {
        return ToolRegistry.getInstance().compiledSchemas.get(name);
    }
    /**
     * Get all categories.
     */
    static getCategories() {
        return Array.from(ToolRegistry.getInstance().categories.keys());
    }
    /**
     * Get the count of registered tools.
     */
    static count() {
        return ToolRegistry.getInstance().tools.size;
    }
    /**
     * Reset the registry (for testing).
     */
    static reset() {
        ToolRegistry.instance = new ToolRegistry();
    }
    /**
     * Unregister a tool by name.
     */
    static unregister(name) {
        const registry = ToolRegistry.getInstance();
        const existed = registry.tools.delete(name);
        if (existed) {
            registry.compiledSchemas.delete(name);
            for (const [cat, names] of registry.categories) {
                const idx = names.indexOf(name);
                if (idx !== -1)
                    names.splice(idx, 1);
                if (names.length === 0)
                    registry.categories.delete(cat);
            }
        }
        return existed;
    }
}
exports.ToolRegistry = ToolRegistry;
/**
 * Categorize tools for better model understanding.
 * Groups tools by domain to help the model select the right tool faster.
 */
exports.TOOL_CATEGORIES = {
    // STRAP-consolidated resource tools
    file: 'filesystem',
    memory: 'memory',
    web: 'web',
    browser: 'web',
    code: 'code',
    checkpoint: 'workflow',
    handoff: 'development',
    exec: 'code',
    media: 'multimodal',
    system: 'control',
    // Single-domain tools
    git: 'development',
    agent: 'development',
    meta: 'development',
    lsp_diagnostics: 'development',
    lsp_attach: 'development',
    skill_view: 'skills',
    apply_patch: 'code',
    verify_answer: 'control',
    search_conversations: 'memory',
};
