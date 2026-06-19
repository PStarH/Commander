import type { Tool, ToolDefinition, CompiledSchema } from '../runtime/types';
import { compileSchema } from '../runtime/toolCallValidator';
import { getGlobalLogger } from '../logging';

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
  private static instance: ToolRegistry | undefined;
  private tools: Map<string, Tool> = new Map();
  private categories: Map<string, string[]> = new Map();
  private compiledSchemas: Map<string, CompiledSchema> = new Map();

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

    // Auto-compile schema for runtime validation
    try {
      const compiled = compileSchema(tool.definition.inputSchema);
      registry.compiledSchemas.set(tool.definition.name, compiled);
      tool.compiledSchema = compiled;
    } catch (e) {
      getGlobalLogger().warn('ToolRegistry', 'Schema compilation failed', {
        error: (e as Error)?.message,
        tool: tool.definition.name,
      });
    }

    if (category) {
      // Remove from old category if re-registering
      for (const [cat, names] of registry.categories) {
        const idx = names.indexOf(tool.definition.name);
        if (idx !== -1) {
          names.splice(idx, 1);
          if (names.length === 0) registry.categories.delete(cat);
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
    return Array.from(ToolRegistry.getInstance().tools.values()).map((t) => t.definition);
  }

  /**
   * Get tool names by category.
   */
  static getToolsByCategory(category: string): string[] {
    return ToolRegistry.getInstance().categories.get(category) || [];
  }

  /** Reset the singleton instance (for test isolation). */
  static resetInstance(): void {
    ToolRegistry.instance = undefined;
  }

  /**
   * Get compiled schema for a tool (for runtime validation).
   */
  static getCompiledSchema(name: string): CompiledSchema | undefined {
    return ToolRegistry.getInstance().compiledSchemas.get(name);
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
    const registry = ToolRegistry.getInstance();
    const existed = registry.tools.delete(name);
    if (existed) {
      registry.compiledSchemas.delete(name);
      for (const [cat, names] of registry.categories) {
        const idx = names.indexOf(name);
        if (idx !== -1) names.splice(idx, 1);
        if (names.length === 0) registry.categories.delete(cat);
      }
    }
    return existed;
  }
}

/**
 * Categorize tools for better model understanding.
 * Groups tools by domain to help the model select the right tool faster.
 */
export const TOOL_CATEGORIES: Record<string, string> = {
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

export type TrustTier = 'trusted' | 'untrusted';

/**
 * Determine the trust tier for a tool based on its name and optional tool metadata.
 *
 * Rules:
 * 1. If the tool has an explicit `trustTier`, use it.
 * 2. If the tool name starts with `mcp_` or the category is `mcp`, treat as untrusted.
 * 3. Otherwise, default to `untrusted` (fail-closed).
 */
export function getToolTrustTier(
  name: string,
  tool?: { trustTier?: TrustTier; definition?: { category?: string } },
): TrustTier {
  // Explicit trustTier overrides everything
  if (tool?.trustTier) {
    return tool.trustTier;
  }

  // MCP prefix → untrusted
  if (name.startsWith('mcp_')) {
    return 'untrusted';
  }

  // MCP category heuristic → untrusted
  if (tool?.definition?.category === 'mcp') {
    return 'untrusted';
  }

  // Default: fail closed to untrusted
  return 'untrusted';
}
