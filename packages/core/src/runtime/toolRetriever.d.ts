/**
 * Dynamic Tool Retrieval (ITR - Instruction-Tool Retrieval)
 *
 * Research finding (arXiv 2602.17046): Dynamic tool retrieval achieves:
 * - 95% reduction in per-step context tokens
 * - 32% improvement in tool routing accuracy
 * - 70% cost reduction
 *
 * Instead of loading ALL tool definitions into every LLM request,
 * we dynamically select only the tools relevant to the current task
 * and conversation state. This reduces prompt size, improves model
 * focus, and cuts costs.
 *
 * The retriever uses a two-stage approach:
 * 1. Keyword-based relevance scoring (fast, no LLM call)
 * 2. Conversation-aware refinement based on recent tool usage patterns
 */
import type { ToolDefinition } from './types';
/**
 * Select the optimal subset of tools based on task context.
 * The `minTools` parameter ensures core tools are always available.
 */
export declare function selectTools(goal: string, availableTools: string[], options?: {
    recentToolCalls?: Array<{
        name: string;
        error?: string;
    }>;
    /** Minimum number of tools to return (default: 3) */
    minTools?: number;
    /** Maximum number of tools to return (default: 15, i.e. all) */
    maxTools?: number;
    /** Force-include these tools regardless of scoring (default: ['file_read', 'shell_execute']) */
    alwaysInclude?: string[];
    /** Tools that conflict with each other (mutually exclusive pairs) */
    stoplist?: [string, string][];
}): string[];
export declare function getToolCategory(toolName: string): string;
/**
 * Sort tool definitions by a stable category+name order for maximum prompt cache hit rates.
 * Cache-friendly ordering ensures the tool definition prefix is identical across LLM calls,
 * regardless of the specific task goal.
 *
 * The order is: category priority (ascending) → tool name (alphabetical).
 */
export declare function sortToolDefinitionsForCache(defs: ToolDefinition[]): ToolDefinition[];
export declare function getToolRelevanceScores(goal: string, availableTools: string[]): Map<string, number>;
export interface ToolTier {
    /** Tools with full schema (injected as LLM tools array) */
    active: ToolDefinition[];
    /** Tools with compact summary only (injected as text in system prompt) */
    registry: Array<{
        name: string;
        description: string;
        category: string;
    }>;
}
/**
 * Build a two-tier tool layout for a given goal.
 *
 * @param goal - The current task goal
 * @param allTools - All available tool definitions
 * @param maxActive - Maximum tools to include with full schema (default: 8)
 * @param recentToolCalls - Recent tool calls for history-aware scoring
 * @returns Two-tier layout with active (full schema) and registry (compact) tools
 */
export declare function buildTwoTierTools(goal: string, allTools: ToolDefinition[], maxActive?: number, recentToolCalls?: Array<{
    name: string;
    error?: string;
}>): ToolTier;
export declare function detectContextPromotions(goal: string, registryTools: ToolTier['registry']): string[];
/**
 * Build a compact text summary of the tool registry (Tier 2 tools).
 * This is injected into the system prompt so the LLM knows what tools exist
 * without paying the full schema cost.
 */
export declare function buildRegistrySummary(registry: ToolTier['registry']): string;
/**
 * Estimate the token cost of tool schemas.
 * Useful for logging and metrics.
 */
export declare function estimateToolTokenCost(tools: ToolDefinition[]): number;
export interface TwoTierMetrics {
    activeCount: number;
    registryCount: number;
    activeTokenEstimate: number;
    registryTokenEstimate: number;
    savingsPercent: number;
}
/**
 * Calculate metrics for a two-tier tool layout.
 * Useful for logging cost savings.
 */
export declare function calculateTierMetrics(tier: ToolTier, allToolsCount: number): TwoTierMetrics;
//# sourceMappingURL=toolRetriever.d.ts.map