import type { Tool, ToolDefinition } from '../runtime/types';

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
export class ToolRegistry {
  private static instance: ToolRegistry;
  private tools: Map<string, Tool> = new Map();
  private categories: Map<string, string[]> = new Map();

  private constructor() {}

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  /**
   * Register a tool. If a tool with the same name already exists,
   * the later registration overwrites the earlier one (enables customization).
   */
  static register(tool: Tool, category?: string): void {
    const registry = ToolRegistry.getInstance();
    registry.tools.set(tool.definition.name, tool);
    if (category) {
      const existing = registry.categories.get(category) || [];
      existing.push(tool.definition.name);
      registry.categories.set(category, existing);
    }
  }

  /**
   * Batch register multiple tools.
   */
  static registerAll(tools: [string, Tool][], category?: string): void {
    for (const [, tool] of tools) {
      ToolRegistry.register(tool, category);
    }
  }

  /**
   * Get a tool by name.
   */
  static get(name: string): Tool | undefined {
    return ToolRegistry.getInstance().tools.get(name);
  }

  /**
   * Get all registered tools as a Map.
   */
  static getAllTools(): Map<string, Tool> {
    return new Map(ToolRegistry.getInstance().tools);
  }

  /**
   * Get all tool definitions (for LLM function calling).
   */
  static getAllDefinitions(): ToolDefinition[] {
    return Array.from(ToolRegistry.getInstance().tools.values()).map(t => t.definition);
  }

  /**
   * Get tool names by category.
   */
  static getToolsByCategory(category: string): string[] {
    return ToolRegistry.getInstance().categories.get(category) || [];
  }

  /**
   * Get all categories.
   */
  static getCategories(): string[] {
    return Array.from(ToolRegistry.getInstance().categories.keys());
  }

  /**
   * Get the count of registered tools.
   */
  static count(): number {
    return ToolRegistry.getInstance().tools.size;
  }

  /**
   * Reset the registry (for testing).
   */
  static reset(): void {
    ToolRegistry.instance = new ToolRegistry();
  }

  /**
   * Unregister a tool by name.
   */
  static unregister(name: string): boolean {
    return ToolRegistry.getInstance().tools.delete(name);
  }
}

/**
 * Categorize tools for better model understanding.
 * Groups tools by domain to help the model select the right tool faster.
 */
export const TOOL_CATEGORIES: Record<string, string> = {
  web_search: 'web',
  web_fetch: 'web',
  browser_search: 'web',
  browser_fetch: 'web',
  file_read: 'filesystem',
  file_write: 'filesystem',
  file_edit: 'filesystem',
  file_search: 'filesystem',
  file_list: 'filesystem',
  python_execute: 'code',
  shell_execute: 'code',
  execute_script: 'code',
  memory_store: 'memory',
  memory_recall: 'memory',
  memory_list: 'memory',
  git: 'development',
  agent: 'development',
  meta: 'development',
  lsp_diagnostics: 'development',
  lsp_attach: 'development',
  vision_analyze: 'multimodal',
  pdf_extract: 'multimodal',
  screenshot_capture: 'multimodal',
};