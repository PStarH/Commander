import type { Tool, ToolDefinition, CompiledSchema } from '../runtime/types';
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
export declare class ToolRegistry {
    private static instance;
    private tools;
    private categories;
    private compiledSchemas;
    private constructor();
    static getInstance(): ToolRegistry;
    /**
     * Register a tool. If a tool with the same name already exists,
     * the later registration overwrites the earlier one (enables customization).
     */
    static register(tool: Tool, category?: string): void;
    /**
     * Batch register multiple tools.
     */
    static registerAll(tools: [string, Tool][], category?: string): void;
    /**
     * Get a tool by name.
     */
    static get(name: string): Tool | undefined;
    /**
     * Get all registered tools as a Map.
     */
    static getAllTools(): Map<string, Tool>;
    /**
     * Get all tool definitions (for LLM function calling).
     */
    static getAllDefinitions(): ToolDefinition[];
    /**
     * Get tool names by category.
     */
    static getToolsByCategory(category: string): string[];
    /** Reset the singleton instance (for test isolation). */
    static resetInstance(): void;
    /**
     * Get compiled schema for a tool (for runtime validation).
     */
    static getCompiledSchema(name: string): CompiledSchema | undefined;
    /**
     * Get all categories.
     */
    static getCategories(): string[];
    /**
     * Get the count of registered tools.
     */
    static count(): number;
    /**
     * Reset the registry (for testing).
     */
    static reset(): void;
    /**
     * Unregister a tool by name.
     */
    static unregister(name: string): boolean;
}
/**
 * Categorize tools for better model understanding.
 * Groups tools by domain to help the model select the right tool faster.
 */
export declare const TOOL_CATEGORIES: Record<string, string>;
//# sourceMappingURL=toolRegistry.d.ts.map